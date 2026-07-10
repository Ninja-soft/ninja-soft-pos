"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  Banknote,
  Check,
  ChevronRight,
  Minus,
  Package,
  Plus,
  Receipt,
  RotateCcw,
  Search,
  Store,
  Tag,
  Ticket,
  UserPlus,
} from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import {
  useSaleDetail,
  useReturnSaleV2,
  useReturnReasons,
  useReturnSettings,
  useBranches,
  useSaleNumberFormat,
} from "@/modules/sales/hooks";
import { useCustomers, useCustomerMutations, useRequiredCustomerFields } from "@/modules/customers/hooks";
import {
  DOC_TYPES,
  DOC_TYPE_LABELS,
  isValidCuit,
  type CustomerFieldKey,
} from "@/modules/customers/schemas";
import {
  useActiveTemplate,
  usePrintProfiles,
  useTicketBranding,
} from "@/modules/tickets/hooks";
import { defaultSaleBlocks } from "@/lib/tickets/blocks";
import { webPrintCopies } from "@/lib/print/webPrint";
import { TemplateRenderer } from "@/components/tickets/TemplateRenderer";
import { Barcode, type TicketData } from "@/components/tickets/TicketRenderer";
import { STOCK_DESTINATIONS, type ReturnV2Result, type ExchangeResult } from "@/modules/sales/api";
import { ExchangeFlow } from "@/components/sales/ExchangeFlow";
import { formatCurrency, formatQty } from "@/lib/utils/format";
import { formatSaleNumber } from "@/lib/utils/saleNumber";
import { cn } from "@/lib/utils/cn";

type Refund = "cash" | "store_credit";

// Paleta del destino de stock (reusada por el badge y la tarjeta explicativa).
function destTone(d: string): string {
  return d === "resale"
    ? "bg-emerald-400/15 text-success"
    : d === "warehouse"
      ? "bg-sky-400/15 text-info"
      : "bg-amber-400/15 text-warning";
}

