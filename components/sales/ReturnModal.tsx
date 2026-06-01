"use client";

import { useEffect, useMemo, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { useSaleDetail, useReturnSale, useReturnReasons } from "@/modules/sales/hooks";
import { formatCurrency, formatQty } from "@/lib/utils/format";

type Restock = "stock" | "review" | "discard";
type Line = { qty: number; restock: Restock };

const RESTOCK_OPTS: { value: Restock; label: string }[] = [
  { value: "stock", label: "Vuelve a stock" },
  { value: "review", label: "A revisión" },
  { value: "discard", label: "Descarte / merma" },
];

// Devolución parcial de una venta (H29). Elegís cuánto de cada ítem, a dónde va
// el stock, el motivo y si reintegrás por efectivo o emitís un vale.
export function ReturnModal({
  open,
  onOpenChange,
  saleId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  saleId: string | null;
}) {
  const { toast } = useToast();
  const { data } = useSaleDetail(saleId, open);
  const { data: reasons } = useReturnReasons(true);
  const ret = useReturnSale();
  const [lines, setLines] = useState<Record<string, Line>>({});
  const [reasonChoice, setReasonChoice] = useState("");
  const [reasonOther, setReasonOther] = useState("");
  const [refund, setRefund] = useState<"cash" | "store_credit">("cash");
  const [result, setResult] = useState<{
    number: number;
    total: number;
    refund: "cash" | "store_credit";
    reason: string;
    items: { name: string; qty: number; subtotal: number }[];
  } | null>(null);

  useEffect(() => {
    if (open) {
      setLines({});
      setReasonChoice("");
      setReasonOther("");
      setRefund("cash");
      setResult(null);
    }
  }, [open, saleId]);

  const hasReasons = (reasons ?? []).length > 0;
  const finalReason =
    !hasReasons || reasonChoice === "__other__"
      ? reasonOther.trim()
      : (reasons ?? []).find((r) => r.id === reasonChoice)?.label ?? "";

  const hasCustomer = Boolean(data?.sale.customer_id);

  const total = useMemo(() => {
    if (!data) return 0;
    return data.items.reduce((acc, it) => {
      const q = lines[it.id]?.qty ?? 0;
      const unit = it.quantity > 0 ? it.subtotal / it.quantity : it.unit_price;
      return acc + unit * q;
    }, 0);
  }, [data, lines]);

  function setQty(itemId: string, qty: number, max: number) {
    const clamped = Math.max(0, Math.min(qty, max));
    setLines((p) => ({
      ...p,
      [itemId]: { qty: clamped, restock: p[itemId]?.restock ?? "stock" },
    }));
  }
  function setRestock(itemId: string, restock: Restock) {
    setLines((p) => ({ ...p, [itemId]: { qty: p[itemId]?.qty ?? 0, restock } }));
  }

  async function confirm() {
    if (!saleId || !data) return;
    const items = Object.entries(lines)
      .filter(([, l]) => l.qty > 0)
      .map(([sale_item_id, l]) => ({ sale_item_id, quantity: l.qty, restock: l.restock }));
    if (items.length === 0) {
      toast({ title: "Elegí al menos un ítem a devolver", variant: "error" });
      return;
    }
    const snapshot = data.items
      .filter((it) => (lines[it.id]?.qty ?? 0) > 0)
      .map((it) => {
        const qty = lines[it.id]?.qty ?? 0;
        const unit = it.quantity > 0 ? it.subtotal / it.quantity : it.unit_price;
        return { name: it.product_name, qty, subtotal: unit * qty };
      });
    try {
      const res = await ret.mutateAsync({ saleId, items, reason: finalReason, refund });
      toast({ title: `Devolución #${res.number} registrada`, variant: "success" });
      setResult({ number: res.number, total: res.total, refund, reason: finalReason, items: snapshot });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      toast({
        title: msg.includes("no_open_shift")
          ? "Abrí la caja para reintegrar en efectivo"
          : msg.includes("store_credit_needs_customer")
            ? "El vale necesita un cliente en la venta"
            : "No se pudo registrar la devolución",
        variant: "error",
      });
    }
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Devolución / cambio" className="max-w-lg">
      {!data ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Cargando…</p>
      ) : result ? (
        <div className="space-y-4">
          <div className="ticket-print mx-auto rounded-lg border border-border bg-background p-4 font-mono text-sm">
            <div className="text-center font-display text-base font-bold">
              Comprobante de devolución
            </div>
            <div className="mt-1 text-center text-xs text-muted-foreground">
              Dev #{result.number} · {new Date().toLocaleString("es-AR")}
            </div>
            <div className="my-3 border-t border-dashed border-border" />
            <ul className="space-y-1">
              {result.items.map((it, i) => (
                <li key={i} className="flex justify-between gap-2">
                  <span className="truncate">
                    {it.qty}× {it.name}
                  </span>
                  <span>{formatCurrency(it.subtotal)}</span>
                </li>
              ))}
            </ul>
            <div className="my-3 border-t border-dashed border-border" />
            <div className="flex justify-between font-bold">
              <span>TOTAL DEVUELTO</span>
              <span>{formatCurrency(result.total)}</span>
            </div>
            <div className="mt-1 flex justify-between text-xs">
              <span>Reintegro</span>
              <span>{result.refund === "store_credit" ? "Vale (saldo a favor)" : "Efectivo"}</span>
            </div>
            {result.reason && (
              <div className="mt-2 text-xs text-muted-foreground">Motivo: {result.reason}</div>
            )}
          </div>
          <div className="no-print flex justify-end gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cerrar
            </Button>
            <Button onClick={() => window.print()}>Imprimir</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="space-y-2">
            {data.items.map((it) => {
              const available = it.quantity - (it.returned_qty ?? 0);
              const l = lines[it.id];
              return (
                <div key={it.id} className="rounded-lg border border-border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{it.product_name}</div>
                      <div className="text-xs text-muted-foreground">
                        Vendido {formatQty(it.quantity)} · disponible {formatQty(available)} ·{" "}
                        {formatCurrency(it.quantity > 0 ? it.subtotal / it.quantity : it.unit_price)} c/u
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <button
                        type="button"
                        aria-label="Quitar uno"
                        className="grid h-8 w-8 place-items-center rounded-md border border-border text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
                        disabled={(l?.qty ?? 0) <= 0}
                        onClick={() => setQty(it.id, (l?.qty ?? 0) - 1, available)}
                      >
                        <Minus size={15} />
                      </button>
                      <input
                        className="h-8 w-12 rounded-md border border-input bg-background px-1 text-center text-sm tabular-nums outline-none focus:border-ninja-flameSoft"
                        type="number"
                        min={0}
                        max={available}
                        value={l?.qty ?? 0}
                        onChange={(e) => setQty(it.id, Number(e.target.value) || 0, available)}
                      />
                      <button
                        type="button"
                        aria-label="Agregar uno"
                        className="grid h-8 w-8 place-items-center rounded-md border border-border text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
                        disabled={(l?.qty ?? 0) >= available}
                        onClick={() => setQty(it.id, (l?.qty ?? 0) + 1, available)}
                      >
                        <Plus size={15} />
                      </button>
                    </div>
                  </div>
                  {l && l.qty > 0 && (
                    <select
                      value={l.restock}
                      onChange={(e) => setRestock(it.id, e.target.value as Restock)}
                      className="mt-2 h-9 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus:border-ninja-flameSoft"
                    >
                      {RESTOCK_OPTS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              );
            })}
          </div>

          <div>
            <span className="mb-1 block text-sm font-medium text-muted-foreground">Motivo</span>
            {hasReasons ? (
              <div className="space-y-2">
                <select
                  value={reasonChoice}
                  onChange={(e) => setReasonChoice(e.target.value)}
                  className="h-10 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus:border-ninja-flameSoft"
                >
                  <option value="">Elegí un motivo…</option>
                  {(reasons ?? []).map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                  <option value="__other__">Otro (especificar)</option>
                </select>
                {reasonChoice === "__other__" && (
                  <Input
                    placeholder="Especificá el motivo"
                    value={reasonOther}
                    onChange={(e) => setReasonOther(e.target.value)}
                  />
                )}
              </div>
            ) : (
              <Input
                placeholder="Falla, cambio de talle, arrepentimiento…"
                value={reasonOther}
                onChange={(e) => setReasonOther(e.target.value)}
              />
            )}
          </div>

          <div>
            <span className="mb-1 block text-sm font-medium text-muted-foreground">Reintegro</span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setRefund("cash")}
                className={
                  refund === "cash"
                    ? "flex-1 rounded-lg border border-ninja-flame bg-ninja-flame/10 px-3 py-2 text-sm font-medium"
                    : "flex-1 rounded-lg border border-border px-3 py-2 text-sm"
                }
              >
                Efectivo
              </button>
              <button
                type="button"
                disabled={!hasCustomer}
                onClick={() => setRefund("store_credit")}
                title={hasCustomer ? "" : "La venta no tiene cliente"}
                className={
                  refund === "store_credit"
                    ? "flex-1 rounded-lg border border-ninja-flame bg-ninja-flame/10 px-3 py-2 text-sm font-medium disabled:opacity-40"
                    : "flex-1 rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-40"
                }
              >
                Vale (saldo a favor)
              </button>
            </div>
            {!hasCustomer && (
              <p className="mt-1 text-xs text-muted-foreground">
                El vale necesita un cliente asociado a la venta.
              </p>
            )}
          </div>

          <div className="flex items-center justify-between border-t border-border pt-3">
            <span className="text-sm text-muted-foreground">A devolver</span>
            <span className="price-hl font-price text-xl font-black tabular-nums">
              {formatCurrency(total)}
            </span>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button loading={ret.isPending} disabled={total <= 0} onClick={confirm}>
              Registrar devolución
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
