"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CreditCard,
  Sparkles,
  Check,
  Calendar,
  Receipt,
  ArrowUpRight,
  XCircle,
  AlertTriangle,
  Star,
  Zap,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import {
  fetchOwnerBillingSummary,
  startOwnerSubscriptionCheckout,
  syncSubscriptionAmount,
  fetchSubscriptionPaymentMethod,
  type OwnerBillingSummary,
} from "@/modules/saas/subscriptionBilling";
import { useToast } from "@/components/ui/Toast";
import { Card, CardContent } from "@/components/ui/Card";
import { Heading } from "@/components/ui/Typography";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input } from "@/components/ui/Input";

// Tipos del RPC my_subscription() (no están en los tipos generados → cast).
type Addon = {
  addon_key: string;
  label: string | null;
  status: string;
  cancel_at_period_end: boolean;
  current_period_end: string | null;
  monthly_price_ars: number | null;
};
type MySub = {
  plan: {
    key: string;
    name: string;
    secondary_name: string | null;
    image_url: string | null;
    icon: string | null;
    monthly_price_ars: number;
    is_custom: boolean;
  };
  status: string;
  billing_cycle: string;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  is_lifetime: boolean;
  closure_requested_at: string | null;
  next_charge: string | null;
  addons: Addon[];
  last_payment: {
    amount: number;
    medium: string;
    period_end: string | null;
    created_at: string;
  } | null;
};
type PublicPlan = {
  key: string;
  name: string;
  secondary_name: string | null;
  description: string | null;
  image_url: string | null;
  icon: string | null;
  monthly_price_ars: number;
  trial_days: number;
  is_recommended: boolean;
  sort: number;
};
type AiCfg = {
  image_url: string;
  commercial_text: string;
  addon_price_ars: string;
};

const STATUS_LABELS: Record<string, string> = {
  trial: "Prueba",
  active: "Activa",
  past_due: "Pago pendiente",
  suspended: "Suspendida",
  cancelled: "Cancelada",
};
const STATUS_TONE: Record<string, string> = {
  trial: "border-ninja-brightViolet/40 bg-ninja-brightViolet/10 text-ninja-brightViolet",
  active: "border-emerald-500/40 bg-emerald-500/10 text-emerald-400",
  past_due: "border-amber-500/40 bg-amber-500/10 text-amber-400",
  suspended: "border-red-500/40 bg-red-500/10 text-red-400",
  cancelled: "border-red-500/40 bg-red-500/10 text-red-400",
};
const AI_ADDON_KEYS = ["ai_assistant", "asistente_ia"];

// Estado del preapproval de Mercado Pago (medio de pago de la suscripción).
const MP_STATUS_LABELS: Record<string, string> = {
  authorized: "Autorizado",
  pending: "Pendiente de autorizar",
  paused: "Pausado",
  cancelled: "Cancelado",
};
// Marca legible del medio (MP no expone los últimos 4 dígitos en el preapproval).
const MP_PM_LABELS: Record<string, string> = {
  visa: "Visa",
  master: "Mastercard",
  amex: "American Express",
  naranja: "Naranja",
  cabal: "Cabal",
  account_money: "Dinero en cuenta",
};

function fmtMoney(n: number | null | undefined): string {
  return `$${Number(n ?? 0).toLocaleString("es-AR")}`;
}
function fmtDate(s: string | null | undefined): string {
  return s ? new Date(s).toLocaleDateString("es-AR") : "—";
}
// rpc tipado laxo: los RPC nuevos no están en los tipos generados.
function rpc(supabase: ReturnType<typeof createClient>) {
  return supabase.rpc as unknown as (
    fn: string,
    args?: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message?: string } | null }>;
}

