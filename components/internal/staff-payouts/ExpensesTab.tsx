"use client";

// Gastos (F21 · ADR-121): servidores, dominios, servicios, sueldos,
// impuestos, comisiones y otros, con recurrencia, moneda, prorrateo y a quién
// se le descuentan. Cotización del dólar por mes.

import { useMemo, useState } from "react";
import { CalendarRange, DollarSign, Pencil, Plus, Receipt, Trash2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Segmented } from "@/components/ui/Segmented";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionHeader } from "@/components/ui/PageHeader";
import { useToast } from "@/components/ui/Toast";
import { ReasonField } from "@/components/internal/billing/LedgerModals";
import { todayAR } from "@/lib/billing/ledger";
import {
  ALLOCATION_LABEL,
  CATEGORY_LABEL,
  RECURRENCE_LABEL,
  formatBp,
  formatCents,
  formatDay,
  monthLabel,
  parsePercentToBp,
  parsePesosToCents,
  recurrenceText,
  staffErrorMessage,
} from "@/lib/staffPayouts/format";
import type { ExpenseAllocation, ExpenseCategory, Recurrence } from "@/supabase/functions/_shared/staff/settlement";
import { useStaffMutations, useTenantsForStaff, type ExpenseRow, type StaffData } from "@/modules/staffPayouts/api";
import { Card, FIELD_LABEL, NATIVE_SELECT } from "./parts";

