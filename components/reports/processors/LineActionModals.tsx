"use client";

// Acciones sobre una línea de liquidación (ADR-061): vincular a una venta,
// marcar revisado y crear la venta de un cobro sin venta (Mercado Pago).

import { useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Callout } from "@/components/ui/Callout";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { createClient } from "@/lib/supabase/client";
import { formatCurrency } from "@/lib/utils/format";
import { formatSaleNumber } from "@/lib/utils/saleNumber";
import type { SettlementLineRow } from "@/lib/reports/processorReconciliation";
import { useSaleNumberFormat } from "@/modules/sales/hooks";
import { posApi } from "@/modules/pos/api";
import {
  settlementErrorMessage,
  usePaymentsForLink,
  useResolveLine,
} from "@/modules/reports/processorReconciliation";

const METHOD: Record<string, string> = {
  qr: "QR / billetera",
  debit: "Débito",
  credit: "Crédito",
  transfer: "Transferencia",
  directo: "Directo",
  other: "Otro",
};

function LineSummary({ line }: { line: SettlementLineRow }) {
  return (
    <div className="rounded-lg bg-muted/50 px-3 py-2.5 text-sm">
      <div className="flex justify-between gap-3">
        <span className="text-muted-foreground">
          {new Date(line.operation_at).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" })}
        </span>
        <span className="font-semibold tabular-nums">{formatCurrency(line.gross - line.refunded)}</span>
      </div>
      <div className="mt-0.5 truncate text-xs text-muted-foreground">
        {[line.card_brand, line.last4 ? `**** ${line.last4}` : null, line.external_id ? `Pago ${line.external_id}` : null]
          .filter(Boolean)
          .join(" · ")}
      </div>
    </div>
  );
}

export function LinkLineModal({ line, onClose, onDone }: { line: SettlementLineRow; onClose: () => void; onDone: () => void }) {
  const { toast } = useToast();
  const { data: numFmt } = useSaleNumberFormat();
  const resolve = useResolveLine();
  const candidates = usePaymentsForLink(line.operation_at, line.gross - line.refunded);
  const [picked, setPicked] = useState<string | null>(null);
  const [note, setNote] = useState("");

  async function save() {
    if (!picked) return;
    try {
      await resolve.mutateAsync({ lineId: line.id, action: "link", paymentId: picked, note: note.trim() || null });
      toast({ title: "Cobro vinculado a la venta", variant: "success" });
      onDone();
      onClose();
    } catch (e) {
      toast({ title: "No se pudo vincular", description: settlementErrorMessage(e), variant: "error" });
    }
  }

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Vincular a una venta"
      description="Elegí el cobro de la venta que corresponde a este pago. Mostramos primero los del mismo monto, dos días antes y después."
      className="sm:max-w-lg"
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={!picked || resolve.isPending}>
            Vincular
          </Button>
        </div>
      }
    >
      <LineSummary line={line} />
      <div className="mt-3 max-h-72 space-y-1.5 overflow-auto">
        {candidates.isLoading && <Spinner />}
        {!candidates.isLoading && (candidates.data ?? []).length === 0 && (
          <p className="py-4 text-center text-sm text-muted-foreground">No hay cobros en esas fechas.</p>
        )}
        {(candidates.data ?? []).slice(0, 60).map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setPicked(c.id)}
            className={cn(
              "flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left text-sm transition",
              picked === c.id ? "border-ninja-flame bg-ninja-flame/10" : "border-border hover:bg-muted/50",
            )}
          >
            <span className="min-w-0">
              <span className="font-mono text-xs">Venta {formatSaleNumber(c.sales.number, numFmt)}</span>
              {c.sales.status === "voided" && <span className="ml-1 text-xs text-danger">(anulada)</span>}
              <span className="block text-xs text-muted-foreground">
                {new Date(c.created_at).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" })} ·{" "}
                {METHOD[c.method] ?? c.method}
              </span>
            </span>
            <span className={cn("tabular-nums", Math.abs(c.amount - (line.gross - line.refunded)) < 0.01 && "font-semibold text-success")}>
              {formatCurrency(c.amount)}
            </span>
          </button>
        ))}
      </div>
      <label className="mt-3 block">
        <span className="text-xs text-muted-foreground">Nota (opcional)</span>
        <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
      </label>
    </Modal>
  );
}