// Devolución PRO — flujo por pasos. El motivo fija el destino de stock; la
// política del tenant puede forzar el reintegro; si es vale se puede cargar un
// cliente al vuelo (respetando el documento obligatorio del tenant) y limitar el
// vale a sucursales; el comprobante se imprime con la plantilla activa.
//
// Backend intacto: usa return_sale_v2 con los mismos parámetros que antes. Esto
// es un rediseño de UX (pasos guiados), no un cambio de lógica.
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
  const { data: settings } = useReturnSettings();
  const { data: branches } = useBranches(open);
  const { data: numFmt } = useSaleNumberFormat();
  const ret = useReturnSaleV2();

  // Modo del flujo: devolución pura (dinero/vale al cliente) o CAMBIO (devuelve y
  // se lleva otros productos; la diferencia se cobra o reintegra).
  const [mode, setMode] = useState<"return" | "exchange">("return");
  const [step, setStep] = useState(0);
  const [qtys, setQtys] = useState<Record<string, number>>({});
  const [reasonId, setReasonId] = useState<string>("");
  const [refundChoice, setRefundChoice] = useState<Refund>("cash");
  const [customer, setCustomer] = useState<{ id: string; name: string } | null>(null);
  const [allowedBranchIds, setAllowedBranchIds] = useState<string[]>([]);
  const [result, setResult] = useState<
    | (ReturnV2Result & {
        items: { name: string; qty: number; subtotal: number }[];
        reasonLabel: string;
      })
    | null
  >(null);
  const [exchangeResult, setExchangeResult] = useState<ExchangeResult | null>(null);

  useEffect(() => {
    if (open) {
      setMode("return");
      setStep(0);
      setQtys({});
      setReasonId("");
      setRefundChoice("cash");
      setCustomer(null);
      setAllowedBranchIds([]);
      setResult(null);
      setExchangeResult(null);
    }
  }, [open, saleId]);

  const policy = settings?.return_policy ?? "cashier_choice";
  // La política puede forzar el reintegro; si no, manda la elección del cajero.
  const effectiveRefund: Refund =
    policy === "always_credit" ? "store_credit" : policy === "always_cash" ? "cash" : refundChoice;
  const isVoucher = effectiveRefund === "store_credit";
  const multiBranch = (branches ?? []).length > 1;

  const chosenReason = (reasons ?? []).find((r) => r.id === reasonId) ?? null;
  const destMeta = chosenReason
    ? STOCK_DESTINATIONS.find((d) => d.value === chosenReason.stock_destination)
    : null;

  // Cliente del vale: el de la venta, o el cargado en este flujo.
  const saleCustomerId = data?.sale.customer_id ?? null;
  const saleCustomerName = data?.sale.customers?.name ?? null;
  const voucherCustomerId = saleCustomerId ?? customer?.id ?? null;
  const needsCustomer = isVoucher && !voucherCustomerId;

  const total = useMemo(() => {
    if (!data) return 0;
    return data.items.reduce((acc, it) => {
      const q = qtys[it.id] ?? 0;
      const unit = it.quantity > 0 ? it.subtotal / it.quantity : it.unit_price;
      return acc + unit * q;
    }, 0);
  }, [data, qtys]);

  const totalUnits = useMemo(
    () => Object.values(qtys).reduce((a, q) => a + (q > 0 ? q : 0), 0),
    [qtys],
  );

  // Pasos del flujo. El paso "Cliente / vale" solo aparece si el reintegro es un
  // vale (efectivo no necesita cliente). Esto mantiene el flujo corto cuando no
  // hace falta y completo cuando sí.
  const steps = useMemo(() => {
    const base = [
      { key: "items", label: "Ítems", icon: Package },
      { key: "reason", label: "Motivo", icon: Tag },
      { key: "refund", label: "Reintegro", icon: Banknote },
    ];
    if (isVoucher) base.push({ key: "voucher", label: "Cliente", icon: Ticket });
    return base;
  }, [isVoucher]);

  const stepKey = steps[Math.min(step, steps.length - 1)]?.key ?? "items";
  const isLastStep = step >= steps.length - 1;

  function setQty(itemId: string, qty: number, max: number) {
    setQtys((p) => ({ ...p, [itemId]: Math.max(0, Math.min(qty, max)) }));
  }

  // Validación por paso antes de avanzar: bloquea con un toast claro.
  function canAdvance(): boolean {
    if (stepKey === "items") {
      if (totalUnits <= 0) {
        toast({ title: "Elegí al menos un ítem a devolver", variant: "error" });
        return false;
      }
    }
    if (stepKey === "voucher" && needsCustomer) {
      toast({ title: "El vale necesita un cliente. Cargá uno para continuar.", variant: "error" });
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
    if (!saleId || !data) return;
    const items = Object.entries(qtys)
      .filter(([, q]) => q > 0)
      .map(([sale_item_id, q]) => ({ sale_item_id, quantity: q }));
    if (items.length === 0) {
      toast({ title: "Elegí al menos un ítem a devolver", variant: "error" });
      return;
    }
    if (needsCustomer) {
      toast({ title: "El vale necesita un cliente. Cargá uno abajo.", variant: "error" });
      return;
    }
    const snapshot = data.items
      .filter((it) => (qtys[it.id] ?? 0) > 0)
      .map((it) => {
        const qty = qtys[it.id] ?? 0;
        const unit = it.quantity > 0 ? it.subtotal / it.quantity : it.unit_price;
        return { name: it.product_name, qty, subtotal: unit * qty };
      });
    try {
      const res = await ret.mutateAsync({
        saleId,
        items,
        reasonId: reasonId || null,
        refund: effectiveRefund,
        customerId: voucherCustomerId,
        // Sin selección = válido en todas las sucursales (null).
        allowedBranchIds: isVoucher && allowedBranchIds.length > 0 ? allowedBranchIds : null,
      });
      toast({ title: `Devolución #${res.number} registrada`, variant: "success" });
      setResult({ ...res, items: snapshot, reasonLabel: chosenReason?.label ?? "" });
    } catch (e) {
      toast({ title: returnError(e), variant: "error" });
    }
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Devolución / cambio" className="max-w-lg">
      {!data ? (
        <p className="py-10 text-center text-sm text-muted-foreground">Cargando venta…</p>
      ) : result ? (
        <ReturnResult result={result} onClose={() => onOpenChange(false)} />
      ) : exchangeResult ? (
        <ExchangeResultView result={exchangeResult} onClose={() => onOpenChange(false)} />
      ) : (
        <div className="space-y-5">
          {/* Resumen de la venta de origen */}
          <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-muted/30 px-4 py-3">
            <div className="flex items-center gap-2.5">
              <span className="grid h-9 w-9 place-items-center rounded-lg bg-ninja-flame/10 text-ninja-flameSoft">
                <Receipt size={17} />
              </span>
              <div className="min-w-0">
                <div className="font-mono text-sm font-semibold leading-tight">
                  {formatSaleNumber(data.sale.number, numFmt)}
                </div>
                <div className="text-xs text-muted-foreground">
                  {new Date(data.sale.created_at).toLocaleString("es-AR")}
                </div>
              </div>
            </div>
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Venta</div>
              <div className="font-price text-sm font-bold tabular-nums">
                {formatCurrency(data.sale.total)}
              </div>
            </div>
          </div>

          {/* Selector de modo: Devolución pura vs Cambio (diferencia a cobrar) */}
          <ModeToggle mode={mode} onChange={setMode} />

          {mode === "exchange" ? (
            <ExchangeFlow
              data={data}
              saleId={saleId as string}
              onDone={setExchangeResult}
              onClose={() => onOpenChange(false)}
            />
          ) : (
          <>
          {/* Stepper */}
          <Stepper steps={steps} current={step} />

          {/* Contenido del paso */}
          <div className="min-h-[8rem]">
            {stepKey === "items" && (
              <ItemsStep
                items={data.items}
                qtys={qtys}
                setQty={setQty}
                onAll={() =>
                  setQtys(() => {
                    const next: Record<string, number> = {};
                    for (const it of data.items) {
                      const avail = it.quantity - (it.returned_qty ?? 0);
                      if (avail > 0) next[it.id] = avail;
                    }
                    return next;
                  })
                }
                onNone={() => setQtys({})}
              />
            )}

            {stepKey === "reason" && (
              <ReasonStep
                reasons={(reasons ?? []).map((r) => ({ id: r.id, label: r.label }))}
                reasonId={reasonId}
                onChange={setReasonId}
                destMeta={destMeta ?? null}
                chosenDestination={chosenReason?.stock_destination ?? null}
              />
            )}

            {stepKey === "refund" && (
              <RefundStep
                policy={policy}
                effectiveRefund={effectiveRefund}
                onChoose={setRefundChoice}
              />
            )}

            {stepKey === "voucher" && (
              <div className="space-y-4">
                {saleCustomerId ? (
                  <div className="rounded-xl border border-emerald-400/30 bg-emerald-400/[0.06] px-4 py-3 text-sm">
                    <span className="flex items-center gap-2">
                      <UserPlus size={15} className="text-success" />
                      Vale para el cliente de la venta:{" "}
                      <strong>{saleCustomerName ?? "cliente"}</strong>
                    </span>
                  </div>
                ) : (
                  <VoucherCustomerPicker selected={customer} onSelect={setCustomer} />
                )}

                {multiBranch && (
                  <BranchScope
                    branches={(branches ?? []).map((b) => ({ id: b.id, name: b.name }))}
                    selected={allowedBranchIds}
                    onToggle={(id) =>
                      setAllowedBranchIds((p) =>
                        p.includes(id) ? p.filter((x) => x !== id) : [...p, id],
                      )
                    }
                  />
                )}
              </div>
            )}
          </div>

          {/* Pie: total + navegación */}
          <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                A devolver{totalUnits > 0 ? ` · ${formatQty(totalUnits)} u.` : ""}
              </div>
              <div className="price-hl font-price text-xl font-black tabular-nums">
                {formatCurrency(total)}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {step > 0 ? (
                <Button variant="secondary" onClick={back}>
                  <ArrowLeft size={16} /> Atrás
                </Button>
              ) : (
                <Button variant="secondary" onClick={() => onOpenChange(false)}>
                  Cancelar
                </Button>
              )}
              {isLastStep ? (
                <Button
                  loading={ret.isPending}
                  disabled={total <= 0 || needsCustomer}
                  onClick={confirm}
                >
                  {isVoucher ? (
                    <>
                      <Ticket size={16} /> Emitir vale
                    </>
                  ) : (
                    "Registrar devolución"
                  )}
                </Button>
              ) : (
                <Button onClick={next} disabled={stepKey === "items" && totalUnits <= 0}>
                  Siguiente <ArrowRight size={16} />
                </Button>
              )}
            </div>
          </div>
          </>
          )}
        </div>
      )}
    </Modal>
  );
}