const money = (cents: number, currency: "ARS" | "USD") =>
  currency === "USD" ? `USD ${(cents / 100).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : formatCents(cents);

function ExpenseModal({ open, onOpenChange, data, expense }: { open: boolean; onOpenChange: (o: boolean) => void; data: StaffData; expense: ExpenseRow | null }) {
  const { toast } = useToast();
  const mut = useStaffMutations();
  const { data: tenants } = useTenantsForStaff(open);
  const e = expense;
  const [name, setName] = useState(e?.name ?? "");
  const [category, setCategory] = useState<ExpenseCategory>(e?.category ?? "servidores");
  const [vendor, setVendor] = useState(e?.vendor ?? "");
  const [amount, setAmount] = useState(e ? String(e.amount_cents / 100).replace(".", ",") : "");
  const [currency, setCurrency] = useState<"ARS" | "USD">(e?.currency ?? "ARS");
  const [recurrence, setRecurrence] = useState<Recurrence>(e?.recurrence ?? "monthly");
  const [intervalN, setIntervalN] = useState(String(e?.interval_n ?? 2));
  const [start, setStart] = useState(e?.start_date ?? todayAR());
  const [end, setEnd] = useState(e?.end_date ?? "");
  const [spread, setSpread] = useState(String(e?.spread_months ?? 1));
  const [allocation, setAllocation] = useState<ExpenseAllocation>(e?.allocation ?? "proportional");
  const [member, setMember] = useState(e?.member_id ?? "");
  const [tenant, setTenant] = useState(e?.tenant_id ?? "");
  const [custom, setCustom] = useState<Record<string, string>>(() =>
    Object.fromEntries((e?.staff_expense_splits ?? []).map((x) => [x.member_id ?? "house", String(x.share_bp / 100)])),
  );
  const [exempt, setExempt] = useState<string[]>((e?.staff_expense_exemptions ?? []).map((x) => x.member_id));
  const [notes, setNotes] = useState(e?.notes ?? "");
  const [reason, setReason] = useState(e ? "" : "Alta del gasto");

  const amountCents = parsePesosToCents(amount);
  const customRows = [...data.members.map((m) => ({ id: m.id, label: m.display_name })), { id: "house", label: data.settings?.house_label ?? "La casa" }];
  const customTotal = customRows.reduce((s, r) => s + (parsePercentToBp(custom[r.id] ?? "") ?? 0), 0);
  const valid =
    name.trim().length >= 2 &&
    amountCents !== null &&
    (recurrence !== "every_n_months" && recurrence !== "every_n_days" ? true : Number(intervalN) >= 1) &&
    (allocation !== "client" || !!tenant) &&
    (allocation !== "custom" || customTotal === 10_000) &&
    reason.trim().length >= 5;

  const save = () => {
    const payload: Record<string, unknown> = {
      name: name.trim(),
      category,
      vendor: vendor.trim() || null,
      amount_cents: amountCents,
      currency,
      recurrence,
      interval_n: recurrence === "every_n_months" || recurrence === "every_n_days" ? Number(intervalN) : null,
      start_date: start,
      end_date: end || null,
      spread_months: Math.max(1, Math.min(36, Number(spread) || 1)),
      allocation,
      member_id: allocation === "single" ? member || null : null,
      tenant_id: allocation === "client" ? tenant : tenant || null,
      notes: notes.trim() || null,
      custom:
        allocation === "custom"
          ? customRows
              .map((r) => ({ member_id: r.id === "house" ? null : r.id, share_bp: parsePercentToBp(custom[r.id] ?? "") ?? 0 }))
              .filter((x) => x.share_bp > 0)
          : [],
      exemptions: allocation === "proportional" || allocation === "client" ? exempt.map((m) => ({ member_id: m })) : [],
    };
    mut.saveExpense.mutate(
      { id: e?.id ?? null, payload, reason },
      {
        onSuccess: () => {
          toast({ title: e ? "Gasto actualizado" : "Gasto agregado", variant: "success" });
          onOpenChange(false);
        },
        onError: (err) => toast({ title: staffErrorMessage(err), variant: "error" }),
      },
    );
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={e ? "Editar gasto" : "Nuevo gasto"}
      description={e ? "Los cambios aplican a los meses que no están cerrados." : "Se descuenta de lo que se reparte, según a quién se lo asignes."}
      className="sm:max-w-2xl"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={save} loading={mut.saveExpense.isPending} disabled={!valid}>
            Guardar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Nombre" value={name} onChange={(ev) => setName(ev.target.value)} placeholder="Ej. Servidor de producción" maxLength={120} />
          <div>
            <label className={FIELD_LABEL} htmlFor="ex-cat">
              Categoría
            </label>
            <select id="ex-cat" className={NATIVE_SELECT} value={category} onChange={(ev) => setCategory(ev.target.value as ExpenseCategory)}>
              {(Object.keys(CATEGORY_LABEL) as ExpenseCategory[]).map((k) => (
                <option key={k} value={k}>
                  {CATEGORY_LABEL[k]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-[1fr_auto_1fr] sm:items-end">
          <Input label="Monto" inputMode="decimal" value={amount} onChange={(ev) => setAmount(ev.target.value)} placeholder="Ej. 25,00" />
          <Segmented
            value={currency}
            onChange={(v) => setCurrency(v)}
            options={[
              { value: "ARS", label: "Pesos" },
              { value: "USD", label: "Dólares" },
            ]}
            aria-label="Moneda"
          />
          <Input label="Proveedor (opcional)" value={vendor} onChange={(ev) => setVendor(ev.target.value)} placeholder="Ej. Hetzner, Vercel" />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label className={FIELD_LABEL} htmlFor="ex-rec">
              Se repite
            </label>
            <select id="ex-rec" className={NATIVE_SELECT} value={recurrence} onChange={(ev) => setRecurrence(ev.target.value as Recurrence)}>
              {(Object.keys(RECURRENCE_LABEL) as Recurrence[]).map((k) => (
                <option key={k} value={k}>
                  {RECURRENCE_LABEL[k]}
                </option>
              ))}
            </select>
          </div>
          {(recurrence === "every_n_months" || recurrence === "every_n_days") && (
            <Input label={recurrence === "every_n_days" ? "Cada cuántos días" : "Cada cuántos meses"} type="number" min={1} value={intervalN} onChange={(ev) => setIntervalN(ev.target.value)} />
          )}
          <Input label={recurrence === "once" ? "Fecha" : "Primera vez"} type="date" value={start} onChange={(ev) => setStart(ev.target.value)} />
          {recurrence !== "once" && <Input label="Hasta (opcional)" type="date" value={end} onChange={(ev) => setEnd(ev.target.value)} />}
        </div>
        <div>
          <Input label="Repartir cada pago en N meses" type="number" min={1} max={36} value={spread} onChange={(ev) => setSpread(ev.target.value)} />
          <p className="mt-1.5 text-xs text-muted-foreground">
            1 = entero en el mes en que se paga. Un anual con 12 se descuenta en 12 cuotas iguales (los centavos que sobran van en las primeras).
          </p>
        </div>

        <div>
          <label className={FIELD_LABEL} htmlFor="ex-alloc">
            A quién se le descuenta
          </label>
          <select id="ex-alloc" className={NATIVE_SELECT} value={allocation} onChange={(ev) => setAllocation(ev.target.value as ExpenseAllocation)}>
            {(Object.keys(ALLOCATION_LABEL) as ExpenseAllocation[]).map((k) => (
              <option key={k} value={k}>
                {ALLOCATION_LABEL[k]}
              </option>
            ))}
          </select>
        </div>
        {allocation === "single" && (
          <div>
            <label className={FIELD_LABEL} htmlFor="ex-member">
              Persona que lo absorbe entero
            </label>
            <select id="ex-member" className={NATIVE_SELECT} value={member} onChange={(ev) => setMember(ev.target.value)}>
              <option value="">{data.settings?.house_label ?? "La casa"}</option>
              {data.members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.display_name}
                </option>
              ))}
            </select>
          </div>
        )}
        {allocation === "client" && (
          <div>
            <label className={FIELD_LABEL} htmlFor="ex-tenant">
              Cliente al que corresponde
            </label>
            <select id="ex-tenant" className={NATIVE_SELECT} value={tenant} onChange={(ev) => setTenant(ev.target.value)}>
              <option value="">Elegí un negocio</option>
              {(tenants ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <p className="mt-1.5 text-xs text-muted-foreground">Se reparte en proporción a lo que cada uno cobra de ese negocio (con sus reglas).</p>
          </div>
        )}
        {allocation === "custom" && (
          <div className="space-y-2">
            {customRows.map((r) => (
              <div key={r.id} className="grid grid-cols-[1fr_120px] items-center gap-3 text-sm">
                <span>{r.label}</span>
                <Input aria-label={`% de ${r.label}`} inputMode="decimal" value={custom[r.id] ?? ""} onChange={(ev) => setCustom((p) => ({ ...p, [r.id]: ev.target.value }))} placeholder="%" />
              </div>
            ))}
            <p className={customTotal === 10_000 ? "text-xs text-success" : "text-xs text-danger"}>Suma {formatBp(customTotal)} (tiene que dar 100 %).</p>
          </div>
        )}
        {(allocation === "proportional" || allocation === "client") && data.members.length > 0 && (
          <div>
            <span className={FIELD_LABEL}>Eximir a</span>
            <div className="flex flex-wrap gap-2">
              {data.members.map((m) => {
                const on = exempt.includes(m.id);
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setExempt((p) => (on ? p.filter((x) => x !== m.id) : [...p, m.id]))}
                    className={on ? "rounded-full bg-[var(--pos-solid)] px-3 py-1.5 text-sm text-white" : "rounded-full bg-muted px-3 py-1.5 text-sm"}
                    aria-pressed={on}
                  >
                    {m.display_name}
                  </button>
                );
              })}
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">Los eximidos no pagan este gasto; los demás lo absorben en proporción, sin ellos.</p>
          </div>
        )}
        <Input label="Notas (opcional)" value={notes} onChange={(ev) => setNotes(ev.target.value)} maxLength={500} />
        <ReasonField value={reason} onChange={setReason} />
      </div>
    </Modal>
  );
}

function MonthAmountModal({ expense, onClose }: { expense: ExpenseRow; onClose: () => void }) {
  const { toast } = useToast();
  const mut = useStaffMutations();
  const [period, setPeriod] = useState(todayAR().slice(0, 7));
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const zero = amount.trim() === "0";
  const cents = zero ? 0 : parsePesosToCents(amount);
  const run = (amt: number | null) =>
    mut.setExpenseMonth.mutate(
      { expense: expense.id, period: `${period}-01`, amount_cents: amt, note: note.trim() || null },
      {
        onSuccess: () => {
          toast({ title: "Monto del mes guardado", variant: "success" });
          onClose();
        },
        onError: (e) => toast({ title: staffErrorMessage(e), variant: "error" }),
      },
    );
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Monto de un mes: ${expense.name}`}
      description="Si un mes vino distinto (o no hubo), cargalo acá. 0 = ese mes no hubo gasto."
      footer={
        <>
          <Button variant="ghost" onClick={() => run(null)} loading={mut.setExpenseMonth.isPending}>
            Volver al habitual
          </Button>
          <Button onClick={() => cents !== null && run(cents)} loading={mut.setExpenseMonth.isPending} disabled={cents === null}>
            Guardar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Mes" type="month" value={period} onChange={(e) => setPeriod(e.target.value)} />
          <Input label={`Monto (${expense.currency === "USD" ? "USD" : "$"})`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <Input label="Nota (opcional)" value={note} onChange={(e) => setNote(e.target.value)} />
        {(expense.staff_expense_period_amounts ?? []).length > 0 && (
          <ul className="divide-y divide-border/60 text-sm">
            {expense.staff_expense_period_amounts!.map((p) => (
              <li key={p.period} className="flex justify-between py-1.5">
                <span className="text-muted-foreground">{monthLabel(p.period)}</span>
                <span className="tabular-nums">{p.amount_cents === 0 ? "No hubo" : money(p.amount_cents, expense.currency)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

function FxCard({ data }: { data: StaffData }) {
  const { toast } = useToast();
  const mut = useStaffMutations();
  const [period, setPeriod] = useState(todayAR().slice(0, 7));
  const [rate, setRate] = useState("");
  const [source, setSource] = useState("BNA venta");
  const value = Number(rate.replace(/\./g, "").replace(",", "."));
  return (
    <Card>
      <h3 className="flex items-center gap-2 font-semibold">
        <DollarSign size={16} className="text-ninja-flameSoft" aria-hidden /> Cotización del dólar
      </h3>
      <p className="mt-1 text-xs text-muted-foreground">Se usa la del mes en que ocurre cada gasto en dólares. Si falta, la del último mes cargado (y se avisa).</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
        <Input label="Mes" type="month" value={period} onChange={(e) => setPeriod(e.target.value)} />
        <Input label="$ por USD" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="Ej. 1.450,50" />
        <Input label="Fuente" value={source} onChange={(e) => setSource(e.target.value)} />
        <Button
          onClick={() =>
            mut.setFx.mutate(
              { period: `${period}-01`, rate: value, source: source.trim() || null },
              {
                onSuccess: () => {
                  toast({ title: "Cotización guardada", variant: "success" });
                  setRate("");
                },
                onError: (e) => toast({ title: staffErrorMessage(e), variant: "error" }),
              },
            )
          }
          loading={mut.setFx.isPending}
          disabled={!(value > 0)}
        >
          Guardar
        </Button>
      </div>
      {data.fx.length > 0 && (
        <ul className="mt-3 divide-y divide-border/60 text-sm">
          {data.fx.slice(0, 6).map((f) => (
            <li key={f.period} className="flex justify-between py-1.5">
              <span className="text-muted-foreground">
                {monthLabel(f.period)}
                {f.source ? ` · ${f.source}` : ""}
              </span>
              <span className="tabular-nums">$ {Number(f.rate).toLocaleString("es-AR", { maximumFractionDigits: 4 })}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function ExpensesTab({ data }: { data: StaffData }) {
  const { toast } = useToast();
  const mut = useStaffMutations();
  const [editing, setEditing] = useState<ExpenseRow | null | "new">(null);
  const [month, setMonth] = useState<ExpenseRow | null>(null);
  const [removing, setRemoving] = useState<ExpenseRow | null>(null);
  const [cat, setCat] = useState<"todas" | ExpenseCategory>("todas");
  const name = (id: string | null) => (id ? data.members.find((m) => m.id === id)?.display_name ?? "Persona" : data.settings?.house_label ?? "La casa");
  const rows = useMemo(() => data.expenses.filter((e) => cat === "todas" || e.category === cat), [data.expenses, cat]);
  const today = todayAR();

  return (
    <div className="space-y-8">
      <section>
        <SectionHeader
          icon={Receipt}
          title="Gastos"
          description="Se descuentan de lo cobrado antes de repartir, a quien corresponda."
          actions={
            <Button size="sm" onClick={() => setEditing("new")}>
              <Plus size={14} aria-hidden /> Nuevo gasto
            </Button>
          }
        />
        <div className="slim-scrollbar -mx-4 mt-3 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <Segmented
            value={cat}
            onChange={setCat}
            size="sm"
            className="max-w-none flex-nowrap"
            aria-label="Categoría"
            options={[{ value: "todas" as const, label: "Todas" }, ...(Object.keys(CATEGORY_LABEL) as ExpenseCategory[]).map((k) => ({ value: k, label: CATEGORY_LABEL[k] }))]}
          />
        </div>
        {rows.length === 0 ? (
          <div className="mt-3 rounded-xl border border-border bg-card">
            <EmptyState compact icon={Receipt} title="Sin gastos" description="Cargá servidores, dominios, servicios, sueldos o lo que corresponda." />
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
            {rows.map((e) => {
              const ended = e.end_date && e.end_date < today;
              return (
                <li key={e.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      {e.name}
                      <Badge tone="neutral">{CATEGORY_LABEL[e.category]}</Badge>
                      {ended && <Badge tone="neutral">Terminado</Badge>}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {recurrenceText(e.recurrence, e.interval_n, e.spread_months)} · desde {formatDay(e.start_date)}
                      {e.end_date ? ` hasta ${formatDay(e.end_date)}` : ""}
                      {e.vendor ? ` · ${e.vendor}` : ""}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {e.allocation === "single" ? `Todo a ${name(e.member_id)}` : ALLOCATION_LABEL[e.allocation]}
                      {(e.staff_expense_exemptions ?? []).length > 0 ? ` · eximidos: ${e.staff_expense_exemptions!.map((x) => name(x.member_id)).join(", ")}` : ""}
                    </p>
                  </div>
                  <span className="text-sm font-semibold tabular-nums">{money(e.amount_cents, e.currency)}</span>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="icon" aria-label="Monto de un mes" onClick={() => setMonth(e)}>
                      <CalendarRange size={15} />
                    </Button>
                    <Button variant="ghost" size="icon" aria-label="Editar gasto" onClick={() => setEditing(e)}>
                      <Pencil size={15} />
                    </Button>
                    <Button variant="ghost" size="icon" aria-label="Eliminar gasto" onClick={() => setRemoving(e)}>
                      <Trash2 size={15} />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <FxCard data={data} />

      {editing !== null && <ExpenseModal open onOpenChange={(o) => !o && setEditing(null)} data={data} expense={editing === "new" ? null : editing} />}
      {month && <MonthAmountModal expense={month} onClose={() => setMonth(null)} />}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title="Eliminar gasto"
        description="Deja de descontarse en los meses abiertos. Lo ya liquidado no cambia. Si sólo terminó, mejor ponele fecha de fin."
        confirmLabel="Eliminar"
        danger
        withReason
        loading={mut.deleteExpense.isPending}
        onConfirm={(reason) =>
          removing &&
          mut.deleteExpense.mutate(
            { id: removing.id, reason },
            { onSuccess: () => setRemoving(null), onError: (e) => toast({ title: staffErrorMessage(e), variant: "error" }) },
          )
        }
      />
    </div>
  );
}
