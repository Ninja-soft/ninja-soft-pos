"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Clock } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { LoginSchema, type LoginInput } from "@/modules/auth/schemas";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { PasswordInput } from "@/components/auth/PasswordInput";
import { AuthAlert, AuthHeading, AuthLink } from "@/components/auth/AuthBits";

export default function LoginInternalPage({
  searchParams,
}: {
  searchParams?: { reason?: string };
}) {
  const inactivityLogout = searchParams?.reason === "inactivity";
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginInput>({ resolver: zodResolver(LoginSchema) });

  async function onSubmit(values: LoginInput) {
    setServerError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword(values);
    if (error) {
      setServerError("Email o contraseña incorrectos.");
      return;
    }
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user?.app_metadata?.is_internal !== true) {
      await supabase.auth.signOut();
      setServerError("Esta cuenta no tiene acceso al panel interno de NinjaSoft.");
      return;
    }
    router.push("/internal/tenants");
    router.refresh();
  }

  return (
    <>
      <AuthHeading
        title="Panel interno"
        description="Acceso exclusivo del equipo de NinjaSoft. Toda acción administrativa queda auditada."
      />

      {inactivityLogout && (
        <div
          role="status"
          className="mb-6 flex items-start gap-2.5 rounded-lg bg-amber-500/10 p-3 text-sm text-warning"
        >
          <Clock size={16} className="mt-0.5 shrink-0" aria-hidden />
          <span>
            Tu sesión se cerró por inactividad. Volvé a iniciar sesión para
            continuar.
          </span>
        </div>
      )}
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-5" noValidate>
        <Input
          label="Email"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
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
        {serverError && <AuthAlert>{serverError}</AuthAlert>}
        <Button type="submit" loading={isSubmitting} className="w-full">
          Entrar al panel
        </Button>
      </form>

      <p className="mt-8 text-center text-sm text-muted-foreground">
        ¿Sos cliente? <AuthLink href="/login">Ir al acceso del POS</AuthLink>
      </p>
    </>
  );
}
