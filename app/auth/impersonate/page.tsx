"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/Card";
import {
  impersonationErrorMessage,
  parseImpersonationFragment,
} from "@/supabase/functions/_shared/impersonation";

// Acceso del staff como el negocio (ADR-084). El link trae en el fragmento el
// token de un uso y el nonce: se inicia la sesión del dueño, se ata la sesión
// de Auth al registro (impersonation_claim) y recién ahí se entra al panel,
// que muestra el banner con la cuenta regresiva. Si el canje falla, se cierra
// la sesión: nunca queda una sesión del dueño sin banner.
export default function ImpersonatePage() {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function run() {
      const parsed = parseImpersonationFragment(window.location.hash);
      // El fragmento no debe quedar en el historial.
      window.history.replaceState({}, document.title, "/auth/impersonate");
      if (!parsed) {
        setError(impersonationErrorMessage("invalid_link"));
        return;
      }
      const supabase = createClient();
      const { error: otpError } = await supabase.auth.verifyOtp({
        type: "magiclink",
        token_hash: parsed.tokenHash,
      });
      if (otpError) {
        setError(impersonationErrorMessage("link_used"));
        return;
      }
      const { error: claimError } = await (supabase as any).rpc("impersonation_claim", {
        p_nonce: parsed.nonce,
      });
      if (claimError) {
        await supabase.auth.signOut({ scope: "local" });
        setError(impersonationErrorMessage(String(claimError.message ?? "")));
        return;
      }
      window.location.replace("/dashboard");
    }
    void run();
  }, []);

  return (
    <div data-theme="ninja-dark" className="grid min-h-dvh place-items-center bg-background px-4 text-foreground">
      <Card className="w-full max-w-md">
        <CardContent className="space-y-3 p-6">
          <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
            Staff NinjaSoft
          </p>
          <h1 className="text-xl font-bold">Acceso como el negocio</h1>
          {error ? (
            <>
              <p className="text-sm text-danger">{error}</p>
              <Link href="/login-internal" className="text-sm font-medium text-ninja-flameSoft hover:underline">
                Volver al panel interno
              </Link>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Abriendo la sesión con la auditoría activa…</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
