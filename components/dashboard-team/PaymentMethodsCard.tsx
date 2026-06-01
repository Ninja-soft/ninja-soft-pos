"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CreditCard, Link2, Check, Clock, ChevronDown, Percent } from "lucide-react";
import { PaymentPlansGridModal } from "@/components/dashboard-team/PaymentPlansGridModal";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/ui/Toast";
import { Card } from "@/components/ui/Card";
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
const IMPLEMENTED = new Set(["mercadopago", "mobbex"]);

// Logo (ícono cuadrado) por proveedor. En public/img/medios_de_pago.
const PROVIDER_LOGO: Record<string, string> = {
  cash: "/img/medios_de_pago/Cash_cube.webp",
  transfer: "/img/medios_de_pago/Transferencia_cube.webp",
  mercadopago: "/img/medios_de_pago/mercado_pago_cube.webp",
  mercadopago_point: "/img/medios_de_pago/mercado_pago_cube.webp",
  modo: "/img/medios_de_pago/Modo_cube.webp",
  payway: "/img/medios_de_pago/payway_cube.webp",
  getnet: "/img/medios_de_pago/getnet_cube.webp",
  fiserv: "/img/medios_de_pago/Fiserv_cube.webp",
  mobbex: "/img/medios_de_pago/Mobbex_cube.webp",
  pagos360: "/img/medios_de_pago/Pagos360_cube.webp",
  nave: "/img/medios_de_pago/nave_cube.webp",
};

// Resumen corto bajo el nombre (qué tipo de medio es).
const PROVIDER_CHIP: Record<string, string> = {
  manual: "Lo cobrás vos · sin conexión",
  gateway: "Cobro online · tarjeta",
  qr: "Cobro online · QR",
  orchestrator: "Conecta varias pasarelas",
};

