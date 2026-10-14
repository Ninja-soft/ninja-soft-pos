"use client";

// Pagos al staff (F21 · ADR-121): lo que falta pagar de cada liquidación
// cerrada, registrar pagos (parciales) por transferencia, Mercado Pago (con la
// operación leída desde la cuenta de NinjaSoft), efectivo u otro, email de
// acreditación y anulación con motivo.

import { useMemo, useState } from "react";
import { CircleAlert, CircleCheck, CreditCard, HandCoins, Mail, Search, Wallet } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionHeader } from "@/components/ui/PageHeader";
import { useToast } from "@/components/ui/Toast";
import { BankLogo } from "@/components/payments/BankLogo";
import { todayAR } from "@/lib/billing/ledger";
import { formatCbu } from "@/lib/payments/transfer";
import { METHOD_LABEL, formatCents, formatDay, monthLabel, parsePesosToCents, staffErrorMessage } from "@/lib/staffPayouts/format";
import { normalizeMpOperationId } from "@/supabase/functions/_shared/staff/mpPayout";
import { mpLookup, useStaffMutations, type LineRow, type MpLookupResponse, type PaymentRow, type StaffData } from "@/modules/staffPayouts/api";
import { AccountsList } from "./SharesTab";
import { Card, Money } from "./parts";

type Method = PaymentRow["method"];