export function SubscriptionCard() {
  const supabase = createClient();
  const qc = useQueryClient();
  const { toast } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();

  // Vuelta desde el checkout de Mercado Pago (?sub=ok). El estado real lo
  // confirma el webhook mp_billing_webhook; acá sólo damos feedback y refrescamos.
  useEffect(() => {
    if (searchParams.get("sub") !== "ok") return;
    toast({
      title: "Listo, configuramos tu pago",
      description:
        "Mercado Pago está procesando tu suscripción. En unos minutos vas a ver el estado actualizado.",
      variant: "success",
    });
    qc.invalidateQueries({ queryKey: ["my-subscription"] });
    qc.invalidateQueries({ queryKey: ["owner-billing-summary"] });
    qc.invalidateQueries({ queryKey: ["subscription-payment-method"] });
    router.replace("/dashboard-team");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const [planPickerOpen, setPlanPickerOpen] = useState(false);
  const [confirmPlan, setConfirmPlan] = useState<PublicPlan | null>(null);
  const [cancelSubOpen, setCancelSubOpen] = useState(false);
  const [cancelAddonKey, setCancelAddonKey] = useState<string | null>(null);
  const [closeAccountOpen, setCloseAccountOpen] = useState(false);
  const [closeReason, setCloseReason] = useState("");
  const [closeConfirmText, setCloseConfirmText] = useState("");

  const { data: sub, isLoading } = useQuery({
    queryKey: ["my-subscription"],
    queryFn: async (): Promise<MySub | null> => {
      const { data, error } = await rpc(supabase)("my_subscription");
      if (error) throw new Error(error.message ?? "error");
      return (data as MySub | null) ?? null;
    },
  });

  const { data: plans = [] } = useQuery({
    queryKey: ["public-plans"],
    queryFn: async (): Promise<PublicPlan[]> => {
      const { data, error } = await rpc(supabase)("public_plans");
      if (error) throw new Error(error.message ?? "error");
      return (data as PublicPlan[]) ?? [];
    },
  });

  const { data: aiCfg } = useQuery({
    queryKey: ["ai-public-config"],
    queryFn: async (): Promise<AiCfg | null> => {
      const { data, error } = await rpc(supabase)("ai_public_config");
      if (error) return null;
      const c = (data ?? {}) as Partial<AiCfg>;
      return {
        image_url: String(c.image_url ?? ""),
        commercial_text: String(c.commercial_text ?? ""),
        addon_price_ars: String(c.addon_price_ars ?? ""),
      };
    },
  });

  // Estado de cobro de la suscripción (preapproval + total calculado plan+addons).
  const { data: billing } = useQuery({
    queryKey: ["owner-billing-summary"],
    queryFn: async (): Promise<OwnerBillingSummary | null> =>
      fetchOwnerBillingSummary(),
  });
  const hasPreapproval = billing?.has_preapproval === true;

  // Estado del medio de pago (consulta a MP vía edge). Sólo se pide si ya hay un
  // preapproval; así un tenant en trial sin pago no dispara una llamada inútil.
  const { data: payMethod } = useQuery({
    queryKey: ["subscription-payment-method"],
    enabled: hasPreapproval,
    staleTime: 5 * 60_000,
    queryFn: async () => fetchSubscriptionPaymentMethod(),
  });

  function invalidate() {
    qc.invalidateQueries({ queryKey: ["my-subscription"] });
    qc.invalidateQueries({ queryKey: ["ai-available"] });
    qc.invalidateQueries({ queryKey: ["owner-billing-summary"] });
  }

  // Tras activar/cancelar un addon, el monto del preapproval debe reflejar el
  // nuevo total (plan + addons). Best-effort: el addon ya quedó bien en la base;
  // si MP falla, no rompemos el flujo (el panel/edge re-sincroniza después).
  async function syncAmountSilently() {
    try {
      await syncSubscriptionAmount();
    } catch {
      /* el addon ya está aplicado; la sync se reintenta luego. */
    }
  }

  // Inicia el checkout del preapproval del dueño (pagar/activar/reactivar) y
  // redirige a Mercado Pago. back_url vuelve al panel con ?sub=ok.
  const startCheckout = useMutation({
    mutationFn: async () => {
      const backUrl = `${window.location.origin}/dashboard-team?sub=ok`;
      return startOwnerSubscriptionCheckout(backUrl);
    },
    onSuccess: (initPoint) => {
      window.location.href = initPoint;
    },
    onError: () =>
      toast({ title: "No se pudo iniciar el pago", variant: "error" }),
  });

  // Abre el flujo de Mercado Pago para cambiar/actualizar la tarjeta del
  // preapproval. Pide la URL al edge (mp_subscription_manage) y redirige.
  const updatePaymentMethod = useMutation({
    mutationFn: async () => {
      const pm = await fetchSubscriptionPaymentMethod();
      if (!pm.has_preapproval || !pm.manage_url) {
        throw new Error("no_preapproval");
      }
      return pm.manage_url;
    },
    onSuccess: (manageUrl) => {
      window.location.href = manageUrl;
    },
    onError: (e: Error) =>
      toast({
        title:
          e.message === "no_preapproval"
            ? "Todavía no tenés un pago activo para gestionar"
            : "No se pudo abrir el medio de pago",
        variant: "error",
      }),
  });

  const changePlan = useMutation({
    mutationFn: async (planKey: string) => {
      const { error } = await rpc(supabase)("request_plan_change", {
        p_plan_key: planKey,
      });
      if (error) throw new Error(error.message ?? "error");
    },
    onSuccess: async () => {
      toast({ title: "Plan actualizado", variant: "success" });
      setConfirmPlan(null);
      setPlanPickerOpen(false);
      // El monto del preapproval debe reflejar el nuevo plan (+ addons).
      await syncAmountSilently();
      invalidate();
    },
    onError: () => toast({ title: "No se pudo cambiar el plan", variant: "error" }),
  });

  const activateAddon = useMutation({
    mutationFn: async (addonKey: string) => {
      const { error } = await rpc(supabase)("activate_addon", {
        p_addon_key: addonKey,
      });
      if (error) throw new Error(error.message ?? "error");
    },
    onSuccess: async () => {
      toast({ title: "Complemento activado", variant: "success" });
      await syncAmountSilently();
      invalidate();
    },
    onError: () =>
      toast({ title: "No se pudo activar el complemento", variant: "error" }),
  });

  const cancelAddon = useMutation({
    mutationFn: async (addonKey: string) => {
      const { error } = await rpc(supabase)("cancel_addon", {
        p_addon_key: addonKey,
      });
      if (error) throw new Error(error.message ?? "error");
    },
    onSuccess: async () => {
      toast({ title: "Complemento dado de baja", variant: "success" });
      setCancelAddonKey(null);
      await syncAmountSilently();
      invalidate();
    },
    onError: () => toast({ title: "No se pudo dar de baja", variant: "error" }),
  });

  const setCancelSub = useMutation({
    mutationFn: async (cancel: boolean) => {
      const { error } = await rpc(supabase)("set_cancel_at_period_end", {
        p_cancel: cancel,
      });
      if (error) throw new Error(error.message ?? "error");
    },
    onSuccess: (_d, cancel) => {
      toast({
        title: cancel ? "Suscripción programada para baja" : "Baja cancelada",
        variant: "success",
      });
      setCancelSubOpen(false);
      invalidate();
    },
    onError: () => toast({ title: "No se pudo actualizar", variant: "error" }),
  });

  const closeAccount = useMutation({
    mutationFn: async (reason: string) => {
      const { error } = await rpc(supabase)("request_account_closure", {
        p_reason: reason,
      });
      if (error) throw new Error(error.message ?? "error");
    },
    onSuccess: () => {
      toast({ title: "Solicitud de baja registrada", variant: "success" });
      setCloseAccountOpen(false);
      setCloseReason("");
      setCloseConfirmText("");
      invalidate();
    },
    onError: () =>
      toast({ title: "No se pudo registrar la baja", variant: "error" }),
  });

  if (isLoading) {
    return (
      <section className="mt-10">
        <Heading as="h2" className="flex items-center gap-2 text-base">
          <CreditCard size={18} /> Suscripción
        </Heading>
        <Card className="mt-3">
          <CardContent className="p-6 text-muted-foreground">Cargando…</CardContent>
        </Card>
      </section>
    );
  }

  if (!sub) {
    return (
      <section className="mt-10">
        <Heading as="h2" className="flex items-center gap-2 text-base">
          <CreditCard size={18} /> Suscripción
        </Heading>
        <Card className="mt-3">
          <CardContent className="p-6 text-muted-foreground">
            No encontramos tu suscripción. Si creés que es un error, escribinos.
          </CardContent>
        </Card>
      </section>
    );
  }

  const closureRequested = Boolean(sub.closure_requested_at);
  const aiAddon = sub.addons.find((a) => AI_ADDON_KEYS.includes(a.addon_key));
  const aiActive =
    aiAddon &&
    (aiAddon.status === "active" || aiAddon.cancel_at_period_end);
  const aiPrice = (aiCfg?.addon_price_ars ?? "").trim();

  return (
    <section className="mt-10">
      <Heading as="h2" className="flex items-center gap-2 text-base">
        <CreditCard size={18} /> Suscripción
      </Heading>
      <p className="mt-1 text-sm text-muted-foreground">
        Gestioná tu plan, tus complementos y tu método de pago.
      </p>

      {/* ── Plan actual + estado ── */}
      <Card className="mt-3">
        <CardContent className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-lg font-bold">{sub.plan.name}</span>
                <span
                  className={`inline-flex items-center rounded-ninjaFull border px-2 py-0.5 text-[11px] font-semibold ${
                    STATUS_TONE[sub.status] ??
                    "border-border bg-muted/30 text-muted-foreground"
                  }`}
                >
                  {STATUS_LABELS[sub.status] ?? sub.status}
                </span>
                {sub.is_lifetime && (
                  <span className="inline-flex items-center gap-1 rounded-ninjaFull border border-ninja-flameSoft/40 bg-ninja-flame/10 px-2 py-0.5 text-[11px] font-semibold text-ninja-flameSoft">
                    <Star size={11} /> Vitalicio
                  </span>
                )}
              </div>
              {sub.plan.secondary_name && (
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {sub.plan.secondary_name}
                </p>
              )}
              <p className="mt-1 text-sm text-muted-foreground">
                {fmtMoney(sub.plan.monthly_price_ars)}{" "}
                <span className="text-xs">/ mes</span>
              </p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPlanPickerOpen(true)}
            >
              <ArrowUpRight size={15} /> Cambiar plan
            </Button>
          </div>

          {/* Próximo cobro + último pago */}
          <div className="mt-4 grid gap-3 border-t border-border pt-4 sm:grid-cols-2">
            <div className="flex items-start gap-2.5">
              <Calendar size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
              <div>
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Próximo cobro
                </div>
                <div className="text-sm font-medium">
                  {sub.is_lifetime
                    ? "Sin cobros (vitalicio)"
                    : sub.cancel_at_period_end
                      ? `Se cancela el ${fmtDate(sub.current_period_end)}`
                      : fmtDate(sub.next_charge)}
                </div>
              </div>
            </div>
            <div className="flex items-start gap-2.5">
              <Receipt size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
              <div>
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Último pago
                </div>
                <div className="text-sm font-medium">
                  {sub.last_payment
                    ? `${fmtMoney(sub.last_payment.amount)} · ${fmtDate(
                        sub.last_payment.created_at,
                      )}`
                    : "Sin pagos registrados"}
                </div>
              </div>
            </div>
          </div>

          {sub.cancel_at_period_end && !closureRequested && (
            <div className="mt-4 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-300">
              <AlertTriangle size={14} className="shrink-0" />
              Tu suscripción se cancela el {fmtDate(sub.current_period_end)}. Vas a
              mantener el acceso hasta esa fecha.
            </div>
          )}

          {/* Total facturado (plan + addons). Sólo si hay addons que suman al
              cobro, para que el dueño entienda por qué paga más que el plan. */}
          {!sub.is_lifetime &&
            billing?.billing &&
            billing.billing.addons_amount > 0 && (
              <div className="mt-4 flex items-start gap-2.5 border-t border-border pt-4">
                <Receipt size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
                <div className="text-sm">
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Total que se cobra
                  </div>
                  <p className="text-muted-foreground">
                    {fmtMoney(billing.billing.plan_amount)} (plan) +{" "}
                    {fmtMoney(billing.billing.addons_amount)} (complementos) ={" "}
                    <span className="font-semibold text-foreground">
                      {fmtMoney(billing.billing.total)}
                    </span>
                  </p>
                </div>
              </div>
            )}

          {/* Método de pago de la suscripción (preapproval de Mercado Pago que
              gestiona NinjaSoft). El dueño puede pagar/activar, reactivar y
              cambiar su tarjeta. */}
          {!sub.is_lifetime && (
            <div className="mt-4 flex items-start gap-2.5 border-t border-border pt-4">
              <CreditCard size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1 text-sm">
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Método de pago
                </div>

                {hasPreapproval ? (
                  <>
                    <p className="text-muted-foreground">
                      Cobro automático por Mercado Pago
                      {payMethod?.payment_method_id
                        ? ` · ${
                            MP_PM_LABELS[payMethod.payment_method_id] ??
                            payMethod.payment_method_id
                          }`
                        : ""}
                      {payMethod?.status
                        ? ` · ${
                            MP_STATUS_LABELS[payMethod.status] ?? payMethod.status
                          }`
                        : ""}
                      .
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        loading={updatePaymentMethod.isPending}
                        onClick={() => updatePaymentMethod.mutate()}
                      >
                        <CreditCard size={15} /> Actualizar medio de pago
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="text-muted-foreground">
                      {sub.status === "trial"
                        ? "Estás en período de prueba. Activá tu plan para que el cobro mensual se haga solo por Mercado Pago."
                        : "Tu suscripción no tiene un pago activo. Activala para no perder acceso."}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        loading={startCheckout.isPending}
                        onClick={() => startCheckout.mutate()}
                      >
                        <Zap size={15} />{" "}
                        {sub.status === "cancelled" || sub.status === "past_due"
                          ? "Reactivar y pagar"
                          : "Pagar y activar"}
                      </Button>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Complementos (addon IA) ── */}
      <Card className="mt-3">
        <CardContent className="p-5">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Sparkles size={16} className="text-ninja-flameSoft" /> Complementos
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3.5">
            <div className="flex min-w-0 items-center gap-3">
              {aiCfg?.image_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={aiCfg.image_url}
                  alt="Asistente IA"
                  className="h-10 w-10 shrink-0 rounded-full border border-border object-cover"
                />
              ) : (
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-ninja-gradient text-ninja-voidViolet">
                  <Sparkles size={18} />
                </span>
              )}
              <div className="min-w-0">
                <div className="font-medium">Asistente IA</div>
                <div className="text-xs text-muted-foreground">
                  {aiActive ? (
                    aiAddon?.cancel_at_period_end ? (
                      <span className="text-amber-400">
                        Se da de baja el {fmtDate(aiAddon?.current_period_end)}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-emerald-400">
                        <Check size={12} /> Activo
                      </span>
                    )
                  ) : aiPrice ? (
                    `${fmtMoney(Number(aiPrice))} / mes`
                  ) : (
                    "Complemento opcional"
                  )}
                </div>
              </div>
            </div>
            {aiActive ? (
              aiAddon?.cancel_at_period_end ? (
                <Button
                  variant="secondary"
                  size="sm"
                  loading={activateAddon.isPending}
                  onClick={() => activateAddon.mutate("ai_assistant")}
                >
                  Reactivar
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  onClick={() => setCancelAddonKey(aiAddon!.addon_key)}
                >
                  Dar de baja
                </Button>
              )
            ) : (
              <Button
                size="sm"
                loading={activateAddon.isPending}
                onClick={() => activateAddon.mutate("ai_assistant")}
              >
                <Sparkles size={15} /> Activar
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ── Acciones de baja ── */}
      <Card className="mt-3 border-border/60">
        <CardContent className="space-y-3 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium">Cancelar suscripción</div>
              <p className="text-xs text-muted-foreground">
                Seguís con acceso hasta el fin del período. No se borra nada.
              </p>
            </div>
            {sub.cancel_at_period_end ? (
              <Button
                variant="secondary"
                size="sm"
                loading={setCancelSub.isPending}
                onClick={() => setCancelSub.mutate(false)}
              >
                No cancelar
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive"
                disabled={sub.is_lifetime}
                onClick={() => setCancelSubOpen(true)}
              >
                <XCircle size={15} /> Cancelar suscripción
              </Button>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
            <div className="min-w-0">
              <div className="text-sm font-medium text-destructive">
                Dar de baja mi cuenta
              </div>
              <p className="text-xs text-muted-foreground">
                {closureRequested
                  ? `Solicitada el ${fmtDate(sub.closure_requested_at)}. Mantenés acceso hasta el fin del período.`
                  : "Cierre definitivo de la cuenta (doble confirmación)."}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive"
              disabled={closureRequested}
              onClick={() => setCloseAccountOpen(true)}
            >
              {closureRequested ? "Baja solicitada" : "Dar de baja mi cuenta"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── Modal: selector de plan ── */}
      <Modal
        open={planPickerOpen}
        onOpenChange={setPlanPickerOpen}
        title="Elegí tu plan"
        className="max-w-3xl"
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {plans.map((p) => {
            const current = p.key === sub.plan.key;
            return (
              <div
                key={p.key}
                className={`relative flex flex-col rounded-xl border p-4 transition ${
                  p.is_recommended
                    ? "border-ninja-flameSoft/60 bg-ninja-flame/5 shadow-ninjaGlow"
                    : "border-border bg-card"
                }`}
              >
                {p.is_recommended && (
                  <span className="absolute -top-2.5 left-4 inline-flex items-center gap-1 rounded-ninjaFull bg-ninja-gradient px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-ninja-voidViolet">
                    <Star size={10} /> Recomendado
                  </span>
                )}
                <div className="font-bold">{p.name}</div>
                {p.secondary_name && (
                  <div className="text-xs text-muted-foreground">
                    {p.secondary_name}
                  </div>
                )}
                <div className="mt-2 text-lg font-bold">
                  {fmtMoney(p.monthly_price_ars)}
                  <span className="text-xs font-normal text-muted-foreground">
                    {" "}
                    / mes
                  </span>
                </div>
                {p.description && (
                  <p className="mt-2 line-clamp-3 text-xs text-muted-foreground">
                    {p.description}
                  </p>
                )}
                <div className="mt-4 flex-1" />
                {current ? (
                  <span className="inline-flex items-center justify-center gap-1 rounded-lg border border-emerald-500/40 bg-emerald-500/10 py-2 text-xs font-semibold text-emerald-400">
                    <Check size={14} /> Tu plan actual
                  </span>
                ) : (
                  <Button
                    size="sm"
                    variant={p.is_recommended ? "primary" : "secondary"}
                    onClick={() => setConfirmPlan(p)}
                  >
                    Elegir {p.name}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
        {sub.plan.is_custom && (
          <p className="mt-4 text-xs text-muted-foreground">
            Tu plan actual es a medida. Si cambiás a un plan estándar, perdés las
            condiciones personalizadas.
          </p>
        )}
      </Modal>

      {/* Confirmar cambio de plan */}
      <ConfirmDialog
        open={confirmPlan !== null}
        onOpenChange={(o) => !o && setConfirmPlan(null)}
        title={`Cambiar a ${confirmPlan?.name ?? ""}`}
        description={`Tu plan pasará a ${confirmPlan?.name ?? ""} (${fmtMoney(
          confirmPlan?.monthly_price_ars,
        )} / mes). El nuevo precio se aplica desde tu próximo ciclo de facturación.`}
        confirmLabel="Confirmar cambio"
        loading={changePlan.isPending}
        onConfirm={() => confirmPlan && changePlan.mutate(confirmPlan.key)}
      />

      {/* Confirmar baja de addon */}
      <ConfirmDialog
        open={cancelAddonKey !== null}
        onOpenChange={(o) => !o && setCancelAddonKey(null)}
        title="Dar de baja el Asistente IA"
        description="Vas a poder seguir usándolo hasta el fin de tu período actual. Después de esa fecha deja de facturarse y se desactiva."
        confirmLabel="Dar de baja"
        danger
        loading={cancelAddon.isPending}
        onConfirm={() => cancelAddonKey && cancelAddon.mutate(cancelAddonKey)}
      />

      {/* Confirmar cancelar suscripción */}
      <ConfirmDialog
        open={cancelSubOpen}
        onOpenChange={setCancelSubOpen}
        title="Cancelar suscripción"
        description={`Tu suscripción seguirá activa hasta el ${fmtDate(
          sub.current_period_end,
        )}. Después de esa fecha no se renueva. No se borra ninguna información.`}
        confirmLabel="Sí, cancelar"
        danger
        loading={setCancelSub.isPending}
        onConfirm={() => setCancelSub.mutate(true)}
      />

      {/* Dar de baja la cuenta — doble confirmación (motivo + escribir BAJA) */}
      <Modal
        open={closeAccountOpen}
        onOpenChange={(o) => {
          if (!o) {
            setCloseAccountOpen(false);
            setCloseReason("");
            setCloseConfirmText("");
          }
        }}
        title="Dar de baja mi cuenta"
        className="max-w-md"
      >
        <div className="space-y-4">
          <div className="flex items-start gap-2.5 rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-xs text-red-300">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <div>
              Esto solicita el cierre de tu cuenta. Mantenés el acceso hasta el fin
              de tu período actual y conservamos tus datos según nuestra política.
              Para confirmar, contanos el motivo y escribí{" "}
              <strong>BAJA</strong> abajo.
            </div>
          </div>
          <Input
            label="Motivo (nos ayuda a mejorar)"
            value={closeReason}
            onChange={(e) => setCloseReason(e.target.value)}
            placeholder="Por qué te vas"
          />
          <Input
            label='Escribí "BAJA" para confirmar'
            value={closeConfirmText}
            onChange={(e) => setCloseConfirmText(e.target.value)}
            placeholder="BAJA"
          />
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setCloseAccountOpen(false);
                setCloseReason("");
                setCloseConfirmText("");
              }}
            >
              Cancelar
            </Button>
            <Button
              variant="destructive"
              loading={closeAccount.isPending}
              disabled={
                closeConfirmText.trim().toUpperCase() !== "BAJA" ||
                closeReason.trim().length === 0
              }
              onClick={() => closeAccount.mutate(closeReason.trim())}
            >
              Dar de baja mi cuenta
            </Button>
          </div>
        </div>
      </Modal>
    </section>
  );
}
