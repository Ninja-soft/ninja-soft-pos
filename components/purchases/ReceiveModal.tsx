"use client";

// Recepción de mercadería (F18 · H101, ADR-050): contra una orden de compra
// (pendiente precargado, diferencias con motivo, cierre con faltante) o libre
// (proveedor opcional, sucursal y productos a mano). Suma stock en la sucursal
// y actualiza costos en el servidor (RPC purchase_receive).

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, PackageCheck, Trash2, TriangleAlert } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { formatQty } from "@/lib/utils/format";
import {
  RECEIPT_DIFFERENCE_LABEL,
  formatOrderNumber,
  pendingQty,
  purchaseErrorMessage,
  unitNet,
  type ReceiptDifferenceReason,
} from "@/lib/purchases/orders";
import { CURRENCIES, CURRENCY_LABEL } from "@/lib/purchases/suppliers";
import { variantLabel, type Product, type ProductVariant } from "@/modules/products/api";
import { useCurrentStoreId, useStores } from "@/modules/stock/hooks";
import { useMyTenant } from "@/modules/tenants/hooks";
import {
  usePurchaseMutations,
  usePurchaseOrder,
  usePurchasesAccess,
  useSuppliers,
} from "@/modules/purchases/hooks";
import type { ReceiveLineInput } from "@/modules/purchases/api";
import { ProductPicker } from "./ProductPicker";
import { formatMoney, inputCls, parseNum, selectCls, storeName, supplierName, today } from "./shared";

interface Line {
  key: string;
  order_item_id: string | null;
  product_id: string;
  variant_id: string | null;
  name: string;
  variant_label: string | null;
  unit: string;
  pending: number | null;
  ordered: number | null;
  qty: string;
  unit_cost: string;
  reason: ReceiptDifferenceReason | "";
  lot_code: string;
  expires_on: string;
  weight_kg: string;
  volume_m3: string;
}

const numStr = (n: number) => String(n).replace(".", ",");

