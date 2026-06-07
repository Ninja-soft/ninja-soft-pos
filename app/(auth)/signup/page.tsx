"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm, type UseFormRegister, type FieldValues } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Check } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { createTenant } from "@/modules/tenants/api";
import { redeemInviteCode } from "@/modules/auth/invite";
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
import { Isotype, WordmarkPos } from "@/components/brand/Logo";
import { ValuePanel } from "@/components/auth/ValuePanel";
import { GoogleButton } from "@/components/auth/GoogleButton";
import { SignupStepBusiness } from "@/components/auth/SignupStepBusiness";
import type { Vertical } from "@/lib/verticals/config";
import { cn } from "@/lib/utils/cn";

const ivaSelectCls =
  "h-11 w-full rounded-lg border border-input bg-background px-4 text-sm text-foreground outline-none transition focus:border-ninja-flameSoft focus:ring-2 focus:ring-ninja-flameSoft/20";

function Stepper({ step }: { step: 1 | 2 }) {
  const items = [
    { n: 1, label: "Tu cuenta" },
    { n: 2, label: "Tu negocio" },
  ] as const;
  return (
    <div className="flex items-center gap-3">
      {items.map((it, i) => {
        const active = step === it.n;
        const done = step > it.n;
        return (
          <div key={it.n} className="flex items-center gap-3">
            <span className="flex items-center gap-2">
              <span
                className={cn(
                  "grid h-6 w-6 place-items-center rounded-full text-xs font-bold transition",
                  active
                    ? "bg-ninja-gradient text-white shadow-ninjaGlow"
                    : done
                      ? "bg-ninja-flame/20 text-ninja-flameSoft"
                      : "bg-white/10 text-ninja-lavender",
                )}
              >
                {done ? <Check size={13} /> : it.n}
              </span>
              <span
                className={cn(
                  "text-sm font-medium",
                  active ? "text-ninja-softWhite" : "text-ninja-lavender",
                )}
              >
                {it.label}
              </span>
            </span>
            {i === 0 && <span className="h-px w-6 bg-white/15" aria-hidden />}
          </div>
        );
      })}
    </div>
  );
}

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
  return (
    <div className="space-y-3">
      <Disclosure title="Datos fiscales (opcional)">
        <div className="space-y-3 pt-1">
          <Input
            label="CUIT"
            inputMode="numeric"
            placeholder="20123456786"
            maxLength={13}
            error={cuitError}
            {...register("cuit")}
          />
          <Input label="Razón social" {...register("legalName")} />
          <div className="w-full">
            <label className="mb-2 block text-sm font-medium text-muted-foreground">
              Condición frente al IVA
            </label>
            <select className={ivaSelectCls} defaultValue="" {...register("ivaCondition")}>
              <option value="" className="bg-ninja-deepViolet">
                Seleccionar…
              </option>
              {IVA_CONDITIONS.map((c) => (
                <option key={c} value={c} className="bg-ninja-deepViolet">
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
  // - "account": flujo email, paso 1 (cuenta) → paso 2 (negocio).
  // - "sso": usuario autenticado por Google sin tenant → solo paso 2 con
  //   nombre de negocio incluido.
  const [mode, setMode] = useState<"loading" | "account" | "sso">("loading");
  const [step, setStep] = useState<1 | 2>(1);
  const [industry, setIndustry] = useState<Vertical | null>(null);
  const [industryError, setIndustryError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  // Si el alta de email ya creó el usuario, no lo recreamos en un reintento.
  const userCreatedRef = useRef(false);

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
        // Sesión sin tenant (típico de Google SSO): completar negocio.
        setMode("sso");
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
    const origin = window.location.origin;
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${origin}/signup?step=2` },
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

  // Aplica datos fiscales + código tras crear el tenant. No aborta el alta.
  async function applyFiscalAndCode(
    tenantId: string,
    code: string | undefined,
  ) {
    if (code && code.trim()) {
      const res = await redeemInviteCode(code, tenantId);
      if (!res.ok && res.message) {
        toast({
          title: "Registro creado",
          description: `Pero el código no se aplicó: ${res.message}.`,
          variant: "info",
        });
      } else if (res.ok) {
        toast({ title: res.message, variant: "success" });
      }
    }
  }

  // Submit del flujo EMAIL (paso 2 → crear cuenta).
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
        const { data, error } = await supabase.auth.signUp({
          email: v.email,
          password: v.password,
          options: { data: { full_name: v.fullName } },
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
        // Si hay confirmación por email activa, no hay sesión: avisamos.
        if (!data.session) {
          toast({
            title: "Revisá tu email",
            description: "Confirmá tu cuenta y volvé a ingresar para terminar.",
            variant: "info",
          });
          setSubmitting(false);
          router.push("/login");
          return;
        }
      }

      // 2. Crear tenant (Edge). Reintentable sin recrear el usuario.
      const res = await createTenant({
        name: v.businessName,
        industry,
        cuit: v.cuit || undefined,
        legal_name: v.legalName || undefined,
        iva_condition: v.ivaCondition || undefined,
      });
      await supabase.auth.refreshSession();

      // 3. Código de invitación (no bloqueante).
      await applyFiscalAndCode(res.tenant_id, v.inviteCode);

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
      const res = await createTenant({
        name: v.businessName,
        industry,
        cuit: v.cuit || undefined,
        legal_name: v.legalName || undefined,
        iva_condition: v.ivaCondition || undefined,
      });
      await supabase.auth.refreshSession();
      await applyFiscalAndCode(res.tenant_id, v.inviteCode);
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
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-ninja-flameSoft border-t-transparent" />
      </div>
    );
  }

  const accountErrors = accountForm.formState.errors;
  const businessErrors = businessForm.formState.errors;

  return (
    <div className="overflow-hidden rounded-2xl border border-white/10 bg-card/70 shadow-ninjaSoft backdrop-blur-xl">
      <div className="grid lg:grid-cols-2">
        <ValuePanel />

        <div className="p-6 sm:p-8">
          {/* Header compacto (mobile) */}
          <div className="mb-6 flex items-center gap-2 lg:hidden">
            <Isotype className="h-7 w-auto" priority />
            <WordmarkPos variant="dark" className="h-6 w-auto" priority />
          </div>

          <Stepper step={mode === "sso" ? 2 : step} />

          <div className="mt-6">
            {/* ---------- FLUJO EMAIL ---------- */}
            {mode === "account" && step === 1 && (
              <div className="space-y-5">
                <GoogleButton onClick={onGoogle} loading={googleLoading} />

                <div className="flex items-center gap-3">
                  <span className="h-px flex-1 bg-white/10" />
                  <span className="text-xs uppercase tracking-wider text-ninja-lavender">
                    o con email
                  </span>
                  <span className="h-px flex-1 bg-white/10" />
                </div>

                <form
                  className="space-y-4"
                  noValidate
                  onSubmit={(e) => {
                    e.preventDefault();
                    goToBusiness();
                  }}
                >
                  <Input
                    label="Nombre del negocio"
                    placeholder="Kiosco La Esquina"
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
                    autoComplete="email"
                    error={accountErrors.email?.message}
                    {...accountForm.register("email")}
                  />
                  <Input
                    label="Contraseña"
                    type="password"
                    autoComplete="new-password"
                    hint="Mínimo 10 caracteres, con mayúscula, minúscula y número."
                    error={accountErrors.password?.message}
                    {...accountForm.register("password")}
                  />

                  <FiscalAndCode
                    register={accountForm.register as unknown as UseFormRegister<FieldValues>}
                    cuitError={accountErrors.cuit?.message}
                  />

                  <p className="text-xs text-ninja-lavender">
                    Al continuar aceptás los términos y la política de
                    privacidad de NinjaSoft.
                  </p>

                  <Button type="submit" className="w-full">
                    Continuar
                  </Button>
                </form>

                <p className="text-center text-sm text-ninja-lavender">
                  ¿Ya tenés cuenta?{" "}
                  <Link href="/login" className="text-ninja-flameSoft hover:underline">
                    Ingresá
                  </Link>
                </p>
              </div>
            )}

            {mode === "account" && step === 2 && (
              <div className="space-y-6">
                <SignupStepBusiness
                  value={industry}
                  onChange={(v) => {
                    setIndustry(v);
                    setIndustryError(null);
                  }}
                />
                {industryError && (
                  <p className="text-sm text-destructive">{industryError}</p>
                )}
                <div className="flex gap-3">
                  <Button
                    type="button"
                    variant="secondary"
                    className="flex-1"
                    disabled={submitting}
                    onClick={() => setStep(1)}
                  >
                    Atrás
                  </Button>
                  <Button
                    type="button"
                    className="flex-1"
                    loading={submitting}
                    onClick={submitAccount}
                  >
                    Crear cuenta
                  </Button>
                </div>
              </div>
            )}

            {/* ---------- FLUJO SSO (Google sin tenant) ---------- */}
            {mode === "sso" && (
              <div className="space-y-6">
                <div>
                  <h3 className="font-sans text-xl font-bold tracking-[-0.01em] text-ninja-softWhite">
                    Contanos de tu negocio
                  </h3>
                  <p className="mt-1 text-sm text-ninja-lavender">
                    Ya entraste con Google. Solo falta crear tu negocio.
                  </p>
                </div>

                <form className="space-y-4" noValidate>
                  <Input
                    label="Nombre del negocio"
                    placeholder="Kiosco La Esquina"
                    error={businessErrors.businessName?.message}
                    {...businessForm.register("businessName")}
                  />
                  <FiscalAndCode
                    register={businessForm.register as unknown as UseFormRegister<FieldValues>}
                    cuitError={businessErrors.cuit?.message}
                  />
                </form>

                <SignupStepBusiness
                  value={industry}
                  onChange={(v) => {
                    setIndustry(v);
                    setIndustryError(null);
                  }}
                />
                {industryError && (
                  <p className="text-sm text-destructive">{industryError}</p>
                )}

                <Button
                  type="button"
                  className="w-full"
                  loading={submitting}
                  onClick={submitBusiness}
                >
                  Crear cuenta
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function SignupPage() {
  return (
    <Suspense
      fallback={
        <div className="grid place-items-center py-24">
          <span className="h-6 w-6 animate-spin rounded-full border-2 border-ninja-flameSoft border-t-transparent" />
        </div>
      }
    >
      <SignupWizard />
    </Suspense>
  );
}
