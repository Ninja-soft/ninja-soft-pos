"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CreditCard,
  Sparkles,
  Check,
  CalendarClock,
  Receipt,
  ArrowUpRight,
  XCircle,
  AlertTriangle,
  Star,
  Zap,
  TrendingUp,
  ShieldCheck,
  ChevronDown,
  Gift,
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
import { PlanBadge } from "@/components/internal/plans/PlanBadge";
import { PlanCards, type PlanCardModel } from "@/components/saas/PlanCards";
import { PaymentHistory, type PaymentRecord } from "@/components/saas/PaymentHistory";
import { useMyPaymentHistory } from "@/modules/saas/paymentHistory";

// Tipos de los RPC (no están en los tipos generados → cast laxo).
type Addon = {
  addon_key: string;
  label: string | null;
  status: string;
  // 'granted' = bonificado por NinjaSoft (sin cobro); 'purchased' = pago.
  source: string | null;
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
// public_plans(): incluye modules + limits (para comparar planes).
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
  modules: Record<string, boolean>;
  limits: Record<string, number | null>;
};
type AiCfg = {
  image_url: string;
  commercial_text: string;
  addon_price_ars: string;
};

const STATUS_LABELS: Record<string, string> = {
  trial: "Prueba gratis",
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

const MP_STATUS_LABELS: Record<string, string> = {
  authorized: "Autorizado",
  pending: "Pendiente de autorizar",
  paused: "Pausado",
  cancelled: "Cancelado",
};
const MP_PM_LABELS: Record<string, string> = {
  visa: "Visa",
  master: "Mastercard",
  amex: "American Express",
  naranja: "Naranja",
  cabal: "Cabal",
  account_money: "Dinero en cuenta",
};

// Marca local para mostrar "Cambiaste a X" un ratito tras un cambio de plan
// (request_plan_change aplica al instante; no hay estado "pendiente" en DB).
const PLAN_CHANGE_KEY = "ninja:last-plan-change";
const PLAN_CHANGE_WINDOW_MS = 1000 * 60 * 60 * 24; // 24 h.

function fmtMoney(n: number | null | undefined): string {
  return `$${Number(n ?? 0).toLocaleString("es-AR")}`;
}
function fmtDate(s: string | null | undefined): string {
  return s
    ? new Date(s).toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" })
    : "—";
}
function fmtDateShort(s: string | null | undefined): string {
  return s ? new Date(s).toLocaleDateString("es-AR", { day: "2-digit", month: "long" }) : "—";
}
// Días restantes (>= 0) hasta una fecha. null si no hay fecha.
function daysUntil(s: string | null | undefined): number | null {
  if (!s) return null;
  const ms = new Date(s).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)));
}
function rpc(supabase: ReturnType<typeof createClient>) {
  return supabase.rpc as unknown as (
    fn: string,
    args?: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message?: string } | null }>;
}

function toPlanCardModel(p: PublicPlan): PlanCardModel {
  return {
    key: p.key,
    name: p.name,
    secondaryName: p.secondary_name,
    imageUrl: p.image_url,
    icon: p.icon,
    monthlyPriceArs: Number(p.monthly_price_ars ?? 0),
    trialDays: Number(p.trial_days ?? 0),
    isRecommended: p.is_recommended === true,
    sort: Number(p.sort ?? 0),
    modules: p.modules ?? {},
    limits: p.limits ?? {},
  };
}

