"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/Card";

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

      if (code) {
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
    <Card>
      <CardHeader>
        <CardTitle>Blanquear contraseña</CardTitle>
        <CardDescription>
          Definí una nueva contraseña desde el enlace que recibiste por email.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!ready ? (
          <p className="text-sm text-ninja-lavender">Validando enlace...</p>
        ) : sessionError ? (
          <div className="space-y-4">
            <p className="text-sm text-destructive">{sessionError}</p>
            <Link
              href="/recover"
              className="inline-flex h-11 w-full items-center justify-center rounded-lg border border-border bg-secondary px-5 text-sm font-semibold text-secondary-foreground transition hover:bg-secondary/70"
            >
              Enviar otro enlace
            </Link>
          </div>
        ) : done ? (
          <p className="text-sm text-ninja-lavender">
            Contraseña actualizada. Te estamos llevando al login.
          </p>
        ) : (
          <form onSubmit={submit} className="space-y-4" noValidate>
            <Input
              label="Nueva contraseña"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              hint="Mínimo 10 caracteres, una mayúscula, una minúscula y un número."
            />
            <Input
              label="Repetir contraseña"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" loading={loading} className="w-full">
              Guardar nueva contraseña
            </Button>
          </form>
        )}

        <p className="mt-6 text-center text-sm text-ninja-lavender">
          <Link href="/login" className="text-ninja-flameSoft hover:underline">
            Volver a iniciar sesión
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
