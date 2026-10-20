"use client";

// Devoluciones de un cobro de Talo desde la conciliación de cobros QR
// (ADR-175). "Devolver" = todo lo cobrado (sin venta vigente: la venta se
// anula primero). "Devolver diferencia" = lo transferido de más (OVERPAID),
// con la venta vigente. El servidor vuelve a validar todo (rol, plan, venta,
// montos contra el pago re-consultado, una devolución en curso por cobro).
import { useState } from "react";
import { Undo2 } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { formatCurrency } from "@/lib/utils/format";
import {
  taloRefundErrorCopy,
  taloRefundLabel,
  taloRefundOptions,
  type TaloRefundIntent,
  type TaloRefundRow,
} from "@/lib/payments/talo";

type Kind = "full" | "excess";

const btn =
  "inline-flex h-7 items-center gap-1 rounded-md bg-muted px-2 text-xs font-semibold text-foreground transition hover:bg-[color-mix(in_srgb,var(--foreground)_10%,transparent)]";

export function TaloRefundAction({
  intent,
  refunds,
  onRefund,
  onDone,
}: {
  intent: TaloRefundIntent & { id: string };
  refunds: TaloRefundRow[] | null | undefined;
  onRefund: (intentId: string, kind: Kind) => Promise<{ status?: string; error?: string }>;
  onDone?: () => void;
}) {
  const { toast } = useToast();
  const [ask, setAsk] = useState<Kind | null>(null);
  const [busy, setBusy] = useState(false);
  const opts = taloRefundOptions(intent, refunds);
  const last = refunds?.[0] ?? null;
  const badge = last ? taloRefundLabel(last) : null;

  if (!opts.full && opts.excess === null && !badge) return null;

  const fullAmount = intent.paidAmount && intent.paidAmount > 0 ? intent.paidAmount : intent.amount;

  async function confirm(kind: Kind) {
    setBusy(true);
    try {
      const r = await onRefund(intent.id, kind);
      if (r.error || r.status === "failed") {
        toast({ title: taloRefundErrorCopy(r.error), variant: "error" });
      } else {
        toast({
          title: r.status === "refunded" ? "Plata devuelta" : "Devolución pedida a Talo",
          variant: "success",
        });
      }
    } catch {
      toast({ title: taloRefundErrorCopy(null), variant: "error" });
    } finally {
      setBusy(false);
      setAsk(null);
      onDone?.();
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
      {opts.excess !== null && (
        <button type="button" onClick={() => setAsk("excess")} className={btn}>
          <Undo2 size={12} /> Devolver diferencia
        </button>
      )}
      {opts.full && (
        <button type="button" onClick={() => setAsk("full")} className={btn}>
          <Undo2 size={12} /> Devolver
        </button>
      )}
      <ConfirmDialog
        open={ask !== null}
        onOpenChange={(o) => !o && setAsk(null)}
        title={ask === "excess" ? "Devolver la diferencia con Talo" : "Devolver el pago con Talo"}
        description={
          ask === "excess"
            ? `Se le devuelven ${formatCurrency(opts.excess ?? 0)} al cliente, lo que transfirió de más. La venta sigue vigente.`
            : `Se le devuelve al cliente lo que transfirió (${formatCurrency(fullAmount)}, menos lo ya devuelto) a la cuenta de origen.`
        }
        confirmLabel="Devolver"
        danger
        loading={busy}
        onConfirm={() => ask && void confirm(ask)}
      />
    </span>
  );
}
TaloRefundAction.displayName = "TaloRefundAction";
