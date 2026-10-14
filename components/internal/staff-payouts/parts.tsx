"use client";

// Piezas compartidas del panel de participación del staff (F21 · ADR-121).

import { CircleAlert, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { Callout } from "@/components/ui/Callout";
import { formatCents } from "@/lib/staffPayouts/format";
import type { ExplainStep } from "@/supabase/functions/_shared/staff/settlement";

/** Lista de pasos de un cálculo: concepto a la izquierda, importe a la derecha. */
export function StepsList({ steps, className }: { steps: ExplainStep[]; className?: string }) {
  return (
    <ol className={cn("divide-y divide-border/60 text-sm", className)}>
      {steps.map((s, i) => (
        <li
          key={`${s.label}-${i}`}
          className={cn("flex items-start justify-between gap-3 py-2", s.tone === "total" && "font-semibold")}
        >
          <span className="min-w-0">
            <span className={cn(s.tone === "total" ? "text-foreground" : "text-muted-foreground")}>{s.label}</span>
            {s.detail && <span className="mt-0.5 block text-xs text-muted-foreground">{s.detail}</span>}
          </span>
          <span
            className={cn(
              "shrink-0 tabular-nums",
              s.tone === "minus" && "text-danger",
              s.tone === "plus" && "text-success",
              s.tone === "total" && "text-foreground",
            )}
          >
            {s.tone === "plus" ? formatCents(s.cents, { signed: true }) : formatCents(s.cents)}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function ResultNotices({ warnings, errors }: { warnings: string[]; errors: string[] }) {
  if (!warnings.length && !errors.length) return null;
  return (
    <div className="space-y-2">
      {errors.length > 0 && (
        <Callout tone="danger" icon={CircleAlert} title="Hay que resolver esto antes de cerrar">
          <ul className="list-disc space-y-1 pl-4">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Callout>
      )}
      {warnings.length > 0 && (
        <Callout tone="warning" icon={TriangleAlert} title="Para tener en cuenta">
          <ul className="list-disc space-y-1 pl-4">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Callout>
      )}
    </div>
  );
}

export function Money({ cents, className, strong }: { cents: number; className?: string; strong?: boolean }) {
  return (
    <span className={cn("whitespace-nowrap tabular-nums", cents < 0 && "text-danger", strong && "font-semibold", className)}>
      {formatCents(cents)}
    </span>
  );
}

export function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("rounded-xl border border-border bg-card p-4 sm:p-5", className)}>{children}</div>;
}

export const FIELD_LABEL = "mb-2 block text-sm font-medium text-muted-foreground";
export const NATIVE_SELECT =
  "h-11 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-ring";
