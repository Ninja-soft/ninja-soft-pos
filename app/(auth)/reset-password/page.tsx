"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/Button";
import { PasswordInput } from "@/components/auth/PasswordInput";
import { AuthAlert, AuthHeading, AuthLink } from "@/components/auth/AuthBits";

function validatePassword(value: string) {
  if (value.length < 10) return "Mínimo 10 caracteres.";
  if (!/[A-Z]/.test(value)) return "Debe incluir al menos una mayúscula.";
  if (!/[a-z]/.test(value)) return "Debe incluir al menos una minúscula.";
  if (!/[0-9]/.test(value)) return "Debe incluir al menos un número.";
  return null;
}

export default function ResetPasswordPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function prepareRecoverySession() {
      const supabase = createClient();
      const params = new URLSearchParams(window.location.search);
      const code = params.get("code");
      const tokenHash = params.get("token_hash");

      if (tokenHash) {
        // Link de send_password_recovery: verifyOtp funciona en cualquier
        // navegador/dispositivo (no depende del verifier PKCE).
        const { error: otpError } = await supabase.auth.verifyOtp({
          type: "recovery",
          token_hash: tokenHash,
        });
        if (otpError) {
          setSessionError("El enlace no es válido o ya expiró.");
          setReady(true);
          return;
        }
        window.history.replaceState({}, document.title, "/reset-password");
      } else if (code) {
        const { error: exchangeError } =
          await supabase.auth.exchangeCodeForSession(code);
        if (exchangeError) {
          setSessionError("El enlace no es válido o ya expiró.");
          setReady(true);
          return;
        }
        window.history.replaceState({}, document.title, "/reset-password");
      }

      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) {
        setSessionError("Necesitás abrir el enlace de recuperación desde tu email.");
      }
      setReady(true);
    }

    void prepareRecoverySession();
  }, []);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const passwordError = validatePassword(password);
    if (passwordError) {
      setError(passwordError);
      return;
    }
    if (password !== confirm) {
      setError("Las contraseñas no coinciden.");
      return;
    }

    setLoading(true);
    const { error: err } = await createClient().auth.updateUser({ password });
    setLoading(false);
    if (err) {
      setError(err.message);
      return;
    }
    setDone(true);
    setTimeout(() => router.push("/login"), 1200);
  }

  return (
    <>
      <AuthHeading
        title="Creá una nueva contraseña"
        description="Definí tu nueva contraseña desde el enlace que recibiste por email."
      />

      {!ready ? (
        <p role="status" className="text-sm text-muted-foreground">
          Validando enlace...
        </p>
      ) : sessionError ? (
        <div className="space-y-5">
          <AuthAlert>{sessionError}</AuthAlert>
          <Link
            href="/recover"
            className="inline-flex h-11 w-full items-center justify-center rounded-lg border border-border bg-secondary px-5 text-sm font-semibold text-secondary-foreground outline-none transition hover:bg-secondary/70 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            Enviar otro enlace
          </Link>
        </div>
      ) : done ? (
        <p role="status" className="text-sm text-muted-foreground">
          Contraseña actualizada. Te estamos llevando al inicio de sesión.
        </p>
      ) : (
        <form onSubmit={submit} className="space-y-5" noValidate>
          <PasswordInput
            label="Nueva contraseña"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            hint="Mínimo 10 caracteres, una mayúscula, una minúscula y un número."
          />
          <PasswordInput
            label="Repetir contraseña"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
          {error && <AuthAlert>{error}</AuthAlert>}
          <Button type="submit" loading={loading} className="w-full">
            Guardar nueva contraseña
          </Button>
        </form>
      )}

      <p className="mt-8 text-center text-sm text-muted-foreground">
        <AuthLink href="/login">Volver a iniciar sesión</AuthLink>
      </p>
    </>
  );
}
