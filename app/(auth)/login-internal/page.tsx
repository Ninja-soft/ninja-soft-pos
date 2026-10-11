"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Clock, ShieldCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { LoginSchema, type LoginInput } from "@/modules/auth/schemas";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/Card";
import { Accent, Eyebrow } from "@/components/ui/Typography";

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
    <Card className="border-ninja-flame/30">
      <CardHeader>
        <Eyebrow className="mb-2 flex items-center gap-1.5">
          <ShieldCheck size={13} /> Staff NinjaSoft
        </Eyebrow>
        <CardTitle>
          Panel <Accent>interno</Accent>
        </CardTitle>
        <CardDescription>
          Acceso exclusivo del equipo de NinjaSoft. Toda acción administrativa
          queda auditada.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {inactivityLogout && (
          <div className="mb-5 flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-warning">
            <Clock size={16} className="mt-0.5 shrink-0" />
            <span>Tu sesión se cerró por inactividad. Volvé a iniciar sesión para continuar.</span>
          </div>
        )}
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
          <Input
            label="Email"
            type="email"
            autoComplete="email"
            error={errors.email?.message}
            {...register("email")}
          />
          <Input
            label="Contraseña"
            type="password"
            autoComplete="current-password"
            error={errors.password?.message}
            {...register("password")}
          />
          {serverError && (
            <p className="text-sm text-destructive">{serverError}</p>
          )}
          <Button type="submit" loading={isSubmitting} className="w-full">
            Entrar al panel
          </Button>
        </form>

        <div className="mt-6 space-y-2 text-center text-sm text-ninja-lavender">
          <p>
            <Link href="/recover" className="text-ninja-flameSoft hover:underline">
              Olvidé mi contraseña
            </Link>
          </p>
          <p>
            ¿Sos cliente?{" "}
            <Link href="/login" className="text-ninja-flameSoft hover:underline">
              Ir al acceso del POS
            </Link>
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
