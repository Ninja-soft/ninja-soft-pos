"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Banknote,
  Check,
  ChevronRight,
  CreditCard,
  Minus,
  Package,
  Plus,
  QrCode,
  RotateCcw,
  Search,
  ShoppingCart,
  Tag,
  Ticket,
  UserPlus,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { useExchangeSale, useReturnReasons, useReturnSettings } from "@/modules/sales/hooks";
import { useCustomers } from "@/modules/customers/hooks";
import { useProducts } from "@/modules/products/hooks";
import { useMostradorPricing } from "@/modules/prices/hooks";
import { resolvePrice } from "@/lib/prices/resolve";
import type { ExchangeNewItem, ExchangeResult, SaleDetail } from "@/modules/sales/api";
import { STOCK_DESTINATIONS } from "@/modules/sales/api";
import { formatCurrency, formatQty } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

// Medios de cobro de la diferencia (cuando la mercadería nueva es más cara).
// El cajero elige un medio para el total de la diferencia (caso típico). El RPC
// acepta un array, así que se manda [{ method, amount: diferencia }].
const DIFF_METHODS: { value: string; label: string; icon: typeof Banknote }[] = [
  { value: "cash", label: "Efectivo", icon: Banknote },
  { value: "transfer", label: "Transferencia", icon: Banknote },
  { value: "debit", label: "Débito", icon: CreditCard },
  { value: "credit", label: "Crédito", icon: CreditCard },
  { value: "qr", label: "QR / Terminal", icon: QrCode },
];

type SurplusTo = "cash" | "store_credit";

// Línea del carrito de productos NUEVOS que se lleva el cliente. El precio se
// resuelve contra la lista de precios 'mostrador' activa (igual que el POS).
interface NewLine {
  productId: string;
  name: string;
  unitPrice: number;
  quantity: number;
}

