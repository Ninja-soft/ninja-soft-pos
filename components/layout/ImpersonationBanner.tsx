"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import {
  formatRemaining,
  remainingSeconds,
} from "@/supabase/functions/_shared/impersonation";

type Info = {
  id: string;
  tenant_name: string;
  staff_email: string | null;
  reason: string;
  expires_at: string;
};

// Banner del acceso del staff como el negocio (ADR-084). Sólo aparece en la
// sesión que abrió el staff (my_impersonation compara el session_id del JWT):
// el dueño real nunca lo ve. Muestra la cuenta regresiva y al llegar a cero
// (o con "Terminar acceso") cierra la sesión en el servidor y en el navegador.
export function ImpersonationBanner() {
  const { data } = useQuery({
    queryKey: ["my-impersonation"],
    queryFn: async () => {
      const { data: d, error } = await (createClient() as any).rpc("my_impersonation");
      if (error) return null;
      return (d ?? null) as Info | null;
    },
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  const [now, setNow] = useState(() => new Date());
  const ending = useRef(false);

  useEffect(() => {
    if (!data) return;
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, [data]);

  async function finish() {
    if (ending.current) return;
    ending.current = true;
    const supabase = createClient();
    try {
      await (supabase as any).rpc("impersonation_end");
    } finally {
      await supabase.auth.signOut({ scope: "local" });
      window.location.replace("/login-internal?reason=impersonation");
    }
  }

  const left = data ? remainingSeconds(data.expires_at, now) : null;
  useEffect(() => {
    if (left === 0) void finish();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left]);

  if (!data) return null;

  return (
    <div
      role="status"
      className="sticky top-0 z-50 flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-t-2 border-b-border border-t-warning bg-background px-4 py-2 text-sm"
    >
      <span className="inline-flex items-center gap-2 font-semibold text-warning">
        <ShieldAlert size={16} aria-hidden />
        Staff NinjaSoft viendo {data.tenant_name}
      </span>
      <span className="text-muted-foreground">
        {data.staff_email ?? "Staff"} · Motivo: {data.reason}
      </span>
      <span className="ml-auto font-mono tabular-nums text-foreground" aria-label="Tiempo restante">
        {formatRemaining(left ?? 0)}
      </span>
      <button
        type="button"
        onClick={() => void finish()}
        className="rounded-md border border-border px-3 py-1 text-sm font-medium text-foreground transition hover:bg-muted"
      >
        Terminar acceso
      </button>
    </div>
  );
}