export function SubscriptionCard() {
  const supabase = createClient();
  const qc = useQueryClient();
  const { toast } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();

  // Vuelta desde el checkout de MP (?sub=ok): feedback + refresco (el estado real
  // lo confirma el webhook mp_billing_webhook).
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
  // Aviso local de "cambiaste a X" (nombre del plan recién elegido).
  const [recentChange, setRecentChange] = useState<string | null>(null);

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

  const { data: billing } = useQuery({
    queryKey: ["owner-billing-summary"],
    queryFn: async (): Promise<OwnerBillingSummary | null> =>
      fetchOwnerBillingSummary(),
  });
  const hasPreapproval = billing?.has_preapproval === true;

  const { data: payMethod } = useQuery({
    queryKey: ["subscription-payment-method"],
    enabled: hasPreapproval,
    staleTime: 5 * 60_000,
    queryFn: async () => fetchSubscriptionPaymentMethod(),
  });

  // Historial completo de pagos (RPC owner-gated my_payment_history). Si falla o
  // viene vacío, caemos al último pago de my_subscription (abajo en `payments`).
  const { data: paymentHistory = [] } = useMyPaymentHistory();

  // Lee la marca local de cambio reciente al montar (y limpia si venció).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PLAN_CHANGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { name: string; at: number };
      if (Date.now() - parsed.at <= PLAN_CHANGE_WINDOW_MS) {
        setRecentChange(parsed.name);
      } else {
        localStorage.removeItem(PLAN_CHANGE_KEY);
      }
    } catch {
      /* marca corrupta: ignorar */
    }
  }, []);

  function invalidate() {
    qc.invalidateQueries({ queryKey: ["my-subscription"] });
    qc.invalidateQueries({ queryKey: ["ai-available"] });
    qc.invalidateQueries({ queryKey: ["owner-billing-summary"] });
  }

  async function syncAmountSilently() {
    try {
      await syncSubscriptionAmount();
    } catch {
      /* el addon ya está aplicado; la sync se reintenta luego. */
    }
  }

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
    onSuccess: async (_d, planKey) => {
      const chosen = plans.find((p) => p.key === planKey);
      const needsPay = chosen != null && chosen.trial_days <= 0 && !hasPreapproval;
      // Marca local del cambio para el aviso de estado.
      if (chosen) {
        try {
          localStorage.setItem(
            PLAN_CHANGE_KEY,
            JSON.stringify({ name: chosen.name, at: Date.now() }),
          );
        } catch {
          /* sin storage: el aviso simplemente no persiste */
        }
        setRecentChange(chosen.name);
      }
      toast({
        title: chosen ? `Cambiaste a ${chosen.name}` : "Plan actualizado",
        variant: "success",
      });
      setConfirmPlan(null);
      setPlanPickerOpen(false);
      await syncAmountSilently();
      invalidate();
      // Plan sin trial y sin medio de pago → llevamos a pagar para activarlo.
      if (needsPay) startCheckout.mutate();
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
      toast({ title: "Asistente IA activado", variant: "success" });
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

  // Modelos para PlanCards (todos los planes + comparación contra el actual).
  const planModels = useMemo<PlanCardModel[]>(
    () => plans.map(toPlanCardModel),
    [plans],
  );

  // Pagos para el "Registro de pagos": historial completo vía my_payment_history
  // (RPC owner-gated; billing_records tiene RLS solo-staff). Si el RPC viene vacío
  // (sin pagos aún, o error), caemos al último pago expuesto por my_subscription
  // para no perder info en trial. Si tampoco hay, lista vacía.
  const payments = useMemo<PaymentRecord[]>(() => {
    if (paymentHistory.length > 0) return paymentHistory;
    if (!sub?.last_payment) return [];
    return [
      {
        amount: sub.last_payment.amount,
        medium: sub.last_payment.medium,
        period_end: sub.last_payment.period_end,
        created_at: sub.last_payment.created_at,
        currency: "ARS",
      },
    ];
  }, [paymentHistory, sub?.last_payment]);

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
    aiAddon && (aiAddon.status === "active" || aiAddon.cancel_at_period_end);
  const aiPrice = (aiCfg?.addon_price_ars ?? "").trim();
  // Bonificado por NinjaSoft: el addon fue regalado desde el panel interno
  // (subscription_addons.source = 'granted', sin cobro). Un addon pago tiene
  // source='purchased' y monthly_price_ars seteado; los grants nunca setean
  // precio. Usamos `source` (flag canónico) con el precio nulo como respaldo
  // por si el RPC aún no expone source.
  const aiComped =
    !!aiAddon &&
    (aiAddon.source === "granted" || aiAddon.monthly_price_ars == null);

  const isTrial = sub.status === "trial";
  const daysLeft = daysUntil(sub.current_period_end);
  // Mensaje principal de "días restantes" según el estado.
  let periodLine: { label: string; tone: string } | null = null;
  if (sub.is_lifetime) {
    periodLine = { label: "Acceso vitalicio, sin cobros", tone: "text-ninja-flameSoft" };
  } else if (sub.cancel_at_period_end) {
    periodLine = {
      label: `Acceso hasta el ${fmtDate(sub.current_period_end)} (no se renueva)`,
      tone: "text-amber-400",
    };
  } else if (daysLeft != null) {
    periodLine = isTrial
      ? {
          label:
            daysLeft === 0
              ? "Tu prueba termina hoy"
              : `Te ${daysLeft === 1 ? "queda 1 día" : `quedan ${daysLeft} días`} de prueba gratis`,
          tone: daysLeft <= 3 ? "text-amber-400" : "text-ninja-brightViolet",
        }
      : {
          label:
            daysLeft === 0
              ? `Próximo cobro hoy (${fmtDateShort(sub.current_period_end)})`
              : `Próximo cobro en ${daysLeft === 1 ? "1 día" : `${daysLeft} días`}, el ${fmtDateShort(sub.current_period_end)}`,
          tone: "text-muted-foreground",
        };
  }

  return (
    <section className="mt-10">
      <Heading as="h2" className="flex items-center gap-2 text-base">
        <CreditCard size={18} /> Suscripción
      </Heading>
      <p className="mt-1 text-sm text-muted-foreground">
        Gestioná tu plan, tus complementos y tu método de pago.
      </p>

      {/* ── Plan actual (hero premium) ── */}
      <Card className="mt-3 overflow-hidden">
        <div className="bg-[radial-gradient(120%_140%_at_0%_0%,rgba(236,63,23,0.10),transparent_55%)]">
          <CardContent className="p-5 sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex min-w-0 items-start gap-4">
                <PlanBadge
                  plan={{
                    name: sub.plan.name,
                    secondaryName: sub.plan.secondary_name,
                    imageUrl: sub.plan.image_url,
                    icon: sub.plan.icon,
                  }}
                  size="md"
                />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
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
                  <p className="mt-1.5 text-2xl font-black tracking-tight text-foreground">
                    {fmtMoney(sub.plan.monthly_price_ars)}
                    <span className="text-sm font-normal text-muted-foreground">
                      {" "}
                      / mes
                    </span>
                  </p>
                </div>
              </div>
              <Button size="sm" onClick={() => setPlanPickerOpen(true)}>
                <TrendingUp size={15} /> Mejorar / Cambiar plan
              </Button>
            </div>

            {/* Días restantes + estado de cambio */}
            <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-border pt-4">
              {periodLine && (
                <div className="flex items-center gap-2">
                  <CalendarClock size={16} className={`shrink-0 ${periodLine.tone}`} />
                  <span className={`text-sm font-medium ${periodLine.tone}`}>
                    {periodLine.label}
                  </span>
                </div>
              )}
              <div className="flex items-center gap-2">
                <span
                  className={`inline-flex items-center gap-1.5 text-sm ${
                    recentChange ? "text-emerald-400" : "text-muted-foreground"
                  }`}
                >
                  {recentChange ? (
                    <>
                      <Check size={15} className="shrink-0" /> Cambiaste a{" "}
                      <strong className="font-semibold">{recentChange}</strong> ·
                      aplicado
                    </>
                  ) : (
                    <>
                      <ShieldCheck size={15} className="shrink-0" /> Sin cambios
                      pendientes
                    </>
                  )}
                </span>
              </div>
            </div>

            {sub.cancel_at_period_end && !closureRequested && (
              <div className="mt-4 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-300">
                <AlertTriangle size={14} className="shrink-0" />
                Tu suscripción se cancela el {fmtDate(sub.current_period_end)}. Vas
                a mantener el acceso hasta esa fecha.
              </div>
            )}

            {/* Total facturado (sólo si hay addons que suman al cobro). */}
            {!sub.is_lifetime &&
              billing?.billing &&
              billing.billing.addons_amount > 0 && (
                <div className="mt-4 flex items-start gap-2.5 border-t border-border pt-4 text-sm">
                  <Receipt size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
                  <div>
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

            {/* Método de pago. */}
            {!sub.is_lifetime && (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
                <div className="flex items-start gap-2.5">
                  <CreditCard size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
                  <div className="text-sm">
                    <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Método de pago
                    </div>
                    {hasPreapproval ? (
                      payMethod?.mp_unavailable ? (
                        <p className="text-muted-foreground">
                          Cobro automático por Mercado Pago. No pudimos verificar
                          el estado con Mercado Pago en este momento; podés
                          gestionarlo igual desde el botón.
                        </p>
                      ) : (
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
                      )
                    ) : (
                      <p className="text-muted-foreground">
                        {isTrial
                          ? "Todavía no tenés un cobro automático activo. Se configura al pagar tu plan: el cobro mensual se hace solo por Mercado Pago."
                          : "Tu suscripción no tiene un pago activo. Activala para no perder acceso."}
                      </p>
                    )}
                  </div>
                </div>
                {hasPreapproval ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={updatePaymentMethod.isPending}
                    onClick={() => updatePaymentMethod.mutate()}
                  >
                    <CreditCard size={15} /> Actualizar medio de pago
                  </Button>
                ) : (
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
                )}
              </div>
            )}
          </CardContent>
        </div>
      </Card>

      {/* ── Asistente IA (addon) ── */}
      <Card className="mt-3">
        <CardContent className="p-5">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Sparkles size={16} className="text-ninja-flameSoft" /> Asistente IA
          </div>

          {aiActive ? (
            // Contratado: estado + acción discreta.
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-3.5">
              <div className="flex min-w-0 items-center gap-3">
                <AiAvatar src={aiCfg?.image_url} />
                <div className="min-w-0">
                  <div className="font-medium">Asistente IA</div>
                  <div className="text-xs">
                    {aiAddon?.cancel_at_period_end ? (
                      <span className="text-amber-400">
                        Se da de baja el {fmtDate(aiAddon?.current_period_end)}
                      </span>
                    ) : (
                      <span className="inline-flex flex-wrap items-center gap-1.5">
                        <span className="inline-flex items-center gap-1 text-emerald-400">
                          <Check size={12} /> Activo
                        </span>
                        {aiComped ? (
                          <span className="inline-flex items-center gap-1 rounded-ninjaFull border border-ninja-flameSoft/40 bg-ninja-flame/10 px-1.5 py-0.5 text-[10px] font-semibold text-ninja-flameSoft">
                            <Gift size={10} /> Bonificado por NinjaSoft
                          </span>
                        ) : aiPrice ? (
                          <span className="text-muted-foreground">
                            · {fmtMoney(Number(aiPrice))}/mes
                          </span>
                        ) : null}
                      </span>
                    )}
                  </div>
                </div>
              </div>
              {aiAddon?.cancel_at_period_end ? (
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
              )}
            </div>
          ) : (
            // No contratado: venta corta + CTA.
            <div className="mt-3 rounded-xl border border-ninja-flame/30 bg-ninja-flame/[0.05] p-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex min-w-0 items-start gap-3">
                  <AiAvatar src={aiCfg?.image_url} />
                  <div className="min-w-0">
                    <div className="font-semibold text-foreground">
                      Sumá inteligencia a tu negocio
                    </div>
                    <p className="mt-0.5 max-w-md text-xs text-muted-foreground">
                      {aiCfg?.commercial_text?.trim() ||
                        "Un asistente que responde sobre tus ventas, tu stock y cómo usar cada función del sistema, desde cualquier pantalla."}
                    </p>
                    <ul className="mt-2 grid gap-1 text-xs text-ninja-lavender sm:grid-cols-2">
                      {[
                        "Consultá tus ventas en lenguaje natural",
                        "Resolvé dudas del sistema al instante",
                        "Ideas para vender y reponer mejor",
                        "Disponible para todo tu equipo",
                      ].map((b) => (
                        <li key={b} className="flex items-start gap-1.5">
                          <Check size={13} className="mt-0.5 shrink-0 text-ninja-flameSoft" />
                          <span>{b}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
                <div className="text-right">
                  {aiPrice && (
                    <div className="mb-2">
                      <span className="text-lg font-black text-foreground">
                        {fmtMoney(Number(aiPrice))}
                      </span>
                      <span className="text-xs text-muted-foreground"> / mes</span>
                    </div>
                  )}
                  <Button
                    size="sm"
                    loading={activateAddon.isPending}
                    onClick={() => activateAddon.mutate("ai_assistant")}
                  >
                    <Sparkles size={15} /> Activar Asistente IA
                  </Button>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Registro de pagos ── */}
      <Card className="mt-3">
        <CardContent className="p-5">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <Receipt size={16} className="text-muted-foreground" /> Registro de pagos
          </div>
          <PaymentHistory payments={payments} />
        </CardContent>
      </Card>

      {/* ── Acciones discretas (cancelar / dar de baja) ── */}
      <details className="group mt-3">
        <summary className="flex cursor-pointer list-none items-center justify-center gap-1.5 py-2 text-xs text-muted-foreground transition hover:text-foreground">
          <ChevronDown
            size={14}
            className="transition-transform group-open:rotate-180"
          />
          Opciones de la cuenta
        </summary>
        <div className="mt-2 space-y-2 rounded-xl border border-border/60 bg-muted/10 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
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
              <button
                type="button"
                disabled={sub.is_lifetime}
                onClick={() => setCancelSubOpen(true)}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground underline-offset-2 transition hover:text-destructive hover:underline disabled:opacity-40"
              >
                <XCircle size={13} /> Cancelar suscripción
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2">
            <div className="min-w-0">
              <div className="text-sm font-medium">Dar de baja la cuenta</div>
              <p className="text-xs text-muted-foreground">
                {closureRequested
                  ? `Solicitada el ${fmtDate(sub.closure_requested_at)}. Mantenés acceso hasta el fin del período.`
                  : "Cierre definitivo de la cuenta (doble confirmación)."}
              </p>
            </div>
            <button
              type="button"
              disabled={closureRequested}
              onClick={() => setCloseAccountOpen(true)}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground underline-offset-2 transition hover:text-destructive hover:underline disabled:opacity-40"
            >
              {closureRequested ? "Baja solicitada" : "Dar de baja la cuenta"}
            </button>
          </div>
        </div>
      </details>

      {/* ── Modal: selector comercial de planes ── */}
      <Modal
        open={planPickerOpen}
        onOpenChange={setPlanPickerOpen}
        title="Mejorá o cambiá tu plan"
        description="Mirá qué suma cada plan respecto del tuyo. El nuevo precio se aplica desde tu próximo ciclo."
        className="max-w-6xl"
      >
        <PlanCards
          plans={planModels}
          comparedToKey={sub.plan.is_custom ? null : sub.plan.key}
          columnsClassName="sm:grid-cols-2 lg:grid-cols-4"
          renderCta={(p, isCompared) =>
            isCompared ? (
              <span className="inline-flex w-full items-center justify-center gap-1 rounded-lg border border-emerald-500/40 bg-emerald-500/10 py-2 text-xs font-semibold text-emerald-400">
                <Check size={14} /> Tu plan actual
              </span>
            ) : (
              <Button
                size="sm"
                className="w-full"
                variant={p.isRecommended ? "primary" : "secondary"}
                onClick={() => {
                  const full = plans.find((pp) => pp.key === p.key) ?? null;
                  setConfirmPlan(full);
                }}
              >
                {p.monthlyPriceArs > sub.plan.monthly_price_ars ? (
                  <>
                    <ArrowUpRight size={14} /> Mejorar a {p.name}
                  </>
                ) : (
                  `Cambiar a ${p.name}`
                )}
              </Button>
            )
          }
        />
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
        description={
          confirmPlan
            ? `Tu plan pasará a ${confirmPlan.name} (${fmtMoney(
                confirmPlan.monthly_price_ars,
              )} / mes).${
                confirmPlan.trial_days <= 0 && !hasPreapproval
                  ? " Te vamos a llevar a Mercado Pago para activar el cobro."
                  : " El nuevo precio se aplica desde tu próximo ciclo de facturación."
              }`
            : ""
        }
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

// Avatar del asistente IA (imagen del proveedor o ícono de marca).
function AiAvatar({ src }: { src?: string }) {
  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt="Asistente IA"
        className="h-10 w-10 shrink-0 rounded-full border border-border object-cover"
      />
    );
  }
  return (
    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-ninja-gradient text-ninja-voidViolet">
      <Sparkles size={18} />
    </span>
  );
}
