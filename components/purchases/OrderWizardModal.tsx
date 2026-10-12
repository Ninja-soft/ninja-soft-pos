"use client";

// Alta y edición de órdenes de compra en borrador (F18 · H101, ADR-050):
// proveedor y sucursal destino, productos con costo, descuentos en cascada e
// IVA, sugerencia por stock bajo y revisión con totales.

import { useEffect, useMemo, useState } from "react";
import { Lightbulb, Plus, Send, Trash2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { formatQty } from "@/lib/utils/format";
import {
  formatDiscounts,
  lineNet,
  orderTotals,
  parseDiscounts,
  purchaseErrorMessage,
  validDiscounts,
} from "@/lib/purchases/orders";
import { VAT_RATES } from "@/lib/purchases/invoices";
import { suggestPurchaseQty } from "@/lib/purchases/suggest";
import { CURRENCIES, CURRENCY_LABEL } from "@/lib/purchases/suppliers";
import { variantLabel, type Product, type ProductVariant } from "@/modules/products/api";
import { useCurrentStoreId, useStores } from "@/modules/stock/hooks";
import {
  usePurchaseMutations,
  usePurchaseSuggestions,
  usePurchasesAccess,
  useSupplierProducts,
  useSuppliers,
} from "@/modules/purchases/hooks";
import type { OrderDetail, Supplier } from "@/modules/purchases/api";
import { ProductPicker } from "./ProductPicker";
import { SupplierFormModal } from "./SupplierFormModal";
import { formatMoney, inputCls, parseNum, selectCls, textareaCls } from "./shared";

type Step = "datos" | "productos" | "revisar";

interface Line {
  key: string;
  product_id: string;
  variant_id: string | null;
  name: string;
  variant_label: string | null;
  sku: string | null;
  supplier_sku: string | null;
  unit: string;
  qty: string;
  unit_cost: string;
  discounts: string;
  tax_rate: number;
}

const numStr = (n: number) => String(n).replace(".", ",");
const lineKey = (p: string, v: string | null) => `${p}:${v ?? ""}`;

export function OrderWizardModal({
  open,
  onOpenChange,
  initial,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initial?: OrderDetail | null;
  onSaved?: (id: string) => void;
}) {
  const { toast } = useToast();
  const m = usePurchaseMutations();
  const access = usePurchasesAccess();
  const { data: suppliers = [] } = useSuppliers({}, open);
  const { data: stores = [] } = useStores();
  const currentStoreId = useCurrentStoreId();

  const [step, setStep] = useState<Step>("datos");
  const [supplierId, setSupplierId] = useState("");
  const [storeId, setStoreId] = useState("");
  const [expected, setExpected] = useState("");
  const [terms, setTerms] = useState("0");
  const [notes, setNotes] = useState("");
  const [currency, setCurrency] = useState("ARS");
  const [fx, setFx] = useState("1");
  const [globalDisc, setGlobalDisc] = useState("0");
  const [lines, setLines] = useState<Line[]>([]);
  const [newSupplier, setNewSupplier] = useState(false);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStep(initial?.items.length ? "productos" : "datos");
    setSupplierId(initial?.supplier_id ?? "");
    setStoreId(initial?.store_id ?? currentStoreId ?? stores[0]?.id ?? "");
    setExpected(initial?.expected_date ?? "");
    setTerms(String(initial?.payment_terms_days ?? 0));
    setNotes(initial?.notes ?? "");
    setCurrency(initial?.currency ?? "ARS");
    setFx(numStr(initial?.fx_rate ?? 1));
    setGlobalDisc(numStr(initial?.discount_pct ?? 0));
    setSuggestOpen(false);
    setPicked({});
    setLines(
      (initial?.items ?? []).map((i) => ({
        key: lineKey(i.product_id, i.variant_id),
        product_id: i.product_id,
        variant_id: i.variant_id,
        name: i.product_name,
        variant_label: i.variant_label,
        sku: i.sku,
        supplier_sku: i.supplier_sku,
        unit: i.unit,
        qty: numStr(i.qty_ordered),
        unit_cost: numStr(i.unit_cost),
        discounts: formatDiscounts(i.discounts),
        tax_rate: i.tax_rate,
      })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initial]);

  useEffect(() => {
    if (open && !storeId && (currentStoreId || stores[0]?.id)) setStoreId(currentStoreId ?? stores[0]!.id);
  }, [open, storeId, currentStoreId, stores]);

  const supplier = suppliers.find((s) => s.id === supplierId) ?? null;
  const { data: supplierProducts = [] } = useSupplierProducts({ supplierId: supplierId || undefined }, open);
  const { data: suggestions = [], isFetching: suggLoading } = usePurchaseSuggestions(
    storeId || null,
    supplierId || null,
    open && suggestOpen,
  );

  function chooseSupplier(s: Supplier | null) {
    setSupplierId(s?.id ?? "");
    if (s) {
      setTerms(String(s.payment_terms_days ?? 0));
      if (access.pro) setCurrency(s.currency || "ARS");
    }
  }

  function costFor(productId: string, variantId: string | null, fallback: number | null) {
    const sp =
      supplierProducts.find((x) => x.product_id === productId && x.variant_id === variantId) ??
      supplierProducts.find((x) => x.product_id === productId && x.variant_id == null);
    const c = sp?.list_cost ?? sp?.last_cost ?? fallback;
    return { cost: c == null ? "" : numStr(c), supplier_sku: sp?.supplier_sku ?? null };
  }

  function addLine(
    p: { id: string; name: string; sku: string | null; unit: string | null; cost: number | null; tax_rate: number | null },
    v: { id: string; label: string; sku: string | null } | null,
    qty = 1,
  ) {
    const key = lineKey(p.id, v?.id ?? null);
    setLines((prev) => {
      const i = prev.findIndex((l) => l.key === key);
      if (i >= 0) {
        const next = [...prev];
        next[i] = { ...next[i]!, qty: numStr(parseNum(next[i]!.qty) + qty) };
        return next;
      }
      const c = costFor(p.id, v?.id ?? null, p.cost);
      return [
        ...prev,
        {
          key,
          product_id: p.id,
          variant_id: v?.id ?? null,
          name: p.name,
          variant_label: v?.label ?? null,
          sku: v?.sku ?? p.sku,
          supplier_sku: c.supplier_sku,
          unit: p.unit ?? "un",
          qty: numStr(qty),
          unit_cost: c.cost,
          discounts: "",
          tax_rate: p.tax_rate ?? 21,
        },
      ];
    });
  }

  function onPick(p: Product, v: ProductVariant | null) {
    addLine(
      {
        id: p.id,
        name: p.name,
        sku: p.sku,
        unit: p.unit,
        cost: p.cost == null ? null : Number(p.cost),
        tax_rate: p.tax_rate == null ? null : Number(p.tax_rate),
      },
      v ? { id: v.id, label: variantLabel(v), sku: v.sku } : null,
    );
  }

  function patch(key: string, p: Partial<Line>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...p } : l)));
  }

  const suggested = useMemo(
    () =>
      suggestions
        .map((r) => ({ r, qty: suggestPurchaseQty(r), key: lineKey(r.product_id, r.variant_id) }))
        .filter((x) => x.qty > 0),
    [suggestions],
  );

  function addSuggested() {
    for (const x of suggested) {
      const q = picked[x.key];
      if (q === undefined) continue;
      const qty = parseNum(q);
      if (!(qty > 0)) continue;
      addLine(
        {
          id: x.r.product_id,
          name: x.r.product_name,
          sku: x.r.sku,
          unit: x.r.unit,
          cost: x.r.supplier_cost ?? x.r.cost,
          tax_rate: x.r.tax_rate,
        },
        x.r.variant_id ? { id: x.r.variant_id, label: x.r.variant_label ?? "", sku: x.r.sku } : null,
        qty,
      );
    }
    setPicked({});
    setSuggestOpen(false);
  }

  const parsed = lines.map((l) => ({
    l,
    qty: parseNum(l.qty),
    cost: parseNum(l.unit_cost),
    disc: parseDiscounts(l.discounts),
  }));
  const gd = parseNum(globalDisc);
  const totals = orderTotals(
    parsed.map((x) => ({ qty: x.qty, unit_cost: x.cost, discounts: x.disc, tax_rate: x.l.tax_rate })),
    gd,
  );
  const foreign = currency !== "ARS";

  const lineProblems =
    parsed.some((x) => !(x.qty > 0) || x.cost < 0 || !validDiscounts(x.disc)) || !(gd >= 0 && gd < 100);
  const datosOk = Boolean(supplierId && storeId) && (!foreign || parseNum(fx) > 0);

  async function save(send: boolean) {
    if (!datosOk || lines.length === 0 || lineProblems) return;
    setBusy(true);
    try {
      const id = await m.saveOrder.mutateAsync({
        id: initial?.id ?? null,
        supplier_id: supplierId,
        store_id: storeId,
        expected_date: expected || null,
        currency,
        fx_rate: foreign ? parseNum(fx) : 1,
        discount_pct: gd,
        payment_terms_days: terms.trim() === "" ? null : Math.max(0, Math.round(parseNum(terms))),
        notes: notes.trim() || null,
        items: parsed.map((x) => ({
          product_id: x.l.product_id,
          variant_id: x.l.variant_id,
          qty: x.qty,
          unit_cost: x.cost,
          discounts: x.disc,
          tax_rate: x.l.tax_rate,
          supplier_sku: x.l.supplier_sku,
        })),
      });
      if (send) await m.sendOrder.mutateAsync(id);
      toast({ title: send ? "Orden enviada" : "Borrador guardado", variant: "success" });
      onSaved?.(id);
      onOpenChange(false);
    } catch (e) {
      toast({ title: "No se pudo guardar la orden", description: purchaseErrorMessage(e), variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  const footer = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-xs text-muted-foreground">
        {lines.length} {lines.length === 1 ? "producto" : "productos"} · {formatMoney(totals.total, currency)}
      </span>
      <div className="flex flex-wrap justify-end gap-2">
        {step !== "datos" && (
          <Button variant="secondary" onClick={() => setStep(step === "revisar" ? "productos" : "datos")}>
            Atrás
          </Button>
        )}
        {step === "datos" && (
          <Button onClick={() => setStep("productos")} disabled={!datosOk}>
            Siguiente
          </Button>
        )}
        {step === "productos" && (
          <Button onClick={() => setStep("revisar")} disabled={lines.length === 0 || lineProblems}>
            Revisar
          </Button>
        )}
        {step === "revisar" && (
          <>
            <Button variant="secondary" onClick={() => void save(false)} loading={busy}>
              Guardar borrador
            </Button>
            <Button onClick={() => void save(true)} loading={busy}>
              <Send size={15} /> Guardar y enviar
            </Button>
          </>
        )}
      </div>
    </div>
  );

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={initial?.id ? "Editar orden de compra" : "Nueva orden de compra"}
      className="sm:max-w-4xl"
      footer={footer}
    >
      <div className="space-y-5">
        <Segmented<Step>
          aria-label="Paso"
          value={step}
          onChange={(s) => (s === "datos" || datosOk) && setStep(s)}
          size="sm"
          options={[
            { value: "datos", label: "1. Proveedor" },
            { value: "productos", label: "2. Productos" },
            { value: "revisar", label: "3. Revisar" },
          ]}
        />

        {step === "datos" && (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Proveedor</span>
                <select
                  className={selectCls}
                  value={supplierId}
                  onChange={(e) => chooseSupplier(suppliers.find((s) => s.id === e.target.value) ?? null)}
                >
                  <option value="" className="bg-popover text-popover-foreground">
                    Elegí un proveedor
                  </option>
                  {suppliers
                    .filter((s) => s.is_active || s.id === supplierId)
                    .map((s) => (
                      <option key={s.id} value={s.id} className="bg-popover text-popover-foreground">
                        {s.name}
                      </option>
                    ))}
                </select>
                <button
                  type="button"
                  onClick={() => setNewSupplier(true)}
                  className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                >
                  <Plus size={13} /> Nuevo proveedor
                </button>
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
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                label="Fecha esperada de entrega (opcional)"
                type="date"
                value={expected}
                onChange={(e) => setExpected(e.target.value)}
              />
              <Input
                label="Plazo de pago (días)"
                inputMode="numeric"
                value={terms}
                onChange={(e) => setTerms(e.target.value)}
                hint={supplier?.payment_terms_note ?? undefined}
              />
            </div>
            {access.pro && (
              <div className="grid gap-3 sm:grid-cols-2">
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
                {foreign && (
                  <Input
                    label="Tipo de cambio de referencia"
                    inputMode="decimal"
                    value={fx}
                    onChange={(e) => setFx(e.target.value)}
                    hint="Pesos por unidad de moneda. En la recepción se puede ajustar."
                  />
                )}
              </div>
            )}
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Notas para el proveedor</span>
              <textarea
                className={textareaCls}
                maxLength={1000}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Horario de entrega, condiciones, contacto en la sucursal"
              />
            </label>
          </div>
        )}

        {step === "productos" && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-start gap-2">
              <div className="min-w-[16rem] flex-1">
                <ProductPicker onPick={onPick} enabled={open && step === "productos" && !suggestOpen} />
              </div>
              <Button variant="secondary" onClick={() => setSuggestOpen((s) => !s)}>
                <Lightbulb size={16} /> Sugerir por stock bajo
              </Button>
            </div>

            {suggestOpen && (
              <div className="rounded-xl bg-muted p-3">
                <p className="mb-2 text-sm font-medium">
                  Productos bajo el mínimo en la sucursal
                  {supplier ? ` que trabaja ${supplier.name}` : ""}
                </p>
                {suggLoading ? (
                  <p className="text-xs text-muted-foreground">Buscando...</p>
                ) : suggested.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No hay faltantes: todo está sobre su mínimo contando lo que viene en camino y lo ya pedido.
                  </p>
                ) : (
                  <>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead className="text-muted-foreground">
                          <tr>
                            <th className="px-2 py-1.5 text-left" />
                            <th className="px-2 py-1.5 text-left">Producto</th>
                            <th className="px-2 py-1.5 text-right">Stock</th>
                            <th className="px-2 py-1.5 text-right">Mín.</th>
                            <th className="px-2 py-1.5 text-right">Máx.</th>
                            <th className="px-2 py-1.5 text-right">En camino</th>
                            <th className="px-2 py-1.5 text-right">Pedido</th>
                            <th className="px-2 py-1.5 text-right">Comprar</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {suggested.map((x) => {
                            const on = picked[x.key] !== undefined;
                            return (
                              <tr key={x.key}>
                                <td className="px-2 py-1.5">
                                  <input
                                    type="checkbox"
                                    aria-label={`Sumar ${x.r.product_name}`}
                                    checked={on}
                                    onChange={(e) =>
                                      setPicked((p) => {
                                        const n = { ...p };
                                        if (e.target.checked) n[x.key] = numStr(x.qty);
                                        else delete n[x.key];
                                        return n;
                                      })
                                    }
                                  />
                                </td>
                                <td className="px-2 py-1.5">
                                  {x.r.product_name}
                                  {x.r.variant_label ? ` (${x.r.variant_label})` : ""}
                                </td>
                                <td className="px-2 py-1.5 text-right tabular-nums">{formatQty(x.r.qty)}</td>
                                <td className="px-2 py-1.5 text-right tabular-nums">{formatQty(x.r.min_qty)}</td>
                                <td className="px-2 py-1.5 text-right tabular-nums">
                                  {x.r.max_qty == null ? "" : formatQty(x.r.max_qty)}
                                </td>
                                <td className="px-2 py-1.5 text-right tabular-nums">{formatQty(x.r.in_transit_in)}</td>
                                <td className="px-2 py-1.5 text-right tabular-nums">{formatQty(x.r.on_order)}</td>
                                <td className="px-2 py-1.5 text-right">
                                  <input
                                    aria-label="Cantidad a comprar"
                                    inputMode="decimal"
                                    disabled={!on}
                                    className={cn(inputCls, "ml-auto h-8 w-20 text-right text-xs")}
                                    value={picked[x.key] ?? numStr(x.qty)}
                                    onChange={(e) => setPicked((p) => ({ ...p, [x.key]: e.target.value }))}
                                  />
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <div className="mt-2 flex flex-wrap justify-end gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setPicked(Object.fromEntries(suggested.map((x) => [x.key, numStr(x.qty)])))
                        }
                      >
                        Marcar todos
                      </Button>
                      <Button size="sm" onClick={addSuggested} disabled={Object.keys(picked).length === 0}>
                        Sumar a la orden
                      </Button>
                    </div>
                  </>
                )}
              </div>
            )}

            {lines.length === 0 ? (
              <p className="rounded-xl bg-muted p-4 text-center text-sm text-muted-foreground">
                Buscá productos, escanealos o pedí una sugerencia por stock bajo.
              </p>
            ) : (
              <div className="overflow-x-auto rounded-xl ring-1 ring-border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/60 text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left">Producto</th>
                      <th className="px-3 py-2 text-right">Cantidad</th>
                      <th className="px-3 py-2 text-right">Costo unit.</th>
                      <th className="px-3 py-2 text-right">Desc. %</th>
                      <th className="px-3 py-2 text-right">IVA</th>
                      <th className="px-3 py-2 text-right">Neto</th>
                      <th className="px-2 py-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {parsed.map(({ l, qty, cost, disc }) => (
                      <tr key={l.key}>
                        <td className="px-3 py-2">
                          <div className="font-medium">
                            {l.name}
                            {l.variant_label ? ` (${l.variant_label})` : ""}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {[l.supplier_sku && `Cód. prov. ${l.supplier_sku}`, l.sku].filter(Boolean).join(" · ")}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right">
                          <input
                            aria-label="Cantidad"
                            inputMode="decimal"
                            className={cn(inputCls, "ml-auto h-9 w-20 text-right", !(qty > 0) && "border-danger")}
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
                        <td className="px-3 py-2 text-right">
                          <input
                            aria-label="Descuentos"
                            placeholder="10+5"
                            className={cn(
                              inputCls,
                              "ml-auto h-9 w-24 text-right",
                              !validDiscounts(disc) && "border-danger",
                            )}
                            value={l.discounts}
                            onChange={(e) => patch(l.key, { discounts: e.target.value })}
                          />
                        </td>
                        <td className="px-3 py-2 text-right">
                          <select
                            aria-label="Alícuota de IVA"
                            className="h-9 rounded-lg border border-input bg-background px-2 text-sm"
                            value={l.tax_rate}
                            onChange={(e) => patch(l.key, { tax_rate: Number(e.target.value) })}
                          >
                            {VAT_RATES.map((r) => (
                              <option key={r} value={r}>
                                {String(r).replace(".", ",")} %
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums">
                          {formatMoney(lineNet(qty, cost, disc), currency)}
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
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Costos netos de IVA. Los descuentos se aplican en cascada: 10 + 5 es 14,5 %, no 15 %.
            </p>
          </div>
        )}

        {step === "revisar" && (
          <div className="space-y-4">
            <dl className="grid grid-cols-2 gap-3 rounded-xl bg-muted p-3.5 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-xs text-muted-foreground">Proveedor</dt>
                <dd className="font-medium">{supplier?.name ?? ""}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Sucursal</dt>
                <dd className="font-medium">{stores.find((s) => s.id === storeId)?.name ?? ""}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Entrega</dt>
                <dd className="font-medium">{expected ? expected.split("-").reverse().join("/") : "Sin fecha"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Unidades</dt>
                <dd className="font-medium">{formatQty(totals.units)}</dd>
              </div>
            </dl>
            <div className="ml-auto max-w-sm space-y-2 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Subtotal</span>
                <span className="font-mono tabular-nums">{formatMoney(totals.subtotal, currency)}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Descuento general %</span>
                <input
                  aria-label="Descuento general"
                  inputMode="decimal"
                  className={cn(inputCls, "h-8 w-20 text-right", !(gd >= 0 && gd < 100) && "border-danger")}
                  value={globalDisc}
                  onChange={(e) => setGlobalDisc(e.target.value)}
                />
              </div>
              {totals.discount_total > 0 && (
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Descuento</span>
                  <span className="font-mono tabular-nums">-{formatMoney(totals.discount_total, currency)}</span>
                </div>
              )}
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Neto</span>
                <span className="font-mono tabular-nums">{formatMoney(totals.net_total, currency)}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">IVA estimado</span>
                <span className="font-mono tabular-nums">{formatMoney(totals.tax_total, currency)}</span>
              </div>
              <div className="flex justify-between gap-3 border-t border-border pt-2 font-semibold">
                <span>Total estimado</span>
                <span className="font-mono tabular-nums">{formatMoney(totals.total, currency)}</span>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Al enviarla podés imprimirla o mandarla por WhatsApp o mail desde el detalle de la orden.
            </p>
          </div>
        )}
      </div>

      <SupplierFormModal
        open={newSupplier}
        onOpenChange={setNewSupplier}
        onSaved={(s) => chooseSupplier(s)}
      />
    </Modal>
  );
}
