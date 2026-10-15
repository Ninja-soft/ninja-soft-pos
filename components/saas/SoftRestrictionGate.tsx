"use client";

// =============================================================================
// Restricción blanda de la escalera de mora (F20-9 · ADR-128, spec docs/40
// §11.1 día +7). Con la restricción activa, las secciones configuradas
// (reportes, configuración, importaciones, integraciones) muestran un aviso
// para regularizar en lugar del contenido. Vender, cobrar, la caja, las
// devoluciones y el panel del dueño nunca se tocan (lib/billing/mora.ts →
// NEVER_RESTRICTED): no se corta ninguna venta en curso. La barrera dura sigue
// siendo la suspensión (assert_account_active en el servidor).
// =============================================================================

import Link from "next/link";
import type { Route } from "next";
import { usePathname } from "next/navigation";
import { Lock } from "lucide-react";
import { formatDay } from "@/lib/billing/ledger";
import { RESTRICT_AREAS, restrictedAreaFor } from "@/lib/billing/mora";
import { useMyRestriction } from "@/modules/billing/mora";

export function SoftRestrictionGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "";
  const { data } = useMyRestriction();
  const area = data?.soft_restricted ? restrictedAreaFor(pathname, data.areas) : null;
  if (!area || !data) return <>{children}</>;
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-lg flex-col items-center justify-center gap-4 px-4 py-12 text-center">
      <span className="grid h-14 w-14 place-items-center rounded-lg bg-warning/15 text-warning" aria-hidden>
        <Lock size={24} />
      </span>
      <div className="space-y-2">
        <h1 className="font-display text-xl font-bold">{RESTRICT_AREAS[area].label}: limitado por un pago pendiente</h1>
        <p className="text-sm text-muted-foreground">
          Podés seguir vendiendo y cobrando con normalidad. Esta sección vuelve apenas se registre el pago.
          {data.suspend_on ? ` Si no se regulariza, la cuenta se suspende el ${formatDay(data.suspend_on)}.` : ""}
        </p>
      </div>
      {data.is_manager ? (
        <Link
          href={"/dashboard-team#mora" as Route}
          className="inline-flex h-11 items-center rounded-lg bg-[var(--pos-solid)] px-5 text-sm font-semibold text-white transition-colors hover:bg-[var(--pos-solid-hover)]"
        >
          Regularizar mi cuenta
        </Link>
      ) : (
        <p className="text-sm font-medium">Avisale al dueño del negocio para que regularice el pago.</p>
      )}
    </div>
  );
}
SoftRestrictionGate.displayName = "SoftRestrictionGate";
