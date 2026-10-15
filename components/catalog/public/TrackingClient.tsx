"use client";

// Piezas de cliente del seguimiento (ADR-130): el código de retiro que el
// servidor devolvió una sola vez (queda en este navegador) y el refresco
// periódico mientras el pedido no terminó.
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRound } from "lucide-react";

export const pickupCodeKey = (token: string) => `ninja-pedido-codigo:${token}`;

export function PickupCode({ token }: { token: string }) {
  const [code, setCode] = useState<string | null>(null);
  useEffect(() => {
    try {
      const k = pickupCodeKey(token);
      const v = sessionStorage.getItem(k) ?? localStorage.getItem(k);
      if (v) {
        setCode(v);
        // Se pasa a localStorage para que siga al volver otro día.
        localStorage.setItem(k, v);
      }
    } catch {
      // Sin almacenamiento: el código está en el email de confirmación.
    }
  }, [token]);
  if (!code) return null;
  return (
    <section className="flex items-center gap-3 rounded-xl border border-neutral-200 bg-white p-4">
      <KeyRound size={20} className="shrink-0 text-neutral-500" aria-hidden />
      <div>
        <p className="text-sm text-neutral-600">Código de retiro</p>
        <p className="text-2xl font-bold tracking-[0.2em] tabular-nums">{code}</p>
        <p className="text-xs text-neutral-500">Mostralo cuando retires el pedido.</p>
      </div>
    </section>
  );
}

export function StatusAutoRefresh({ seconds }: { seconds: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = window.setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, seconds * 1000);
    return () => window.clearInterval(t);
  }, [router, seconds]);
  return null;
}
