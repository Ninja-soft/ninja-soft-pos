"use client";

// =============================================================================
// Pagos a verificar (F20-8 · ADR-120, spec docs/40 §9.3): transferencias que
// los negocios informaron con "Ya transferí". El staff abre el comprobante
// (URL firmada de 10 minutos), lo coteja con el banco y:
//   · aprueba: se imputa el pago (FIFO, deuda más vieja primero) por lo que
//     efectivamente entró, que puede diferir de lo informado;
//   · rechaza: con motivo, que le llega al negocio por email.
// Operan Cobranzas, admin y super_admin (el servidor lo valida).
// =============================================================================

import { useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { Check, FileText, Inbox, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { ReasonDialog } from "@/components/internal/ReasonDialog";
import { billingErrorMessage, formatCents, formatDay, parsePesosToCents } from "@/lib/billing/ledger";
import { proofSignedUrl, useCollectionMutations, type PlatformBankAccount, type TransferReport } from "@/modules/billing/collection";

const STATUS: Record<TransferReport["status"], { label: string; tone: "warning" | "success" | "danger" | "neutral" }> = {
  pending: { label: "A verificar", tone: "warning" },
  approved: { label: "Acreditada", tone: "success" },
  rejected: { label: "Rechazada", tone: "danger" },
  cancelled: { label: "Retirada", tone: "neutral" },
};

export function TransferStatusBadge({ status }: { status: TransferReport["status"] }) {
  const s = STATUS[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function ProofButton({ path }: { path: string | undefined }) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  if (!path) return null;
  return (
    <Button
      variant="secondary"
      size="sm"
      loading={loading}
      onClick={async () => {
        setLoading(true);
        try {
          const url = await proofSignedUrl(path);
          window.open(url, "_blank", "noopener,noreferrer");
        } catch {
          toast({ title: "No se pudo abrir el comprobante", variant: "error" });
        } finally {
          setLoading(false);
        }
      }}
    >
      <FileText size={15} aria-hidden /> Comprobante
    </Button>
  );
}

export function TransferInbox({
  reports,
  accounts,
  canOperate,
  showTenant = true,
}: {
  reports: TransferReport[];
  accounts: PlatformBankAccount[];
  canOperate: boolean;
  showTenant?: boolean;
}) {
  const { toast } = useToast();
  const m = useCollectionMutations();
  const [approving, setApproving] = useState<TransferReport | null>(null);
  const [rejecting, setRejecting] = useState<TransferReport | null>(null);
  const [amount, setAmount] = useState("");

  if (reports.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card">
        <EmptyState compact icon={Inbox} title="Nada para verificar" description="Cuando un negocio informe una transferencia aparece acá." />
      </div>
    );
  }

  const accountName = (id: string | null | undefined) => accounts.find((a) => a.id === id)?.bank_name ?? null;
  const cents = parsePesosToCents(amount);

  return (
    <>
      <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
        {reports.map((r) => {
          const acc = accountName(r.bank_account_id);
          return (
            <li key={r.id} className="flex flex-col gap-3 px-4 py-4 lg:flex-row lg:items-center">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  {showTenant && r.tenant_id ? (
                    <Link
                      href={`/internal/tenants/${r.tenant_id}?tab=cuenta` as Route}
                      className="truncate font-medium hover:underline"
                    >
                      {r.tenant_name}
                    </Link>
                  ) : null}
                  <span className="text-lg font-semibold tabular-nums">{formatCents(r.amount_cents)}</span>
                  <TransferStatusBadge status={r.status} />
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Transferido el {formatDay(r.paid_on)}
                  {acc ? ` a ${acc}` : ""}
                  {r.reference ? ` · Ref. ${r.reference}` : ""}
                  {r.reported_by_name ? ` · informó ${r.reported_by_name}` : ""}
                  {` · ${new Date(r.created_at).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" })}`}
                </p>
                {r.note && <p className="mt-1 text-sm text-muted-foreground">{r.note}</p>}
                {typeof r.balance_cents === "number" && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Saldo actual del negocio: <span className="font-medium tabular-nums text-foreground">{formatCents(r.balance_cents)}</span>
                  </p>
                )}
                {r.status === "rejected" && r.reject_reason && <p className="mt-1 text-xs text-danger">{r.reject_reason}</p>}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <ProofButton path={r.proof_path} />
                {canOperate && r.status === "pending" && (
                  <>
                    <Button variant="secondary" size="sm" onClick={() => setRejecting(r)}>
                      <X size={15} aria-hidden /> Rechazar
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => {
                        setAmount(String(r.amount_cents / 100).replace(".", ","));
                        setApproving(r);
                      }}
                    >
                      <Check size={15} aria-hidden /> Acreditar
                    </Button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <ReasonDialog
        open={approving !== null}
        onOpenChange={(o) => !o && setApproving(null)}
        title="Acreditar transferencia"
        description={
          approving
            ? `${approving.tenant_name ?? "El negocio"} informó ${formatCents(approving.amount_cents)}. Se imputa a la deuda más vieja; lo que sobre queda a favor.`
            : undefined
        }
        confirmLabel={cents ? `Acreditar ${formatCents(cents)}` : "Acreditar"}
        loading={m.verifyTransfer.isPending}
        extra={
          <Input
            label="Importe que entró"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            error={amount && cents === null ? "Importe inválido" : undefined}
            hint="Si el banco muestra otro importe, acreditá el real."
          />
        }
        onConfirm={async (reason) => {
          if (!approving || !cents) return;
          try {
            await m.verifyTransfer.mutateAsync({ reportId: approving.id, approve: true, amountCents: cents, reason });
            toast({ title: "Transferencia acreditada", variant: "success" });
            setApproving(null);
          } catch (e) {
            toast({ title: "No se pudo acreditar", description: billingErrorMessage(e), variant: "error" });
          }
        }}
      />

      <ReasonDialog
        open={rejecting !== null}
        onOpenChange={(o) => !o && setRejecting(null)}
        title="Rechazar transferencia"
        description="El motivo le llega al negocio por email. Puede volver a informarla."
        confirmLabel="Rechazar"
        danger
        loading={m.verifyTransfer.isPending}
        onConfirm={async (reason) => {
          if (!rejecting) return;
          try {
            await m.verifyTransfer.mutateAsync({ reportId: rejecting.id, approve: false, amountCents: null, reason });
            toast({ title: "Transferencia rechazada", variant: "success" });
            setRejecting(null);
          } catch (e) {
            toast({ title: "No se pudo rechazar", description: billingErrorMessage(e), variant: "error" });
          }
        }}
      />
    </>
  );
}
TransferInbox.displayName = "TransferInbox";
