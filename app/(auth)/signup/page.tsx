"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { createClient } from "@/lib/supabase/client";
import { SignupSchema, type SignupInput } from "@/modules/auth/schemas";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/Card";

export default function SignupPage() {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignupInput>({ resolver: zodResolver(SignupSchema) });

  async function onSubmit(values: SignupInput) {
    setServerError(null);
    const supabase = createClient();
    const { data, error } = await supabase.auth.signUp({
      email: values.email,
      password: values.password,
      options: { data: { full_name: values.fullName } },
    });
    if (error) {
      setServerError(error.message);
      return;
    }
    // Si la confirmación por email está activa, no hay sesión todavía.
    if (data.session) {
      router.push("/dashboard-team");
      router.refresh();
    } else {
      setDone(true);
    }
  }

  if (done) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Revisá tu email</CardTitle>
          <CardDescription>
            Te enviamos un enlace para confirmar tu cuenta. Confirmá y volvé a
            iniciar sesión.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link href="/login" className="text-sm text-ninja-flameSoft hover:underline">
            Ir a iniciar sesión
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Crear cuenta</CardTitle>
        <CardDescription>Empezá a operar con NinjaSoft.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
          <Input
            label="Nombre completo"
            autoComplete="name"
            error={errors.fullName?.message}
            {...register("fullName")}
          />
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
            autoComplete="new-password"
            hint="Mínimo 10 caracteres, con mayúscula, minúscula y número."
            error={errors.password?.message}
            {...register("password")}
          />
          <Input
            label="Repetir contraseña"
            type="password"
            autoComplete="new-password"
            error={errors.confirmPassword?.message}
            {...register("confirmPassword")}
          />
          {serverError && (
            <p className="text-sm text-destructive">{serverError}</p>
          )}
          <Button type="submit" loading={isSubmitting} className="w-full">
            Crear cuenta
          </Button>
        </form>

        <p className="mt-6 text-center text-sm text-ninja-lavender">
          ¿Ya tenés cuenta?{" "}
          <Link href="/login" className="text-ninja-flameSoft hover:underline">
            Iniciar sesión
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