export function IgnoreLineModal({ line, onClose }: { line: SettlementLineRow; onClose: () => void }) {
  const { toast } = useToast();
  const resolve = useResolveLine();
  const [note, setNote] = useState("");
  async function save() {
    try {
      await resolve.mutateAsync({ lineId: line.id, action: "ignore", note: note.trim() || null });
      toast({ title: "Marcado como revisado", variant: "success" });
      onClose();
    } catch (e) {
      toast({ title: "No se pudo guardar", description: settlementErrorMessage(e), variant: "error" });
    }
  }
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Marcar revisado"
      description="Queda fuera de los pendientes. Podés volver a revisarlo cuando quieras."
      className="sm:max-w-md"
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={resolve.isPending}>
            Marcar revisado
          </Button>
        </div>
      }
    >
      <LineSummary line={line} />
      <label className="mt-3 block">
        <span className="text-xs text-muted-foreground">Motivo (opcional)</span>
        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={300}
          placeholder="Ej.: venta de la tienda online, cobro de otra cuenta"
        />
      </label>
    </Modal>
  );
}

/**
 * Cobro de Mercado Pago sin venta: registra una venta libre por el monto
 * cobrado con el cobro como referencia (el intent aprobado si existe, si no el
 * id del pago de Mercado Pago) en la caja abierta del usuario, y la vincula.
 * Pasa por create_sale como cualquier venta (caja propia, venta libre y tope
 * por rol, plan del medio).
 */
export function CreateSaleFromLineModal({
  line,
  onClose,
  onDone,
}: {
  line: SettlementLineRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const resolve = useResolveLine();
  const amount = Math.round((line.gross - line.refunded) * 100) / 100;
  const [name, setName] = useState(`Cobro Mercado Pago ${line.external_id ?? ""}`.trim());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const reference = line.intent_id ?? line.external_id;
      const res = await posApi.createSale(
        [{ product_id: null, name: name.trim() || "Cobro Mercado Pago", quantity: 1, unit_price: amount, discount: 0 }],
        [{ method: "qr", amount, ...(reference ? { reference } : {}) }],
        0,
      );
      const { data: pay } = await createClient()
        .from("payments")
        .select("id")
        .eq("sale_id", res.sale_id)
        .eq("method", "qr")
        .limit(1)
        .maybeSingle();
      if (pay?.id) await resolve.mutateAsync({ lineId: line.id, action: "link", paymentId: pay.id, note: "Venta creada desde la conciliación" });
      toast({ title: `Venta ${res.number} registrada y conciliada`, variant: "success" });
      onDone();
      onClose();
    } catch (e) {
      setError(settlementErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Crear la venta de este cobro"
      description="Se registra una venta libre por el monto cobrado, en tu caja abierta, con el pago de Mercado Pago como medio."
      className="sm:max-w-md"
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={create} disabled={busy || amount <= 0}>
            {busy ? "Registrando..." : `Registrar ${formatCurrency(amount)}`}
          </Button>
        </div>
      }
    >
      <LineSummary line={line} />
      <label className="mt-3 block">
        <span className="text-xs text-muted-foreground">Descripción del ítem</span>
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
      </label>
      <p className="mt-2 text-xs text-muted-foreground">
        Si querés registrar los productos que se vendieron, hacé la venta desde Vender y después vinculala con
        &quot;Vincular a una venta&quot;.
      </p>
      {error && (
        <Callout tone="danger" className="mt-3">
          {error}
        </Callout>
      )}
    </Modal>
  );
}
