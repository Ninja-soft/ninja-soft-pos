"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Clock } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
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
import { GoogleButton } from "@/components/auth/GoogleButton";
import { useToast } from "@/components/ui/Toast";

export default function LoginPage({
  searchParams,
}: {
  searchParams?: { next?: string; reason?: string };
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [serverError, setServerError] = useState<string | null>(null);
  // Aviso de cierre de sesión por inactividad (?reason=inactivity), seteado por
  // el InactivityGuard del shell.
  const inactivityLogout = searchParams?.reason === "inactivity";
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
    const origin = window.location.origin;
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${origin}/dashboard` },
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
          title: "Google está casi listo — falta habilitarlo",
          variant: "info",
        });
      } else {
        toast({ title: "No pudimos iniciar con Google", variant: "error" });
      }
    }
    // En éxito, el navegador redirige a Google; no hace falta más.
  }

  return (
    <Card>
      <CardHeader>
        <Eyebrow className="mb-2">Acceso</Eyebrow>
        <CardTitle>
          Iniciar <Accent>sesión</Accent>
        </CardTitle>
        <CardDescription>
          {safeNext?.startsWith("/internal")
            ? "Accedé al panel interno de NinjaSoft."
            : "Accedé a tu negocio en NinjaSoft."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {inactivityLogout && (
          <div className="mb-5 flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-warning">
            <Clock size={16} className="mt-0.5 shrink-0" />
            <span>
              Tu sesión se cerró por inactividad. Volvé a iniciar sesión para
              continuar.
            </span>
          </div>
        )}
        <GoogleButton
          label="Ingresar con Google"
          onClick={onGoogle}
          loading={googleLoading}
        />

        <div className="my-6 flex items-center gap-3">
          <span className="h-px flex-1 bg-white/10" />
          <span className="text-xs uppercase tracking-wider text-ninja-lavender">
            o con email
          </span>
          <span className="h-px flex-1 bg-white/10" />
        </div>

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
          {showGoogleHint && (
            <p className="text-sm text-ninja-lavender">
              ¿Te registraste con Google? Usá el botón &quot;Ingresar con
              Google&quot;.
            </p>
          )}
          <Button type="submit" loading={isSubmitting} className="w-full">
            Entrar
          </Button>
        </form>

        <div className="mt-6 space-y-2 text-center text-sm text-ninja-lavender">
          <p>
            <Link href="/recover" className="text-ninja-flameSoft hover:underline">
              Olvidé mi contraseña
            </Link>
          </p>
          <p>
            ¿No tenés cuenta?{" "}
            <Link href="/signup" className="text-ninja-flameSoft hover:underline">
              Crear una
            </Link>
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
