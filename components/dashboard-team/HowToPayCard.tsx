"use client";

// =============================================================================
// "Mi suscripción > Cómo pagar" (F20-8 · ADR-120, spec docs/40 §9.3 y §14.5).
// La modalidad con la que el negocio le paga a NinjaSoft y lo que implica:
//   · cuenta corriente: cuentas para transferir (copiar CBU / alias), la
//     referencia, a dónde mandar el comprobante y "Ya transferí" para subirlo
//     (sólo el dueño; el staff lo verifica e imputa);
//   · pase pendiente a débito automático: botón para autorizarlo en Mercado
//     Pago (sigue en su modalidad hasta el primer débito);
//   · historial de cambios de modalidad y de transferencias informadas.
// Dueño y encargado (my_billing_account valida el rol en el servidor).
// =============================================================================

import { useRef, useState } from "react";
import {
  ArrowRightLeft,
  CircleCheck,
  CreditCard,
  FileUp,
  Landmark,
  Mail,
  MessageCircle,
  Paperclip,
  Send,
  Undo2,
  Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { ChoiceCard } from "@/components/ui/ChoiceCard";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { SectionHeader } from "@/components/ui/PageHeader";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { BankAccountDetails, CopyValue } from "@/components/billing/BankAccountDetails";
import { BankLogo } from "@/components/payments/BankLogo";
import {
  BILLING_MODE_LABELS,
  billingErrorMessage,
  formatCents,
  formatDay,
  parsePesosToCents,
  todayAR,
} from "@/lib/billing/ledger";
import { PROOF_MIME, validateTransferReport } from "@/lib/billing/paymentNotice";
import { whatsappLink } from "@/lib/purchases/suppliers";
import { useMyStatement } from "@/modules/billing/ledger";
import {
  ownerSubscriptionCheckout,
  useMyBillingAccount,
  useReportTransfer,
  type MyBillingAccount,
  type TransferReport,
} from "@/modules/billing/collection";

const REPORT_STATUS: Record<TransferReport["status"], { label: string; tone: "warning" | "success" | "danger" | "neutral" }> = {
  pending: { label: "La estamos verificando", tone: "warning" },
  approved: { label: "Acreditada", tone: "success" },
  rejected: { label: "No la pudimos verificar", tone: "danger" },
  cancelled: { label: "Retirada", tone: "neutral" },
};

const modeLabel = (m: string | null | undefined) => (m ? BILLING_MODE_LABELS[m] ?? m : "Automática");

// ── "Ya transferí" ──────────────────────────────────────────────────────────

function ReportTransferModal({
  open,
  onOpenChange,
  account,
  tenantId,
  suggestedCents,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  account: MyBillingAccount;
  tenantId: string | null;
  suggestedCents: number;
}) {
  const { toast } = useToast();
  const r = useReportTransfer(tenantId);
  const fileRef = useRef<HTMLInputElement>(null);
  const [amount, setAmount] = useState("");
  const [paidOn, setPaidOn] = useState(todayAR());
  const [bankId, setBankId] = useState<string | null>(null);
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [touched, setTouched] = useState(false);

  const reset = () => {
    setAmount(suggestedCents > 0 ? String(suggestedCents / 100).replace(".", ",") : "");
    setPaidOn(todayAR());
    setBankId(account.bank_accounts.find((a) => a.is_default)?.id ?? account.bank_accounts[0]?.id ?? null);
    setReference(account.reference);
    setNote("");
    setFile(null);
    setTouched(false);
  };

  const cents = parsePesosToCents(amount);
  const errors = validateTransferReport({ amountCents: cents, paidOn, today: todayAR(), file });
  const valid = Object.keys(errors).length === 0;
  const err = (k: keyof typeof errors) => (touched ? errors[k] : undefined);

  async function submit() {
    setTouched(true);
    if (!valid || !file || cents === null) return;
    try {
      await r.report.mutateAsync({ amountCents: cents, paidOn, bankAccountId: bankId, reference, note, file });
      toast({ title: "Recibimos tu comprobante", description: "Te avisamos por email cuando lo acreditemos.", variant: "success" });
      onOpenChange(false);
    } catch (e) {
      toast({ title: "No se pudo informar la transferencia", description: billingErrorMessage(e), variant: "error" });
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (o) reset();
        onOpenChange(o);
      }}
      title="Ya transferí"
      description="Contanos cuánto transferiste y subí el comprobante. Lo verificamos y lo imputamos a tu cuenta."
      className="max-w-lg"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={submit} loading={r.report.isPending}>
            <Send size={15} aria-hidden /> Informar transferencia
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Importe transferido ($)"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0,00"
            error={err("amount")}
          />
          <Input label="Fecha de la transferencia" type="date" value={paidOn} max={todayAR()} onChange={(e) => setPaidOn(e.target.value)} error={err("paidOn")} />
        </div>

        {account.bank_accounts.length > 1 && (
          <div>
            <span className="mb-2 block text-sm font-medium text-muted-foreground">¿A qué cuenta?</span>
            <div role="radiogroup" aria-label="Cuenta de destino" className="grid gap-2 sm:grid-cols-2">
              {account.bank_accounts.map((a) => (
                <ChoiceCard
                  key={a.id}
                  selected={bankId === a.id}
                  onClick={() => setBankId(a.id)}
                  icon={<BankLogo slug={a.bank_slug} name={a.bank_name} size={28} />}
                  title={a.bank_name}
                  description={a.alias ?? a.cbu ?? undefined}
                />
              ))}
            </div>
          </div>
        )}

        <Input
          label="Referencia o número de operación (opcional)"
          value={reference}
          maxLength={80}
          onChange={(e) => setReference(e.target.value)}
        />

        <div>
          <span className="mb-2 block text-sm font-medium text-muted-foreground">Comprobante</span>
          <input
            ref={fileRef}
            type="file"
            accept={PROOF_MIME.join(",")}
            className="hidden"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="flex w-full items-center gap-3 rounded-lg bg-muted/60 px-4 py-3 text-left transition hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-background text-muted-foreground">
              {file ? <Paperclip size={18} aria-hidden /> : <FileUp size={18} aria-hidden />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{file ? file.name : "Elegí el archivo"}</span>
              <span className="block text-xs text-muted-foreground">PDF, JPG, PNG o WebP hasta 10 MB.</span>
            </span>
          </button>
          {err("file") && <p className="mt-2 text-sm text-destructive">{err("file")}</p>}
        </div>

        <Input label="Comentario (opcional)" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
      </div>
    </Modal>
  );
}

// ── Tarjeta ─────────────────────────────────────────────────────────────────

export function HowToPayCard({ tenantId }: { tenantId: string | null }) {
  const { toast } = useToast();
  const { data: acc, isLoading, error } = useMyBillingAccount();
  const { data: st } = useMyStatement();
  const r = useReportTransfer(tenantId);
  const [reportOpen, setReportOpen] = useState(false);
  const [going, setGoing] = useState(false);

  // Sin la migración (o sin permiso) no se muestra nada.
  if (error) return null;
  if (isLoading || !acc) return <Skeleton className="h-40 rounded-xl" />;

  const isAccount = acc.billing_mode === "account";
  const pendingMp = acc.pending_mode === "mp_subscription";
  const suggested = st ? (st.overdue_cents > 0 ? st.overdue_cents : (st.next_due?.cents ?? 0)) : 0;
  const waHref = acc.payment_proof_whatsapp
    ? whatsappLink(acc.payment_proof_whatsapp, `Hola, les mando el comprobante de la transferencia (${acc.reference}).`)
    : null;
  const lastChange = acc.mode_changes.find((c) => c.status !== "cancelled") ?? null;

  if (!isAccount && !pendingMp && acc.reports.length === 0 && acc.mode_changes.length === 0) return null;

  return (
    <section>
      <SectionHeader
        title="Cómo pagar"
        icon={Wallet}
        description={`Pagás tu suscripción con ${modeLabel(acc.billing_mode).toLowerCase()}.`}
        actions={
          isAccount && acc.is_owner ? (
            <Button size="sm" onClick={() => setReportOpen(true)}>
              <Send size={15} aria-hidden /> Ya transferí
            </Button>
          ) : undefined
        }
      />

      <div className="mt-3 space-y-4">
        {pendingMp && (
          <Callout
            tone="brand"
            icon={CreditCard}
            title="Activá el débito automático con Mercado Pago"
            actions={
              acc.is_owner ? (
                <Button
                  size="sm"
                  loading={going}
                  onClick={async () => {
                    setGoing(true);
                    try {
                      window.location.href = await ownerSubscriptionCheckout();
                    } catch (e) {
                      setGoing(false);
                      toast({ title: "No pudimos abrir Mercado Pago", description: billingErrorMessage(e), variant: "error" });
                    }
                  }}
                >
                  Autorizar en Mercado Pago
                </Button>
              ) : undefined
            }
          >
            Acordamos pasar tu suscripción a débito automático. Hasta el primer débito seguís pagando como ahora
            {isAccount ? " por transferencia" : ""}; el primer débito paga el próximo período.
            {!acc.is_owner ? " Lo autoriza el dueño del negocio." : ""}
          </Callout>
        )}

        {isAccount && (
          <>
            {acc.bank_accounts.length === 0 ? (
              <Callout tone="neutral" icon={Landmark} title="Pronto vas a ver acá los datos para transferir">
                Mientras tanto, escribinos y te los pasamos.
              </Callout>
            ) : (
              <div className="grid gap-3 lg:grid-cols-2">
                {acc.bank_accounts.map((a) => (
                  <BankAccountDetails key={a.id} account={a} />
                ))}
              </div>
            )}

            <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">Poné esta referencia en el concepto</p>
                <CopyValue value={acc.reference} label="referencia" />
              </div>
              <div className="min-w-0 sm:text-right">
                <p className="text-xs text-muted-foreground">
                  Plazo para pagar cada cuota: {acc.due_days} {acc.due_days === 1 ? "día" : "días"} desde el inicio del período
                </p>
                <div className="mt-1 flex flex-wrap gap-2 sm:justify-end">
                  {acc.payment_proof_email && (
                    <a
                      href={`mailto:${acc.payment_proof_email}?subject=${encodeURIComponent(`Comprobante ${acc.reference}`)}`}
                      className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm font-medium hover:bg-muted"
                    >
                      <Mail size={14} aria-hidden /> {acc.payment_proof_email}
                    </a>
                  )}
                  {waHref && (
                    <a
                      href={waHref}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm font-medium hover:bg-muted"
                    >
                      <MessageCircle size={14} aria-hidden /> WhatsApp
                    </a>
                  )}
                </div>
              </div>
            </div>
            {acc.is_owner ? (
              <p className="text-xs text-muted-foreground">
                Cuando transfieras, tocá <span className="font-medium text-foreground">Ya transferí</span> y subí el comprobante: lo
                verificamos y lo imputamos a tu cuenta. También podés mandarlo por email o WhatsApp.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">El dueño del negocio informa las transferencias.</p>
            )}
          </>
        )}

        {acc.reports.length > 0 && (
          <div>
            <p className="mb-2 text-sm font-medium text-muted-foreground">Transferencias informadas</p>
            <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
              {acc.reports.slice(0, 8).map((t) => {
                const s = REPORT_STATUS[t.status];
                return (
                  <li key={t.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium tabular-nums">
                        {formatCents(t.approved_cents ?? t.amount_cents)}
                        <span className="font-normal text-muted-foreground"> · transferido el {formatDay(t.paid_on)}</span>
                      </p>
                      {t.status === "rejected" && t.reject_reason && <p className="text-xs text-danger">{t.reject_reason}</p>}
                      {t.status === "approved" && t.approved_cents != null && t.approved_cents !== t.amount_cents && (
                        <p className="text-xs text-muted-foreground">Informaste {formatCents(t.amount_cents)}.</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge tone={s.tone}>
                        {t.status === "approved" && <CircleCheck size={12} aria-hidden />} {s.label}
                      </Badge>
                      {t.status === "pending" && acc.is_owner && (
                        <Button
                          variant="ghost"
                          size="sm"
                          loading={r.cancel.isPending}
                          onClick={() =>
                            r.cancel.mutate(t.id, {
                              onSuccess: () => toast({ title: "Transferencia retirada", variant: "success" }),
                              onError: (e) => toast({ title: "No se pudo retirar", description: billingErrorMessage(e), variant: "error" }),
                            })
                          }
                          aria-label="Retirar la transferencia informada"
                        >
                          <Undo2 size={14} aria-hidden /> <span className="hidden sm:inline">Retirar</span>
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {lastChange && (
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <ArrowRightLeft size={14} className="mt-0.5 shrink-0" aria-hidden />
            <span>
              {lastChange.status === "pending_checkout"
                ? `Desde el ${formatDay(lastChange.created_at)}: pase de ${modeLabel(lastChange.from_mode).toLowerCase()} a débito automático, pendiente de tu autorización.`
                : `Desde el ${formatDay(lastChange.completed_at ?? lastChange.created_at)} pagás con ${modeLabel(lastChange.to_mode).toLowerCase()}${
                    lastChange.from_mode ? ` (antes, ${modeLabel(lastChange.from_mode).toLowerCase()})` : ""
                  }.`}
            </span>
          </p>
        )}
      </div>

      {isAccount && acc.is_owner && (
        <ReportTransferModal open={reportOpen} onOpenChange={setReportOpen} account={acc} tenantId={tenantId} suggestedCents={suggested} />
      )}
    </section>
  );
}
HowToPayCard.displayName = "HowToPayCard";