// Explicación desplegable por medio: qué pasa al activar, conexión y proceso.
type Explain = {
  activa: string;
  conexion?: string;
  pasos?: string[];
  recargo?: string;
};
const PROVIDER_INFO: Record<string, Explain> = {
  cash: {
    activa:
      "Aparece como forma de pago en el POS. El monto cobrado entra al arqueo de caja.",
    pasos: [
      "En el POS tocás Cobrar y elegís Efectivo.",
      "Recibís la plata en mano y das el vuelto.",
      "La venta queda registrada y suma al cierre de caja (Z).",
    ],
    recargo:
      "Si ponés un %, se suma al total al pagar con este medio. Efectivo suele quedar en 0.",
  },
  transfer: {
    activa:
      "Aparece como forma de pago en el POS para cobrar por transferencia a tu cuenta.",
    pasos: [
      "El cliente transfiere a tu CBU/alias.",
      "Verificás que la plata haya llegado.",
      "Registrás la venta (la confirmación es manual, no se valida sola).",
    ],
    recargo: "Si ponés un %, se suma al total al pagar por transferencia.",
  },
  mercadopago: {
    activa:
      "Habilita el botón Cobrar con QR en el POS. La plata entra a tu cuenta de Mercado Pago.",
    conexion:
      "Conectá tu cuenta en un click (Conectar con Mercado Pago) o pegando tu Access Token. Sin conectar, el QR no funciona.",
    pasos: [
      "En el POS tocás Cobrar con QR.",
      "El cliente escanea el QR con su app de Mercado Pago y paga.",
      "Al acreditarse, la venta se cierra sola y queda registrada.",
    ],
    recargo: "Si ponés un %, se suma al total al cobrar con Mercado Pago.",
  },
  mobbex: {
    activa:
      "Habilita el botón Cobrar con QR (Mobbex) en el POS. La plata entra a tu cuenta de Mobbex.",
    conexion:
      "Pegá tu API Key y Access Token (Mobbex → Desarrollo → Credenciales). Se guardan cifrados del lado del servidor.",
    pasos: [
      "En el POS tocás Cobrar con QR · Mobbex.",
      "El cliente escanea el QR y paga (tarjeta o saldo).",
      "Al acreditarse, la venta se cierra sola y queda registrada.",
    ],
    recargo: "Definí los recargos por marca/cuota en Planes (botón del medio).",
  },
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
  const [mbApiKey, setMbApiKey] = useState("");
  const [mbToken, setMbToken] = useState("");
  const [showManual, setShowManual] = useState(false);
  const [plansProvider, setPlansProvider] = useState<{ key: string; name: string } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggleExpand = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
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
      secrets?: Record<string, string>;
      clear?: boolean;
    }) => {
      const body = vars.clear
        ? { provider_key: vars.provider_key, action: "clear" }
        : {
            provider_key: vars.provider_key,
            secrets: vars.secrets ?? { access_token: vars.token },
          };
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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Heading as="h2" className="flex items-center gap-2 text-base">
          <CreditCard size={18} /> Medios de pago
        </Heading>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Activá los medios que aceptás y su recargo. Tocá la flecha{" "}
        <ChevronDown size={13} className="inline align-middle" /> de cada medio para
        ver qué hace al activarlo y cómo es el proceso.
      </p>
      <div className="mt-3 flex flex-col gap-2.5">
        {providers.map((p) => {
          const m = byKey.get(p.key);
          const connected = Boolean(m?.config?.connected);
          const soon = p.kind !== "manual" && !IMPLEMENTED.has(p.key);
          const isOpen = expanded.has(p.key);
          const info = PROVIDER_INFO[p.key];
          // Medios con grid de planes: el recargo se configura ahí, no en la fila.
          // Todo medio implementado y no manual (gateway/qr/orquestador).
          const hasPlans = IMPLEMENTED.has(p.key) && p.kind !== "manual";
          return (
            <Card
              key={p.key}
              className={
                connected ? "overflow-hidden border-emerald-500/30" : "overflow-hidden"
              }
            >
              <div className="flex items-center gap-3 p-3.5 sm:gap-4 sm:p-4">
                {/* Logo */}
                <span className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden">
                  {PROVIDER_LOGO[p.key] ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={PROVIDER_LOGO[p.key]}
                      alt={p.name}
                      className="h-full w-full object-contain"
                    />
                  ) : (
                    <CreditCard size={18} className="text-muted-foreground" />
                  )}
                </span>

                {/* Nombre + chip de tipo */}
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold">{p.name}</div>
                  <div className="mt-1 inline-flex items-center rounded-ninjaFull border border-ninja-brightViolet/30 bg-ninja-brightViolet/10 px-2 py-0.5 text-[11px] text-muted-foreground">
                    {PROVIDER_CHIP[p.kind] ?? KIND_LABELS[p.kind] ?? p.kind}
                  </div>
                </div>

                {/* Estado de conexión */}
                <div className="hidden shrink-0 sm:block">
                  {p.kind === "manual" ? (
                    <span className="text-xs text-muted-foreground">No requiere</span>
                  ) : soon ? (
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock size={13} /> Próximamente
                    </span>
                  ) : (
                    <button
                      onClick={() => {
                        setConnectKey(p.key);
                        setToken("");
                        setMbApiKey("");
                        setMbToken("");
                        setShowManual(false);
                      }}
                      className={
                        connected
                          ? "inline-flex items-center gap-1 text-xs font-semibold text-emerald-400 hover:underline"
                          : "inline-flex items-center gap-1 text-xs font-semibold text-ninja-flameSoft hover:underline"
                      }
                    >
                      {connected ? (
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
                </div>

                {/* Planes por marca (solo tarjeta/QR conectado) */}
                {hasPlans && (
                  <button
                    onClick={() => setPlansProvider({ key: p.key, name: p.name })}
                    title="Planes por tarjeta y cuotas"
                    className="inline-flex shrink-0 items-center gap-1 rounded-md border border-ninja-flameSoft/40 bg-ninja-flame/10 px-2.5 py-1.5 text-xs font-semibold text-ninja-flameSoft transition hover:bg-ninja-flame/20"
                  >
                    <Percent size={13} /> Planes
                  </button>
                )}

                {/* Recargo (oculto en medios con planes: se configura en el grid) */}
                <div
                  className={
                    hasPlans
                      ? "hidden"
                      : "hidden shrink-0 flex-col items-end gap-0.5 md:flex"
                  }
                >
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    Recargo %
                  </span>
                  <input
                    type="number"
                    step="0.5"
                    min="0"
                    defaultValue={m?.surcharge_pct ?? 0}
                    disabled={soon}
                    onBlur={(e) =>
                      save.mutate({
                        provider_key: p.key,
                        surcharge_pct: Number(e.target.value) || 0,
                      })
                    }
                    className="h-9 w-[68px] rounded-md border border-input bg-background px-2 text-right text-sm outline-none focus:border-ninja-flameSoft disabled:opacity-40"
                  />
                </div>

                {/* Switch activar */}
                <Switch
                  checked={m?.enabled ?? false}
                  disabled={soon}
                  onCheckedChange={(v) => save.mutate({ provider_key: p.key, enabled: v })}
                  label={`Activar ${p.name}`}
                />

                {/* Desplegar explicación */}
                <button
                  type="button"
                  onClick={() => toggleExpand(p.key)}
                  aria-label={isOpen ? "Ocultar detalle" : "Ver detalle"}
                  aria-expanded={isOpen}
                  className="shrink-0 rounded-md p-1 text-muted-foreground transition hover:text-foreground"
                >
                  <ChevronDown
                    size={18}
                    className={isOpen ? "rotate-180 transition" : "transition"}
                  />
                </button>
              </div>

              {/* Detalle desplegable */}
              {isOpen && (
                <div className="space-y-3 border-t border-dashed border-border bg-muted/30 px-4 py-4 text-sm">
                  {/* En mobile, conexión + recargo viven acá (se ocultan en la fila). */}
                  <div className="flex flex-wrap items-center gap-3 sm:hidden">
                    {p.kind === "manual" ? (
                      <span className="text-xs text-muted-foreground">Sin conexión</span>
                    ) : soon ? (
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <Clock size={13} /> Próximamente
                      </span>
                    ) : (
                      <button
                        onClick={() => {
                          setConnectKey(p.key);
                          setToken("");
                          setMbApiKey("");
                          setMbToken("");
                          setShowManual(false);
                        }}
                        className={
                          connected
                            ? "inline-flex items-center gap-1 text-xs font-semibold text-emerald-400"
                            : "inline-flex items-center gap-1 text-xs font-semibold text-ninja-flameSoft"
                        }
                      >
                        {connected ? (
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
                    {hasPlans && (
                      <button
                        onClick={() => setPlansProvider({ key: p.key, name: p.name })}
                        className="inline-flex items-center gap-1 text-xs font-semibold text-ninja-flameSoft"
                      >
                        <Percent size={13} /> Planes por tarjeta
                      </button>
                    )}
                  </div>

                  {info ? (
                    <>
                      <div>
                        <div className="mb-1 text-[10.5px] font-bold uppercase tracking-[0.12em] text-ninja-flameSoft">
                          Qué pasa al activar
                        </div>
                        <p className="text-muted-foreground">{info.activa}</p>
                      </div>
                      {info.conexion && (
                        <div>
                          <div className="mb-1 text-[10.5px] font-bold uppercase tracking-[0.12em] text-ninja-flameSoft">
                            Conexión
                          </div>
                          <p className="text-muted-foreground">{info.conexion}</p>
                        </div>
                      )}
                      {info.pasos && (
                        <div>
                          <div className="mb-1.5 text-[10.5px] font-bold uppercase tracking-[0.12em] text-ninja-flameSoft">
                            Cómo es el proceso
                          </div>
                          <ol className="space-y-1.5">
                            {info.pasos.map((step, i) => (
                              <li key={i} className="flex gap-2.5 text-muted-foreground">
                                <span className="mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border border-ninja-flameSoft/50 bg-ninja-flame/15 text-[10px] font-bold text-ninja-flameSoft">
                                  {i + 1}
                                </span>
                                <span>{step}</span>
                              </li>
                            ))}
                          </ol>
                        </div>
                      )}
                      {info.recargo && !hasPlans && (
                        <div>
                          <div className="mb-1 text-[10.5px] font-bold uppercase tracking-[0.12em] text-ninja-flameSoft">
                            Recargo
                          </div>
                          <p className="text-muted-foreground">{info.recargo}</p>
                        </div>
                      )}
                    </>
                  ) : (
                    <p className="text-muted-foreground">
                      Integración en camino. Pronto vas a poder conectar tu cuenta y
                      cobrar con {p.name} desde el POS.
                    </p>
                  )}
                </div>
              )}
            </Card>
          );
        })}
      </div>

      <Modal
        open={connectKey !== null}
        onOpenChange={(o) => !o && setConnectKey(null)}
        title={connectingProvider ? `Conectar ${connectingProvider.name}` : "Conectar"}
      >
        <form
          className="space-y-4"
          autoComplete="off"
          onSubmit={(e) => e.preventDefault()}
        >
          {/* Señuelos anti-autocompletado del navegador. */}
          <input type="text" name="username" autoComplete="username" className="hidden" />
          <input type="password" name="password" autoComplete="new-password" className="hidden" />
          {connectKey && PROVIDER_LOGO[connectKey] && (
            <div className="flex items-center justify-center py-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={PROVIDER_LOGO[connectKey]}
                alt={connectingProvider?.name ?? ""}
                className="h-14 w-auto object-contain"
              />
            </div>
          )}
          {connectKey === "mobbex" ? (
            <>
              {connectingConnected ? (
                <p className="flex items-center gap-2 text-sm text-emerald-400">
                  <Check size={16} /> Mobbex está conectado.
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Pegá tus credenciales de Mobbex (Mobbex → Desarrollo →
                  Credenciales). Se guardan cifradas del lado del servidor.
                </p>
              )}
              <Input
                label="API Key"
                name="mobbex_api_key"
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                value={mbApiKey}
                onChange={(e) => setMbApiKey(e.target.value)}
                placeholder={connectingConnected ? "•••••• (configurado)" : "Tu API Key"}
              />
              <Input
                label="Access Token"
                type="password"
                name="mobbex_access_token"
                autoComplete="new-password"
                data-1p-ignore
                data-lpignore="true"
                value={mbToken}
                onChange={(e) => setMbToken(e.target.value)}
                placeholder={connectingConnected ? "•••••• (configurado)" : "Tu Access Token"}
              />
              <Button
                className="w-full"
                disabled={
                  connect.isPending || mbApiKey.trim().length < 6 || mbToken.trim().length < 6
                }
                onClick={() =>
                  connect.mutate({
                    provider_key: "mobbex",
                    secrets: { api_key: mbApiKey.trim(), access_token: mbToken.trim() },
                  })
                }
              >
                {connect.isPending
                  ? "Guardando…"
                  : connectingConnected
                    ? "Actualizar credenciales"
                    : "Conectar Mobbex"}
              </Button>
            </>
          ) : (
            <>
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
                    name="mp_access_token"
                    autoComplete="new-password"
                    data-1p-ignore
                    data-lpignore="true"
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
            </>
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
        </form>
      </Modal>

      {plansProvider && (
        <PaymentPlansGridModal
          open={plansProvider !== null}
          onOpenChange={(o) => !o && setPlansProvider(null)}
          providerKey={plansProvider.key}
          providerName={plansProvider.name}
        />
      )}
    </section>
  );
}
