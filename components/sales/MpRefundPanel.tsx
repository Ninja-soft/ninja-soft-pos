"use client";

import { useState } from "react";
import { Banknote, Check, CircleAlert, Loader2, RefreshCw, Ticket } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import {
  MP_REFUND_STATUS_LABEL,
  canFallback,
  canRetry,
  mpRefundErrorMessage,
  type MpRefundStatus,
} from "@/lib/payments/mpRefund";
import { useMpRefundFallback, useRunMpRefund } from "@/modules/sales/mpRefund";

export interface MpRefundPanelRefund {
  id: string;
  amount: number;
  status: MpRefundStatus;
  error_code: string | null;
  mp_refund_id: string | null;
  fallback_method?: "cash" | "store_credit" | null;
}

const TONE: Record<string, string> = {
  success: "bg-emerald-400/10 text-success",
  warning: "bg-amber-400/10 text-warning",
  danger: "bg-red-500/10 text-destructive",
  neutral: "bg-muted/40 text-muted-foreground",
};

// Estado de un reintegro por Mercado Pago (H21h · ADR-067) con las acciones
// honestas: reintentar (misma clave si la respuesta fue dudosa) y, si Mercado
// Pago lo rechazó, devolver en efectivo o con un vale.
export function MpRefundPanel({
  refund,
  customerId,
  compact = false,
  onChange,
}: {
  refund: MpRefundPanelRefund;
  customerId?: string | null;
  compact?: boolean;
  onChange?: (next: MpRefundPanelRefund, extra?: { voucherCode?: string | null }) => void;
}) {
  const { toast } = useToast();
  const run = useRunMpRefund();
  const fallback = useMpRefundFallback();
  const [voucher, setVoucher] = useState<string | null>(null);
  const meta = MP_REFUND_STATUS_LABEL[refund.status] ?? MP_REFUND_STATUS_LABEL.pending;
  const busy = run.isPending || fallback.isPending || refund.status === "processing";
  const done = refund.status === "approved" || refund.status === "in_process";

  const retry = async () => {
    const res = await run.mutateAsync(refund.id);
    const status = (res.status === "error" && res.error === "in_progress" ? "processing" : res.status) as MpRefundStatus;
    onChange?.({ ...refund, status, error_code: res.error ?? null, mp_refund_id: res.mp_refund_id ?? refund.mp_refund_id });
    if (status === "approved" || status === "in_process") {
      toast({ title: "Reintegro hecho por Mercado Pago", variant: "success" });
    } else {
      toast({ title: mpRefundErrorMessage(res.error), variant: "error" });
    }
  };

  const toFallback = (method: "cash" | "store_credit") =>
    fallback.mutate(
      { refundId: refund.id, method, customerId },
      {
        onSuccess: (r) => {
          setVoucher(r.voucher_code);
          onChange?.({ ...refund, status: "fallback", fallback_method: method }, { voucherCode: r.voucher_code });
          toast({
            title: method === "cash" ? "Reintegro en efectivo registrado" : `Vale ${r.voucher_code ?? ""} emitido`,
            variant: "success",
          });
        },
        onError: (e) => {
          const msg = e instanceof Error ? e.message : String(e);
          toast({
            title: msg.includes("no_open_shift")
              ? "Abrí tu caja para devolver en efectivo"
              : msg.includes("store_credit_needs_customer")
                ? "El vale necesita un cliente: devolvelo en efectivo"
                : mpRefundErrorMessage(msg),
            variant: "error",
          });
        },
      },
    );

  return (
    <div className={cn("rounded-xl border border-border", compact ? "p-3" : "p-3.5")}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-lg", TONE[meta.tone])}>
            {busy ? (
              <Loader2 size={15} className="animate-spin" />
            ) : done ? (
              <Check size={15} />
            ) : refund.status === "fallback" ? (
              refund.fallback_method === "store_credit" ? <Ticket size={15} /> : <Banknote size={15} />
            ) : (
              <CircleAlert size={15} />
            )}
          </span>
          <div className="min-w-0 text-sm">
            <div className="font-semibold">{meta.label}</div>
            <div className="text-xs text-muted-foreground">
              {formatCurrency(refund.amount)}
              {refund.mp_refund_id ? ` · Devolución MP ${refund.mp_refund_id}` : ""}
              {refund.status === "fallback" && refund.fallback_method
                ? ` · ${refund.fallback_method === "cash" ? "en efectivo" : "con vale"}`
                : ""}
            </div>
            {(refund.status === "failed" || refund.status === "error") && (
              <p className="mt-1 text-xs text-muted-foreground">{mpRefundErrorMessage(refund.error_code)}</p>
            )}
            {voucher && <p className="mt-1 font-mono text-xs font-semibold">Vale {voucher}</p>}
          </div>
        </div>
      </div>

      {(canRetry(refund.status) || canFallback(refund.status)) && (
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          {canFallback(refund.status) && (
            <>
              <Button variant="secondary" className="h-9 px-3" disabled={busy} onClick={() => toFallback("cash")}>
                <Banknote size={14} /> Devolver en efectivo
              </Button>
              <Button variant="secondary" className="h-9 px-3" disabled={busy} onClick={() => toFallback("store_credit")}>
                <Ticket size={14} /> Dar un vale
              </Button>
            </>
          )}
          {canRetry(refund.status) && (
            <Button className="h-9 px-3" loading={run.isPending} disabled={busy} onClick={retry}>
              <RefreshCw size={14} /> {refund.status === "pending" ? "Enviar a Mercado Pago" : "Reintentar"}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
