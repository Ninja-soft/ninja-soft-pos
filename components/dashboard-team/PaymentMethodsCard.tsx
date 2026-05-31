"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CreditCard, Link2, Check, Clock } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/ui/Toast";
import { Card, CardContent } from "@/components/ui/Card";
import { Heading } from "@/components/ui/Typography";
import { Switch } from "@/components/ui/Switch";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";

const KIND_LABELS: Record<string, string> = {
  manual: "Lo cobrás vos",
  gateway: "Tarjeta / online",
  qr: "Pago con QR",
  orchestrator: "Varias pasarelas",
};

// Proveedores con flujo de cobro real implementado. El resto se muestra como
// "Próximamente" para no ofrecer botones de conexión que aún no hacen nada.
const IMPLEMENTED = new Set(["mercadopago"]);

type Provider = { key: string; name: string; kind: string; sort: number };
type Method = {
  provider_key: string;
  enabled: boolean;
  sandbox: boolean;
  surcharge_pct: number;
  config: { connected?: boolean } | null;
};

export function PaymentMethodsCard() {
  const supabase = createClient();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [connectKey, setConnectKey] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [showManual, setShowManual] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();

  // Resultado del redirect del OAuth de Mercado Pago (?mp=ok|err|denied).
  useEffect(() => {
    const mp = searchParams.get("mp");
    if (!mp) return;
    if (mp === "ok") toast({ title: "Mercado Pago conectado", variant: "success" });
    else if (mp === "denied")
      toast({ title: "Conexión cancelada", variant: "error" });
    else toast({ title: "No se pudo conectar Mercado Pago", variant: "error" });
    qc.invalidateQueries({ queryKey: ["tenant-payment-methods"] });
    router.replace("/configuracion");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const { data: ctx } = useQuery({
    queryKey: ["my-payments-ctx"],
    queryFn: async (): Promise<{ tenantId: string; canManage: boolean } | null> => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return null;
      const { data: mem } = await supabase
        .from("tenant_users")
        .select("tenant_id, role")
        .eq("user_id", user.id)
        .eq("status", "active")
        .limit(1)
        .maybeSingle();
      if (!mem) return null;
      return {
        tenantId: mem.tenant_id,
        canManage: ["owner", "manager"].includes(mem.role),
      };
    },
  });
  const tenantId = ctx?.tenantId ?? "";

  const { data: providers = [] } = useQuery({
    queryKey: ["payment-providers"],
    queryFn: async (): Promise<Provider[]> => {
      const { data } = await supabase
        .from("payment_providers")
        .select("key, name, kind, sort")
        .eq("is_active", true)
        .order("sort");
      return (data ?? []) as Provider[];
    },
  });

  const { data: methods = [] } = useQuery({
    queryKey: ["tenant-payment-methods", tenantId],
    enabled: !!tenantId,
    queryFn: async (): Promise<Method[]> => {
      const { data } = await supabase
        .from("tenant_payment_methods")
        .select("provider_key, enabled, sandbox, surcharge_pct, config")
        .eq("tenant_id", tenantId);
      return (data ?? []) as Method[];
    },
  });

  const byKey = useMemo(() => {
    const m = new Map<string, Method>();
    methods.forEach((x) => m.set(x.provider_key, x));
    return m;
  }, [methods]);

  const save = useMutation({
    mutationFn: async (vars: {
      provider_key: string;
      enabled?: boolean;
      sandbox?: boolean;
      surcharge_pct?: number;
    }) => {
      const cur = byKey.get(vars.provider_key);
      const { error } = await supabase.from("tenant_payment_methods").upsert(
        {
          tenant_id: tenantId,
          provider_key: vars.provider_key,
          enabled: vars.enabled ?? cur?.enabled ?? false,
          sandbox: vars.sandbox ?? cur?.sandbox ?? true,
          surcharge_pct: vars.surcharge_pct ?? cur?.surcharge_pct ?? 0,
        },
        { onConflict: "tenant_id,provider_key" },
      );
      if (error) throw error;
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["tenant-payment-methods", tenantId] }),
    onError: () => toast({ title: "No se pudo guardar", variant: "error" }),
  });

  const connect = useMutation({
    mutationFn: async (vars: {
      provider_key: string;
      token?: string;
      clear?: boolean;
    }) => {
      const body = vars.clear
        ? { provider_key: vars.provider_key, action: "clear" }
        : { provider_key: vars.provider_key, secrets: { access_token: vars.token } };
      const { data, error } = await supabase.functions.invoke("set_payment_secret", {
        body,
      });
      if (error) throw error;
      if ((data as { error?: string })?.error) throw new Error((data as { error: string }).error);
    },
    onSuccess: () => {
      toast({ title: "Listo", variant: "success" });
      qc.invalidateQueries({ queryKey: ["tenant-payment-methods", tenantId] });
      setConnectKey(null);
      setToken("");
    },
    onError: () => toast({ title: "No se pudo guardar la conexión", variant: "error" }),
  });

  // OAuth: pide la URL de autorización y redirige a Mercado Pago.
  const oauthStart = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("mp_oauth_start", {
        body: {},
      });
      if (error) throw error;
      const res = data as { url?: string; error?: string };
      if (res?.error || !res?.url) throw new Error(res?.error ?? "no_url");
      return res.url;
    },
    onSuccess: (url) => {
      window.location.href = url;
    },
    onError: (e: Error) => {
      toast({
        title:
          e.message === "platform_not_configured"
            ? "Mercado Pago no está configurado por NinjaSoft todavía"
            : "No se pudo iniciar la conexión",
        variant: "error",
      });
    },
  });

  if (!ctx || !ctx.canManage) return null;

  const connectingProvider = providers.find((p) => p.key === connectKey);
  const connectingConnected = Boolean(byKey.get(connectKey ?? "")?.config?.connected);

  return (
    <section>
      <Heading as="h2" className="flex items-center gap-2 text-base">
        <CreditCard size={18} /> Medios de pago
      </Heading>
      <p className="mt-1 text-sm text-muted-foreground">
        Activá los medios que aceptás y su recargo. Para cobrar online, conectá tu
        cuenta del proveedor en <strong>Conexión</strong>. Mercado Pago se conecta
        en un click.
      </p>
      <Card className="mt-3">
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full min-w-[480px] text-sm">
            <thead className="bg-muted text-left text-xs uppercase tracking-[0.14em] text-muted-foreground">
              <tr>
                <th className="whitespace-nowrap px-4 py-3">Medio</th>
                <th className="whitespace-nowrap px-4 py-3">Tipo</th>
                <th className="whitespace-nowrap px-4 py-3">Conexión</th>
                <th className="whitespace-nowrap px-4 py-3 text-right">Recargo %</th>
                <th className="whitespace-nowrap px-4 py-3 text-right">Activo</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {providers.map((p) => {
                const m = byKey.get(p.key);
                return (
                  <tr key={p.key}>
                    <td className="whitespace-nowrap px-4 py-3 font-medium">{p.name}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                      {KIND_LABELS[p.kind] ?? p.kind}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      {p.kind === "manual" ? (
                        <span className="text-xs text-muted-foreground">No requiere</span>
                      ) : !IMPLEMENTED.has(p.key) ? (
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                          <Clock size={13} /> Próximamente
                        </span>
                      ) : (
                        <button
                          onClick={() => {
                            setConnectKey(p.key);
                            setToken("");
                            setShowManual(false);
                          }}
                          className={
                            m?.config?.connected
                              ? "inline-flex items-center gap-1 text-xs font-medium text-emerald-400 hover:underline"
                              : "inline-flex items-center gap-1 text-xs font-medium text-ninja-flameSoft hover:underline"
                          }
                        >
                          {m?.config?.connected ? (
                            <>
                              <Check size={13} /> Conectado
                            </>
                          ) : (
                            <>
                              <Link2 size={13} /> Conectar
                            </>
                          )}
                        </button>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <input
                        type="number"
                        step="0.5"
                        min="0"
                        defaultValue={m?.surcharge_pct ?? 0}
                        onBlur={(e) =>
                          save.mutate({
                            provider_key: p.key,
                            surcharge_pct: Number(e.target.value) || 0,
                          })
                        }
                        className="h-9 w-20 rounded-md border border-input bg-background px-2 text-right text-sm outline-none focus:border-ninja-flameSoft"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end">
                        <Switch
                          checked={m?.enabled ?? false}
                          disabled={p.kind !== "manual" && !IMPLEMENTED.has(p.key)}
                          onCheckedChange={(v) =>
                            save.mutate({ provider_key: p.key, enabled: v })
                          }
                          label={`Activar ${p.name}`}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Modal
        open={connectKey !== null}
        onOpenChange={(o) => !o && setConnectKey(null)}
        title={connectingProvider ? `Conectar ${connectingProvider.name}` : "Conectar"}
      >
        <div className="space-y-4">
          {connectingConnected ? (
            <p className="flex items-center gap-2 text-sm text-emerald-400">
              <Check size={16} /> Tu cuenta de Mercado Pago está conectada.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Conectá tu cuenta de Mercado Pago para cobrar online. Te lleva a
              Mercado Pago para autorizar; no tenés que copiar nada.
            </p>
          )}

          {/* Opción principal: OAuth en un click. */}
          <Button
            className="w-full"
            disabled={oauthStart.isPending}
            onClick={() => oauthStart.mutate()}
          >
            {oauthStart.isPending
              ? "Redirigiendo…"
              : connectingConnected
                ? "Reconectar con Mercado Pago"
                : "Conectar con Mercado Pago"}
          </Button>

          {/* Opción avanzada: pegar Access Token manualmente. */}
          {showManual ? (
            <div className="space-y-3 rounded-md border border-border p-3">
              <p className="text-xs text-muted-foreground">
                Pegá el <strong>Access Token</strong> de tu cuenta (MP → Tus
                integraciones → Credenciales). Se guarda cifrado del lado del
                servidor; nunca se expone al navegador.
              </p>
              <Input
                label="Access Token"
                type="password"
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={connectingConnected ? "•••••• (ya configurado)" : "APP_USR-..."}
              />
              <Button
                className="w-full"
                variant="secondary"
                disabled={connect.isPending || token.trim().length < 8}
                onClick={() =>
                  connect.mutate({ provider_key: connectKey!, token: token.trim() })
                }
              >
                {connect.isPending ? "Guardando…" : "Guardar Access Token"}
              </Button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setShowManual(true)}
              className="text-xs text-muted-foreground underline hover:text-foreground"
            >
              o pegá tu Access Token manualmente
            </button>
          )}

          <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
            {connectingConnected ? (
              <Button
                variant="ghost"
                className="text-destructive"
                disabled={connect.isPending}
                onClick={() =>
                  connect.mutate({ provider_key: connectKey!, clear: true })
                }
              >
                Desconectar
              </Button>
            ) : (
              <span />
            )}
            <Button variant="secondary" onClick={() => setConnectKey(null)}>
              Cerrar
            </Button>
          </div>
        </div>
      </Modal>
    </section>
  );
}
