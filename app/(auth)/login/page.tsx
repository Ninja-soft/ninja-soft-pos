"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
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

export default function LoginPage() {
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
    router.push("/dashboard-team");
    router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <Eyebrow className="mb-2">Acceso</Eyebrow>
        <CardTitle>
          Iniciar <Accent>sesión</Accent>
        </CardTitle>
        <CardDescription>Accedé a tu negocio en NinjaSoft.</CardDescription>
      </CardHeader>
      <CardContent>
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
