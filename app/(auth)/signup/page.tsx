"use client";

import { Suspense, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm, type UseFormRegister, type FieldValues } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeft, ArrowRight, Check, MailCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { createTenant } from "@/modules/tenants/api";
import { redeemInviteCode } from "@/modules/auth/invite";
import { applySignupPlan } from "@/modules/auth/plan";
import { startOwnerSubscriptionCheckout } from "@/modules/saas/subscriptionBilling";
import { signupTrialDays, trialCopy, useSignupPlans, type SignupPlan } from "@/modules/saas/signupPlans";
import { activateAiAddon } from "@/modules/saas/aiPublicConfig";
import {
  isPendingSignupComplete,
  readPendingSignup,
  toPendingSignupMeta,
} from "@/modules/auth/pendingSignup";
import { VERTICAL_LABELS } from "@/lib/verticals/config";
import { salesContactHref } from "@/lib/support/contact";
import {
  SignupAccountSchema,
  SignupBusinessSchema,
  IVA_CONDITIONS,
  IVA_CONDITION_LABELS,
  type SignupAccountInput,
  type SignupBusinessInput,
} from "@/modules/auth/signup-schemas";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Disclosure } from "@/components/ui/Disclosure";
import { useToast } from "@/components/ui/Toast";
import { GoogleButton } from "@/components/auth/GoogleButton";
import { PasswordInput } from "@/components/auth/PasswordInput";
import { AuthHeading, AuthLink } from "@/components/auth/AuthBits";
import { SignupStepBusiness } from "@/components/auth/SignupStepBusiness";
import { SignupStepPlan } from "@/components/auth/SignupStepPlan";
import type { Vertical } from "@/lib/verticals/config";
import { callbackUrl } from "@/lib/auth/redirect";
import { cn } from "@/lib/utils/cn";
import { Spinner } from "@/components/ui/Spinner";
import { appOrigin } from "@/lib/site";

const ivaSelectCls =
  "h-11 w-full rounded-lg border border-input bg-background px-4 text-sm text-foreground outline-none transition focus:border-ninja-flameSoft focus:ring-2 focus:ring-ninja-flameSoft/20";

const STEPS = [
  { n: 1, label: "Tu cuenta" },
  { n: 2, label: "Tu negocio" },
  { n: 3, label: "Tu plan" },
] as const;