// Selector de modo: devolución pura (dinero/vale) o cambio (diferencia a cobrar).
function ModeToggle({
  mode,
  onChange,
}: {
  mode: "return" | "exchange";
  onChange: (m: "return" | "exchange") => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-1 rounded-xl border border-border bg-muted/30 p-1">
      <button
        type="button"
        onClick={() => onChange("return")}
        className={cn(
          "flex items-center justify-center gap-2 rounded-lg py-2 text-sm font-medium transition-colors",
          mode === "return"
            ? "bg-ninja-flame/15 text-ninja-flameSoft"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        <RotateCcw size={15} /> Devolución
      </button>
      <button
        type="button"
        onClick={() => onChange("exchange")}
        className={cn(
          "flex items-center justify-center gap-2 rounded-lg py-2 text-sm font-medium transition-colors",
          mode === "exchange"
            ? "bg-ninja-flame/15 text-ninja-flameSoft"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        <ArrowLeftRight size={15} /> Cambio
      </button>
    </div>
  );
}

// Resultado del cambio: devolución + venta nueva enlazadas, con la diferencia /
// sobrante y el vale de la devolución (canjeable si quedó saldo).
function ExchangeResultView({
  result,
  onClose,
}: {
  result: ExchangeResult;
  onClose: () => void;
}) {
  const charged = result.difference > 0.001;
  const surplus = result.surplus > 0.001;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2.5 rounded-xl border border-emerald-400/30 bg-emerald-400/[0.06] px-4 py-3">
        <span className="grid h-9 w-9 place-items-center rounded-lg bg-emerald-400/15 text-success">
          <Check size={18} />
        </span>
        <div className="text-sm">
          <div className="font-semibold">Cambio registrado</div>
          <div className="text-xs text-muted-foreground">
            Devolución #{result.return_number} → Venta #{result.sale_number}
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-muted/30 px-4 py-3 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Valor devuelto (crédito)</span>
          <span className="tabular-nums">{formatCurrency(result.returned)}</span>
        </div>
        <div className="mt-1 flex items-center justify-between">
          <span className="text-muted-foreground">Total productos nuevos</span>
          <span className="tabular-nums">{formatCurrency(result.new_total)}</span>
        </div>
        <div className="mt-2 flex items-center justify-between border-t border-border pt-2">
          <span className="font-semibold">
            {charged ? "Diferencia cobrada" : surplus ? "Sobrante devuelto" : "Cambio par"}
          </span>
          <span
            className={cn(
              "font-price font-bold tabular-nums",
              charged ? "text-ninja-flameSoft" : surplus ? "text-success" : "text-muted-foreground",
            )}
          >
            {formatCurrency(charged ? result.difference : result.surplus)}
          </span>
        </div>
        {surplus && (
          <div className="mt-1 flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Sobrante en</span>
            <span>{result.surplus_to === "store_credit" ? "Vale (saldo a favor)" : "Efectivo"}</span>
          </div>
        )}
      </div>

      {/* El vale de la devolución solo deja saldo canjeable si quedó sobrante en
          vale; si se aplicó todo a la compra (o el sobrante fue efectivo), el vale
          queda en cero. Mostramos el código emitido para trazabilidad. */}
      {result.voucher_code && (
        <div className="rounded-xl border border-dashed border-border px-4 py-3 text-center">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Comprobante de devolución del cambio
          </div>
          <div className="mt-1 font-mono text-base font-black tracking-wider">
            {result.voucher_code}
          </div>
          {surplus && result.surplus_to === "store_credit" && (
            <div className="mt-0.5 text-xs text-success">
              Saldo a favor {formatCurrency(result.surplus)} — canjeable en el POS
            </div>
          )}
        </div>
      )}

      <div className="flex justify-end">
        <Button onClick={onClose}>Cerrar</Button>
      </div>
    </div>
  );
}

// Indicador de pasos: número/check + etiqueta, con la línea de progreso.
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
                      ? "border-emerald-400/40 bg-emerald-400/15 text-success"
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

// Paso 1 — Ítems a devolver, con stepper de cantidad y atajos todo/nada.
function ItemsStep({
  items,
  qtys,
  setQty,
  onAll,
  onNone,
}: {
  items: {
    id: string;
    product_name: string;
    quantity: number;
    returned_qty?: number;
    subtotal: number;
    unit_price: number;
  }[];
  qtys: Record<string, number>;
  setQty: (id: string, qty: number, max: number) => void;
  onAll: () => void;
  onNone: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-muted-foreground">
          ¿Qué se devuelve?
        </span>
        <div className="flex items-center gap-1.5 text-xs">
          <button
            type="button"
            onClick={onAll}
            className="rounded-full border border-border px-2.5 py-1 font-medium text-muted-foreground transition hover:border-ninja-flameSoft/40 hover:text-foreground"
          >
            Todo
          </button>
          <button
            type="button"
            onClick={onNone}
            className="rounded-full border border-border px-2.5 py-1 font-medium text-muted-foreground transition hover:border-ninja-flameSoft/40 hover:text-foreground"
          >
            Ninguno
          </button>
        </div>
      </div>
      <div className="space-y-2">
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
                selected
                  ? "border-ninja-flame/40 bg-ninja-flame/[0.04]"
                  : "border-border",
                available <= 0 && "opacity-60",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{it.product_name}</div>
                  <div className="text-xs text-muted-foreground">
                    Vendido {formatQty(it.quantity)} · disponible {formatQty(available)} ·{" "}
                    {formatCurrency(unit)} c/u
                  </div>
                  {selected && (
                    <div className="mt-1 text-xs font-medium text-ninja-flameSoft">
                      Subtotal {formatCurrency(unit * q)}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    aria-label="Quitar uno"
                    className="grid h-8 w-8 place-items-center rounded-md border border-border text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
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
                    className="grid h-8 w-8 place-items-center rounded-md border border-border text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
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
    </div>
  );
}

// Paso 2 — Motivo (define el destino de stock) + explicación del destino.
function ReasonStep({
  reasons,
  reasonId,
  onChange,
  destMeta,
  chosenDestination,
}: {
  reasons: { id: string; label: string }[];
  reasonId: string;
  onChange: (id: string) => void;
  destMeta: { label: string; hint: string } | null;
  chosenDestination: string | null;
}) {
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
            <option key={r.id} value={r.id} className="bg-popover text-popover-foreground">
              {r.label}
            </option>
          ))}
        </select>
      </div>

      {destMeta && chosenDestination ? (
        <div className="rounded-xl border border-border bg-muted/30 p-3.5">
          <div className="flex items-center gap-2">
            <Package size={15} className="text-muted-foreground" />
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Destino del stock
            </span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "rounded-full px-2.5 py-0.5 text-sm font-semibold",
                destTone(chosenDestination),
              )}
            >
              {destMeta.label}
            </span>
            <span className="text-xs text-muted-foreground">{destMeta.hint}</span>
          </div>
        </div>
      ) : (
        <p className="rounded-xl border border-dashed border-border px-3.5 py-3 text-xs text-muted-foreground">
          El motivo define qué pasa con el producto: volver a la venta, a depósito,
          pérdida o revisión. Podés continuar sin motivo, pero recomendamos elegir uno.
        </p>
      )}
    </div>
  );
}

