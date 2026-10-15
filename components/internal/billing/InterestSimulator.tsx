"use client";

// =============================================================================
// Simulador de punitorios (F20-9 · ADR-128, spec docs/40 §14.6 punto 3):
// "Deuda de $ 50.000 vencida hace 45 días → $ 3.750". Usa la misma función
// que el cron (lib/billing/interest.ts, espejo exacto de
// platform_interest_schedule): lo que muestra es lo que se devenga.
// =============================================================================

import { useMemo, useState } from "react";
import { Calculator } from "lucide-react";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Callout } from "@/components/ui/Callout";
import { SectionHeader } from "@/components/ui/PageHeader";
import { formatCents, formatDay, parsePesosToCents, todayAR } from "@/lib/billing/ledger";
import { addDays, formatBp, simulateInterest, type InterestPolicy } from "@/lib/billing/interest";
import type { InterestPolicyRow } from "@/modules/billing/mora";

export function toPolicy(p: Pick<InterestPolicyRow, "monthly_rate_bp" | "grace_days" | "method" | "cap_bp" | "min_amount_cents">): InterestPolicy {
  return {
    monthlyRateBp: Number(p.monthly_rate_bp),
    graceDays: Number(p.grace_days),
    method: p.method,
    capBp: p.cap_bp === null || p.cap_bp === undefined ? null : Number(p.cap_bp),
    minAmountCents: Number(p.min_amount_cents),
  };
}

const monthLabel = (m: string) =>
  new Date(`${m}-15T12:00:00Z`).toLocaleDateString("es-AR", { month: "long", year: "numeric" });

/** Resultado del simulador (también lo usa el editor de políticas). */
export function SimulationResult({
  policy,
  capitalCents,
  days,
  holidays,
}: {
  policy: InterestPolicy;
  capitalCents: number;
  days: number;
  holidays: string[];
}) {
  const today = todayAR();
  const r = useMemo(
    () => simulateInterest({ policy, capitalCents, dueDate: addDays(today, -days), asOf: today, holidays, shiftToBusinessDay: false }),
    [policy, capitalCents, days, holidays, today],
  );
  return (
    <div className="space-y-3 rounded-lg bg-muted/60 p-4 text-sm">
      <p className="font-semibold">
        Deuda de {formatCents(capitalCents)} vencida hace {days} días
        <span className="text-muted-foreground"> da </span>
        <span className="tabular-nums">{formatCents(r.accruedCents)}</span> de punitorios
      </p>
      <p className="text-xs text-muted-foreground">
        {r.daysOverdue} días de mora (después de {policy.graceDays} de gracia).
        {r.capReached ? ` Llegó al tope de ${formatBp(policy.capBp)} (${formatCents(r.capCents ?? 0)}).` : ""}
        {r.pendingCents > 0 ? ` ${formatCents(r.pendingCents)} todavía no llegan al mínimo y pasan al mes siguiente.` : ""}
      </p>
      {r.months.length > 0 && (
        <ul className="divide-y divide-border/60 rounded-md bg-card">
          {r.months.map((m) => (
            <li key={m.month} className="flex items-center justify-between gap-3 px-3 py-2">
              <span className="capitalize">{monthLabel(m.month)}</span>
              <span className="tabular-nums">
                {formatCents(m.accruedCents)}
                {m.liquidatedCents !== m.accruedCents && (
                  <span className="ml-2 text-xs text-muted-foreground">se liquida {formatCents(m.liquidatedCents)}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function InterestSimulator({ policies, holidays }: { policies: InterestPolicyRow[]; holidays: string[] }) {
  const active = policies.filter((p) => !p.archived_at);
  const [policyId, setPolicyId] = useState<string | null>(active[0]?.id ?? null);
  const [capital, setCapital] = useState("50.000");
  const [days, setDays] = useState("45");
  const policy = active.find((p) => p.id === policyId) ?? active[0] ?? null;
  const cents = parsePesosToCents(capital);
  const d = Number(days);
  const daysOk = Number.isInteger(d) && d >= 0 && d <= 730;

  return (
    <section>
      <SectionHeader
        title="Simulador"
        icon={Calculator}
        description="La misma cuenta que hace el cron todos los días: lo que ves acá es lo que se devenga."
      />
      <div className="mt-3 space-y-4 rounded-xl border border-border bg-card p-4">
        {active.length === 0 ? (
          <Callout tone="neutral" icon={Calculator} title="No hay políticas activas">
            Creá una política para simular.
          </Callout>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              <Select
                label="Política"
                value={policy?.id ?? null}
                onChange={setPolicyId}
                options={active.map((p) => ({ value: p.id, label: `${p.name} · ${formatBp(p.monthly_rate_bp)} mensual` }))}
              />
              <Input
                label="Deuda ($)"
                inputMode="decimal"
                value={capital}
                onChange={(e) => setCapital(e.target.value)}
                error={capital && cents === null ? "Importe inválido" : undefined}
              />
              <Input
                label="Días desde el vencimiento"
                inputMode="numeric"
                value={days}
                onChange={(e) => setDays(e.target.value.replace(/[^\d]/g, ""))}
                error={daysOk ? undefined : "De 0 a 730 días"}
                hint={daysOk ? `Venció el ${formatDay(addDays(todayAR(), -d))}` : undefined}
              />
            </div>
            {policy && cents !== null && daysOk && (
              <SimulationResult policy={toPolicy(policy)} capitalCents={cents} days={d} holidays={holidays} />
            )}
          </>
        )}
      </div>
    </section>
  );
}
InterestSimulator.displayName = "InterestSimulator";