// Flujo de CAMBIO de producto (H29 — diferencia a cobrar). Reusa las piezas:
// motivo (return_reasons) que fija el destino de stock de lo devuelto, política
// del tenant para el sobrante, y exchange_sale que orquesta devolución + venta
// nueva en una transacción atómica y auditada.
//
// Pasos: 1) Devolver (ítems de la venta) → 2) Motivo → 3) Llevar (productos
// nuevos) → 4) Diferencia (cobro o sobrante) → resultado.
export function ExchangeFlow({
  data,
  saleId,
  onDone,
  onClose,
}: {
  data: SaleDetail;
  saleId: string;
  onDone: (res: ExchangeResult) => void;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const { data: reasons } = useReturnReasons(true);
  const { data: settings } = useReturnSettings();
  const exch = useExchangeSale();

  const [step, setStep] = useState(0);
  const [returnQtys, setReturnQtys] = useState<Record<string, number>>({});
  const [reasonId, setReasonId] = useState<string>("");
  const [newLines, setNewLines] = useState<NewLine[]>([]);
  const [diffMethod, setDiffMethod] = useState<string>("cash");
  const [surplusTo, setSurplusTo] = useState<SurplusTo>("store_credit");
  const [customer, setCustomer] = useState<{ id: string; name: string } | null>(null);

  const policy = settings?.return_policy ?? "cashier_choice";
  // La política fija el destino del sobrante; cashier_choice deja elegir.
  const effectiveSurplusTo: SurplusTo =
    policy === "always_cash" ? "cash" : policy === "always_credit" ? "store_credit" : surplusTo;

  // Cliente del cambio: el de la venta, o el cargado en este flujo. Un cambio
  // necesita cliente (el crédito de lo devuelto se aplica / el sobrante queda).
  const saleCustomerId = data.sale.customer_id ?? null;
  const saleCustomerName = data.sale.customers?.name ?? null;
  const exchangeCustomerId = saleCustomerId ?? customer?.id ?? null;

  useEffect(() => {
    setStep(0);
    setReturnQtys({});
    setReasonId("");
    setNewLines([]);
    setDiffMethod("cash");
    setSurplusTo("store_credit");
    setCustomer(null);
  }, [saleId]);

  const chosenReason = (reasons ?? []).find((r) => r.id === reasonId) ?? null;
  const destMeta = chosenReason
    ? STOCK_DESTINATIONS.find((d) => d.value === chosenReason.stock_destination)
    : null;

  // Valor devuelto: proporcional a lo realmente pagado (subtotal/cantidad por
  // línea). Espeja el cálculo de return_sale_v2 (sin el ratio de descuento
  // global, que el RPC aplica de forma autoritativa — esto es una estimación UI).
  const returnedValue = useMemo(
    () =>
      data.items.reduce((acc, it) => {
        const q = returnQtys[it.id] ?? 0;
        const unit = it.quantity > 0 ? it.subtotal / it.quantity : it.unit_price;
        return acc + unit * q;
      }, 0),
    [data.items, returnQtys],
  );
  const returnedUnits = useMemo(
    () => Object.values(returnQtys).reduce((a, q) => a + (q > 0 ? q : 0), 0),
    [returnQtys],
  );

  const newTotal = useMemo(
    () => newLines.reduce((acc, l) => acc + l.unitPrice * l.quantity, 0),
    [newLines],
  );
  const newUnits = useMemo(
    () => newLines.reduce((a, l) => a + l.quantity, 0),
    [newLines],
  );

  // Diferencia = total nuevos − valor devuelto. >0 cobra, <0 sobra, =0 par.
  const difference = Math.round((newTotal - returnedValue) * 100) / 100;
  const surplus = difference < 0 ? -difference : 0;

  const needsCustomer = !exchangeCustomerId;

  const steps = useMemo(
    () => [
      { key: "return", label: "Devolver", icon: RotateCcw },
      { key: "reason", label: "Motivo", icon: Tag },
      { key: "take", label: "Llevar", icon: ShoppingCart },
      { key: "diff", label: "Diferencia", icon: Banknote },
    ],
    [],
  );
  const stepKey = steps[Math.min(step, steps.length - 1)]?.key ?? "return";
  const isLastStep = step >= steps.length - 1;

  function setReturnQty(itemId: string, qty: number, max: number) {
    setReturnQtys((p) => ({ ...p, [itemId]: Math.max(0, Math.min(qty, max)) }));
  }

  function canAdvance(): boolean {
    if (stepKey === "return" && returnedUnits <= 0) {
      toast({ title: "Elegí al menos un ítem a devolver", variant: "error" });
      return false;
    }
    if (stepKey === "take" && newUnits <= 0) {
      toast({ title: "Agregá al menos un producto que se lleva el cliente", variant: "error" });
      return false;
    }
    return true;
  }
  function next() {
    if (!canAdvance()) return;
    setStep((s) => Math.min(s + 1, steps.length - 1));
  }
  function back() {
    setStep((s) => Math.max(0, s - 1));
  }

  async function confirm() {
    const returnItems = Object.entries(returnQtys)
      .filter(([, q]) => q > 0)
      .map(([sale_item_id, q]) => ({ sale_item_id, quantity: q }));
    if (returnItems.length === 0) {
      toast({ title: "Elegí al menos un ítem a devolver", variant: "error" });
      return;
    }
    if (newLines.length === 0) {
      toast({ title: "Agregá los productos que se lleva el cliente", variant: "error" });
      return;
    }
    if (needsCustomer) {
      toast({ title: "El cambio necesita un cliente. Elegí uno abajo.", variant: "error" });
      return;
    }
    const newItems: ExchangeNewItem[] = newLines.map((l) => ({
      product_id: l.productId,
      quantity: l.quantity,
      unit_price: l.unitPrice,
      discount: 0,
    }));
    // Solo se cobra diferencia si la mercadería nueva es más cara.
    const differencePayments =
      difference > 0.001 ? [{ method: diffMethod, amount: difference }] : [];
    try {
      const res = await exch.mutateAsync({
        saleId,
        returnItems,
        newItems,
        differencePayments,
        reasonId: reasonId || null,
        customerId: exchangeCustomerId,
        surplusTo: surplus > 0.001 ? effectiveSurplusTo : null,
      });
      toast({ title: `Cambio registrado — venta #${res.sale_number}`, variant: "success" });
      onDone(res);
    } catch (e) {
      toast({ title: exchangeError(e), variant: "error" });
    }
  }

  return (
    <div className="space-y-5">
      <Stepper steps={steps} current={step} />

      <div className="min-h-[10rem]">
        {stepKey === "return" && (
          <ReturnItemsStep
            items={data.items}
            qtys={returnQtys}
            setQty={setReturnQty}
          />
        )}

        {stepKey === "reason" && (
          <ReasonStep
            reasons={(reasons ?? []).map((r) => ({ id: r.id, label: r.label }))}
            reasonId={reasonId}
            onChange={setReasonId}
            destLabel={destMeta?.label ?? null}
            destHint={destMeta?.hint ?? null}
            destination={chosenReason?.stock_destination ?? null}
          />
        )}

        {stepKey === "take" && (
          <TakeProductsStep lines={newLines} onChange={setNewLines} />
        )}

        {stepKey === "diff" && (
          <DifferenceStep
            returnedValue={returnedValue}
            newTotal={newTotal}
            difference={difference}
            diffMethod={diffMethod}
            onDiffMethod={setDiffMethod}
            policy={policy}
            effectiveSurplusTo={effectiveSurplusTo}
            onSurplusTo={setSurplusTo}
            customer={
              saleCustomerId
                ? { id: saleCustomerId, name: saleCustomerName ?? "cliente", locked: true }
                : customer
                  ? { ...customer, locked: false }
                  : null
            }
            onSelectCustomer={setCustomer}
            needsCustomer={needsCustomer}
          />
        )}
      </div>

      {/* Pie: resumen + navegación */}
      <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
        <div className="text-xs">
          <div className="flex items-center gap-3 text-muted-foreground">
            <span>
              Devuelve{" "}
              <strong className="text-foreground">{formatCurrency(returnedValue)}</strong>
            </span>
            <span>
              Lleva <strong className="text-foreground">{formatCurrency(newTotal)}</strong>
            </span>
          </div>
          <div className="mt-0.5 font-price text-base font-black tabular-nums">
            {difference > 0.001 ? (
              <span className="text-ninja-flameSoft">
                A cobrar {formatCurrency(difference)}
              </span>
            ) : difference < -0.001 ? (
              <span className="text-emerald-400">
                Sobrante {formatCurrency(surplus)}
              </span>
            ) : (
              <span className="text-muted-foreground">Cambio par</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {step > 0 ? (
            <Button variant="secondary" onClick={back}>
              <ArrowLeft size={16} /> Atrás
            </Button>
          ) : (
            <Button variant="secondary" onClick={onClose}>
              Cancelar
            </Button>
          )}
          {isLastStep ? (
            <Button
              loading={exch.isPending}
              disabled={returnedUnits <= 0 || newUnits <= 0 || needsCustomer}
              onClick={confirm}
            >
              <Check size={16} /> Confirmar cambio
            </Button>
          ) : (
            <Button onClick={next}>
              Siguiente <ArrowRight size={16} />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// Stepper compacto (espeja el de ReturnModal).
function Stepper({
  steps,
  current,
}: {
  steps: { key: string; label: string; icon: typeof Package }[];
  current: number;
}) {
  return (
    <div className="flex items-center">
      {steps.map((s, i) => {
        const done = i < current;
        const active = i === current;
        const Icon = s.icon;
        return (
          <div key={s.key} className="flex flex-1 items-center last:flex-none">
            <div className="flex flex-col items-center gap-1">
              <span
                className={cn(
                  "grid h-8 w-8 place-items-center rounded-full border text-xs font-bold transition-colors",
                  active
                    ? "border-ninja-flame bg-ninja-flame/15 text-ninja-flameSoft"
                    : done
                      ? "border-emerald-400/40 bg-emerald-400/15 text-emerald-400"
                      : "border-border bg-muted/40 text-muted-foreground",
                )}
              >
                {done ? <Check size={15} /> : <Icon size={15} />}
              </span>
              <span
                className={cn(
                  "text-[10px] font-medium uppercase tracking-wide",
                  active ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {s.label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <span
                className={cn(
                  "mx-1 -mt-4 h-px flex-1 transition-colors",
                  done ? "bg-emerald-400/40" : "bg-border",
                )}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// Paso 1 — ítems de la venta a devolver.
function ReturnItemsStep({
  items,
  qtys,
  setQty,
}: {
  items: SaleDetail["items"];
  qtys: Record<string, number>;
  setQty: (id: string, qty: number, max: number) => void;
}) {
  return (
    <div className="space-y-2">
      <span className="text-sm font-medium text-muted-foreground">¿Qué devuelve?</span>
      {items.map((it) => {
        const available = it.quantity - (it.returned_qty ?? 0);
        const q = qtys[it.id] ?? 0;
        const unit = it.quantity > 0 ? it.subtotal / it.quantity : it.unit_price;
        const selected = q > 0;
        return (
          <div
            key={it.id}
            className={cn(
              "rounded-xl border p-3 transition-colors",
              selected ? "border-ninja-flame/40 bg-ninja-flame/[0.04]" : "border-border",
              available <= 0 && "opacity-60",
            )}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{it.product_name}</div>
                <div className="text-xs text-muted-foreground">
                  disponible {formatQty(available)} · {formatCurrency(unit)} c/u
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  aria-label="Quitar uno"
                  className="grid h-8 w-8 place-items-center rounded-md border border-border text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-40"
                  disabled={q <= 0}
                  onClick={() => setQty(it.id, q - 1, available)}
                >
                  <Minus size={15} />
                </button>
                <input
                  className="h-8 w-12 rounded-md border border-input bg-background px-1 text-center text-sm tabular-nums outline-none focus:border-ninja-flameSoft"
                  type="number"
                  min={0}
                  max={available}
                  value={q}
                  onChange={(e) => setQty(it.id, Number(e.target.value) || 0, available)}
                />
                <button
                  type="button"
                  aria-label="Agregar uno"
                  className="grid h-8 w-8 place-items-center rounded-md border border-border text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-40"
                  disabled={q >= available}
                  onClick={() => setQty(it.id, q + 1, available)}
                >
                  <Plus size={15} />
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Paso 2 — motivo (fija el destino de stock de lo devuelto).
function ReasonStep({
  reasons,
  reasonId,
  onChange,
  destLabel,
  destHint,
  destination,
}: {
  reasons: { id: string; label: string }[];
  reasonId: string;
  onChange: (id: string) => void;
  destLabel: string | null;
  destHint: string | null;
  destination: string | null;
}) {
  const tone =
    destination === "resale"
      ? "bg-emerald-400/15 text-emerald-400"
      : destination === "warehouse"
        ? "bg-sky-400/15 text-sky-400"
        : "bg-amber-400/15 text-amber-400";
  return (
    <div className="space-y-3">
      <div>
        <span className="mb-1.5 block text-sm font-medium text-muted-foreground">
          Motivo de la devolución
        </span>
        <select
          value={reasonId}
          onChange={(e) => onChange(e.target.value)}
          className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-ninja-flameSoft focus:ring-2 focus:ring-ninja-flameSoft/20"
        >
          <option value="">Elegí un motivo…</option>
          {reasons.map((r) => (
            <option key={r.id} value={r.id} className="bg-ninja-deepViolet">
              {r.label}
            </option>
          ))}
        </select>
      </div>
      {destLabel && destination ? (
        <div className="rounded-xl border border-border bg-muted/30 p-3.5">
          <div className="flex items-center gap-2">
            <Package size={15} className="text-muted-foreground" />
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Destino del stock devuelto
            </span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className={cn("rounded-full px-2.5 py-0.5 text-sm font-semibold", tone)}>
              {destLabel}
            </span>
            <span className="text-xs text-muted-foreground">{destHint}</span>
          </div>
        </div>
      ) : (
        <p className="rounded-xl border border-dashed border-border px-3.5 py-3 text-xs text-muted-foreground">
          El motivo define qué pasa con el producto devuelto. Podés continuar sin
          motivo (vuelve a stock por defecto).
        </p>
      )}
    </div>
  );
}

// Paso 3 — productos nuevos que se lleva el cliente. Buscador + carrito. El
// precio se resuelve contra la lista de precios 'mostrador' activa (igual POS).
// Productos con variantes/seriales/peso se manejan en el POS; acá el cambio
// cubre productos simples (caso típico).
function TakeProductsStep({
  lines,
  onChange,
}: {
  lines: NewLine[];
  onChange: (lines: NewLine[]) => void;
}) {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const { data: products } = useProducts(search);
  const { data: mostrador } = useMostradorPricing();

  function priceFor(productId: string, basePrice: number): number {
    return resolvePrice(basePrice, productId, null, mostrador?.list ?? null, mostrador?.items ?? []);
  }

  function add(p: { id: string; name: string; price: number; has_variants?: boolean }) {
    // Variantes requieren picker (axes/stock por combinación): se atienden en el
    // POS. En el cambio mantenemos productos simples para no romper el flujo.
    if (p.has_variants) {
      toast({
        title: "Ese producto tiene variantes: cambialo desde el POS",
        variant: "info",
      });
      return;
    }
    const price = priceFor(p.id, p.price);
    const existing = lines.find((l) => l.productId === p.id);
    if (existing) {
      onChange(lines.map((l) => (l.productId === p.id ? { ...l, quantity: l.quantity + 1 } : l)));
    } else {
      onChange([...lines, { productId: p.id, name: p.name, unitPrice: price, quantity: 1 }]);
    }
  }
  function setQty(productId: string, qty: number) {
    if (qty <= 0) {
      onChange(lines.filter((l) => l.productId !== productId));
    } else {
      onChange(lines.map((l) => (l.productId === productId ? { ...l, quantity: qty } : l)));
    }
  }

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search
          size={15}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar producto por nombre, SKU o código…"
          className="h-10 w-full rounded-lg border border-input bg-background pl-8 pr-3 text-sm outline-none focus:border-ninja-flameSoft focus:ring-2 focus:ring-ninja-flameSoft/20"
        />
      </div>

      {search.trim() && (
        <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-border p-1">
          {(products ?? []).slice(0, 8).map((p) => (
            <button
              key={p.id}
              onClick={() =>
                add({ id: p.id, name: p.name, price: p.price, has_variants: p.has_variants })
              }
              className="flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-sm transition hover:bg-muted"
            >
              <span className="min-w-0 truncate">
                {p.name}
                {p.has_variants && (
                  <span className="ml-1.5 rounded-full bg-ninja-flame/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-ninja-flameSoft">
                    variantes
                  </span>
                )}
              </span>
              <span className="ml-2 flex shrink-0 items-center gap-1.5 text-muted-foreground">
                {formatCurrency(p.price)}
                <Plus size={14} className="text-ninja-flameSoft" />
              </span>
            </button>
          ))}
          {(products ?? []).length === 0 && (
            <p className="py-3 text-center text-xs text-muted-foreground">Sin resultados.</p>
          )}
        </div>
      )}

      <div className="space-y-2">
        {lines.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-3.5 py-4 text-center text-xs text-muted-foreground">
            Buscá y agregá los productos que se lleva el cliente.
          </p>
        ) : (
          lines.map((l) => (
            <div
              key={l.productId}
              className="flex items-center justify-between gap-2 rounded-xl border border-ninja-flame/30 bg-ninja-flame/[0.04] p-2.5"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{l.name}</div>
                <div className="text-xs text-muted-foreground">
                  {formatCurrency(l.unitPrice)} c/u · {formatCurrency(l.unitPrice * l.quantity)}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  aria-label="Quitar uno"
                  className="grid h-8 w-8 place-items-center rounded-md border border-border text-muted-foreground transition hover:bg-muted hover:text-foreground"
                  onClick={() => setQty(l.productId, l.quantity - 1)}
                >
                  <Minus size={15} />
                </button>
                <span className="w-8 text-center text-sm tabular-nums">{l.quantity}</span>
                <button
                  type="button"
                  aria-label="Agregar uno"
                  className="grid h-8 w-8 place-items-center rounded-md border border-border text-muted-foreground transition hover:bg-muted hover:text-foreground"
                  onClick={() => setQty(l.productId, l.quantity + 1)}
                >
                  <Plus size={15} />
                </button>
                <button
                  type="button"
                  aria-label="Quitar producto"
                  className="ml-1 text-muted-foreground hover:text-danger"
                  onClick={() => setQty(l.productId, 0)}
                >
                  <X size={15} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// Paso 4 — diferencia: cobro (>0), sobrante (<0) o par. Incluye el cliente del
// cambio (obligatorio): si la venta no tenía, se elige aquí.
function DifferenceStep({
  returnedValue,
  newTotal,
  difference,
  diffMethod,
  onDiffMethod,
  policy,
  effectiveSurplusTo,
  onSurplusTo,
  customer,
  onSelectCustomer,
  needsCustomer,
}: {
  returnedValue: number;
  newTotal: number;
  difference: number;
  diffMethod: string;
  onDiffMethod: (m: string) => void;
  policy: "cashier_choice" | "always_credit" | "always_cash";
  effectiveSurplusTo: SurplusTo;
  onSurplusTo: (s: SurplusTo) => void;
  customer: { id: string; name: string; locked: boolean } | null;
  onSelectCustomer: (c: { id: string; name: string } | null) => void;
  needsCustomer: boolean;
}) {
  const surplus = difference < 0 ? -difference : 0;
  return (
    <div className="space-y-4">
      {/* Resumen de la diferencia */}
      <div className="rounded-xl border border-border bg-muted/30 p-3.5 text-sm">
        <div className="flex items-center justify-between text-muted-foreground">
          <span>Valor devuelto (crédito)</span>
          <span className="tabular-nums">{formatCurrency(returnedValue)}</span>
        </div>
        <div className="mt-1 flex items-center justify-between text-muted-foreground">
          <span>Total productos nuevos</span>
          <span className="tabular-nums">{formatCurrency(newTotal)}</span>
        </div>
        <div className="mt-2 flex items-center justify-between border-t border-border pt-2">
          <span className="font-semibold">
            {difference > 0.001 ? "A cobrar" : difference < -0.001 ? "Sobrante" : "Cambio par"}
          </span>
          <span
            className={cn(
              "font-price text-lg font-black tabular-nums",
              difference > 0.001
                ? "text-ninja-flameSoft"
                : difference < -0.001
                  ? "text-emerald-400"
                  : "text-muted-foreground",
            )}
          >
            {formatCurrency(difference > 0 ? difference : surplus)}
          </span>
        </div>
      </div>

      {/* Cobro de la diferencia (>0): medio de pago */}
      {difference > 0.001 && (
        <div>
          <span className="mb-2 block text-sm font-medium text-muted-foreground">
            ¿Cómo cobra la diferencia?
          </span>
          <div className="grid grid-cols-3 gap-2">
            {DIFF_METHODS.map((m) => {
              const Icon = m.icon;
              const active = diffMethod === m.value;
              return (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => onDiffMethod(m.value)}
                  className={cn(
                    "flex flex-col items-center gap-1 rounded-xl border p-2.5 text-center transition-colors",
                    active
                      ? "border-ninja-flame bg-ninja-flame/10 text-foreground"
                      : "border-border text-muted-foreground hover:border-ninja-flameSoft/40",
                  )}
                >
                  <Icon size={16} className={active ? "text-ninja-flameSoft" : ""} />
                  <span className="text-xs font-medium">{m.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Sobrante (<0): efectivo o vale, según política */}
      {surplus > 0.001 && (
        <div>
          <span className="mb-2 block text-sm font-medium text-muted-foreground">
            El cliente se lleva algo más barato. ¿Qué hacés con el sobrante?
          </span>
          {policy !== "cashier_choice" ? (
            <div className="flex items-center gap-3 rounded-xl border border-ninja-flame/40 bg-ninja-flame/[0.05] px-4 py-3 text-sm">
              <span className="grid h-9 w-9 place-items-center rounded-lg bg-ninja-flame/15 text-ninja-flameSoft">
                {effectiveSurplusTo === "store_credit" ? <Ticket size={17} /> : <Banknote size={17} />}
              </span>
              <div>
                <div className="font-semibold">
                  {effectiveSurplusTo === "store_credit" ? "Vale (saldo a favor)" : "Efectivo"}
                </div>
                <div className="text-xs text-muted-foreground">Fijado por la política del negocio.</div>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <SurplusCard
                active={effectiveSurplusTo === "cash"}
                onClick={() => onSurplusTo("cash")}
                icon={<Banknote size={18} />}
                title="Efectivo"
                hint="Reintegro por caja"
              />
              <SurplusCard
                active={effectiveSurplusTo === "store_credit"}
                onClick={() => onSurplusTo("store_credit")}
                icon={<Ticket size={18} />}
                title="Vale"
                hint="Saldo a favor del cliente"
              />
            </div>
          )}
        </div>
      )}

      {/* Cliente del cambio (obligatorio) */}
      <div>
        <span className="mb-2 block text-sm font-medium text-muted-foreground">
          Cliente del cambio
        </span>
        {customer ? (
          <div className="flex items-center justify-between gap-2 rounded-xl border border-emerald-400/30 bg-emerald-400/[0.06] px-4 py-3 text-sm">
            <span className="flex items-center gap-2">
              <UserPlus size={15} className="text-emerald-400" />
              <strong>{customer.name}</strong>
            </span>
            {!customer.locked && (
              <button
                className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                onClick={() => onSelectCustomer(null)}
              >
                Cambiar
              </button>
            )}
          </div>
        ) : (
          <CustomerPicker onSelect={onSelectCustomer} highlight={needsCustomer} />
        )}
      </div>
    </div>
  );
}

function SurplusCard({
  active,
  onClick,
  icon,
  title,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex flex-col items-start gap-2 rounded-xl border p-3.5 text-left transition-colors",
        active
          ? "border-ninja-flame bg-ninja-flame/10"
          : "border-border hover:border-ninja-flameSoft/40 hover:bg-muted/40",
      )}
    >
      <span
        className={cn(
          "grid h-9 w-9 place-items-center rounded-lg",
          active ? "bg-ninja-flame/20 text-ninja-flameSoft" : "bg-muted text-muted-foreground",
        )}
      >
        {icon}
      </span>
      <span>
        <span className="block text-sm font-semibold">{title}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
    </button>
  );
}

// Selector de cliente para el cambio (cuando la venta no tenía uno).
function CustomerPicker({
  onSelect,
  highlight,
}: {
  onSelect: (c: { id: string; name: string } | null) => void;
  highlight: boolean;
}) {
  const [search, setSearch] = useState("");
  const { data: customers } = useCustomers(search);
  return (
    <div
      className={cn(
        "rounded-xl border p-3.5",
        highlight ? "border-amber-400/40 bg-amber-400/[0.05]" : "border-border",
      )}
    >
      <div className="relative">
        <Search
          size={15}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar cliente…"
          className="h-10 w-full rounded-lg border border-input bg-background pl-8 pr-3 text-sm outline-none focus:border-ninja-flameSoft focus:ring-2 focus:ring-ninja-flameSoft/20"
        />
      </div>
      {search.trim() && (
        <div className="mt-2 max-h-40 space-y-1 overflow-y-auto">
          {(customers ?? []).slice(0, 6).map((c) => (
            <button
              key={c.id}
              onClick={() => onSelect({ id: c.id, name: c.name })}
              className="flex w-full items-center justify-between rounded-lg border border-border px-3 py-2 text-left text-sm transition hover:border-ninja-flameSoft/40 hover:bg-muted"
            >
              <span className="truncate">{c.name}</span>
              <ChevronRight size={14} className="text-muted-foreground" />
            </button>
          ))}
          {(customers ?? []).length === 0 && (
            <p className="py-2 text-center text-xs text-muted-foreground">Sin resultados.</p>
          )}
        </div>
      )}
      <p className="mt-2 text-xs text-muted-foreground">
        Un cambio necesita cliente: el crédito de lo devuelto se aplica a la compra
        nueva (y un sobrante eventual queda como saldo a favor).
      </p>
    </div>
  );
}

function exchangeError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const map: Record<string, string> = {
    exchange_needs_customer: "El cambio necesita un cliente",
    exchange_needs_new_items: "Agregá los productos que se lleva el cliente",
    no_open_shift: "Abrí la caja para reintegrar el sobrante en efectivo",
    sale_not_returnable: "La venta ya no es devolvible (fue anulada)",
    qty_exceeds: "La cantidad supera lo disponible; refrescá e intentá de nuevo",
    empty_return: "Elegí al menos un ítem a devolver",
    insufficient_stock: "No hay stock suficiente del producto nuevo",
    insufficient_difference: "El pago de la diferencia no alcanza",
    item_not_found: "Un ítem ya no existe; refrescá e intentá de nuevo",
    "feature_not_in_plan: descuentos": "Los descuentos no están incluidos en tu plan",
    discount_exceeds_limit: "El descuento supera el máximo de tu rol",
  };
  const key = Object.keys(map).find((k) => msg.includes(k));
  return (key && map[key]) || "No se pudo registrar el cambio";
}