export function MpLookupCard({ r }: { r: MpLookupResponse }) {
  const s = r.summary;
  return (
    <div className="space-y-2 rounded-lg bg-fg-4 p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">Operación {s.id}</span>
        <Badge tone={s.status === "approved" ? "success" : "warning"}>{s.status === "approved" ? "Aprobada" : s.status}</Badge>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
        <dt className="text-muted-foreground">Monto</dt>
        <dd className="text-right tabular-nums">{formatCents(s.amount_cents)}</dd>
        <dt className="text-muted-foreground">Fecha</dt>
        <dd className="text-right">{formatDay(s.date_approved ?? s.date_created)}</dd>
        <dt className="text-muted-foreground">Desde la cuenta</dt>
        <dd className="truncate text-right">{s.account?.nickname ?? s.payer.email ?? s.payer.name ?? "Sin dato"}</dd>
        <dt className="text-muted-foreground">Destinatario</dt>
        <dd className="truncate text-right">{s.counterpart.name ?? s.counterpart.bank ?? (s.collector_id ? `Usuario ${s.collector_id}` : "Sin dato")}</dd>
        {s.description && (
          <>
            <dt className="text-muted-foreground">Descripción</dt>
            <dd className="truncate text-right">{s.description}</dd>
          </>
        )}
      </dl>
      {r.check.ok ? (
        <p className="flex items-center gap-1.5 text-xs text-success">
          <CircleCheck size={13} aria-hidden /> Coincide: aprobada, en pesos, mismo monto y salió de la cuenta de NinjaSoft.
        </p>
      ) : (
        <ul className="space-y-1 text-xs text-danger">
          {r.check.issues.map((i) => (
            <li key={i} className="flex items-start gap-1.5">
              <CircleAlert size={13} className="mt-0.5 shrink-0" aria-hidden /> {i}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PayModal({ data, line, onClose }: { data: StaffData; line: LineRow; onClose: () => void }) {
  const { toast } = useToast();
  const mut = useStaffMutations();
  const paid = data.payments.filter((p) => p.line_id === line.id && !p.voided_at).reduce((s, p) => s + p.amount_cents, 0);
  const remaining = line.payable_cents - paid;
  const member = data.members.find((m) => m.id === line.member_id);
  const accounts = data.accounts.filter((a) => a.member_id === line.member_id);
  const run = data.runs.find((r) => r.id === line.run_id);
  const [method, setMethod] = useState<Method>("transfer");
  const [amount, setAmount] = useState((remaining / 100).toFixed(2).replace(".", ","));
  const [paidOn, setPaidOn] = useState(todayAR());
  const [account, setAccount] = useState(accounts.find((a) => a.is_default)?.id ?? accounts[0]?.id ?? "");
  const [reference, setReference] = useState("");
  const [op, setOp] = useState("");
  const [notes, setNotes] = useState("");
  const [notify, setNotify] = useState(data.settings?.notify_on_payment ?? true);
  const [lookup, setLookup] = useState<MpLookupResponse | null>(null);
  const [looking, setLooking] = useState(false);
  const cents = parsePesosToCents(amount);
  const opId = normalizeMpOperationId(op);
  const mpReady = method !== "mercadopago" || (lookup !== null && lookup.check.ok && lookup.summary.id === opId);
  const valid = cents !== null && cents <= remaining && (method !== "transfer" || !!account) && mpReady;

  const fetchMp = async () => {
    if (!opId || cents === null) return;
    setLooking(true);
    try {
      setLookup(await mpLookup(opId, cents));
    } catch (e) {
      setLookup(null);
      toast({ title: staffErrorMessage(e), variant: "error" });
    } finally {
      setLooking(false);
    }
  };

  const save = () =>
    mut.registerPayment.mutate(
      {
        line: line.id,
        amount_cents: cents ?? 0,
        method,
        paid_on: paidOn,
        account: account || null,
        reference: reference.trim() || null,
        mp_operation: method === "mercadopago" ? opId : null,
        notes: notes.trim() || null,
        notify,
      },
      {
        onSuccess: () => {
          toast({ title: notify && member?.email ? `Pago registrado. Le avisamos a ${member.email}.` : "Pago registrado", variant: "success" });
          onClose();
        },
        onError: (e) => toast({ title: staffErrorMessage(e), variant: "error" }),
      },
    );

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Pagar a ${member?.display_name ?? "la persona"}`}
      description={`${run ? monthLabel(run.period) : ""} · falta pagar ${formatCents(remaining)} de ${formatCents(line.payable_cents)}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={save} loading={mut.registerPayment.isPending} disabled={!valid}>
            Registrar pago
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Segmented
          value={method}
          onChange={(m) => {
            setMethod(m);
            setLookup(null);
          }}
          fill
          aria-label="Medio de pago"
          options={(["transfer", "mercadopago", "cash", "other"] as Method[]).map((m) => ({ value: m, label: m === "transfer" ? "Transferencia" : METHOD_LABEL[m]! }))}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Monto ($)"
            inputMode="decimal"
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              setLookup(null);
            }}
            error={cents !== null && cents > remaining ? `Máximo ${formatCents(remaining)}` : undefined}
          />
          <Input label="Fecha del pago" type="date" value={paidOn} max={todayAR()} onChange={(e) => setPaidOn(e.target.value)} />
        </div>

        {(method === "transfer" || method === "mercadopago") && (
          <div>
            <span className="mb-2 block text-sm font-medium text-muted-foreground">
              Cuenta destino{method === "mercadopago" ? " (opcional)" : ""}
            </span>
            {accounts.length === 0 ? (
              <AccountsList accounts={data.accounts} memberId={line.member_id} compact />
            ) : (
              <div className="space-y-1.5">
                {accounts.map((a) => (
                  <label key={a.id} className="flex cursor-pointer items-center gap-3 rounded-lg bg-fg-4 p-2.5 has-[:checked]:ring-2 has-[:checked]:ring-ring">
                    <input type="radio" name="pay-account" className="sr-only" checked={account === a.id} onChange={() => setAccount(a.id)} />
                    <BankLogo slug={a.bank_slug} name={a.bank_name} size={30} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{a.bank_name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {a.holder_name}
                        {a.alias ? ` · ${a.alias}` : ""}
                        {a.cbu ? ` · ${formatCbu(a.cbu)}` : ""}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
        )}

        {method === "mercadopago" ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <BankLogo slug="mercado-pago" name="Mercado Pago" size={18} /> Se lee con el access token de NinjaSoft (Pagos de plataforma). No se guarda nada sin tu confirmación.
            </div>
            <div className="grid grid-cols-[1fr_auto] items-end gap-2">
              <Input
                label="Número de operación de Mercado Pago"
                inputMode="numeric"
                value={op}
                onChange={(e) => {
                  setOp(e.target.value);
                  setLookup(null);
                }}
                placeholder="Ej. 123456789012"
              />
              <Button variant="secondary" onClick={() => void fetchMp()} loading={looking} disabled={!opId || cents === null}>
                <Search size={14} aria-hidden /> Traer de MP
              </Button>
            </div>
            {lookup && <MpLookupCard r={lookup} />}
          </div>
        ) : (
          <Input label="Referencia (opcional)" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Nº de transferencia, recibo, etc." maxLength={120} />
        )}

        <Input label="Nota (opcional)" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
        <label className="flex items-start justify-between gap-4 text-sm">
          <span>
            <span className="flex items-center gap-1.5 font-medium">
              <Mail size={14} aria-hidden /> Avisarle por email
            </span>
            <span className="block text-xs text-muted-foreground">{member?.email ? `A ${member.email}, con el monto, el medio y la cuenta.` : "Esta persona no tiene email cargado."}</span>
          </span>
          <Switch checked={notify && !!member?.email} onCheckedChange={setNotify} disabled={!member?.email} label="Avisar por email" />
        </label>
      </div>
    </Modal>
  );
}

export function PaymentsTab({ data }: { data: StaffData }) {
  const { toast } = useToast();
  const mut = useStaffMutations();
  const [paying, setPaying] = useState<LineRow | null>(null);
  const [voiding, setVoiding] = useState<PaymentRow | null>(null);
  const [showVoided, setShowVoided] = useState(false);
  const name = (id: string) => data.members.find((m) => m.id === id)?.display_name ?? "Persona";
  const period = (runId: string) => data.runs.find((r) => r.id === runId)?.period ?? null;
  const pending = useMemo(
    () =>
      data.lines
        .map((l) => ({ l, paid: data.payments.filter((p) => p.line_id === l.id && !p.voided_at).reduce((s, p) => s + p.amount_cents, 0) }))
        .filter((x) => x.l.payable_cents - x.paid > 0)
        .sort((a, b) => ((period(a.l.run_id) ?? "") < (period(b.l.run_id) ?? "") ? -1 : 1)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.lines, data.payments, data.runs],
  );
  const payments = data.payments.filter((p) => showVoided || !p.voided_at);

  return (
    <div className="space-y-8">
      <section>
        <SectionHeader icon={HandCoins} title="Pendientes de pago" description="De las liquidaciones cerradas. Se pueden pagar en partes." />
        {pending.length === 0 ? (
          <div className="mt-3 rounded-xl border border-border bg-card">
            <EmptyState compact icon={Wallet} title="No hay nada pendiente" description="Cuando cierres una liquidación, lo que hay que pagar aparece acá." />
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
            {pending.map(({ l, paid }) => {
              const acc = data.accounts.find((a) => a.member_id === l.member_id && a.is_default);
              return (
                <li key={l.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">
                      {name(l.member_id)} · {monthLabel(period(l.run_id))}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {paid > 0 ? `Pagado ${formatCents(paid)} de ${formatCents(l.payable_cents)}` : `A pagar ${formatCents(l.payable_cents)}`}
                      {acc ? ` · ${acc.bank_name}${acc.alias ? ` (${acc.alias})` : ""}` : " · sin cuenta de cobro"}
                    </p>
                  </div>
                  <Money cents={l.payable_cents - paid} strong />
                  <Button size="sm" onClick={() => setPaying(l)}>
                    Registrar pago
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section>
        <SectionHeader
          icon={CreditCard}
          title="Pagos registrados"
          actions={
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <Switch checked={showVoided} onCheckedChange={setShowVoided} label="Ver anulados" /> Ver anulados
            </label>
          }
        />
        {payments.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">Todavía no hay pagos.</p>
        ) : (
          <ul className="mt-3 divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
            {payments.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                {p.method === "mercadopago" ? (
                  <BankLogo slug="mercado-pago" name="Mercado Pago" size={30} />
                ) : (
                  <BankLogo slug={p.account_snapshot?.bank_slug ?? null} name={p.account_snapshot?.bank_name ?? METHOD_LABEL[p.method] ?? "Pago"} size={30} />
                )}
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {name(p.member_id)} · {monthLabel(period(p.run_id))}
                    {p.voided_at && <Badge tone="danger">Anulado</Badge>}
                    {p.mp_summary?.check?.ok && <Badge tone="success">Verificado en MP</Badge>}
                    {p.email_queued_at && <Badge tone="neutral">Email enviado</Badge>}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {METHOD_LABEL[p.method]} · {formatDay(p.paid_on)}
                    {p.mp_operation_id ? ` · op. ${p.mp_operation_id}` : p.reference ? ` · ${p.reference}` : ""}
                    {p.account_snapshot?.bank_name ? ` · ${p.account_snapshot.bank_name}` : ""}
                    {p.voided_at && p.void_reason ? ` · anulado: ${p.void_reason}` : ""}
                  </p>
                </div>
                <Money cents={p.amount_cents} strong className={p.voided_at ? "line-through opacity-60" : undefined} />
                {!p.voided_at && (
                  <Button variant="ghost" size="sm" onClick={() => setVoiding(p)}>
                    Anular
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <Card>
        <Callout tone="neutral" title="Cómo funciona">
          Al registrar un pago se guarda el medio, la cuenta (congelada: si después la editan, el pago conserva los datos de ese momento) y, si es Mercado
          Pago, el detalle de la operación leído de la cuenta de NinjaSoft. El email de acreditación sale por la cola de emails del sistema.
        </Callout>
      </Card>

      {paying && <PayModal data={data} line={paying} onClose={() => setPaying(null)} />}
      <ConfirmDialog
        open={voiding !== null}
        onOpenChange={(o) => !o && setVoiding(null)}
        title="Anular pago"
        description="Queda registrado como anulado (no se borra) y vuelve a figurar como pendiente."
        confirmLabel="Anular pago"
        danger
        withReason
        loading={mut.voidPayment.isPending}
        onConfirm={(reason) =>
          voiding &&
          mut.voidPayment.mutate(
            { id: voiding.id, reason },
            { onSuccess: () => setVoiding(null), onError: (e) => toast({ title: staffErrorMessage(e), variant: "error" }) },
          )
        }
      />
    </div>
  );
}