export function ReceiveModal({
  open,
  onOpenChange,
  orderId,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  orderId?: string | null;
  onDone?: (receiptId: string) => void;
}) {
  const { toast } = useToast();
  const m = usePurchaseMutations();
  const access = usePurchasesAccess();
  const settings = access.settings;
  const { data: me } = useMyTenant();
  const { data: stores = [] } = useStores();
  const currentStoreId = useCurrentStoreId();
  const { data: suppliers = [] } = useSuppliers({}, open);
  const { data: order, isLoading: orderLoading } = usePurchaseOrder(open && orderId ? orderId : null);

  const [lines, setLines] = useState<Line[]>([]);
  const [supplierId, setSupplierId] = useState("");
  const [storeId, setStoreId] = useState("");
  const [currency, setCurrency] = useState("ARS");
  const [fx, setFx] = useState("1");
  const [date, setDate] = useState(today());
  const [remito, setRemito] = useState("");
  const [notes, setNotes] = useState("");
  const [close, setClose] = useState(false);
  const [showLots, setShowLots] = useState(false);
  const [busy, setBusy] = useState(false);

  // Inicialización al abrir (y cuando llega la OC).
  useEffect(() => {
    if (!open) return;
    setDate(today());
    setRemito("");
    setNotes("");
    setClose(false);
    setShowLots(false);
    if (orderId) {
      if (!order || order.id !== orderId) {
        setLines([]);
        return;
      }
      setSupplierId(order.supplier_id);
      setStoreId(order.store_id);
      setCurrency(order.currency);
      setFx(numStr(order.fx_rate));
      setLines(
        order.items
          .filter((i) => pendingQty(i) > 0)
          .map((i) => ({
            key: i.id,
            order_item_id: i.id,
            product_id: i.product_id,
            variant_id: i.variant_id,
            name: i.product_name,
            variant_label: i.variant_label,
            unit: i.unit,
            pending: pendingQty(i),
            ordered: i.qty_ordered,
            qty: numStr(pendingQty(i)),
            unit_cost: numStr(unitNet(i.unit_cost, i.discounts, order.discount_pct)),
            reason: "",
            lot_code: "",
            expires_on: "",
            weight_kg: "",
            volume_m3: "",
          })),
      );
    } else {
      setSupplierId("");
      setStoreId(currentStoreId ?? stores[0]?.id ?? "");
      setCurrency("ARS");
      setFx("1");
      setLines([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, orderId, order?.id]);

  // La sucursal por defecto puede llegar después de abrir.
  useEffect(() => {
    if (open && !orderId && !storeId && (currentStoreId || stores[0]?.id)) {
      setStoreId(currentStoreId ?? stores[0]!.id);
    }
  }, [open, orderId, storeId, currentStoreId, stores]);

  const role = me?.role ?? "viewer";
  const canFree = settings.allow_free_receipts || role === "owner";
  const foreign = currency !== "ARS";

  function patch(key: string, p: Partial<Line>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...p } : l)));
  }

  function addProduct(p: Product, v: ProductVariant | null) {
    const key = `x:${p.id}:${v?.id ?? ""}`;
    setLines((prev) => {
      const i = prev.findIndex((l) => l.key === key);
      if (i >= 0) {
        const next = [...prev];
        next[i] = { ...next[i]!, qty: numStr(parseNum(next[i]!.qty) + 1) };
        return next;
      }
      return [
        ...prev,
        {
          key,
          order_item_id: null,
          product_id: p.id,
          variant_id: v?.id ?? null,
          name: p.name,
          variant_label: v ? variantLabel(v) : null,
          unit: p.unit ?? "un",
          pending: null,
          ordered: null,
          qty: "1",
          unit_cost: p.cost == null ? "" : numStr(Number(p.cost)),
          reason: "",
          lot_code: "",
          expires_on: "",
          weight_kg: "",
          volume_m3: "",
        },
      ];
    });
  }

  const diffOf = (l: Line) => (l.pending == null ? 0 : parseNum(l.qty) - l.pending);
  const units = lines.reduce((t, l) => t + parseNum(l.qty), 0);
  const value = lines.reduce((t, l) => t + parseNum(l.qty) * parseNum(l.unit_cost), 0);
  const leftPending = lines.some((l) => l.pending != null && parseNum(l.qty) < l.pending);

  const problems = useMemo(() => {
    const out: string[] = [];
    if (lines.some((l) => parseNum(l.qty) < 0)) out.push("Hay cantidades negativas.");
    if (!settings.allow_over_receive && lines.some((l) => l.pending != null && parseNum(l.qty) > l.pending)) {
      out.push("No se puede recibir más de lo pedido (configuración de compras).");
    }
    if (
      settings.require_difference_reason &&
      (close || !leftPending) &&
      lines.some((l) => l.pending != null && diffOf(l) !== 0 && !l.reason)
    ) {
      out.push("Indicá el motivo de cada diferencia.");
    }
    if (foreign && !(parseNum(fx) > 0)) out.push("Cargá el tipo de cambio.");
    if (!orderId && !storeId) out.push("Elegí la sucursal.");
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, settings, close, leftPending, foreign, fx, orderId, storeId]);

  const nothing = units <= 0 && !(orderId && close);

  async function submit() {
    if (problems.length > 0 || nothing) return;
    setBusy(true);
    try {
      const items: ReceiveLineInput[] = lines.map((l) => ({
        order_item_id: l.order_item_id,
        product_id: l.order_item_id ? null : l.product_id,
        variant_id: l.order_item_id ? null : l.variant_id,
        qty: parseNum(l.qty),
        unit_cost: l.unit_cost.trim() === "" ? null : parseNum(l.unit_cost),
        reason: l.reason || null,
        lot_code: l.lot_code.trim() || null,
        expires_on: l.expires_on || null,
        weight_kg: l.weight_kg.trim() ? parseNum(l.weight_kg) : null,
        volume_m3: l.volume_m3.trim() ? parseNum(l.volume_m3) : null,
      }));
      const id = await m.receive.mutateAsync({
        order_id: orderId ?? null,
        store_id: orderId ? null : storeId,
        supplier_id: orderId ? null : supplierId || null,
        received_date: date,
        remito_number: remito.trim() || null,
        currency,
        fx_rate: foreign ? parseNum(fx) : 1,
        items,
        close,
        notes: notes.trim() || null,
      });
      toast({ title: "Mercadería recibida: el stock ya está actualizado", variant: "success" });
      onDone?.(id);
      onOpenChange(false);
    } catch (e) {
      toast({ title: "No se pudo registrar la recepción", description: purchaseErrorMessage(e), variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  const title = orderId
    ? `Recibir ${order ? formatOrderNumber(order.number) : "orden de compra"}`
    : "Recepción sin orden de compra";

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      className="sm:max-w-4xl"
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {formatQty(units)} unidades · {formatMoney(value, currency)}
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button onClick={submit} loading={busy} disabled={problems.length > 0 || nothing}>
              <PackageCheck size={16} /> Registrar recepción
            </Button>
          </div>
        </div>
      }
    >
      {!orderId && !canFree ? (
        <p className="rounded-xl bg-muted p-4 text-sm text-muted-foreground">
          Las recepciones sin orden de compra están desactivadas en la configuración de compras.
        </p>
      ) : orderId && orderLoading ? (
        <p className="p-4 text-sm text-muted-foreground">Cargando la orden...</p>
      ) : (
        <div className="space-y-5">
          {orderId && order ? (
            <div className="rounded-xl bg-muted p-3.5 text-sm">
              <span className="font-medium">{supplierName(suppliers, order.supplier_id)}</span>
              <span className="text-muted-foreground"> · entra en </span>
              <span className="font-medium">{storeName(stores, order.store_id)}</span>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Proveedor (opcional)</span>
                <select className={selectCls} value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                  <option value="" className="bg-popover text-popover-foreground">
                    Sin proveedor
                  </option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id} className="bg-popover text-popover-foreground">
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Sucursal que recibe</span>
                <select className={selectCls} value={storeId} onChange={(e) => setStoreId(e.target.value)}>
                  {stores.map((s) => (
                    <option key={s.id} value={s.id} className="bg-popover text-popover-foreground">
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-3">
            <Input label="Fecha de recepción" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            <Input
              label="N° de remito del proveedor"
              placeholder="0001-00001234"
              maxLength={40}
              value={remito}
              onChange={(e) => setRemito(e.target.value)}
            />
            <Input label="Notas" maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>

          {access.pro && (
            <div className="grid gap-3 sm:grid-cols-3">
              {!orderId ? (
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Moneda</span>
                  <select className={selectCls} value={currency} onChange={(e) => setCurrency(e.target.value)}>
                    {CURRENCIES.map((c) => (
                      <option key={c} value={c} className="bg-popover text-popover-foreground">
                        {CURRENCY_LABEL[c] ?? c}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <div className="text-sm">
                  <span className="block text-xs text-muted-foreground">Moneda de la orden</span>
                  <span className="font-medium">{CURRENCY_LABEL[currency] ?? currency}</span>
                </div>
              )}
              {foreign && (
                <Input
                  label="Tipo de cambio de la recepción"
                  inputMode="decimal"
                  value={fx}
                  onChange={(e) => setFx(e.target.value)}
                  hint="Pesos por unidad de moneda. El costo entra en pesos."
                />
              )}
            </div>
          )}

          <div>
            <div className="mb-2 flex items-center justify-between">
              <h4 className="text-sm font-semibold">Productos</h4>
              <button
                type="button"
                onClick={() => setShowLots((s) => !s)}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                {showLots ? <ChevronDown size={13} /> : <ChevronRight size={13} />} Lote y vencimiento
                {access.pro ? ", peso y volumen" : ""}
              </button>
            </div>
            {lines.length === 0 ? (
              <p className="rounded-xl bg-muted p-4 text-center text-sm text-muted-foreground">
                {orderId
                  ? "No queda nada pendiente en la orden. Podés sumar productos abajo."
                  : "Buscá productos o escanealos para sumarlos a la recepción."}
              </p>
            ) : (
              <div className="overflow-x-auto rounded-xl ring-1 ring-border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/60 text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left">Producto</th>
                      {orderId && <th className="px-3 py-2 text-right">Pendiente</th>}
                      <th className="px-3 py-2 text-right">Recibo</th>
                      <th className="px-3 py-2 text-right">Costo unit.{foreign ? ` (${currency})` : ""}</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {lines.map((l) => {
                      const diff = diffOf(l);
                      return (
                        <tr key={l.key} className="align-top">
                          <td className="px-3 py-2">
                            <div className="font-medium">
                              {l.name}
                              {l.variant_label ? ` (${l.variant_label})` : ""}
                            </div>
                            {!l.order_item_id && orderId && (
                              <div className="text-xs text-warning">Fuera de la orden</div>
                            )}
                            {l.pending != null && diff !== 0 && (
                              <div className="mt-1 flex flex-wrap items-center gap-2">
                                <span className={cn("text-xs", diff < 0 ? "text-warning" : "text-info")}>
                                  {diff < 0 ? "Faltan" : "Sobran"} {formatQty(Math.abs(diff))}
                                </span>
                                <select
                                  aria-label="Motivo de la diferencia"
                                  className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                                  value={l.reason}
                                  onChange={(e) =>
                                    patch(l.key, { reason: e.target.value as ReceiptDifferenceReason | "" })
                                  }
                                >
                                  <option value="">Motivo</option>
                                  {Object.entries(RECEIPT_DIFFERENCE_LABEL).map(([k, v]) => (
                                    <option key={k} value={k}>
                                      {v}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            )}
                            {showLots && (
                              <div className="mt-2 grid grid-cols-2 gap-2">
                                <input
                                  aria-label="Lote"
                                  placeholder="Lote"
                                  className={cn(inputCls, "h-8 text-xs")}
                                  value={l.lot_code}
                                  maxLength={60}
                                  onChange={(e) => patch(l.key, { lot_code: e.target.value })}
                                />
                                <input
                                  aria-label="Vencimiento"
                                  type="date"
                                  className={cn(inputCls, "h-8 text-xs")}
                                  value={l.expires_on}
                                  onChange={(e) => patch(l.key, { expires_on: e.target.value })}
                                />
                                {access.pro && (
                                  <>
                                    <input
                                      aria-label="Peso total (kg)"
                                      placeholder="Peso total kg"
                                      inputMode="decimal"
                                      className={cn(inputCls, "h-8 text-xs")}
                                      value={l.weight_kg}
                                      onChange={(e) => patch(l.key, { weight_kg: e.target.value })}
                                    />
                                    <input
                                      aria-label="Volumen total (m³)"
                                      placeholder="Volumen total m³"
                                      inputMode="decimal"
                                      className={cn(inputCls, "h-8 text-xs")}
                                      value={l.volume_m3}
                                      onChange={(e) => patch(l.key, { volume_m3: e.target.value })}
                                    />
                                  </>
                                )}
                              </div>
                            )}
                          </td>
                          {orderId && (
                            <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                              {l.pending == null ? "" : `${formatQty(l.pending)} ${l.unit}`}
                            </td>
                          )}
                          <td className="px-3 py-2 text-right">
                            <input
                              aria-label="Cantidad recibida"
                              inputMode="decimal"
                              className={cn(inputCls, "ml-auto h-9 w-24 text-right")}
                              value={l.qty}
                              onChange={(e) => patch(l.key, { qty: e.target.value })}
                            />
                          </td>
                          <td className="px-3 py-2 text-right">
                            <input
                              aria-label="Costo unitario"
                              inputMode="decimal"
                              className={cn(inputCls, "ml-auto h-9 w-28 text-right")}
                              value={l.unit_cost}
                              onChange={(e) => patch(l.key, { unit_cost: e.target.value })}
                            />
                          </td>
                          <td className="px-2 py-2 text-right">
                            <button
                              type="button"
                              aria-label="Quitar"
                              onClick={() => setLines((prev) => prev.filter((x) => x.key !== l.key))}
                              className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-danger"
                            >
                              <Trash2 size={15} />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {orderId ? "Sumar un producto que no estaba en la orden" : "Agregar productos"}
            </h4>
            <ProductPicker onPick={addProduct} enabled={open} autoFocus={!orderId} />
          </div>

          {orderId && (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={close}
                onChange={(e) => setClose(e.target.checked)}
              />
              <span>
                Cerrar la orden aunque falte mercadería
                <span className="block text-xs text-muted-foreground">
                  Lo pendiente no se espera más. Sin marcarlo, la orden queda recibida en parte.
                </span>
              </span>
            </label>
          )}

          {problems.length > 0 && (
            <div className="space-y-1 rounded-xl bg-warning/10 p-3 text-sm text-warning">
              {problems.map((p) => (
                <div key={p} className="flex items-center gap-1.5">
                  <TriangleAlert size={14} /> {p}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