// Progreso del wizard: tres segmentos con barra arriba (sólida en los pasos
// hechos y el actual), número o check y nombre del paso. El actual se marca con
// aria-current="step".
function Stepper({ step }: { step: 1 | 2 | 3 }) {
  return (
    <nav aria-label={`Paso ${step} de ${STEPS.length}`}>
      <ol className="grid grid-cols-3 gap-2 sm:gap-3">
        {STEPS.map((it) => {
          const active = step === it.n;
          const done = step > it.n;
          return (
            <li
              key={it.n}
              aria-current={active ? "step" : undefined}
              className="min-w-0"
            >
              <span
                className={cn(
                  "block h-1 rounded-full transition-colors",
                  active || done ? "bg-[var(--pos-solid)]" : "bg-border",
                )}
                aria-hidden
              />
              <span className="mt-2.5 flex items-center gap-2">
                <span
                  className={cn(
                    "grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-bold transition-colors",
                    active
                      ? "bg-[var(--pos-solid)] text-white"
                      : done
                        ? "bg-secondary text-foreground"
                        : "bg-muted text-muted-foreground",
                  )}
                  aria-hidden
                >
                  {done ? <Check size={13} strokeWidth={3} /> : it.n}
                </span>
                <span
                  className={cn(
                    "truncate text-sm",
                    active
                      ? "font-semibold text-foreground"
                      : done
                        ? "font-medium text-foreground"
                        : "font-medium text-muted-foreground",
                  )}
                >
                  {it.label}
                  {done && <span className="sr-only"> (completo)</span>}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// Barra de acciones del wizard, igual en los tres pasos: separador arriba,
// acción secundaria (o texto) a la izquierda y la principal a la derecha. En
// celular se apilan y la principal queda arriba, a todo el ancho.
function StepActions({
  start,
  children,
}: {
  start?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col-reverse gap-3 border-t border-border pt-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center">
        {start}
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        {children}
      </div>
    </div>
  );
}

const ACTION_CLS = "w-full sm:w-auto sm:min-w-[11rem]";

// Campos fiscales + código de invitación, compartidos por ambos flujos.
// Ambos forms comparten estos nombres de campo (cuit, legalName, ivaCondition,
// inviteCode); usamos un register genérico para reutilizar el fragmento.
function FiscalAndCode({
  register,
  cuitError,
}: {
  register: UseFormRegister<FieldValues>;
  cuitError?: string;
}) {
  const ivaId = useId();
  return (
    <div className="grid items-start gap-3 sm:grid-cols-2">
      {/* Si el CUIT tiene error, se abre solo (antes quedaba escondido y no se podía avanzar sin saber por qué). */}
      <Disclosure key={cuitError ? "fiscal-err" : "fiscal"} defaultOpen={Boolean(cuitError)} title="Datos fiscales (opcional)">
        <div className="space-y-3 pt-1">
          <Input
            label="CUIT"
            inputMode="numeric"
            placeholder="20123456786"
            maxLength={13}
            error={cuitError}
            {...register("cuit")}
          />
          <Input label="Razón social" autoComplete="organization" {...register("legalName")} />
          <div className="w-full">
            <label htmlFor={ivaId} className="mb-2 block text-sm font-medium text-muted-foreground">
              Condición frente al IVA
            </label>
            <select id={ivaId} className={ivaSelectCls} defaultValue="" {...register("ivaCondition")}>
              <option value="" className="bg-popover text-popover-foreground">
                Seleccionar…
              </option>
              {IVA_CONDITIONS.map((c) => (
                <option key={c} value={c} className="bg-popover text-popover-foreground">
                  {IVA_CONDITION_LABELS[c]}
                </option>
              ))}
            </select>
          </div>
        </div>
      </Disclosure>

      <Disclosure title="¿Tenés un código de invitación?">
        <div className="pt-1">
          <Input
            label="Código"
            placeholder="NINJA2026"
            className="font-mono uppercase tracking-wider"
            autoCapitalize="characters"
            {...register("inviteCode")}
          />
        </div>
      </Disclosure>
    </div>
  );
}

function SignupWizard() {
  const router = useRouter();
  const { toast } = useToast();

  // Modo del wizard:
  // - "account": flujo email, paso 1 (cuenta) → paso 2 (negocio) → paso 3 (plan).
  // - "sso": usuario autenticado por Google sin tenant → negocio + plan en una
  //   sola vista (las credenciales ya vienen de Google).
  // - "check-email": el alta pide confirmar el email; los datos quedan
  //   guardados en user_metadata.signup.
  // - "resume": volvió de confirmar el email con el alta pendiente completa →
  //   resumen y un solo botón (no se vuelve a pedir nada).
  const [mode, setMode] = useState<"loading" | "account" | "sso" | "check-email" | "resume">("loading");
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [industry, setIndustry] = useState<Vertical | null>(null);
  const [industryError, setIndustryError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  // Plan elegido (key). Arranca null y se autoselecciona el recomendado (Pro)
  // cuando cargan los planes. El selector aplica salvo que un invite code lo fije.
  const [selectedPlan, setSelectedPlan] = useState<string | null>(null);
  // ¿Suma el Asistente IA a la suscripción? Se activa tras crear el tenant.
  const [addonAi, setAddonAi] = useState(false);
  const { data: signupPlans } = useSignupPlans();
  // Si el alta de email ya creó el usuario, no lo recreamos en un reintento.
  const userCreatedRef = useRef(false);
  // Negocio ya creado en este intento: un reintento NUNCA crea otro (bug: cada
  // "Pagar y activar" fallido dejaba un negocio duplicado).
  const tenantIdRef = useRef<string | null>(null);

  // Autoselección del plan recomendado (Pro) en cuanto cargan los planes, sin
  // pisar una elección manual previa del usuario.
  useEffect(() => {
    if (!signupPlans || signupPlans.length === 0) return;
    // Un plan guardado en el alta pendiente que ya no se ofrece cae al recomendado.
    if (selectedPlan && signupPlans.some((p) => p.key === selectedPlan)) return;
    const fallback = signupPlans.find((p) => p.isRecommended) ?? signupPlans[0];
    if (fallback) setSelectedPlan(fallback.key);
  }, [signupPlans, selectedPlan]);

  // Plan elegido resuelto (objeto). Sirve para distinguir trial vs contacto.
  const chosenPlan: SignupPlan | null =
    signupPlans?.find((p) => p.key === selectedPlan) ?? null;
  // Enterprise (trial_days = 0): no hay checkout self-service → es "contactanos".
  const planNeedsContact = chosenPlan != null && chosenPlan.trialDays <= 0;

  const accountForm = useForm<SignupAccountInput>({
    resolver: zodResolver(SignupAccountSchema),
  });
  const businessForm = useForm<SignupBusinessInput>({
    resolver: zodResolver(SignupBusinessSchema),
  });

  // Al montar (y tras volver del OAuth con ?step=2): ¿hay sesión sin tenant?
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (cancelled) return;
      if (user) {
        // Usuario autenticado: ¿ya tiene un tenant?
        const { data: memberships } = await supabase
          .from("tenant_users")
          .select("tenant_id")
          .eq("user_id", user.id)
          .eq("status", "active")
          .limit(1);
        if (cancelled) return;
        if (memberships && memberships.length > 0) {
          router.replace("/dashboard");
          return;
        }
        // Sesión sin tenant: Google SSO, o volvió de confirmar el email. Si el
        // alta quedó guardada, la retomamos sin volver a pedir los datos.
        const pending = readPendingSignup(
          (user.user_metadata as { signup?: unknown } | undefined)?.signup,
        );
        if (pending) {
          businessForm.reset({
            businessName: pending.businessName,
            cuit: pending.cuit ?? undefined,
            legalName: pending.legalName ?? undefined,
            ivaCondition: pending.ivaCondition ?? undefined,
            inviteCode: pending.inviteCode ?? undefined,
          });
          if (pending.industry) setIndustry(pending.industry);
          if (pending.planKey) setSelectedPlan(pending.planKey);
          setAddonAi(pending.addonAi);
        }
        setMode(isPendingSignupComplete(pending) ? "resume" : "sso");
        setStep(2);
      } else {
        // Sin sesión: flujo email desde el paso 1. (Si volvió de OAuth con
        // ?step=2 pero sin sesión, el OAuth no completó; arrancamos limpio.)
        setMode("account");
        setStep(1);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onGoogle() {
    setGoogleLoading(true);
    const supabase = createClient();
    const origin = appOrigin();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: callbackUrl(origin, "/signup?step=2") },
    });
    if (error) {
      setGoogleLoading(false);
      const msg = error.message?.toLowerCase() ?? "";
      if (msg.includes("provider") || msg.includes("not enabled") || msg.includes("disabled")) {
        toast({
          title: "Google está casi listo",
          description: "Falta habilitarlo. Probá con email por ahora.",
          variant: "info",
        });
      } else {
        toast({ title: "No pudimos iniciar con Google", variant: "error" });
      }
    }
    // En éxito, el navegador redirige a Google; no hace falta más.
  }

  // Paso 1 (email): validar y avanzar a elegir rubro.
  function goToBusiness() {
    setIndustryError(null);
    accountForm.handleSubmit(() => setStep(2))();
  }

  // Paso 2 (email): exigir rubro y avanzar a elegir plan.
  function goToPlan() {
    if (!industry) {
      setIndustryError("Elegí un tipo de negocio.");
      return;
    }
    setStep(3);
  }

  // Canjea el código de invitación tras crear el tenant. No aborta el alta.
  // Devuelve true si un código FIJÓ el plan (entonces gana sobre el selector).
  async function applyInviteCode(
    tenantId: string,
    code: string | undefined,
  ): Promise<boolean> {
    if (!code || !code.trim()) return false;
    const res = await redeemInviteCode(code, tenantId);
    if (!res.ok && res.message) {
      toast({
        title: "Registro creado",
        description: `Pero el código no se aplicó: ${res.message}.`,
        variant: "info",
      });
      return false;
    }
    if (res.ok) toast({ title: res.message, variant: "success" });
    return res.ok;
  }

  // Aplica el plan elegido en el selector (planes CON trial). Sólo corre cuando
  // NINGÚN invite fijó el plan. No aborta el alta si falla. Los planes SIN trial
  // se manejan aparte (applyPaidPlanAndCheckout): se cobran en el alta.
  async function applyChosenPlan(invitePinnedPlan: boolean) {
    if (invitePinnedPlan) return; // el código de invitación manda.
    if (!selectedPlan) return;
    const plan = signupPlans?.find((p) => p.key === selectedPlan);
    if (!plan || plan.trialDays <= 0) return; // sin trial → checkout aparte.
    // create_tenant ya dejó la suscripción en plan start (trial 14d); si el
    // usuario eligió otro plan con trial, lo cambiamos manteniendo el trial.
    if (plan.key === "start") return; // ya es el plan por defecto.
    const res = await applySignupPlan(plan.key);
    if (!res.ok && res.message) {
      toast({
        title: "Negocio creado",
        description: `Pero no pudimos fijar el plan ${plan.name}: ${res.message}. Lo elegís desde tu panel.`,
        variant: "info",
      });
    }
  }

  // Si el usuario marcó "sumar Asistente IA", lo activamos tras aplicar el plan.
  // activate_addon alinea el período del addon al de la suscripción (respeta el
  // trial del plan) y fija su precio. Best-effort: si falla, no aborta el alta
  // (el dueño lo activa desde el panel) y para planes pagos debe correr ANTES del
  // checkout para que el preapproval incluya el monto del addon.
  async function maybeActivateAddon() {
    if (!addonAi) return;
    const res = await activateAiAddon();
    if (!res.ok) {
      toast({
        title: "Negocio creado",
        description:
          "No pudimos sumar el Asistente IA ahora. Lo activás desde tu panel (Suscripción).",
        variant: "info",
      });
    }
  }

  // Plan SIN trial (Enterprise/Sensei): el dueño paga al crear la cuenta.
  // 1) fija el plan elegido en la suscripción (request_plan_change, owner-only);
  // 2) crea el preapproval del dueño (Edge mp_subscription_checkout) y redirige
  //    al init_point de Mercado Pago para autorizar el pago.
  // Devuelve true si redirigió a MP (el caller NO debe seguir al dashboard).
  // Si algo falla, NO redirige: el negocio queda creado y el dueño completa el
  // pago desde su panel (Suscripción).
  async function applyPaidPlanAndCheckout(
    invitePinnedPlan: boolean,
  ): Promise<boolean> {
    if (invitePinnedPlan) return false; // el invite ya fijó el plan (sin cobro acá).
    if (!selectedPlan) return false;
    const plan = signupPlans?.find((p) => p.key === selectedPlan);
    if (!plan || plan.trialDays > 0) return false; // sólo planes sin trial.
    // 1) Fijar el plan elegido (la suscripción nace en plan start).
    const applied = await applySignupPlan(plan.key);
    if (!applied.ok) {
      toast({
        title: "Negocio creado",
        description: `No pudimos fijar el plan ${plan.name}: ${applied.message}. Activalo desde tu panel.`,
        variant: "info",
      });
      return false;
    }
    // 2) Crear el preapproval y redirigir a Mercado Pago.
    try {
      const backUrl = `${appOrigin()}/dashboard?sub=ok`;
      const initPoint = await startOwnerSubscriptionCheckout(backUrl);
      toast({ title: "Te llevamos a Mercado Pago para activar tu plan", variant: "info" });
      window.location.href = initPoint;
      return true;
    } catch {
      toast({
        title: "Negocio creado",
        description:
          "No pudimos iniciar el pago ahora. Activá tu plan desde tu panel (Suscripción).",
        variant: "info",
      });
      return false;
    }
  }

  // Crea el negocio una sola vez por intento (el servidor además reutiliza el
  // recién creado con el mismo nombre si el pedido se repite).
  async function createTenantOnce(input: Parameters<typeof createTenant>[0]): Promise<string> {
    if (tenantIdRef.current) return tenantIdRef.current;
    const res = await createTenant(input);
    tenantIdRef.current = res.tenant_id;
    return res.tenant_id;
  }

  // Pasos posteriores al alta (código, plan, IA, cobro). El negocio YA existe:
  // ninguno puede mostrar "No pudimos crear tu negocio" ni abortar el ingreso.
  // Devuelve true si redirigió a Mercado Pago.
  async function finishAfterCreate(tenantId: string, inviteCode: string | undefined): Promise<boolean> {
    let invitePinnedPlan = false;
    try {
      invitePinnedPlan = await applyInviteCode(tenantId, inviteCode);
    } catch {
      toast({ title: "Negocio creado", description: "El código de invitación no se pudo aplicar. Probalo desde tu panel.", variant: "info" });
    }
    try {
      await applyChosenPlan(invitePinnedPlan);
    } catch {
      toast({ title: "Negocio creado", description: "No pudimos fijar el plan elegido. Lo elegís desde tu panel (Suscripción).", variant: "info" });
    }
    try {
      await maybeActivateAddon();
    } catch {
      toast({ title: "Negocio creado", description: "No pudimos sumar el Asistente IA ahora. Lo activás desde tu panel (Suscripción).", variant: "info" });
    }
    try {
      return await applyPaidPlanAndCheckout(invitePinnedPlan);
    } catch {
      return false;
    }
  }

  // CTA secundaria: contacto con ventas (queda como alternativa al self-service).
  function contactSales() {
    window.location.href = salesContactHref("Quiero el plan Enterprise (Sensei)");
  }

  // Submit del flujo EMAIL (paso 3 → crear cuenta).
  async function submitAccount() {
    if (submitting) return;
    if (!industry) {
      setIndustryError("Elegí un tipo de negocio.");
      return;
    }
    const v = accountForm.getValues();
    setSubmitting(true);
    const supabase = createClient();
    try {
      // 1. Crear usuario (si no se creó en un intento previo).
      if (!userCreatedRef.current) {
        // Todo lo cargado viaja en la metadata del usuario: si el alta pide
        // confirmar el email, al volver se retoma sin pedir nada de nuevo
        // (bug: se perdían rubro, plan, IA y código, y se volvía a pedir el
        // nombre del negocio).
        const { data, error } = await supabase.auth.signUp({
          email: v.email,
          password: v.password,
          options: {
            data: {
              full_name: v.fullName.trim(),
              signup: toPendingSignupMeta({
                businessName: v.businessName,
                industry,
                planKey: selectedPlan,
                addonAi,
                inviteCode: v.inviteCode ?? null,
                cuit: v.cuit ?? null,
                legalName: v.legalName ?? null,
                ivaCondition: v.ivaCondition ?? null,
              }),
            },
          },
        });
        if (error) {
          const m = error.message.toLowerCase();
          if (m.includes("already") || m.includes("registered")) {
            toast({
              title: "Ese email ya tiene cuenta",
              description: "Iniciá sesión para continuar.",
              variant: "error",
            });
          } else {
            toast({ title: "No pudimos crear la cuenta", description: error.message, variant: "error" });
          }
          setSubmitting(false);
          return;
        }
        userCreatedRef.current = true;
        // Si hay confirmación por email activa, no hay sesión: pantalla de
        // "revisá tu email". Los datos ya quedaron guardados en la cuenta.
        if (!data.session) {
          setPendingEmail(v.email);
          setSubmitting(false);
          setMode("check-email");
          return;
        }
      }

      // 2. Crear tenant (Edge). Reintentable sin recrear el usuario.
      const tenantId = await createTenantOnce({
        name: v.businessName,
        industry,
        cuit: v.cuit || undefined,
        legal_name: v.legalName || undefined,
        iva_condition: v.ivaCondition || undefined,
        plan_key: selectedPlan || undefined,
      });
      await supabase.auth.refreshSession();

      // 3. Código, plan, IA y cobro: nunca abortan el alta (el negocio ya existe).
      if (await finishAfterCreate(tenantId, v.inviteCode)) return;

      toast({ title: "¡Listo! Tu negocio fue creado", variant: "success" });
      router.push("/dashboard");
      router.refresh();
    } catch (e) {
      toast({
        title: "No pudimos crear tu negocio",
        description:
          (e instanceof Error ? e.message : "") +
          " Volvé a intentar, no perdés tu cuenta.",
        variant: "error",
      });
      setSubmitting(false);
    }
  }

  // Submit del flujo SSO (sesión Google sin tenant → crear negocio).
  async function submitBusiness() {
    if (submitting) return;
    if (!industry) {
      setIndustryError("Elegí un tipo de negocio.");
      return;
    }
    const valid = await businessForm.trigger();
    if (!valid) return;
    const v = businessForm.getValues();
    setSubmitting(true);
    const supabase = createClient();
    try {
      const tenantId = await createTenantOnce({
        name: v.businessName,
        industry,
        cuit: v.cuit || undefined,
        legal_name: v.legalName || undefined,
        iva_condition: v.ivaCondition || undefined,
        plan_key: selectedPlan || undefined,
      });
      await supabase.auth.refreshSession();
      if (await finishAfterCreate(tenantId, v.inviteCode)) return;
      toast({ title: "¡Listo! Tu negocio fue creado", variant: "success" });
      router.push("/dashboard");
      router.refresh();
    } catch (e) {
      toast({
        title: "No pudimos crear tu negocio",
        description: e instanceof Error ? e.message : "Volvé a intentar.",
        variant: "error",
      });
      setSubmitting(false);
    }
  }

  if (mode === "loading") {
    return (
      <div className="grid place-items-center py-24">
        <Spinner size={24} />
      </div>
    );
  }

  const accountErrors = accountForm.formState.errors;
  const businessErrors = businessForm.formState.errors;

  // Nadie paga al crear la cuenta (pedido del dueño): el botón invita a probar
  // y abajo se aclara cuándo empieza el cobro. Acá no se conecta Mercado Pago.
  // Días según la configuración de planes (internal): los del plan elegido o,
  // si no tiene, los que muestra el registro.
  const trialDaysForCta =
    chosenPlan && chosenPlan.trialDays > 0 ? chosenPlan.trialDays : signupTrialDays(signupPlans);
  const trialCta =
    trialDaysForCta > 0
      ? `Probá gratis ${trialDaysForCta === 1 ? "1 día" : `${trialDaysForCta} días`}`
      : "Crear mi negocio";
  const planNote = (
    <p className="text-center text-xs text-muted-foreground sm:text-right">
      No pagás nada ahora: el cobro empieza recién al terminar la prueba.
      {planNeedsContact && (
        <>
          {" "}
          <button
            type="button"
            onClick={contactSales}
            className="rounded-sm font-medium text-ninja-flameSoft outline-none hover:underline focus-visible:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            ¿Preferís hablar con ventas?
          </button>
        </>
      )}
    </p>
  );

  const industryAlert = industryError && (
    <p role="alert" className="text-sm text-destructive">
      {industryError}
    </p>
  );

  return (
    // El panel de marca y el logo los pone app/(auth)/layout.tsx.
    <div>
      <AuthHeading
        className="mb-6"
        title={
          mode === "check-email"
            ? "Revisá tu email"
            : mode === "resume"
              ? "Terminá de crear tu negocio"
              : "Creá tu cuenta"
        }
        description={
          mode === "check-email"
            ? "Te mandamos un link para confirmar tu cuenta."
            : mode === "resume"
              ? "Ya tenemos todos tus datos. Revisalos y listo."
              : signupTrialDays(signupPlans) > 0
                ? trialCopy(signupTrialDays(signupPlans))
                : "Elegí tu plan y empezá a vender."
        }
      />

      {/* En SSO el negocio y el plan van juntos en una sola vista; el
          stepper sólo aplica al flujo email de 3 pasos. */}
      {mode === "account" && <Stepper step={step} />}

      <div className={mode === "account" ? "mt-7" : ""}>
        {/* ---------- FLUJO EMAIL · paso 1: cuenta ---------- */}
        {mode === "account" && step === 1 && (
          <div className="space-y-5">
            <GoogleButton onClick={onGoogle} loading={googleLoading} />

            <div className="flex items-center gap-3" role="separator" aria-label="o con tu email">
              <span className="h-px flex-1 bg-border" aria-hidden />
              <span className="text-xs text-muted-foreground" aria-hidden>
                o con tu email
              </span>
              <span className="h-px flex-1 bg-border" aria-hidden />
            </div>

            <form
              className="space-y-5"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                goToBusiness();
              }}
            >
              <div className="grid items-start gap-4 sm:grid-cols-2">
                <Input
                  label="Nombre del negocio"
                  placeholder="Kiosco La Esquina"
                  autoComplete="organization"
                  error={accountErrors.businessName?.message}
                  {...accountForm.register("businessName")}
                />
                <Input
                  label="Tu nombre"
                  autoComplete="name"
                  error={accountErrors.fullName?.message}
                  {...accountForm.register("fullName")}
                />
                <Input
                  label="Email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  error={accountErrors.email?.message}
                  {...accountForm.register("email")}
                />
                <PasswordInput
                  label="Contraseña"
                  autoComplete="new-password"
                  hint="Mínimo 10 caracteres, con mayúscula, minúscula y número."
                  error={accountErrors.password?.message}
                  {...accountForm.register("password")}
                />
              </div>

              <FiscalAndCode
                register={accountForm.register as unknown as UseFormRegister<FieldValues>}
                cuitError={accountErrors.cuit?.message}
              />

              <p className="text-xs text-muted-foreground">
                Al continuar aceptás los términos y la política de privacidad
                de NinjaSoft.
              </p>

              <StepActions
                start={
                  <p className="text-center text-sm text-muted-foreground sm:text-left">
                    ¿Ya tenés cuenta? <AuthLink href="/login">Iniciar sesión</AuthLink>
                  </p>
                }
              >
                <Button type="submit" className={ACTION_CLS}>
                  Continuar
                  <ArrowRight size={16} aria-hidden />
                </Button>
              </StepActions>
            </form>
          </div>
        )}

        {/* ---------- FLUJO EMAIL · paso 2: rubro ---------- */}
        {mode === "account" && step === 2 && (
          <div className="space-y-6">
            <SignupStepBusiness
              value={industry}
              onChange={(v) => {
                setIndustry(v);
                setIndustryError(null);
              }}
            />
            {industryAlert}
            <StepActions
              start={
                <Button
                  type="button"
                  variant="secondary"
                  className={ACTION_CLS}
                  onClick={() => setStep(1)}
                >
                  <ArrowLeft size={16} aria-hidden />
                  Volver
                </Button>
              }
            >
              <Button type="button" className={ACTION_CLS} onClick={goToPlan}>
                Continuar
                <ArrowRight size={16} aria-hidden />
              </Button>
            </StepActions>
          </div>
        )}

        {/* ---------- FLUJO EMAIL · paso 3: elegir plan ---------- */}
        {mode === "account" && step === 3 && (
          <div className="space-y-6">
            <SignupStepPlan
              value={selectedPlan}
              onChange={setSelectedPlan}
              addonAi={addonAi}
              onAddonAiChange={setAddonAi}
            />
            <div className="space-y-3">
              <StepActions
                start={
                  <Button
                    type="button"
                    variant="secondary"
                    className={ACTION_CLS}
                    disabled={submitting}
                    onClick={() => setStep(2)}
                  >
                    <ArrowLeft size={16} aria-hidden />
                    Volver
                  </Button>
                }
              >
                <Button
                  type="button"
                  className={ACTION_CLS}
                  loading={submitting}
                  onClick={submitAccount}
                >
                  {trialCta}
                </Button>
              </StepActions>
              {planNote}
            </div>
          </div>
        )}

        {/* ---------- FLUJO SSO (Google sin tenant) ---------- */}
        {mode === "sso" && (
          <div className="space-y-8">
            <div>
              <h3 className="font-sans text-xl font-bold tracking-[-0.01em] text-foreground">
                Contanos de tu negocio
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Tu cuenta ya está lista. Solo falta crear tu negocio.
              </p>

              <form className="mt-5 space-y-4" noValidate>
                <Input
                  label="Nombre del negocio"
                  placeholder="Kiosco La Esquina"
                  autoComplete="organization"
                  error={businessErrors.businessName?.message}
                  {...businessForm.register("businessName")}
                />
                <FiscalAndCode
                  register={businessForm.register as unknown as UseFormRegister<FieldValues>}
                  cuitError={businessErrors.cuit?.message}
                />
              </form>
            </div>

            <div className="space-y-3">
              <SignupStepBusiness
                value={industry}
                onChange={(v) => {
                  setIndustry(v);
                  setIndustryError(null);
                }}
              />
              {industryAlert}
            </div>

            <SignupStepPlan
              value={selectedPlan}
              onChange={setSelectedPlan}
              addonAi={addonAi}
              onAddonAiChange={setAddonAi}
            />

            <div className="space-y-3">
              <StepActions>
                <Button
                  type="button"
                  className={ACTION_CLS}
                  loading={submitting}
                  onClick={submitBusiness}
                >
                  {trialCta}
                </Button>
              </StepActions>
              {planNote}
            </div>
          </div>
        )}

        {/* ---------- Confirmación de email pendiente ---------- */}
        {mode === "check-email" && (
          <div className="space-y-5">
            <div className="flex items-start gap-3 rounded-lg border border-border bg-muted p-4">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-background text-ninja-flameSoft">
                <MailCheck size={20} aria-hidden />
              </span>
              <div className="min-w-0 text-sm">
                <p className="font-semibold text-foreground">
                  Confirmá tu cuenta desde el email que te mandamos
                  {pendingEmail ? (
                    <>
                      {" "}a <span className="break-all">{pendingEmail}</span>
                    </>
                  ) : null}
                  .
                </p>
                <p className="mt-1 text-muted-foreground">
                  Tus datos ya quedaron guardados: el negocio, el rubro, el plan y el
                  Asistente IA si lo sumaste. Cuando confirmes, entrá con tu email y
                  contraseña y lo terminás con un clic, sin volver a cargar nada.
                </p>
              </div>
            </div>
            <StepActions>
              <Button type="button" className={ACTION_CLS} onClick={() => router.push("/login")}>
                Ir a iniciar sesión
                <ArrowRight size={16} aria-hidden />
              </Button>
            </StepActions>
          </div>
        )}

        {/* ---------- Alta retomada (volvió de confirmar el email) ---------- */}
        {mode === "resume" && (
          <div className="space-y-6">
            <dl className="divide-y divide-border rounded-lg border border-border bg-card text-sm">
              <ResumeRow label="Negocio" value={businessForm.getValues("businessName")} />
              <ResumeRow label="Rubro" value={industry ? VERTICAL_LABELS[industry] : null} />
              <ResumeRow label="Plan" value={chosenPlan?.name ?? null} />
              <ResumeRow
                label="Asistente IA"
                value={addonAi ? "Lo sumás a tu plan" : "No, por ahora"}
              />
              {businessForm.getValues("inviteCode") ? (
                <ResumeRow label="Código" value={businessForm.getValues("inviteCode") ?? null} mono />
              ) : null}
            </dl>
            <div className="space-y-3">
              <StepActions
                start={
                  <Button
                    type="button"
                    variant="secondary"
                    className={ACTION_CLS}
                    disabled={submitting}
                    onClick={() => setMode("sso")}
                  >
                    Cambiar datos
                  </Button>
                }
              >
                <Button
                  type="button"
                  className={ACTION_CLS}
                  loading={submitting}
                  onClick={submitBusiness}
                >
                  {trialCta}
                </Button>
              </StepActions>
              {planNote}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Fila del resumen del alta retomada.
function ResumeRow({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-4 py-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className={cn("min-w-0 truncate text-right font-medium text-foreground", mono && "font-mono")}>
        {value || "Sin definir"}
      </dd>
    </div>
  );
}

export default function SignupPage() {
  return (
    <Suspense
      fallback={
        <div className="grid place-items-center py-24">
          <Spinner size={24} />
        </div>
      }
    >
      <SignupWizard />
    </Suspense>
  );
}
