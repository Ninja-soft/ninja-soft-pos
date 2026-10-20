"use client";

// Devolución de un cobro de dLocal Go desde la conciliación de cobros QR
// (ADR-180). Sólo cobros aprobados sin venta vigente: se devuelve el total y la
// venta, si la hubo, se anula antes. El servidor vuelve a validar todo (rol,
// plan, venta, una devolución viva por cobro).
import { useState } from "react";
import { Undo2 } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { formatCurrency } from "@/lib/utils/format";
import { canRefundDlocal, dlocalRefundErrorCopy, dlocalRefundLabel } from "@/lib/payments/dlocalgo";

export function DlocalGoRefundAction({
  intent,
  refund,
  onRefund,
  onDone,
}: {
  intent: { id: string; provider_key: string; status: string; amount: number; saleNumber: number | null; saleStatus: string | null };
  refund: { status: string } | null | undefined;
  onRefund: (intentId: string) => Promise<{ status?: string; error?: string }>;
  onDone?: () => void;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const allowed = canRefundDlocal(intent, refund);
  const badge = refund ? dlocalRefundLabel(refund.status) : null;

  if (!allowed && !badge) return null;

  async function confirm() {
    setBusy(true);
    try {
      const r = await onRefund(intent.id);
      if (r.error || r.status === "failed") {
        toast({ title: dlocalRefundErrorCopy(r.error), variant: "error" });
      } else {
        toast({
          title: r.status === "refunded" ? "Pago devuelto" : "Devolución pedida a dLocal Go",
          variant: "success",
        });
      }
    } catch {
      toast({ title: dlocalRefundErrorCopy(null), variant: "error" });
    } finally {
      setBusy(false);
      setOpen(false);
      onDone?.();
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
      {allowed && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex h-7 items-center gap-1 rounded-md bg-muted px-2 text-xs font-semibold text-foreground transition hover:bg-[color-mix(in_srgb,var(--foreground)_10%,transparent)]"
        >
          <Undo2 size={12} /> Devolver
        </button>
      )}
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Devolver el pago de dLocal Go"
        description={`Se le devuelven ${formatCurrency(intent.amount)} al cliente por el mismo medio con que pagó. dLocal Go confirma la devolución después.`}
        confirmLabel="Devolver"
        danger
        loading={busy}
        onConfirm={() => void confirm()}
      />
    </span>
  );
}
DlocalGoRefundAction.displayName = "DlocalGoRefundAction";
