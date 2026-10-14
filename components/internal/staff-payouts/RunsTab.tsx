"use client";

// Liquidaciones (F21 · ADR-121): el borrador del mes abierto más viejo (en
// vivo), el cierre (inmutable y auditado), el historial y los ajustes.

import { useState } from "react";
import { FileLock2, ListChecks, Lock, Scale, Trash2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Disclosure } from "@/components/ui/Disclosure";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionHeader } from "@/components/ui/PageHeader";
import { useToast } from "@/components/ui/Toast";
import { ReasonField } from "@/components/internal/billing/LedgerModals";
import { RUN_STATUS, formatBp, formatCents, formatDay, monthLabel, parsePesosToCents, staffErrorMessage } from "@/lib/staffPayouts/format";
import { explainBase, explainLine, type SettlementLine, type SettlementResult } from "@/supabase/functions/_shared/staff/settlement";
import { addMonths } from "@/supabase/functions/_shared/staff/dates";
import { useStaffMutations, type PreviewResponse, type StaffData } from "@/modules/staffPayouts/api";
import { Card, FIELD_LABEL, Money, NATIVE_SELECT, ResultNotices, StepsList } from "./parts";

export function LinesTable({ result, onDetail }: { result: SettlementResult; onDetail: (l: SettlementLine) => void }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-card">
      <table className="w-full min-w-[620px] text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="px-4 py-3 font-medium">Persona</th>
            <th className="px-4 py-3 text-right font-medium">Le toca</th>
            <th className="px-4 py-3 text-right font-medium">Gastos</th>
            <th className="px-4 py-3 text-right font-medium">Ajustes y arrastre</th>
            <th className="px-4 py-3 text-right font-medium">A pagar</th>
            <th className="px-4 py-3" />
          </tr>
        </thead>
        <tbody>
          {result.lines.map((l) => (
            <tr key={l.member_id} className="border-b border-border/60 last:border-0">
              <td className="px-4 py-3">
                <span className="font-medium">{l.name}</span>
                <span className="ml-2 text-xs text-muted-foreground">{formatBp(l.share_bp_end)}</span>
              </td>
              <td className="px-4 py-3 text-right"><Money cents={l.income_cents + l.signup_cents} /></td>
              <td className="px-4 py-3 text-right"><Money cents={-l.expense_cents} /></td>
              <td className="px-4 py-3 text-right"><Money cents={l.adjustment_cents + l.carry_in_cents} /></td>
              <td className="px-4 py-3 text-right">
                <Money cents={l.payable_cents} strong />
                {l.carry_out_cents < 0 && <span className="block text-xs text-danger">{formatCents(l.carry_out_cents)} al mes siguiente</span>}
              </td>
              <td className="px-4 py-3 text-right">
                <Button variant="ghost" size="sm" onClick={() => onDetail(l)}>
                  Ver cálculo
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AdjustmentModal({ data, onClose, defaultPeriod }: { data: StaffData; onClose: () => void; defaultPeriod: string }) {
  const { toast } = useToast();
  const mut = useStaffMutations();
  const [member, setMember] = useState(data.members[0]?.id ?? "");
  const [period, setPeriod] = useState(defaultPeriod.slice(0, 7));
  const [sign, setSign] = useState<"+" | "-">("+");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const cents = parsePesosToCents(amount);
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Ajuste manual"
      description="Suma o descuenta a una persona en un mes abierto. Lo pone (o lo recibe) la casa. Sirve para corregir un mes ya cerrado."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            loading={mut.addAdjustment.isPending}
            disabled={!member || cents === null || reason.trim().length < 5}
            onClick={() =>
              mut.addAdjustment.mutate(
                { member, period: `${period}-01`, amount_cents: (sign === "+" ? 1 : -1) * (cents ?? 0), reason },
                {
                  onSuccess: () => {
                    toast({ title: "Ajuste cargado", variant: "success" });
                    onClose();
                  },
                  onError: (e) => toast({ title: staffErrorMessage(e), variant: "error" }),
                },
              )
            }
          >
            Guardar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={FIELD_LABEL} htmlFor="adj-member">
              Persona
            </label>
            <select id="adj-member" className={NATIVE_SELECT} value={member} onChange={(e) => setMember(e.target.value)}>
              {data.members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.display_name}
                </option>
              ))}
            </select>
          </div>
          <Input label="Mes" type="month" value={period} onChange={(e) => setPeriod(e.target.value)} />
        </div>
        <div className="grid grid-cols-[auto_1fr] items-end gap-3">
          <div>
            <span className={FIELD_LABEL}>Tipo</span>
            <select aria-label="Tipo" className={NATIVE_SELECT} value={sign} onChange={(e) => setSign(e.target.value as "+" | "-")}>
              <option value="+">Suma</option>
              <option value="-">Descuento</option>
            </select>
          </div>
          <Input label="Monto ($)" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <ReasonField value={reason} onChange={setReason} placeholder="Ej.: corrección de septiembre por un pago cargado dos veces" />
      </div>
    </Modal>
  );
}

