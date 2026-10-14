"use client";

// =============================================================================
// Simulador de la liquidación (F21 · ADR-121): números inventados y editables
// que pasan por el MISMO motor que la liquidación real, con el resultado paso
// a paso. No lee ni escribe la base.
// =============================================================================

import { useMemo, useState } from "react";
import { BadgeCheck, Calculator, Plus, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { Badge } from "@/components/ui/Badge";
import { SectionHeader } from "@/components/ui/PageHeader";
import {
  allocate,
  checkInvariant,
  computeSettlement,
  explainBase,
  explainLine,
  type MoneyItem,
  type SettlementInput,
  type StaffExpense,
} from "@/supabase/functions/_shared/staff/settlement";
import { formatBp, formatCents } from "@/lib/staffPayouts/format";
import { Card, FIELD_LABEL, Money, NATIVE_SELECT, ResultNotices, StepsList } from "./parts";

interface SimPerson {
  name: string;
  pct: string;
  expPct: string;
}
interface SimClient {
  name: string;
  amount: string;
  bonusPerson: string; // índice o ""
  bonusPct: string;
}
interface SimExpense {
  name: string;
  amount: string;
  currency: "ARS" | "USD";
  annual: boolean;
  allocation: "proportional" | "single" | "house";
  person: string; // índice para "single"
  exempt: string; // índice eximido o ""
}

const EXAMPLE = {
  persons: [
    { name: "Juan", pct: "40", expPct: "" },
    { name: "Ana", pct: "30", expPct: "" },
  ] as SimPerson[],
  clients: [
    { name: "Kiosco Centro", amount: "600000", bonusPerson: "", bonusPct: "" },
    { name: "Cliente Z", amount: "400000", bonusPerson: "1", bonusPct: "10" },
  ] as SimClient[],
  fees: "40000",
  refunds: "0",
  fx: "1450",
  reserve: "0",
  houseAbsorbs: true,
  expenses: [
    { name: "Servidor", amount: "25", currency: "USD", annual: false, allocation: "single", person: "1", exempt: "" },
    { name: "Dominio anual", amount: "120000", currency: "ARS", annual: true, allocation: "proportional", person: "0", exempt: "0" },
  ] as SimExpense[],
};

const num = (s: string) => {
  const n = Number(String(s).replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
};
const pctBp = (s: string) => Math.max(0, Math.min(10_000, Math.round(num(s) * 100)));
const pesos = (s: string) => Math.max(0, Math.round(num(s) * 100));

export function buildSimulation(s: typeof EXAMPLE): SettlementInput {
  const members = s.persons.map((p, i) => ({ id: `p${i}`, name: p.name || `Persona ${i + 1}` }));
  const period = "2026-01-01";
  const totalGross = s.clients.reduce((a, c) => a + pesos(c.amount), 0);
  const feeSplit =
    allocate(
      Math.min(pesos(s.fees), totalGross),
      s.clients.map((c, i) => ({ key: `c${i}`, w: pesos(c.amount) })),
    ) ?? new Map<string, number>();
  const items: MoneyItem[] = s.clients
    .map((c, i) => ({
      source: "payment" as const,
      id: `pay${i}`,
      tenant_id: `c${i}`,
      tenant_name: c.name || `Cliente ${i + 1}`,
      date: "2026-01-10",
      amount_cents: pesos(c.amount),
      fee_cents: feeSplit.get(`c${i}`) ?? 0,
    }))
    .filter((x) => x.amount_cents > 0);
  if (pesos(s.refunds) > 0 && s.clients[0]) {
    items.push({
      source: "reversal",
      id: "rev0",
      tenant_id: "c0",
      tenant_name: s.clients[0].name || "Cliente 1",
      date: "2026-01-20",
      amount_cents: -pesos(s.refunds),
      fee_cents: 0,
    });
  }
  const expenses: StaffExpense[] = s.expenses
    .filter((e) => num(e.amount) > 0)
    .map((e, i) => ({
      id: `e${i}`,
      name: e.name || `Gasto ${i + 1}`,
      category: "otros",
      amount_cents: Math.round(num(e.amount) * 100),
      currency: e.currency,
      recurrence: e.annual ? "yearly" : "monthly",
      interval_n: null,
      start_date: "2026-01-05",
      end_date: null,
      spread_months: e.annual ? 12 : 1,
      allocation: e.allocation,
      member_id: e.allocation === "single" ? `p${e.person || "0"}` : null,
      tenant_id: null,
      custom: [],
      exemptions: e.exempt !== "" ? [{ member_id: `p${e.exempt}`, valid_from: null, valid_to: null }] : [],
      period_amounts: [],
    }));
  return {
    period,
    settings: { houseAbsorbsExpenses: s.houseAbsorbs, negativeCarry: true, incomeTaxReserveBp: pctBp(s.reserve) },
    members,
    shares: s.persons.map((p, i) => ({
      member_id: `p${i}`,
      share_bp: pctBp(p.pct),
      expense_bp: p.expPct.trim() === "" ? null : pctBp(p.expPct),
      valid_from: "2026-01-01",
      valid_to: null,
    })),
    clientRules: s.clients
      .map((c, i) =>
        c.bonusPerson !== "" && pctBp(c.bonusPct) > 0
          ? { id: `r${i}`, member_id: `p${c.bonusPerson}`, tenant_id: `c${i}`, kind: "bonus_bp" as const, value: pctBp(c.bonusPct), valid_from: "2026-01-01", valid_to: null }
          : null,
      )
      .filter((r): r is NonNullable<typeof r> => r !== null),
    appliedSignupRuleIds: [],
    items,
    expenses,
    fxRates: [{ period, currency: "USD", rate: Math.max(0.0001, num(s.fx)) }],
    adjustments: [],
    carryIn: [],
  };
}

export function SimulatorTab({ houseLabel = "NinjaSoft" }: { houseLabel?: string }) {
  const [s, setS] = useState(EXAMPLE);
  const input = useMemo(() => buildSimulation(s), [s]);
  const r = useMemo(() => computeSettlement(input), [input]);
  const exact = checkInvariant(r);
  const sharesTotal = input.shares.reduce((a, x) => a + x.share_bp, 0);

  const upd = <K extends keyof typeof EXAMPLE>(k: K, v: (typeof EXAMPLE)[K]) => setS((p) => ({ ...p, [k]: v }));
  const updArr = <K extends "persons" | "clients" | "expenses">(k: K, i: number, patch: Partial<(typeof EXAMPLE)[K][number]>) =>
    setS((p) => ({ ...p, [k]: (p[k] as object[]).map((x, j) => (j === i ? { ...x, ...patch } : x)) }));
  const personOptions = s.persons.map((p, i) => ({ value: String(i), label: p.name || `Persona ${i + 1}` }));

  return (
    <div className="space-y-6">
      <SectionHeader
        icon={Calculator}
        title="Simulador"
        description="Probá con números inventados cómo se reparte un mes. Usa el mismo cálculo que la liquidación real; no guarda nada."
        actions={
          <Button variant="secondary" size="sm" onClick={() => setS(EXAMPLE)}>
            <RotateCcw size={14} aria-hidden /> Volver al ejemplo
          </Button>
        }
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {/* ── Datos ───────────────────────────────────────────────────── */}
        <div className="space-y-4">
          <Card>
            <h3 className="font-semibold">Lo que se cobró en el mes</h3>
            <p className="mt-1 text-xs text-muted-foreground">Un renglón por cliente. El bonus suma puntos a una persona sólo en ese cliente.</p>
            <div className="mt-3 space-y-3">
              {s.clients.map((c, i) => (
                <div key={i} className="grid grid-cols-2 gap-2 sm:grid-cols-[1.3fr_1fr_1fr_0.7fr_auto] sm:items-end">
                  <Input label={i === 0 ? "Cliente" : undefined} aria-label="Cliente" value={c.name} onChange={(e) => updArr("clients", i, { name: e.target.value })} />
                  <Input label={i === 0 ? "Cobrado ($)" : undefined} aria-label="Cobrado" inputMode="decimal" value={c.amount} onChange={(e) => updArr("clients", i, { amount: e.target.value })} />
                  <div>
                    {i === 0 && <span className={FIELD_LABEL}>Bonus para</span>}
                    <select aria-label="Bonus para" className={NATIVE_SELECT} value={c.bonusPerson} onChange={(e) => updArr("clients", i, { bonusPerson: e.target.value })}>
                      <option value="">Nadie</option>
                      {personOptions.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <Input label={i === 0 ? "+ %" : undefined} aria-label="Bonus %" inputMode="decimal" value={c.bonusPct} onChange={(e) => updArr("clients", i, { bonusPct: e.target.value })} />
                  <Button variant="ghost" size="icon" aria-label="Quitar cliente" onClick={() => upd("clients", s.clients.filter((_, j) => j !== i))}>
                    <Trash2 size={15} />
                  </Button>
                </div>
              ))}
              <Button variant="ghost" size="sm" onClick={() => upd("clients", [...s.clients, { name: "", amount: "0", bonusPerson: "", bonusPct: "" }])}>
                <Plus size={14} aria-hidden /> Agregar cliente
              </Button>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <Input label="Comisiones de cobro ($)" inputMode="decimal" value={s.fees} onChange={(e) => upd("fees", e.target.value)} />
              <Input label="Reintegros y contracargos ($)" inputMode="decimal" value={s.refunds} onChange={(e) => upd("refunds", e.target.value)} />
              <Input label="Reserva de impuestos (%)" inputMode="decimal" value={s.reserve} onChange={(e) => upd("reserve", e.target.value)} />
            </div>
          </Card>

          <Card>
            <h3 className="font-semibold">Personas</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              % sobre el cobrado neto. &quot;% de gastos&quot; vacío = el mismo. Lo que no se reparte queda para {houseLabel}.
            </p>
            <div className="mt-3 space-y-3">
              {s.persons.map((p, i) => (
                <div key={i} className="grid grid-cols-[1.4fr_1fr_1fr_auto] items-end gap-2">
                  <Input label={i === 0 ? "Nombre" : undefined} aria-label="Nombre" value={p.name} onChange={(e) => updArr("persons", i, { name: e.target.value })} />
                  <Input label={i === 0 ? "%" : undefined} aria-label="Participación" inputMode="decimal" value={p.pct} onChange={(e) => updArr("persons", i, { pct: e.target.value })} />
                  <Input label={i === 0 ? "% de gastos" : undefined} aria-label="% de gastos" inputMode="decimal" placeholder="igual" value={p.expPct} onChange={(e) => updArr("persons", i, { expPct: e.target.value })} />
                  <Button variant="ghost" size="icon" aria-label="Quitar persona" disabled={s.persons.length <= 1} onClick={() => upd("persons", s.persons.filter((_, j) => j !== i))}>
                    <Trash2 size={15} />
                  </Button>
                </div>
              ))}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Button variant="ghost" size="sm" onClick={() => upd("persons", [...s.persons, { name: "", pct: "0", expPct: "" }])}>
                  <Plus size={14} aria-hidden /> Agregar persona
                </Button>
                <span className={sharesTotal > 10_000 ? "text-sm text-danger" : "text-sm text-muted-foreground"}>
                  Repartido {formatBp(sharesTotal)} · {houseLabel} {formatBp(Math.max(0, 10_000 - sharesTotal))}
                </span>
              </div>
            </div>
          </Card>

          <Card>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-semibold">Gastos del mes</h3>
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <Switch checked={s.houseAbsorbs} onCheckedChange={(v) => upd("houseAbsorbs", v)} label="La casa absorbe gastos" />
                {houseLabel} absorbe con su parte
              </label>
            </div>
            <div className="mt-3 space-y-4">
              {s.expenses.map((e, i) => (
                <div key={i} className="space-y-2 rounded-lg bg-fg-4 p-3">
                  <div className="grid grid-cols-[1.4fr_1fr_0.8fr_auto] items-end gap-2">
                    <Input aria-label="Gasto" value={e.name} onChange={(ev) => updArr("expenses", i, { name: ev.target.value })} />
                    <Input aria-label="Monto" inputMode="decimal" value={e.amount} onChange={(ev) => updArr("expenses", i, { amount: ev.target.value })} />
                    <select aria-label="Moneda" className={NATIVE_SELECT} value={e.currency} onChange={(ev) => updArr("expenses", i, { currency: ev.target.value as "ARS" | "USD" })}>
                      <option value="ARS">$</option>
                      <option value="USD">USD</option>
                    </select>
                    <Button variant="ghost" size="icon" aria-label="Quitar gasto" onClick={() => upd("expenses", s.expenses.filter((_, j) => j !== i))}>
                      <Trash2 size={15} />
                    </Button>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-3">
                    <select aria-label="Asignación" className={NATIVE_SELECT} value={e.allocation} onChange={(ev) => updArr("expenses", i, { allocation: ev.target.value as SimExpense["allocation"] })}>
                      <option value="proportional">Proporcional</option>
                      <option value="single">Todo a una persona</option>
                      <option value="house">Lo absorbe {houseLabel}</option>
                    </select>
                    {e.allocation === "single" ? (
                      <select aria-label="Persona" className={NATIVE_SELECT} value={e.person} onChange={(ev) => updArr("expenses", i, { person: ev.target.value })}>
                        {personOptions.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    ) : e.allocation === "proportional" ? (
                      <select aria-label="Eximir" className={NATIVE_SELECT} value={e.exempt} onChange={(ev) => updArr("expenses", i, { exempt: ev.target.value })}>
                        <option value="">Nadie eximido</option>
                        {personOptions.map((o) => (
                          <option key={o.value} value={o.value}>
                            Eximir a {o.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span />
                    )}
                    <label className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Switch checked={e.annual} onCheckedChange={(v) => updArr("expenses", i, { annual: v })} label="Anual prorrateado" />
                      Anual en 12 cuotas
                    </label>
                  </div>
                </div>
              ))}
              <div className="flex flex-wrap items-end justify-between gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => upd("expenses", [...s.expenses, { name: "", amount: "0", currency: "ARS", annual: false, allocation: "proportional", person: "0", exempt: "" }])}
                >
                  <Plus size={14} aria-hidden /> Agregar gasto
                </Button>
                <div className="w-40">
                  <Input label="Dólar ($ por USD)" inputMode="decimal" value={s.fx} onChange={(e) => upd("fx", e.target.value)} />
                </div>
              </div>
            </div>
          </Card>
        </div>

        {/* ── Resultado ───────────────────────────────────────────────── */}
        <div className="space-y-4">
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-semibold">Paso a paso</h3>
              {exact && (
                <Badge tone="success">
                  <BadgeCheck size={13} aria-hidden className="mr-1 inline" />
                  Cierra exacto al centavo
                </Badge>
              )}
            </div>
            <StepsList className="mt-2" steps={explainBase(r, input.settings.incomeTaxReserveBp)} />
          </Card>
          <ResultNotices warnings={r.warnings} errors={r.errors} />
          {r.lines.map((l) => (
            <Card key={l.member_id}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="font-semibold">{l.name}</h3>
                <span className="text-sm text-muted-foreground">
                  {formatBp(l.share_bp_end)} de participación
                  {l.expense_bp_end !== l.share_bp_end ? ` · ${formatBp(l.expense_bp_end)} de gastos` : ""}
                </span>
              </div>
              <StepsList className="mt-2" steps={explainLine(l)} />
              <p className="mt-3 rounded-lg bg-fg-4 px-3 py-2 text-sm">
                {l.payable_cents > 0 ? (
                  <>
                    NinjaPOS le liquida <strong className="tabular-nums">{formatCents(l.payable_cents)}</strong>.
                  </>
                ) : (
                  <>No cobra este mes: el negativo se descuenta el mes próximo.</>
                )}
              </p>
            </Card>
          ))}
          <Card>
            <h3 className="font-semibold">{houseLabel} (la casa)</h3>
            <dl className="mt-2 space-y-1.5 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Su parte de lo cobrado</dt>
                <dd><Money cents={r.house.income_cents} /></dd>
              </div>
              {r.house.signup_cents !== 0 && (
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Comisiones de alta que paga</dt>
                  <dd><Money cents={r.house.signup_cents} /></dd>
                </div>
              )}
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Gastos que absorbe</dt>
                <dd><Money cents={-r.house.expense_cents} /></dd>
              </div>
              <div className="flex justify-between border-t border-border pt-1.5 font-semibold">
                <dt>Neto de la casa</dt>
                <dd><Money cents={r.house.net_cents} /></dd>
              </div>
            </dl>
          </Card>
        </div>
      </div>
    </div>
  );
}
