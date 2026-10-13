"use client";

import { useState } from "react";
import { MailCheck } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { createClient } from "@/lib/supabase/client";
import { RecoverSchema, type RecoverInput } from "@/modules/auth/schemas";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { AuthHeading, AuthLink } from "@/components/auth/AuthBits";
import { appOrigin } from "@/lib/site";

export default function RecoverPage() {
  const [sent, setSent] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<RecoverInput>({ resolver: zodResolver(RecoverSchema) });

  async function onSubmit(values: RecoverInput) {
    const supabase = createClient();
    // Email con la plantilla propia (Resend/SMTP), no el mailer de Supabase.
    await supabase.functions.invoke("send_password_recovery", {
      body: { email: values.email, origin: appOrigin() },
    });
    // No revelamos si el email existe (anti enumeración).
    setSent(true);
  }

  return (
    <>
      <AuthHeading
        title="Recuperá tu contraseña"
        description="Ingresá el email de tu cuenta y te enviamos un enlace para crear una nueva."
      />

      {sent ? (
        <div
          role="status"
          className="flex items-start gap-2.5 rounded-lg bg-muted p-4 text-sm text-foreground"
        >
          <MailCheck size={18} className="mt-0.5 shrink-0 text-success" aria-hidden />
          <span>
            Si el email está registrado, vas a recibir un enlace en breve.
            Revisá también la carpeta de spam.
          </span>
        </div>
      ) : (
        <form
          onSubmit={handleSubmit(onSubmit)}
          className="space-y-5"
          noValidate
        >
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
          <Button type="submit" loading={isSubmitting} className="w-full">
            Enviar enlace
          </Button>
        </form>
      )}

      <p className="mt-8 text-center text-sm text-muted-foreground">
        ¿La recordaste? <AuthLink href="/login">Iniciar sesión</AuthLink>
      </p>
    </>
  );
}
