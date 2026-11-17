"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { safeNextPath } from "@/lib/auth/redirect";
import {
  INTERNAL_HOME_PATH,
  MFA_ENROLL_PATH,
  isTotpCode,
  normalizeTotpCode,
} from "@/lib/auth/internalMfa";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Spinner } from "@/components/ui/Spinner";
import { AuthAlert, AuthHeading } from "@/components/auth/AuthBits";

type Factor = { id: string; friendly_name?: string | null };

// Segundo paso del login del staff (SEC-23, ADR-186): pide el código de la app
// autenticadora y sube la sesión a aal2. El middleware manda acá al staff con
// factor verificado y sesión aal1 cuando el flag internal_mfa_required está
// prendido.
export default function LoginMfaPage({
  searchParams,
}: {
  searchParams?: { next?: string };
}) {
  const router = useRouter();
  const next = safeNextPath(searchParams?.next, INTERNAL_HOME_PATH);
  const [loading, setLoading] = useState(true);
  const [factors, setFactors] = useState<Factor[]>([]);
  const [factorId, setFactorId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const supabase = createClient();
      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (aal?.currentLevel === "aal2") {
        router.replace(next as never);
        return;
      }
      const { data, error: listErr } = await supabase.auth.mfa.listFactors();
      if (!alive) return;
      if (listErr) setError("No pudimos leer tus factores. Volvé a iniciar sesión.");
      const totp = (data?.totp ?? []).map((f) => ({ id: f.id, friendly_name: f.friendly_name }));
      setFactors(totp);
      setFactorId(totp[0]?.id ?? null);
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [next, router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!factorId) return;
    if (!isTotpCode(code)) {
      setError("El código tiene 6 dígitos.");
      return;
    }
    setError(null);
    setSubmitting(true);
    const supabase = createClient();
    const { error: vErr } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
    if (vErr) {
      setSubmitting(false);
      setCode("");
      setError("Código incorrecto o vencido. Probá con el código nuevo de la app.");
      return;
    }
    router.replace(next as never);
    router.refresh();
  }

  async function signOut() {
    await createClient().auth.signOut();
    router.replace("/login-internal");
    router.refresh();
  }

  return (
    <>
      <AuthHeading
        title="Verificación en dos pasos"
        description="Escribí el código de 6 dígitos que muestra tu app autenticadora (Google Authenticator, 1Password, Authy…)."
      />

      {loading ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : factors.length === 0 ? (
        <div className="space-y-5">
          <AuthAlert>{error ?? "Tu cuenta todavía no tiene una app autenticadora configurada."}</AuthAlert>
          <Button className="w-full" onClick={() => router.replace(MFA_ENROLL_PATH as never)}>
            Configurar ahora
          </Button>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="space-y-5" noValidate>
          {factors.length > 1 && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-foreground">App autenticadora</p>
              <div className="flex flex-wrap gap-2">
                {factors.map((f) => (
                  <Button
                    key={f.id}
                    type="button"
                    size="sm"
                    variant={f.id === factorId ? "primary" : "secondary"}
                    onClick={() => setFactorId(f.id)}
                  >
                    {f.friendly_name || "App autenticadora"}
                  </Button>
                ))}
              </div>
            </div>
          )}
          <Input
            label="Código"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            maxLength={6}
            placeholder="123456"
            value={code}
            onChange={(e) => setCode(normalizeTotpCode(e.target.value))}
            className="text-center font-mono text-lg tracking-[0.4em]"
          />
          {error && <AuthAlert>{error}</AuthAlert>}
          <Button type="submit" loading={submitting} disabled={code.length !== 6} className="w-full">
            Verificar
          </Button>
        </form>
      )}

      <p className="mt-8 text-center text-sm text-muted-foreground">
        ¿Perdiste el teléfono? Pedile a un super admin que resetee tu verificación.{" "}
        <button
          type="button"
          onClick={signOut}
          className="rounded-sm font-medium text-ninja-flameSoft underline-offset-4 outline-none hover:underline focus-visible:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          Cerrar sesión
        </button>
      </p>
    </>
  );
}
