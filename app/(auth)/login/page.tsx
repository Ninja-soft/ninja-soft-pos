"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Clock } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { createClient } from "@/lib/supabase/client";
import { LoginSchema, type LoginInput } from "@/modules/auth/schemas";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { GoogleButton } from "@/components/auth/GoogleButton";
import { PasswordInput } from "@/components/auth/PasswordInput";
import {
  AuthAlert,
  AuthDivider,
  AuthHeading,
  AuthLink,
} from "@/components/auth/AuthBits";
import { useToast } from "@/components/ui/Toast";
import { callbackUrl, safeNextPath } from "@/lib/auth/redirect";
import { appOrigin } from "@/lib/site";

export default function LoginPage({
  searchParams,
}: {
  searchParams?: { next?: string; reason?: string; error?: string };
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [serverError, setServerError] = useState<string | null>(null);
  // Aviso de cierre de sesión por inactividad (?reason=inactivity), seteado por
  // el InactivityGuard del shell.
  const inactivityLogout = searchParams?.reason === "inactivity";
  // Vuelta fallida del OAuth (/auth/callback sin código válido).
  const oauthError = searchParams?.error === "oauth";
  // Tras un fallo de credenciales no sabemos el proveedor (pre-auth no lo
  // expone por email), así que mostramos siempre el hint de Google.
  const [showGoogleHint, setShowGoogleHint] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginInput>({ resolver: zodResolver(LoginSchema) });

  const next = searchParams?.next;
  const safeNext = next?.startsWith("/") && !next.startsWith("//") ? next : null;

  async function onSubmit(values: LoginInput) {
    setServerError(null);
    setShowGoogleHint(false);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword(values);
    if (error) {
      setServerError("Email o contraseña incorrectos.");
      setShowGoogleHint(true);
      return;
    }
    router.push((safeNext ?? "/dashboard") as never);
    router.refresh();
  }

  async function onGoogle() {
    setServerError(null);
    setShowGoogleHint(false);
    setGoogleLoading(true);
    const supabase = createClient();
    const origin = appOrigin();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: callbackUrl(origin, safeNextPath(safeNext)) },
    });
    if (error) {
      setGoogleLoading(false);
      const msg = error.message?.toLowerCase() ?? "";
      if (
        msg.includes("provider") ||
        msg.includes("not enabled") ||
        msg.includes("disabled")
      ) {
        toast({
          title: "Google está casi listo: falta habilitarlo",
          variant: "info",
        });
      } else {
        toast({ title: "No pudimos iniciar con Google", variant: "error" });
      }
    }
    // En éxito, el navegador redirige a Google; no hace falta más.
  }

  return (
    <>
      <AuthHeading
        title="Iniciá sesión"
        description={
          safeNext?.startsWith("/internal")
            ? "Accedé al panel interno de NinjaSoft."
            : "Entrá a tu negocio en Ninja POS."
        }
      />

      {(oauthError || inactivityLogout) && (
        <div className="mb-6 space-y-3">
          {oauthError && (
            <AuthAlert>
              No pudimos completar el ingreso con Google. Probá de nuevo.
            </AuthAlert>
          )}
          {inactivityLogout && (
            <div
              role="status"
              className="flex items-start gap-2.5 rounded-lg bg-amber-500/10 p-3 text-sm text-warning"
            >
              <Clock size={16} className="mt-0.5 shrink-0" aria-hidden />
              <span>
                Tu sesión se cerró por inactividad. Volvé a iniciar sesión para
                continuar.
              </span>
            </div>
          )}
        </div>
      )}

      <GoogleButton
        label="Continuar con Google"
        onClick={onGoogle}
        loading={googleLoading}
      />

      <AuthDivider label="o con tu email" />

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-5" noValidate>
        <Input
          label="Email"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="nombre@negocio.com"
          error={errors.email?.message}
          {...register("email")}
        />
        <PasswordInput
          label="Contraseña"
          autoComplete="current-password"
          error={errors.password?.message}
          labelAside={
            <AuthLink href="/recover" className="text-sm">
              Olvidé mi contraseña
            </AuthLink>
          }
          {...register("password")}
        />
        {serverError && (
          <AuthAlert>
            <p>{serverError}</p>
            {showGoogleHint && (
              <p className="mt-1 text-muted-foreground">
                Si te registraste con Google, usá &quot;Continuar con
                Google&quot;.
              </p>
            )}
          </AuthAlert>
        )}
        <Button type="submit" loading={isSubmitting} className="w-full">
          Iniciar sesión
        </Button>
      </form>

      <p className="mt-8 text-center text-sm text-muted-foreground">
        ¿No tenés cuenta? <AuthLink href="/signup">Crear cuenta</AuthLink>
      </p>
    </>
  );
}
