"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CreditCard, Link2, Check } from "lucide-react";
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

  if (!ctx || !ctx.canManage) return null;

  const connectingProvider = providers.find((p) => p.key === connectKey);
  const connectingConnected = Boolean(byKey.get(connectKey ?? "")?.config?.connected);

  return (
    <section>
      <Heading as="h2" className="flex items-center gap-2 text-base">
        <CreditCard size={18} /> Medios de pago
      </Heading>
      <p className="mt-1 text-sm text-muted-foreground">
        Activá los medios que aceptás y su recargo. Referencia de tipos:{" "}
        <strong>Lo cobrás vos</strong> (efectivo/transferencia, lo registrás a mano),{" "}
        <strong>Tarjeta / online</strong> (cobra con tarjeta o link, ej. Mercado Pago),{" "}
        <strong>Pago con QR</strong> (el cliente escanea, ej. MODO), y{" "}
        <strong>Varias pasarelas</strong> (un servicio que conecta otras, ej. Mobbex).
        En “Conexión” cargás las credenciales del proveedor (ej. el Access Token de
        Mercado Pago) para cobrar online.
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
                      ) : m?.config?.connected ? (
                        <button
                          onClick={() => {
                            setConnectKey(p.key);
                            setToken("");
                          }}
                          className="inline-flex items-center gap-1 text-xs font-medium text-emerald-400 hover:underline"
                        >
                          <Check size={13} /> Conectado
                        </button>
                      ) : (
                        <button
                          onClick={() => {
                            setConnectKey(p.key);
                            setToken("");
                          }}
                          className="inline-flex items-center gap-1 text-xs font-medium text-ninja-flameSoft hover:underline"
                        >
                          <Link2 size={13} /> Conectar
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
          <p className="text-sm text-muted-foreground">
            Pegá el <strong>Access Token</strong> de tu cuenta de Mercado Pago. Lo
            encontrás en tu panel de MP → Tus integraciones / Credenciales. Se guarda
            cifrado del lado del servidor; nunca se expone al navegador.
          </p>
          <Input
            label="Access Token"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={connectingConnected ? "•••••• (ya configurado)" : "APP_USR-..."}
          />
          <div className="flex items-center justify-between gap-2">
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
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setConnectKey(null)}>
                Cancelar
              </Button>
              <Button
                disabled={connect.isPending || token.trim().length < 8}
                onClick={() =>
                  connect.mutate({ provider_key: connectKey!, token: token.trim() })
                }
              >
                {connect.isPending ? "Guardando…" : "Guardar"}
              </Button>
            </div>
          </div>
        </div>
      </Modal>
    </section>
  );
}