// Paso 3 — Reintegro: efectivo / vale como tarjetas grandes. Respeta la política.
function RefundStep({
  policy,
  effectiveRefund,
  onChoose,
}: {
  policy: "cashier_choice" | "always_credit" | "always_cash";
  effectiveRefund: Refund;
  onChoose: (r: Refund) => void;
}) {
  if (policy !== "cashier_choice") {
    const credit = policy === "always_credit";
    return (
      <div className="space-y-3">
        <span className="block text-sm font-medium text-muted-foreground">
          ¿Cómo se reintegra?
        </span>
        <div className="flex items-center gap-3 rounded-xl border border-ninja-flame/40 bg-ninja-flame/[0.05] px-4 py-3.5">
          <span className="grid h-10 w-10 place-items-center rounded-lg bg-ninja-flame/15 text-ninja-flameSoft">
            {credit ? <Ticket size={18} /> : <Banknote size={18} />}
          </span>
          <div className="text-sm">
            <div className="font-semibold">
              {credit ? "Vale (saldo a favor)" : "Efectivo"}
            </div>
            <div className="text-xs text-muted-foreground">
              Fijado por la política del negocio.
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <span className="block text-sm font-medium text-muted-foreground">
        ¿Cómo se reintegra?
      </span>
      <div className="grid grid-cols-2 gap-3">
        <RefundCard
          active={effectiveRefund === "cash"}
          onClick={() => onChoose("cash")}
          icon={<Banknote size={18} />}
          title="Efectivo"
          hint="Reintegro por caja"
        />
        <RefundCard
          active={effectiveRefund === "store_credit"}
          onClick={() => onChoose("store_credit")}
          icon={<Ticket size={18} />}
          title="Vale"
          hint="Saldo a favor del cliente"
        />
      </div>
    </div>
  );
}

function RefundCard({
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

// Sucursales donde vale el comprobante (solo multi-sucursal + vale).
function BranchScope({
  branches,
  selected,
  onToggle,
}: {
  branches: { id: string; name: string }[];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  return (
    <div className="rounded-xl border border-border p-3.5">
      <div className="flex items-center gap-2">
        <Store size={15} className="text-muted-foreground" />
        <span className="text-sm font-medium">Sucursales donde vale el comprobante</span>
      </div>
      <p className="mb-2.5 mt-0.5 text-xs text-muted-foreground">
        Sin selección = válido en todas las sucursales.
      </p>
      <div className="flex flex-wrap gap-2">
        {branches.map((b) => {
          const on = selected.includes(b.id);
          return (
            <button
              key={b.id}
              type="button"
              onClick={() => onToggle(b.id)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition-colors",
                on
                  ? "border-ninja-flame bg-ninja-flame/10 font-medium"
                  : "border-border hover:border-ninja-flameSoft/40",
              )}
            >
              {on && <Check size={13} />}
              {b.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Selector / alta de cliente para el vale cuando la venta no tenía uno.
//
// El alta inline respeta el documento obligatorio del tenant: cuando
// require_customer_doc está activo (default true), exige tipo + número de
// documento y valida CUIT/CUIL/DNI con las mismas reglas del form completo. Si
// el tenant marcó teléfono/email como obligatorios, también los pide.
function VoucherCustomerPicker({
  selected,
  onSelect,
}: {
  selected: { id: string; name: string } | null;
  onSelect: (c: { id: string; name: string } | null) => void;
}) {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [docType, setDocType] = useState("");
  const [docNumber, setDocNumber] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { data: customers } = useCustomers(search);
  const { data: required } = useRequiredCustomerFields();
  const { createQuick } = useCustomerMutations();

  const req = required?.fields ?? {};
  // require_customer_doc (default true): exige tipo + número de documento.
  const requireDoc = required?.requireDoc ?? true;
  const reqPhone = Boolean(req.phone);
  const reqEmail = Boolean(req.email);
  const star = (key: CustomerFieldKey | "doc") =>
    (key === "doc" && requireDoc) ||
    (key === "document_number" && requireDoc) ||
    (key !== "doc" && req[key])
      ? " *"
      : "";

  if (selected) {
    return (
      <div className="rounded-xl border border-emerald-400/30 bg-emerald-400/[0.06] px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2 text-sm">
            <UserPlus size={15} className="text-success" />
            Vale para <strong>{selected.name}</strong>
          </span>
          <button
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
            onClick={() => onSelect(null)}
          >
            Cambiar
          </button>
        </div>
      </div>
    );
  }

  // Validación del alta inline. Reproduce el enforcement del form compartido:
  // documento obligatorio (tipo + número + formato) + campos del tenant.
  function validate(): boolean {
    const e: Record<string, string> = {};
    if (name.trim().length < 1) e.name = "Poné un nombre";
    if (requireDoc) {
      if (!docType.trim()) e.docType = "Requerido";
      if (!docNumber.trim()) e.docNumber = "Requerido";
    }
    // Formato de documento (mismas reglas que el schema de clientes).
    if (docNumber.trim()) {
      if ((docType === "cuit" || docType === "cuil") && !isValidCuit(docNumber)) {
        e.docNumber = "CUIT/CUIL inválido";
      } else if (docType === "dni" && !/^\d{7,8}$/.test(docNumber.replace(/\D/g, ""))) {
        e.docNumber = "DNI inválido (7-8 dígitos)";
      }
    }
    if (reqPhone && !phone.trim()) e.phone = "Requerido";
    if (reqEmail && !email.trim()) e.email = "Requerido";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  function create() {
    if (!validate()) {
      toast({ title: "Completá los campos obligatorios", variant: "error" });
      return;
    }
    createQuick.mutate(
      {
        name,
        phone: phone || null,
        email: email || null,
        document_type: docType || null,
        document_number: docNumber || null,
      },
      {
        onSuccess: (c) => {
          onSelect({ id: c.id, name: c.name });
          setCreating(false);
          setName("");
          setPhone("");
          setEmail("");
          setDocType("");
          setDocNumber("");
          setErrors({});
        },
        onError: () => toast({ title: "No se pudo crear el cliente", variant: "error" }),
      },
    );
  }

  return (
    <div className="rounded-xl border border-amber-400/30 bg-amber-400/[0.05] p-3.5">
      <div className="mb-2.5 flex items-center gap-2 text-sm font-medium">
        <Ticket size={15} className="text-warning" />
        El vale necesita un cliente
      </div>
      {creating ? (
        <div className="space-y-2.5">
          <Input
            label="Nombre / Razón social *"
            placeholder="Nombre del cliente"
            value={name}
            onChange={(e) => setName(e.target.value)}
            error={errors.name}
            className="h-10"
          />
          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="mb-2 block text-sm font-medium text-muted-foreground">
                Tipo doc.{star("doc")}
              </label>
              {errors.docType && (
                <p className="mb-1 text-xs text-destructive">{errors.docType}</p>
              )}
              <select
                value={docType}
                onChange={(e) => setDocType(e.target.value)}
                className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-ninja-flameSoft focus:ring-2 focus:ring-ninja-flameSoft/20"
              >
                <option value="">—</option>
                {DOC_TYPES.map((d) => (
                  <option key={d} value={d} className="bg-popover text-popover-foreground">
                    {DOC_TYPE_LABELS[d]}
                  </option>
                ))}
              </select>
            </div>
            <Input
              label={`Número${star("document_number")}`}
              placeholder="Documento"
              value={docNumber}
              onChange={(e) => setDocNumber(e.target.value)}
              error={errors.docNumber}
              className="h-10"
            />
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <Input
              label={`Teléfono${star("phone")}`}
              placeholder="Teléfono"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              error={errors.phone}
              className="h-10"
            />
            <Input
              label={`Email${star("email")}`}
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={errors.email}
              className="h-10"
            />
          </div>
          <div className="flex justify-end gap-2 pt-0.5">
            <Button variant="ghost" className="h-9 px-3" onClick={() => setCreating(false)}>
              Volver
            </Button>
            <Button className="h-9 px-3" loading={createQuick.isPending} onClick={create}>
              <Plus size={14} /> Crear y usar
            </Button>
          </div>
        </div>
      ) : (
        <>
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
          <button
            onClick={() => {
              setCreating(true);
              setName(search);
              setErrors({});
            }}
            className="mt-2.5 inline-flex items-center gap-1.5 text-sm font-medium text-ninja-flameSoft"
          >
            <UserPlus size={15} /> Cargar nuevo cliente
          </button>
          {requireDoc && (
            <p className="mt-2 text-xs text-muted-foreground">
              Este negocio exige tipo y número de documento para dar de alta un cliente.
            </p>
          )}
        </>
      )}
    </div>
  );
}

// Resultado: si es vale, muestra el código y el comprobante con la plantilla de
// ticket activa (no inventa layout). Imprimible.
function ReturnResult({
  result,
  onClose,
}: {
  result: ReturnV2Result & {
    items: { name: string; qty: number; subtotal: number }[];
    reasonLabel: string;
  };
  onClose: () => void;
}) {
  const { data: brand } = useTicketBranding(true);
  const { data: printTpl } = useActiveTemplate("print", true);
  // Perfil de impresión de "devolución / nota de crédito" (H22): formato + copias.
  const { data: printProfiles } = usePrintProfiles(true);
  const returnProfile = printProfiles?.return;
  const ticketRef = useRef<HTMLDivElement>(null);
  const isVoucher = result.refund === "store_credit" && Boolean(result.voucher_code);

  const fallbackBlocks = useMemo(
    () =>
      defaultSaleBlocks().filter((b) => {
        if (b.type === "qr") return brand?.ticket_show_qr === true;
        if (b.type === "logo") return brand?.ticket_show_logo !== false;
        return true;
      }),
    [brand],
  );

  // El comprobante de devolución/vale reutiliza la plantilla de ticket activa:
  // mismos encabezado/logo/pie/ancho del negocio. El "número" del comprobante es
  // el código del vale (si lo hay) o el N° de devolución.
  const ticketData: TicketData = {
    sale: {
      number: result.number,
      numberLabel: isVoucher ? (result.voucher_code as string) : `DEV #${result.number}`,
      created_at: new Date().toISOString(),
      subtotal: result.total,
      discount_total: 0,
      total: result.total,
      status: "completed",
    },
    items: result.items.map((it, i) => ({
      id: String(i),
      product_name: it.name,
      quantity: it.qty,
      unit_price: it.qty > 0 ? it.subtotal / it.qty : it.subtotal,
      subtotal: it.subtotal,
    })),
    payments: [{ id: "r", method: isVoucher ? "store_credit" : "cash", amount: result.total }],
    customer: null,
    brand: brand ?? null,
  };

  // La plantilla activa manda el formato; si no hay, el del perfil de devolución
  // (H22) y, por último, el ancho del branding.
  const paper =
    (printTpl?.paper as "58" | "80" | "a4" | undefined) ??
    returnProfile?.paper ??
    (brand?.ticket_width === "58" ? "58" : "80");
  const returnCopies = returnProfile?.copies ?? 1;

  return (
    <div className="space-y-4">
      <div className="no-print flex items-center gap-2.5 rounded-xl border border-emerald-400/30 bg-emerald-400/[0.06] px-4 py-3">
        <span className="grid h-9 w-9 place-items-center rounded-lg bg-emerald-400/15 text-success">
          <Check size={18} />
        </span>
        <div className="text-sm">
          <div className="font-semibold">Devolución #{result.number} registrada</div>
          <div className="text-xs text-muted-foreground">
            {isVoucher ? "Se emitió un vale con saldo a favor." : "Reintegro en efectivo por caja."}
          </div>
        </div>
      </div>

      <div className="ticket-print" ref={ticketRef}>
        <TemplateRenderer
          template={printTpl ?? null}
          fallbackBlocks={fallbackBlocks}
          data={ticketData}
          paperOverride={paper}
        />
        {/* Panel del vale (código + vencimiento): info del vale, no un layout
            alternativo del ticket (ese lo provee la plantilla activa de arriba). */}
        {isVoucher && (
          <div className="mx-auto mt-1 max-w-[80mm] px-3 pb-3 text-center font-mono">
            <div className="border-t border-dashed border-neutral-400 pt-2 text-xs font-bold uppercase tracking-wide">
              Vale · saldo a favor
            </div>
            <div className="mt-1 text-lg font-black tracking-wider">{result.voucher_code}</div>
            <div className="mx-auto mt-1 max-w-[60mm]">
              <Barcode value={result.voucher_code as string} />
            </div>
            <div className="mt-1 text-sm font-bold">{formatCurrency(result.total)}</div>
            <div className="mt-0.5 text-[11px] text-neutral-500">
              {result.voucher_expires_at
                ? `Vence el ${new Date(result.voucher_expires_at).toLocaleDateString("es-AR")}`
                : "Sin vencimiento"}
            </div>
            <div className="text-[11px] text-neutral-500">Canjeable en el POS por su código.</div>
          </div>
        )}
      </div>

      <div className="no-print rounded-xl border border-border bg-muted/30 px-4 py-3 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Total devuelto</span>
          <span className="font-semibold">{formatCurrency(result.total)}</span>
        </div>
        <div className="mt-1 flex items-center justify-between">
          <span className="text-muted-foreground">Reintegro</span>
          <span>{isVoucher ? "Vale (saldo a favor)" : "Efectivo"}</span>
        </div>
        {result.reasonLabel && (
          <div className="mt-1 flex items-center justify-between">
            <span className="text-muted-foreground">Motivo</span>
            <span>{result.reasonLabel}</span>
          </div>
        )}
      </div>

      <div className="no-print flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cerrar
        </Button>
        <Button
          onClick={() => webPrintCopies(returnCopies)}
          title={returnCopies > 1 ? `Imprimir (${returnCopies} copias)` : "Imprimir"}
        >
          <RotateCcw size={16} /> Imprimir
          {returnCopies > 1 ? ` (${returnCopies})` : ""}
        </Button>
      </div>
    </div>
  );
}

function returnError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const map: Record<string, string> = {
    no_open_shift: "Abrí la caja para reintegrar en efectivo",
    store_credit_needs_customer: "El vale necesita un cliente",
    sale_not_returnable: "La venta ya no es devolvible (fue anulada)",
    qty_exceeds: "La cantidad supera lo disponible; refrescá e intentá de nuevo",
    empty_return: "Elegí al menos un ítem a devolver",
    item_not_found: "Un ítem ya no existe; refrescá e intentá de nuevo",
  };
  const key = Object.keys(map).find((k) => msg.includes(k));
  return (key && map[key]) || "No se pudo registrar la devolución";
}