export function LineDetailModal({ line, onClose }: { line: SettlementLine; onClose: () => void }) {
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={`Cálculo de ${line.name}`} description={`${formatBp(line.share_bp_end)} de participación`}>
      <StepsList steps={explainLine(line)} />
    </Modal>
  );
}

export function RunsTab({ data, preview, onPeriod }: { data: StaffData; preview: PreviewResponse; onPeriod: (p: string | null) => void }) {
  const { toast } = useToast();
  const mut = useStaffMutations();
  const [detail, setDetail] = useState<SettlementLine | null>(null);
  const [closing, setClosing] = useState(false);
  const [adjOpen, setAdjOpen] = useState(false);
  const [voiding, setVoiding] = useState<string | null>(null);
  const draft = preview.draft.result;
  const name = (id: string) => data.members.find((m) => m.id === id)?.display_name ?? "Persona";
  const openAdjustments = data.adjustments.filter((a) => !a.run_id);
  const nextMonthStart = addMonths(draft.period, 1);

  return (
    <div className="space-y-8">
      <section>
        <SectionHeader
          icon={ListChecks}
          title={`Borrador de ${monthLabel(draft.period).toLowerCase()}`}
          description="Se recalcula en vivo hasta que lo cierres. Al cerrarlo queda fijo: lo que cambie después entra en la liquidación siguiente."
          actions={
            <>
              <Button variant="secondary" size="sm" onClick={() => setAdjOpen(true)} disabled={data.members.length === 0}>
                <Scale size={14} aria-hidden /> Ajuste manual
              </Button>
              <Button size="sm" onClick={() => setClosing(true)} disabled={!preview.draft.can_close}>
                <Lock size={14} aria-hidden /> Cerrar liquidación
              </Button>
            </>
          }
        />
        {!preview.draft.can_close && draft.errors.length === 0 && (
          <p className="mt-2 text-xs text-muted-foreground">
            {draft.period >= preview.this_month
              ? `El mes todavía no terminó: se puede cerrar desde el ${formatDay(nextMonthStart)}.`
              : "Cerrá antes los meses anteriores."}
          </p>
        )}
        <div className="mt-3 grid gap-4 xl:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
          <Card>
            <StepsList steps={explainBase(draft, preview.settings.incomeTaxReserveBp)} />
            <div className="mt-2 flex justify-between border-t border-border pt-2 text-sm">
              <span className="text-muted-foreground">{preview.house_label} (la casa)</span>
              <Money cents={draft.house.net_cents} strong />
            </div>
          </Card>
          <div className="space-y-3">
            <ResultNotices warnings={draft.warnings} errors={draft.errors} />
            {draft.lines.length > 0 ? (
              <LinesTable result={draft} onDetail={setDetail} />
            ) : (
              <div className="rounded-xl border border-border bg-card">
                <EmptyState compact icon={ListChecks} title="Nadie participa todavía" />
              </div>
            )}
            {openAdjustments.length > 0 && (
              <Card>
                <p className="text-sm font-medium">Ajustes pendientes</p>
                <ul className="mt-1 divide-y divide-border/60 text-sm">
                  {openAdjustments.map((a) => (
                    <li key={a.id} className="flex items-center justify-between gap-3 py-2">
                      <span className="min-w-0">
                        {name(a.member_id)} · {monthLabel(a.period)}
                        <span className="block truncate text-xs text-muted-foreground">{a.reason}</span>
                      </span>
                      <span className="flex items-center gap-1">
                        <Money cents={a.amount_cents} />
                        <Button variant="ghost" size="icon" aria-label="Anular ajuste" onClick={() => setVoiding(a.id)}>
                          <Trash2 size={14} />
                        </Button>
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </div>
        </div>
      </section>

      <section>
        <SectionHeader icon={FileLock2} title="Cerradas" description="Inmutables. Las correcciones van como ajuste en la próxima." />
        {data.runs.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">Todavía no se cerró ninguna liquidación.</p>
        ) : (
          <div className="mt-3 space-y-3">
            {data.runs.map((r) => {
              const st = RUN_STATUS[r.status] ?? RUN_STATUS.closed!;
              const lines = data.lines.filter((l) => l.run_id === r.id);
              const paid = data.payments.filter((p) => p.run_id === r.id && !p.voided_at).reduce((s, p) => s + p.amount_cents, 0);
              const due = lines.reduce((s, l) => s + l.payable_cents, 0);
              return (
                <Card key={r.id}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="flex items-center gap-2 font-semibold">
                      {monthLabel(r.period)} <Badge tone={st.tone}>{st.label}</Badge>
                    </p>
                    <span className="text-sm text-muted-foreground">
                      Pagado {formatCents(paid)} de {formatCents(due)}
                    </span>
                  </div>
                  <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
                    <div>
                      <dt className="text-xs text-muted-foreground">Cobrado neto</dt>
                      <dd><Money cents={r.net_cents} /></dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Gastos</dt>
                      <dd><Money cents={-r.expenses_cents} /></dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Repartido</dt>
                      <dd><Money cents={r.to_share_cents} /></dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Casa</dt>
                      <dd><Money cents={r.house_net_cents} /></dd>
                    </div>
                  </dl>
                  <Disclosure className="mt-2" title="Ver detalle">
                    <StepsList steps={explainBase(r.snapshot, preview.settings.incomeTaxReserveBp)} />
                    <div className="mt-3">
                      <LinesTable result={r.snapshot} onDetail={setDetail} />
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">
                      Cerrada el {formatDay(r.closed_at)}
                      {r.notes ? ` · ${r.notes}` : ""}
                    </p>
                  </Disclosure>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      {detail && <LineDetailModal line={detail} onClose={() => setDetail(null)} />}
      {adjOpen && <AdjustmentModal data={data} defaultPeriod={draft.period} onClose={() => setAdjOpen(false)} />}
      <ConfirmDialog
        open={closing}
        onOpenChange={setClosing}
        title={`Cerrar ${monthLabel(draft.period).toLowerCase()}`}
        description={`Se reparten ${formatCents(draft.to_share_cents)}. Queda fija y auditada; lo que cambie después (un pago tardío, un contracargo) entra en la próxima.`}
        confirmLabel="Cerrar liquidación"
        withReason
        reasonLabel="Nota del cierre"
        loading={mut.closeRun.isPending}
        onConfirm={(notes) =>
          mut.closeRun.mutate(
            { period: draft.period, notes },
            {
              onSuccess: () => {
                toast({ title: "Liquidación cerrada", variant: "success" });
                setClosing(false);
                onPeriod(null);
              },
              onError: (e) => toast({ title: staffErrorMessage(e), variant: "error" }),
            },
          )
        }
      />
      <ConfirmDialog
        open={voiding !== null}
        onOpenChange={(o) => !o && setVoiding(null)}
        title="Anular ajuste"
        withReason
        confirmLabel="Anular"
        danger
        loading={mut.voidAdjustment.isPending}
        onConfirm={(reason) =>
          voiding &&
          mut.voidAdjustment.mutate(
            { id: voiding, reason },
            { onSuccess: () => setVoiding(null), onError: (e) => toast({ title: staffErrorMessage(e), variant: "error" }) },
          )
        }
      />
    </div>
  );
}

