"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Users } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { formatCurrency } from "@/lib/utils/format";
import { isPlanActive, type SalePaymentInput } from "@/modules/pos/api";
import { useWarrantyPlans } from "@/modules/products/hooks";
import {
  useEnabledPaymentMethods,
  usePaymentPlans,
  usePosSettings,
  useProfessionals,
} from "@/modules/pos/hooks";
import { useGating } from "@/modules/saas/gating";
import type { CardVoucher, PaymentPlan } from "@/modules/pos/api";
import type { WarrantyPlan } from "@/modules/products/api";

// Extra del cobro que emite el PaymentModal hacia el POS. `kind` decide qué hace
// create_sale (ver SaleExtraInput): warranty/surcharge entran como ítem de venta;
// 'tip' va a sales.tip_amount (no es ítem); 'professional' atribuye la comisión.
export interface PaymentExtra {
  kind: "warranty" | "surcharge" | "tip" | "professional";
  // Etiqueta para el ítem de venta (sólo warranty/surcharge la usan).
  name?: string;
  amount?: number;
  // Medio de la propina (kind='tip').
  method?: string;
  // professionals.id (kind='professional').
  id?: string;
}

// Medios disponibles para la propina (H39). Mapean a sales.tip_method.
const TIP_METHODS: { value: string; label: string }[] = [
  { value: "cash", label: "Efectivo" },
  { value: "debit", label: "Débito" },
  { value: "credit", label: "Crédito" },
  { value: "transfer", label: "Transferencia" },
  { value: "qr", label: "QR" },
];

// Medios de pago base del POS. Se filtran según config del tenant (H14).
const ALL_METHODS: { value: SalePaymentInput["method"]; label: string; providers: string[] }[] = [
  { value: "cash",     label: "Efectivo",       providers: ["cash"] },
  { value: "transfer", label: "Transferencia",   providers: ["transfer"] },
  { value: "debit",    label: "Débito",          providers: ["mercadopago_point", "payway", "getnet", "fiserv", "mobbex"] },
  { value: "credit",   label: "Crédito",         providers: ["mercadopago_point", "payway", "getnet", "fiserv", "mobbex"] },
  { value: "qr",       label: "QR / Terminal",   providers: ["mercadopago", "mobbex", "modo", "pagos360"] },
];

// Feature de plan por proveedor (espejo de payment_method_plan_key en SQL).
// Un proveedor sin entrada NO está gateado por plan. El backend (trigger en
// payments + Edge de QR) bloquea de verdad; esto solo evita ofrecer en la UI un
// medio que el plan no permite. La feature key coincide con payment_providers.key.
const PROVIDER_FEATURE: Record<string, string> = {
  mercadopago: "mercado_pago",
  // Mercado Point tiene su propia feature (MP online ≠ Point presencial).
  mercadopago_point: "mercadopago_point",
  modo: "modo",
  mobbex: "mobbex",
  payway: "payway",
  getnet: "getnet",
  fiserv: "fiserv",
  pagos360: "pagos360",
  nave: "nave",
};

// Base del plan según el método seleccionado.
const METHOD_PLAN_BASE: Partial<Record<SalePaymentInput["method"], string>> = {
  debit: "debito",
  credit: "credito",
};

// ── División de cuenta (F13 · H44) ──────────────────────────────────────────────
// Ítem del pedido/carrito tal como lo recibe el modal para repartir "por ítem".
// Se mantiene desacoplado del store del carrito: la página POS mapea sus líneas a
// esta forma mínima (id estable + etiqueta + monto de la línea ya calculado).
export interface SplitItem {
  id: string;
  label: string;
  amount: number; // subtotal de la línea (cant × precio − descuento)
}

type SplitMode = "equal" | "amount" | "percent" | "item";

const SPLIT_MODES: { value: SplitMode; label: string }[] = [
  { value: "equal", label: "Partes iguales" },
  { value: "amount", label: "Por monto" },
  { value: "percent", label: "Por porcentaje" },
  { value: "item", label: "Por ítem" },
];

// Una línea de cobro del split: medio + monto (en pesos) + (opcional) recibido en
// efectivo para el vuelto + voucher de tarjeta. Para "por ítem" guarda además el
// conjunto de ítems asignados (su monto = suma de esos ítems).
interface SplitLine {
  method: SalePaymentInput["method"];
  amount: number;
  received: string; // sólo efectivo; string para el input controlado
  voucherLote: string;
  voucherCupon: string;
  voucherAuth: string;
  itemIds: string[]; // sólo modo "por ítem"
}

const centsOf = (n: number | string) => Math.round((Number(n) || 0) * 100);
const fromCents = (c: number) => Math.round(c) / 100;

function emptyLine(method: SalePaymentInput["method"]): SplitLine {
  return {
    method,
    amount: 0,
    received: "",
    voucherLote: "",
    voucherCupon: "",
    voucherAuth: "",
    itemIds: [],
  };
}

export function OpenShiftModal({
  open,
  onOpenChange,
  onConfirm,
  loading,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onConfirm: (opening: number) => void;
  loading: boolean;
}) {
  const [amount, setAmount] = useState("0");
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Abrir caja">
      <div className="space-y-4">
        <Input
          label="Monto inicial"
          type="number"
          step="0.01"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button loading={loading} onClick={() => onConfirm(Number(amount) || 0)}>
            Abrir
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function CloseShiftModal({
  open,
  onOpenChange,
  onConfirm,
  loading,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onConfirm: (closing: number, notes: string) => void;
  loading: boolean;
}) {
  const [amount, setAmount] = useState("0");
  const [notes, setNotes] = useState("");
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Cerrar caja (arqueo)">
      <div className="space-y-4">
        <Input
          label="Efectivo contado"
          type="number"
          step="0.01"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <Input
          label="Notas (opcional)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            loading={loading}
            onClick={() => onConfirm(Number(amount) || 0, notes)}
          >
            Cerrar caja
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// Sección "Dividir cuenta" (F13 · H44). Recibe el TOTAL autoritativo a repartir
// (`total` = el mismo payTotal que el server valida: productos redondeados +
// propina) y los métodos de pago ya gateados (misma lista del cobro normal). Arma
// N líneas de pago que suman EXACTO el total y las emite vía onPaymentsChange para
// que el modal padre las mande como p_payments en UN solo create_sale.
//
// Modos: partes iguales (N comensales), por monto, por porcentaje, por ítem. El
// remanente de redondeo va a la última línea para que la suma cuadre al centavo.
// El gateo de medios es el mismo que el cobro simple (lista `methods` heredada);
// no se aplican recargos por línea (el split reparte el total ya calculado) — eso
// queda como follow-up. Cada línea lleva su medio y, en tarjeta, su voucher.
function SplitPaymentSection({
  total,
  methods,
  items,
  voucherRequired,
  onPaymentsChange,
}: {
  total: number;
  methods: { value: SalePaymentInput["method"]; label: string }[];
  items: SplitItem[];
  // Si el negocio exige voucher de tarjeta, las líneas de débito/crédito deben
  // completarlo para poder confirmar.
  voucherRequired: boolean;
  // Reporta al padre: las líneas válidas (null si aún no cuadran) + el vuelto.
  onPaymentsChange: (result: { payments: SalePaymentInput[]; change: number } | null) => void;
}) {
  const totalCents = centsOf(total);
  const firstMethod = methods[0]?.value ?? "cash";

  const [mode, setMode] = useState<SplitMode>("equal");
  const [diners, setDiners] = useState(2);
  const [lines, setLines] = useState<SplitLine[]>([emptyLine(firstMethod), emptyLine(firstMethod)]);
  // Modo "por ítem": si quedan ítems sin asignar, NO se puede cobrar. Toggle para
  // mandar lo no asignado a la última línea automáticamente.
  const [autoAssignRest, setAutoAssignRest] = useState(true);

  // BUG 18: el modo "por ítem" no tiene sentido (ni salida) sin ítems para
  // asignar — cumpliendo el contrato del prop `splitItems` ("Vacío = no se ofrece
  // el modo ítem"). Sin esto, elegir "por ítem" con 0 ítems y destildar
  // "ítems sin asignar → última línea" dejaba el split trabado, sin poder cuadrar.
  const hasItems = items.length > 0;
  const availableModes = useMemo(
    () => (hasItems ? SPLIT_MODES : SPLIT_MODES.filter((m) => m.value !== "item")),
    [hasItems],
  );

  // Defensa: si los ítems desaparecen mientras el modo es "por ítem", volver a un
  // modo válido (partes iguales) para no quedar atrapados en un estado sin salida.
  useEffect(() => {
    if (!hasItems && mode === "item") setMode("equal");
  }, [hasItems, mode]);

  const isCardMethod = (m: SalePaymentInput["method"]) => m === "debit" || m === "credit";

  // Ajusta el array de líneas a `count`, preservando las existentes y rellenando
  // con el primer medio disponible. Se usa al cambiar la cantidad de líneas.
  const resize = (count: number) =>
    setLines((prev) => {
      const next = prev.slice(0, count);
      while (next.length < count) next.push(emptyLine(firstMethod));
      return next;
    });

  const setLine = (i: number, patch: Partial<SplitLine>) =>
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  // Cantidad de líneas según el modo: "partes iguales" la fija la cantidad de
  // comensales; los otros modos usan el largo del array (botón +/− línea).
  const count = mode === "equal" ? Math.max(1, diners) : Math.max(1, lines.length);

  // Mantener lines sincronizado con `count` en modo "partes iguales".
  useEffect(() => {
    if (mode === "equal" && lines.length !== count) resize(count);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, count]);

  // Reparte `totalCents` en `count` partes iguales (el resto, a las primeras
  // líneas) → array de montos en centavos que suma EXACTO el total.
  const equalShares = useMemo(() => {
    const baseShare = Math.floor(totalCents / count);
    const rem = totalCents - baseShare * count;
    return Array.from({ length: count }, (_, i) => baseShare + (i < rem ? 1 : 0));
  }, [totalCents, count]);

  // Monto (en centavos) de cada línea según el modo. Devuelve también si la
  // configuración del modo es válida (suma exacta, ítems asignados, etc.).
  const computed = useMemo((): { amountsCents: number[]; ok: boolean; assignedCents: number } => {
    if (mode === "equal") {
      return { amountsCents: equalShares, ok: true, assignedCents: totalCents };
    }
    if (mode === "amount") {
      const amountsCents = lines.map((l) => centsOf(l.amount));
      const assigned = amountsCents.reduce((a, b) => a + b, 0);
      return { amountsCents, ok: assigned === totalCents, assignedCents: assigned };
    }
    if (mode === "percent") {
      // % por línea → centavos. La última línea absorbe el ajuste de redondeo
      // para que la suma sea exacta. Válido sólo si los % suman 100.
      const pctSum = lines.reduce((a, l) => a + (Number(l.amount) || 0), 0);
      const amountsCents = lines.map((l) => Math.round(((Number(l.amount) || 0) / 100) * totalCents));
      const drift = totalCents - amountsCents.reduce((a, b) => a + b, 0);
      const last = amountsCents.length - 1;
      if (last >= 0) amountsCents[last] = (amountsCents[last] ?? 0) + drift;
      return {
        amountsCents,
        ok: Math.abs(pctSum - 100) < 0.001,
        assignedCents: amountsCents.reduce((a, b) => a + b, 0),
      };
    }
    // mode === "item": cada línea = suma de los ítems asignados. La última línea
    // absorbe la diferencia con el total (propina/recargos/redondeo que no son
    // ítems del carrito) para cuadrar exacto.
    const byId = new Map(items.map((it) => [it.id, centsOf(it.amount)]));
    const assignedIds = new Set<string>();
    const rawCents = lines.map((l) => {
      let s = 0;
      for (const id of l.itemIds) {
        if (assignedIds.has(id)) continue;
        assignedIds.add(id);
        s += byId.get(id) ?? 0;
      }
      return s;
    });
    const unassigned = items.filter((it) => !assignedIds.has(it.id));
    const unassignedCents = unassigned.reduce((a, it) => a + (byId.get(it.id) ?? 0), 0);
    const amountsCents = [...rawCents];
    const lastIdx = amountsCents.length - 1;
    if (autoAssignRest && lastIdx >= 0) {
      // El no asignado + la diferencia con el total → última línea.
      amountsCents[lastIdx] = totalCents - rawCents.slice(0, -1).reduce((a, b) => a + b, 0);
    }
    const sum = amountsCents.reduce((a, b) => a + b, 0);
    const ok = (autoAssignRest || unassignedCents === 0) && sum === totalCents;
    return { amountsCents, ok, assignedCents: sum };
  }, [mode, equalShares, lines, totalCents, items, autoAssignRest]);

  // Vuelto: por cada línea de efectivo, lo recibido por encima de su monto.
  const change = useMemo(() => {
    let c = 0;
    lines.forEach((l, i) => {
      if (l.method === "cash") {
        const recv = centsOf(l.received);
        if (recv > 0) c += Math.max(0, recv - (computed.amountsCents[i] ?? 0));
      }
    });
    return fromCents(c);
  }, [lines, computed.amountsCents]);

  // Voucher de tarjeta completo por línea (si el negocio lo exige).
  const voucherOkFor = (l: SplitLine) =>
    !voucherRequired ||
    !isCardMethod(l.method) ||
    (l.voucherLote.trim() !== "" && l.voucherCupon.trim() !== "" && l.voucherAuth.trim() !== "");
  const allVouchersOk = lines.slice(0, count).every(voucherOkFor);

  // Emite el resultado al padre (memo estable por contenido). null = no cuadra.
  useEffect(() => {
    // Defensa: ninguna línea puede quedar negativa (p. ej. un descuento mayor que
    // los ítems de las primeras líneas dejaría la última en negativo). Si pasa, el
    // split no es válido y el cajero debe reasignar.
    const allNonNeg = computed.amountsCents.slice(0, count).every((c) => c >= 0);
    const usable = computed.ok && allNonNeg && allVouchersOk && totalCents > 0;
    if (!usable) {
      onPaymentsChange(null);
      return;
    }
    // Una línea de pago por cada parte. Se descartan las de monto 0 (p. ej. una
    // línea al 0%): un pago de $0 no aporta y ensucia el reporte. La suma de las
    // que quedan sigue siendo EXACTA (sólo se quitan ceros).
    const payments: SalePaymentInput[] = lines
      .slice(0, count)
      .map((l, i) => {
        const amt = fromCents(computed.amountsCents[i] ?? 0);
        const hasVoucher =
          isCardMethod(l.method) &&
          (voucherRequired ||
            l.voucherLote.trim() !== "" ||
            l.voucherCupon.trim() !== "" ||
            l.voucherAuth.trim() !== "");
        return {
          method: l.method,
          amount: amt,
          ...(hasVoucher
            ? {
                card_voucher: {
                  lote: l.voucherLote.trim(),
                  cupon: l.voucherCupon.trim(),
                  autorizacion: l.voucherAuth.trim(),
                },
              }
            : {}),
        };
      })
      .filter((p) => p.amount > 0);
    if (payments.length === 0) {
      onPaymentsChange(null);
      return;
    }
    onPaymentsChange({ payments, change });
    // onPaymentsChange es estable (useCallback en el padre).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [computed, allVouchersOk, totalCents, lines, count, change, voucherRequired]);

  const assigned = fromCents(computed.assignedCents);
  const remaining = fromCents(totalCents - computed.assignedCents);

  return (
    <div className="space-y-3 rounded-lg border border-ninja-flame/30 bg-ninja-flame/[0.05] p-3">
      {/* Modo de división */}
      <div>
        <label className="mb-2 block text-sm font-medium text-ninja-flameSoft">
          Modo de división
        </label>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {availableModes.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => setMode(m.value)}
              className={
                mode === m.value
                  ? "rounded-lg border border-ninja-flame bg-ninja-flame/15 px-2 py-2 text-xs font-semibold text-ninja-flameSoft"
                  : "rounded-lg border border-border bg-card px-2 py-2 text-xs font-medium text-muted-foreground transition hover:border-ninja-flameSoft/40"
              }
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* Partes iguales: cantidad de comensales */}
      {mode === "equal" && (
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-muted-foreground">Comensales</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label="Quitar comensal"
              onClick={() => setDiners((d) => Math.max(1, d - 1))}
              className="grid h-9 w-9 place-items-center rounded-lg border border-border text-foreground hover:bg-muted"
            >
              −
            </button>
            <span className="w-8 text-center text-sm font-semibold tabular-nums">{count}</span>
            <button
              type="button"
              aria-label="Agregar comensal"
              onClick={() => setDiners((d) => Math.min(20, d + 1))}
              className="grid h-9 w-9 place-items-center rounded-lg border border-border text-foreground hover:bg-muted"
            >
              +
            </button>
          </div>
        </div>
      )}

      {/* Líneas de cobro */}
      <div className="space-y-2">
        {lines.slice(0, count).map((l, i) => (
          <div key={i} className="rounded-lg border border-border bg-card/60 p-2.5">
            <div className="flex items-center gap-2">
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-ninja-flame/15 text-xs font-bold text-ninja-flameSoft">
                {i + 1}
              </span>
              <select
                value={l.method}
                onChange={(e) => setLine(i, { method: e.target.value as SalePaymentInput["method"] })}
                aria-label={`Medio de pago línea ${i + 1}`}
                className="h-10 flex-1 rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-ninja-flameSoft focus:ring-4 focus:ring-ninja-flameSoft/15"
              >
                {methods.map((m) => (
                  <option key={m.value} value={m.value} className="bg-popover text-popover-foreground">
                    {m.label}
                  </option>
                ))}
              </select>
              {mode === "amount" ? (
                <Input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  aria-label={`Monto línea ${i + 1}`}
                  value={l.amount || ""}
                  onChange={(e) => setLine(i, { amount: Number(e.target.value) || 0 })}
                  placeholder="0"
                  className="w-28 text-right"
                />
              ) : mode === "percent" ? (
                <div className="flex w-28 items-center gap-1">
                  <Input
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    aria-label={`Porcentaje línea ${i + 1}`}
                    value={l.amount || ""}
                    onChange={(e) => setLine(i, { amount: Number(e.target.value) || 0 })}
                    placeholder="0"
                    className="text-right"
                  />
                  <span className="text-sm text-muted-foreground">%</span>
                </div>
              ) : (
                <span className="w-28 text-right text-sm font-semibold tabular-nums">
                  {formatCurrency(fromCents(computed.amountsCents[i] ?? 0))}
                </span>
              )}
            </div>

            {/* Por ítem: chips de asignación. Tap = asignar/quitar de esta línea
                (un ítem va a una sola línea). */}
            {mode === "item" && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {items.map((it) => {
                  const ownerIdx = lines.findIndex((ln) => ln.itemIds.includes(it.id));
                  const mine = ownerIdx === i;
                  const takenByOther = ownerIdx !== -1 && ownerIdx !== i;
                  return (
                    <button
                      key={it.id}
                      type="button"
                      onClick={() =>
                        setLines((prev) =>
                          prev.map((ln, idx) => {
                            if (idx === i) {
                              return mine
                                ? { ...ln, itemIds: ln.itemIds.filter((x) => x !== it.id) }
                                : { ...ln, itemIds: [...ln.itemIds, it.id] };
                            }
                            // Sacar el ítem de cualquier otra línea (exclusivo).
                            return ln.itemIds.includes(it.id)
                              ? { ...ln, itemIds: ln.itemIds.filter((x) => x !== it.id) }
                              : ln;
                          }),
                        )
                      }
                      className={
                        mine
                          ? "rounded-full border border-ninja-flame bg-ninja-flame/20 px-2 py-1 text-[11px] font-semibold text-ninja-flameSoft"
                          : takenByOther
                            ? "rounded-full border border-border bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground/50"
                            : "rounded-full border border-border bg-card px-2 py-1 text-[11px] text-muted-foreground transition hover:border-ninja-flameSoft/40"
                      }
                    >
                      {it.label} · {formatCurrency(it.amount)}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Recibido / vuelto por línea de efectivo */}
            {l.method === "cash" && (
              <div className="mt-2 flex items-center gap-2">
                <Input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  aria-label={`Recibido línea ${i + 1}`}
                  value={l.received}
                  onChange={(e) => setLine(i, { received: e.target.value })}
                  placeholder="Recibido (opcional)"
                  className="flex-1"
                />
              </div>
            )}

            {/* Voucher de tarjeta por línea (cuando el negocio lo exige) */}
            {voucherRequired && isCardMethod(l.method) && (
              <div className="mt-2 grid grid-cols-3 gap-2">
                <Input
                  aria-label={`Lote línea ${i + 1}`}
                  inputMode="numeric"
                  value={l.voucherLote}
                  onChange={(e) => setLine(i, { voucherLote: e.target.value })}
                  placeholder="Lote"
                />
                <Input
                  aria-label={`Cupón línea ${i + 1}`}
                  inputMode="numeric"
                  value={l.voucherCupon}
                  onChange={(e) => setLine(i, { voucherCupon: e.target.value })}
                  placeholder="Cupón"
                />
                <Input
                  aria-label={`Autorización línea ${i + 1}`}
                  inputMode="numeric"
                  value={l.voucherAuth}
                  onChange={(e) => setLine(i, { voucherAuth: e.target.value })}
                  placeholder="Autoriz."
                />
              </div>
            )}

            {/* Quitar línea (modos no-iguales con más de 1 línea) */}
            {mode !== "equal" && count > 1 && (
              <div className="mt-2 text-right">
                <button
                  type="button"
                  onClick={() => setLines((prev) => prev.filter((_, idx) => idx !== i))}
                  className="text-xs font-medium text-muted-foreground transition hover:text-danger"
                >
                  Quitar línea
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Agregar línea (modos no-iguales) */}
      {mode !== "equal" && (
        <button
          type="button"
          onClick={() => setLines((prev) => [...prev, emptyLine(firstMethod)])}
          className="w-full rounded-lg border border-dashed border-ninja-flameSoft/40 px-3 py-2 text-xs font-medium text-ninja-flameSoft transition hover:bg-ninja-flame/10"
        >
          + Agregar línea de pago
        </button>
      )}

      {/* Por ítem: asignar lo no asignado a la última línea */}
      {mode === "item" && (
        <label className="flex cursor-pointer items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>Ítems sin asignar → última línea</span>
          <input
            type="checkbox"
            checked={autoAssignRest}
            onChange={(e) => setAutoAssignRest(e.target.checked)}
            className="h-4 w-4 accent-ninja-flame"
          />
        </label>
      )}

      {/* Totales del split */}
      <div className="space-y-1 rounded-lg border border-border bg-muted/40 p-3 text-sm">
        <div className="flex justify-between text-muted-foreground">
          <span>Total a repartir</span>
          <span className="tabular-nums">{formatCurrency(total)}</span>
        </div>
        <div className="flex justify-between text-muted-foreground">
          <span>Asignado</span>
          <span className="tabular-nums">{formatCurrency(assigned)}</span>
        </div>
        <div
          className={
            Math.abs(remaining) < 0.005
              ? "flex justify-between font-semibold text-success"
              : "flex justify-between font-semibold text-warning"
          }
        >
          <span>{remaining >= 0 ? "Restante" : "Sobra"}</span>
          <span className="tabular-nums">{formatCurrency(Math.abs(remaining))}</span>
        </div>
        {change > 0 && (
          <div className="flex justify-between border-t border-border pt-1 text-muted-foreground">
            <span>Vuelto (efectivo)</span>
            <span className="tabular-nums font-semibold text-foreground">{formatCurrency(change)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export function PaymentModal({
  open,
  onOpenChange,
  base,
  rounding = 0,
  onConfirm,
  loading,
  storeCreditBalance = 0,
  hasCustomer = false,
  initialWarrantyId = "",
  splitItems = [],
  deliveryFee = 0,
  cartPromo = null,
  promoForMethod,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  base: number; // subtotal - descuento, SIN redondear
  rounding?: number;
  onConfirm: (
    payments: SalePaymentInput[],
    extras?: PaymentExtra[],
    // Vuelto en efectivo (recibido - total). Lo usa la pantalla del cliente (H25)
    // para mostrar el vuelto tras cobrar. 0 cuando no es efectivo.
    change?: number,
    // Promo FINAL aplicada (F9 · H54): la del carrito o, si el medio elegido
    // habilita una promo por medio de pago mayor, esa. El POS la manda a create_sale.
    appliedPromo?: { discount: number; id: string | null; name: string | null } | null,
  ) => void;
  loading: boolean;
  storeCreditBalance?: number;
  hasCustomer?: boolean;
  // Plan de garantía pre-seleccionado por la oferta contextual (H28). Al abrir,
  // el modal arranca con esta garantía elegida; el cajero puede cambiarla.
  initialWarrantyId?: string;
  // Ítems del carrito para "Dividir cuenta → por ítem" (F13 · H44). La página POS
  // mapea sus líneas a { id, label, amount }. Vacío = no se ofrece el modo ítem.
  splitItems?: SplitItem[];
  // Costo de envío AUTORITATIVO del pedido de delivery (F13 · H49 · Bug 🟠). NO es
  // una línea del carrito: lo agrega create_sale desde delivery_orders.delivery_fee
  // (inviolable). Acá se suma al total a cobrar (payTotal) para que el cajero vea/
  // cobre productos + envío y el total mostrado COINCIDA con el v_total del server
  // (sin insufficient_payment en el flujo honesto). 0 = no es cobro de delivery.
  deliveryFee?: number;
  // Promo método-AGNÓSTICA del carrito (F9 · H54): ya está restada en `base`. Es
  // el punto de partida; el descuento por medio se mide contra ésta.
  cartPromo?: { discount: number; id: string | null; name: string | null } | null;
  // Reevalúa la mejor promo para un medio de pago dado (F9 · H54). Devuelve el
  // descuento ya acotado (≥ cartPromo). El modal resta el EXTRA respecto de
  // cartPromo del total y manda la promo final a onConfirm. null = sin promos.
  promoForMethod?: (
    method: string,
  ) => { discount: number; id: string | null; name: string | null } | null;
}) {
  const { data: wplans } = useWarrantyPlans(true);
  const { data: allPlans } = usePaymentPlans();
  const { data: enabledProviders } = useEnabledPaymentMethods();
  const { data: gating } = useGating();
  const { data: posSettings } = usePosSettings();
  // Profesionales activos para atribuir la comisión de la venta (H39).
  const { data: professionals } = useProfessionals();

  const [method, setMethod] = useState<SalePaymentInput["method"]>("cash");
  const [warrantyId, setWarrantyId] = useState("");
  const [planId, setPlanId] = useState("");
  const [received, setReceived] = useState("");
  // Propina (H39): monto + medio. Aparte del total de productos.
  const [tipAmount, setTipAmount] = useState("");
  const [tipMethod, setTipMethod] = useState("cash");
  // Profesional/vendedor atribuido a la venta (H39). "" = sin atribución.
  const [professionalId, setProfessionalId] = useState("");
  // Voucher de tarjeta (H27): lote / cupón / nº de autorización. Sólo se pide en
  // débito/crédito cuando el negocio activó require_card_voucher.
  const [voucherLote, setVoucherLote] = useState("");
  const [voucherCupon, setVoucherCupon] = useState("");
  const [voucherAuth, setVoucherAuth] = useState("");
  // Dividir cuenta (F13 · H44): el cobro se reparte en N líneas de pago que suman
  // el total. Cuando está activo, el cobro va por `splitResult` (no por el medio
  // único de arriba). `splitResult` = null mientras las líneas no cuadren.
  const [splitOn, setSplitOn] = useState(false);
  const [splitResult, setSplitResult] = useState<{
    payments: SalePaymentInput[];
    change: number;
  } | null>(null);
  // Callback estable para que SplitPaymentSection no re-emita en loop.
  const handleSplitChange = useCallback(
    (r: { payments: SalePaymentInput[]; change: number } | null) => setSplitResult(r),
    [],
  );

  // Reset al abrir (el modal queda montado entre ventas). La garantía arranca con
  // la pre-seleccionada por la oferta contextual (H28), si la hay.
  useEffect(() => {
    if (open) {
      setMethod("cash");
      setWarrantyId(initialWarrantyId);
      setPlanId("");
      setReceived("");
      setVoucherLote("");
      setVoucherCupon("");
      setVoucherAuth("");
      setTipAmount("");
      setTipMethod("cash");
      setProfessionalId("");
      setSplitOn(false);
      setSplitResult(null);
    }
  }, [open, initialWarrantyId]);

  // Reset el plan y el voucher cuando cambia el método (el voucher es por tarjeta).
  useEffect(() => {
    setPlanId("");
    setVoucherLote("");
    setVoucherCupon("");
    setVoucherAuth("");
  }, [method]);

  // Filtrar métodos por los proveedores habilitados del tenant (H14) Y por el
  // plan (gating real, espejo del enforcement backend). Un proveedor se ofrece
  // sólo si está habilitado por el tenant y su feature de plan está activa.
  // Proveedores sin feature (posnet propio, pagos360) sólo dependen de enabled.
  const methods = useMemo(() => {
    const enabledKeys = new Set(
      (enabledProviders ?? []).map((p: { provider_key: string }) => p.provider_key),
    );
    // Si el tenant no configuró nada, mostramos todo (fallback) — pero igual
    // respetamos el plan: un proveedor gateado sin la feature no se ofrece.
    const noConfig = enabledKeys.size === 0;
    const planAllows = (provider: string) => {
      const feat = PROVIDER_FEATURE[provider];
      if (!feat) return true; // sin gating de plan
      // Mientras carga el gating no escondemos nada (optimista); el backend
      // sigue bloqueando si no corresponde.
      return gating ? gating.features[feat] === true : true;
    };
    const providerUsable = (provider: string) =>
      (noConfig || enabledKeys.has(provider)) && planAllows(provider);

    const filtered = ALL_METHODS.filter((m) => m.providers.some(providerUsable));

    const applyRound = (x: number) =>
      rounding > 0 ? Math.round(x / rounding) * rounding : x;
    const payTotalBase = applyRound(base);
    const canVale = storeCreditBalance >= payTotalBase && payTotalBase > 0;

    return [
      ...filtered,
      ...(canVale
        ? [{ value: "store_credit" as const, label: `Vale (saldo ${formatCurrency(storeCreditBalance)})`, providers: [] }]
        : []),
      ...(hasCustomer
        ? [{ value: "account" as const, label: "Cuenta corriente (fiado)", providers: [] }]
        : []),
    ];
  }, [enabledProviders, gating, storeCreditBalance, hasCustomer, base, rounding]);

  // Planes del método actual (débito → base "debito", crédito → "credito").
  // Sólo se ofrecen los planes VIGENTES hoy (H27): valid_from <= hoy y
  // (valid_until null o >= hoy). Los fuera de vigencia (vencidos o programados a
  // futuro) no aparecen en el selector de cuotas.
  const planBase = METHOD_PLAN_BASE[method];
  const methodPlans = useMemo((): PaymentPlan[] => {
    if (!planBase || !allPlans) return [];
    return allPlans.filter((p: PaymentPlan) => p.base === planBase && isPlanActive(p));
  }, [planBase, allPlans]);

  // Plan de cuotas seleccionado (débito/crédito) y su recargo. NO se neutraliza al
  // activar "dividir cuenta": si el cajero eligió "Crédito 3 cuotas (+15%)", ese
  // recargo debe seguir cobrándose. Antes se forzaba a null con split → se cobraba
  // de menos sin aviso (plata perdida). Ahora el recargo se preserva: se suma al
  // total que el split reparte (productsTotal) y entra como ítem en `extras`. El
  // selector de plan sólo se muestra en cobro simple, pero la SELECCIÓN persiste:
  // al activar split se le avisa al cajero con un banner que el recargo está
  // incluido y se le ofrece un botón "Quitar recargo" (setPlanId("")) para dividir
  // sin recargo si lo prefiere (ver BUG 6). Nunca se cobra de menos en silencio.
  const selectedPlan = (allPlans ?? []).find((p: PaymentPlan) => p.id === planId) ?? null;
  const planSurcharge = selectedPlan
    ? Math.round(((base * Number(selectedPlan.surcharge_pct)) / 100) * 100) / 100
    : 0;

  // Recargo global del medio (tenant_payment_methods.surcharge_pct), solo cuando
  // no hay plan seleccionado y el método tiene surcharge_pct > 0 (H14).
  const METHOD_PROVIDER: Partial<Record<SalePaymentInput["method"], string>> = {
    cash: "cash",
    transfer: "transfer",
  };
  const methodProviderKey = METHOD_PROVIDER[method];
  const methodSurchargePct = methodProviderKey
    ? Number(
        (enabledProviders ?? []).find(
          (p: { provider_key: string }) => p.provider_key === methodProviderKey,
        )?.surcharge_pct ?? 0,
      )
    : 0;
  const methodSurcharge =
    !splitOn && !selectedPlan && methodSurchargePct > 0
      ? Math.round(((base * methodSurchargePct) / 100) * 100) / 100
      : 0;

  // Promo final según el medio (F9 · H54). En cobro simple se reevalúa la mejor
  // promo con el medio elegido en contexto (habilita las promos por medio); en
  // cobro dividido se usa la promo método-agnóstica del carrito (las promos por
  // medio no aplican a un cobro repartido). `base` ya tiene restada la del carrito,
  // así que sólo restamos el EXTRA que aporta la promo del medio sobre aquélla.
  const appliedPromo = useMemo(
    () => (!splitOn && promoForMethod ? promoForMethod(method) : cartPromo),
    [splitOn, promoForMethod, method, cartPromo],
  );
  const cartPromoDiscount = cartPromo?.discount ?? 0;
  const methodPromoExtra = Math.max(0, (appliedPromo?.discount ?? 0) - cartPromoDiscount);

  const wplan = (wplans ?? []).find((p: WarrantyPlan) => p.id === warrantyId) ?? null;
  const warrantyPrima = wplan
    ? Number(wplan.price_pct) > 0
      ? Math.round(((base * Number(wplan.price_pct)) / 100) * 100) / 100
      : Number(wplan.price)
    : 0;

  const applyRound = (x: number) =>
    rounding > 0 ? Math.round(x / rounding) * rounding : x;
  // Total de productos (con garantía/recargos), redondeado. La propina NO se
  // redondea ni forma parte de este total: se suma al cobro como un agregado.
  // El costo de envío (delivery) se suma DESPUÉS del redondeo y NO se descuenta:
  // espeja exactamente create_sale (v_total = round(items - desc) + fee), así el
  // payTotal coincide con el v_total del server y no hay insufficient_payment.
  const deliveryFeeAmount = Math.max(0, deliveryFee || 0);
  const productsTotal =
    applyRound(base - methodPromoExtra + warrantyPrima + planSurcharge + methodSurcharge) +
    deliveryFeeAmount;
  const tip = Math.max(0, Number(tipAmount) || 0);
  // Lo que el cliente paga = productos + propina. El cajero recibe ambos.
  const payTotal = productsTotal + tip;
  const receivedNum = Number(received) || 0;
  const change = method === "cash" ? Math.max(0, receivedNum - payTotal) : 0;

  // Voucher de tarjeta (H27): se pide cuando el negocio activó
  // require_card_voucher Y el medio es débito o crédito. Los 3 campos
  // (lote/cupón/autorización) son obligatorios; el botón de confirmar se
  // bloquea hasta completarlos. El voucher viaja en el payload del pago.
  const isCardMethod = method === "debit" || method === "credit";
  const voucherRequired = Boolean(posSettings?.requireCardVoucher) && isCardMethod;
  const voucher: CardVoucher = {
    lote: voucherLote.trim(),
    cupon: voucherCupon.trim(),
    autorizacion: voucherAuth.trim(),
  };
  const voucherComplete =
    voucher.lote !== "" && voucher.cupon !== "" && voucher.autorizacion !== "";
  // Si hay datos de voucher (aunque no sea obligatorio) se adjunta al pago.
  const voucherHasData = voucher.lote !== "" || voucher.cupon !== "" || voucher.autorizacion !== "";

  // `kind` etiqueta el extra para create_sale: 'warranty' (prima de garantía
  // extendida → feature 'garantias') y 'surcharge' (recargo de medio/plan, sin
  // gating) entran como ítem de venta (name). 'tip' (propina) y 'professional'
  // (atribución) NO son ítems: van a sales.tip_amount / sales.professional_id.
  const extras: PaymentExtra[] = [];
  if (warrantyPrima > 0 && wplan)
    extras.push({ name: `Garantía ${wplan.label}`, amount: warrantyPrima, kind: "warranty" });
  if (planSurcharge > 0 && selectedPlan)
    extras.push({ name: `Recargo ${selectedPlan.label}`, amount: planSurcharge, kind: "surcharge" });
  if (methodSurcharge > 0) {
    const methodLabel = ALL_METHODS.find((m) => m.value === method)?.label ?? method;
    extras.push({ name: `Recargo ${methodLabel} (${methodSurchargePct}%)`, amount: methodSurcharge, kind: "surcharge" });
  }
  // Propina (H39): aparte del total de productos; se cobra junto a la venta.
  if (tip > 0) extras.push({ kind: "tip", amount: tip, method: tipMethod });
  // Atribución de comisión (H39): profesional/vendedor de la venta.
  if (professionalId) extras.push({ kind: "professional", id: professionalId });

  // Medios para "Dividir cuenta": sólo dinero real con cobro directo por línea
  // (efectivo / débito / crédito / transferencia). Se excluyen:
  //  · store_credit (vale) y account (cuenta corriente): repartir saldo o fiado
  //    necesitaría validación server extra (límite/saldo por línea) y no es el
  //    caso de uso de la división gastronómica → follow-up.
  //  · qr ("QR / Terminal", BUG 7): requiere flujo de aprobación con intent
  //    (referencia + QR real); una línea de split lo manda sin reference y el
  //    backend no genera QR. No tiene sentido por línea → no se ofrece.
  const splitMethods = useMemo(
    () =>
      methods.filter(
        (m) => m.value !== "store_credit" && m.value !== "account" && m.value !== "qr",
      ),
    [methods],
  );
  // El cobro dividido sólo se ofrece si hay total > 0 y al menos un medio de
  // dinero real. El botón confirmar usará splitResult cuando splitOn esté activo.
  const canSplit = payTotal > 0 && splitMethods.length > 0;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Cobrar"
      description={`Total: ${formatCurrency(payTotal)}`}
    >
      <div className="space-y-4">
        {/* Dividir cuenta (F13 · H44): toggle. Con on, el cobro se reparte en N
            líneas de pago (partes iguales / monto / % / ítem) que suman el total
            y van como p_payments en UN solo create_sale (una venta, la mesa se
            cierra igual). Aditivo: con off, el cobro simple queda idéntico. */}
        {canSplit && (
          <label className="flex cursor-pointer items-center justify-between gap-2 rounded-lg border border-border px-3 py-2.5">
            <span className="flex items-center gap-2 text-sm font-medium text-foreground">
              <Users size={16} className="text-ninja-flameSoft" />
              Dividir cuenta
            </span>
            <input
              type="checkbox"
              checked={splitOn}
              onChange={(e) => setSplitOn(e.target.checked)}
              aria-label="Dividir cuenta"
              className="h-5 w-5 accent-ninja-flame"
            />
          </label>
        )}

        {/* BUG 6: aviso de recargo por cuotas al dividir. Si el cajero había
            elegido un plan con recargo (p. ej. "Crédito 3 cuotas (+15%)") y activa
            "dividir cuenta", el recargo NO se silencia: sigue incluido en el total
            que se reparte (y se cobra). El selector de plan no se muestra en modo
            dividir, así que avisamos explícitamente y damos un botón para quitarlo
            si el cajero prefiere repartir sin recargo. Antes esto se perdía y se
            cobraba de menos sin que nadie se enterara. */}
        {splitOn && canSplit && selectedPlan && planSurcharge > 0 && (
          <div className="flex items-start gap-3 rounded-lg border border-ninja-flame/40 bg-ninja-flame/10 p-3">
            <div className="flex-1 text-sm">
              <p className="font-semibold text-ninja-flameSoft">
                Recargo por cuotas incluido en el total
              </p>
              <p className="mt-0.5 text-muted-foreground">
                El recargo de “{selectedPlan.label}” (+{formatCurrency(planSurcharge)}) se
                reparte dentro del total a dividir. Quitalo si querés dividir sin recargo.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setPlanId("")}
              className="shrink-0 rounded-lg border border-ninja-flame/50 px-2.5 py-1.5 text-xs font-semibold text-ninja-flameSoft transition hover:bg-ninja-flame/15"
            >
              Quitar recargo
            </button>
          </div>
        )}

        {splitOn && canSplit && (
          <SplitPaymentSection
            total={payTotal}
            methods={splitMethods}
            items={splitItems}
            voucherRequired={Boolean(posSettings?.requireCardVoucher)}
            onPaymentsChange={handleSplitChange}
          />
        )}

        {/* Medio de pago (cobro simple). En modo dividir, lo reemplaza la sección
            de división (cada línea elige su medio). */}
        {!splitOn && (
        <div>
          <label className="mb-2 block text-sm font-medium text-muted-foreground">
            Medio de pago
          </label>
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value as SalePaymentInput["method"])}
            className="h-11 w-full rounded-lg border border-input bg-background px-4 text-sm text-foreground outline-none focus:border-ninja-flameSoft focus:ring-4 focus:ring-ninja-flameSoft/15"
          >
            {methods.map((m) => (
              <option key={m.value} value={m.value} className="bg-popover text-popover-foreground">
                {m.label}
              </option>
            ))}
          </select>
        </div>
        )}

        {/* Profesional / vendedor (H39): atribuye la comisión de la venta. Sólo
            aparece si el negocio cargó profesionales. Opcional. */}
        {(professionals ?? []).length > 0 && (
          <div>
            <label className="mb-2 block text-sm font-medium text-muted-foreground">
              Vendedor / profesional
            </label>
            <select
              value={professionalId}
              onChange={(e) => setProfessionalId(e.target.value)}
              className="h-11 w-full rounded-lg border border-input bg-background px-4 text-sm text-foreground outline-none focus:border-ninja-flameSoft focus:ring-4 focus:ring-ninja-flameSoft/15"
            >
              <option value="">Sin asignar (sin comisión)</option>
              {(professionals ?? []).map((p) => (
                <option key={p.id} value={p.id} className="bg-popover text-popover-foreground">
                  {p.name}
                  {p.commission_pct != null ? ` · ${Number(p.commission_pct)}%` : ""}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Plan de pago (débito / crédito) con recargo (H14 / H27). Sólo en cobro
            simple; el modo dividir reparte el total ya calculado sin planes. */}
        {!splitOn && methodPlans.length > 0 && (
          <div>
            <label className="mb-2 block text-sm font-medium text-muted-foreground">
              Plan de pago
            </label>
            <select
              value={planId}
              onChange={(e) => setPlanId(e.target.value)}
              className="h-11 w-full rounded-lg border border-input bg-background px-4 text-sm text-foreground outline-none focus:border-ninja-flameSoft focus:ring-4 focus:ring-ninja-flameSoft/15"
            >
              <option value="">Sin plan / recargo</option>
              {methodPlans.map((p) => (
                <option key={p.id} value={p.id} className="bg-popover text-popover-foreground">
                  {p.label}
                  {Number(p.surcharge_pct) > 0 ? ` (+${Number(p.surcharge_pct)}%)` : ""}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Voucher de tarjeta (H27): lote / cupón / nº de autorización. Sólo en
            débito/crédito cuando el negocio activó require_card_voucher. Los 3
            campos son obligatorios; se guardan junto al pago de la venta. En modo
            dividir, el voucher se pide por línea de tarjeta dentro del split. */}
        {!splitOn && voucherRequired && (
          <div className="rounded-lg border border-ninja-flameSoft/30 bg-ninja-flame/5 p-3">
            <div className="mb-2 text-sm font-medium text-ninja-flameSoft">
              Voucher de tarjeta
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Input
                label="Lote"
                inputMode="numeric"
                value={voucherLote}
                onChange={(e) => setVoucherLote(e.target.value)}
                placeholder="Ej. 045"
              />
              <Input
                label="Cupón"
                inputMode="numeric"
                value={voucherCupon}
                onChange={(e) => setVoucherCupon(e.target.value)}
                placeholder="Ej. 001234"
              />
              <Input
                label="Autorización"
                inputMode="numeric"
                value={voucherAuth}
                onChange={(e) => setVoucherAuth(e.target.value)}
                placeholder="Ej. 998877"
              />
            </div>
            {!voucherComplete && (
              <p className="mt-2 text-xs text-muted-foreground">
                Completá lote, cupón y nº de autorización del voucher para confirmar.
              </p>
            )}
          </div>
        )}

        {/* Garantía extendida */}
        {(wplans ?? []).length > 0 && (
          <div>
            <label className="mb-2 block text-sm font-medium text-muted-foreground">
              Garantía extendida
            </label>
            <select
              value={warrantyId}
              onChange={(e) => setWarrantyId(e.target.value)}
              className="h-11 w-full rounded-lg border border-input bg-background px-4 text-sm text-foreground outline-none focus:border-ninja-flameSoft focus:ring-4 focus:ring-ninja-flameSoft/15"
            >
              <option value="">Sin garantía extendida</option>
              {(wplans ?? []).map((p: WarrantyPlan) => (
                <option key={p.id} value={p.id} className="bg-popover text-popover-foreground">
                  {p.label} ({p.months} meses · {formatCurrency(Number(p.price))})
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Propina (H39): monto + medio. Aparte del total de productos; el cajero
            la cobra junto con la venta. Se atribuye al profesional elegido. */}
        <div>
          <label className="mb-2 block text-sm font-medium text-muted-foreground">
            Propina (opcional)
          </label>
          <div className="flex gap-2">
            <Input
              type="number"
              inputMode="decimal"
              step="0.01"
              value={tipAmount}
              onChange={(e) => setTipAmount(e.target.value)}
              placeholder="0"
              className="flex-1"
            />
            <select
              value={tipMethod}
              onChange={(e) => setTipMethod(e.target.value)}
              aria-label="Medio de la propina"
              className="h-11 w-40 rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-ninja-flameSoft focus:ring-4 focus:ring-ninja-flameSoft/15"
            >
              {TIP_METHODS.map((m) => (
                <option key={m.value} value={m.value} className="bg-popover text-popover-foreground">
                  {m.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Resumen de extras (envío + garantía + recargo de plan + propina +
            descuento por medio de pago) */}
        {(extras.some((e) => e.kind === "warranty" || e.kind === "surcharge") ||
          tip > 0 ||
          deliveryFeeAmount > 0 ||
          methodPromoExtra > 0) && (
          <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm space-y-1">
            {/* Envío (H49 · Bug 🟠): informativo. El monto lo fija el server desde
                delivery_orders; acá sólo se suma al total a cobrar. NO es ítem del
                carrito (lo agrega create_sale como línea autoritativa). */}
            {deliveryFeeAmount > 0 && (
              <div className="flex justify-between text-muted-foreground">
                <span>Envío</span>
                <span>+{formatCurrency(deliveryFeeAmount)}</span>
              </div>
            )}
            {extras
              .filter((e) => e.kind === "warranty" || e.kind === "surcharge")
              .map((e) => (
                <div key={e.name} className="flex justify-between text-muted-foreground">
                  <span>{e.name}</span>
                  <span>+{formatCurrency(e.amount ?? 0)}</span>
                </div>
              ))}
            {tip > 0 && (
              <div className="flex justify-between text-muted-foreground">
                <span>Propina</span>
                <span>+{formatCurrency(tip)}</span>
              </div>
            )}
            {/* Descuento por medio de pago (F9 · H54): extra sobre la promo del
                carrito al elegir este medio. */}
            {methodPromoExtra > 0 && (
              <div className="flex justify-between text-success">
                <span className="truncate">{appliedPromo?.name ?? "Descuento por medio"}</span>
                <span>−{formatCurrency(methodPromoExtra)}</span>
              </div>
            )}
            <div className="flex justify-between font-semibold border-t border-border pt-1 mt-1">
              <span>Total a cobrar</span>
              <span>{formatCurrency(payTotal)}</span>
            </div>
          </div>
        )}

        {!splitOn && method === "cash" && (
          <>
            <Input
              label="Recibido"
              type="number"
              step="0.01"
              value={received}
              onChange={(e) => setReceived(e.target.value)}
            />
            <p className="text-sm text-muted-foreground">
              Vuelto:{" "}
              <span className="font-semibold text-foreground">
                {formatCurrency(change)}
              </span>
            </p>
          </>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          {splitOn ? (
            // Cobro dividido: usa las líneas del split (suman EXACTO payTotal). Se
            // bloquea hasta que cuadren (splitResult != null). Una sola venta: el
            // padre manda estas líneas como p_payments en un create_sale.
            <Button
              loading={loading}
              disabled={!splitResult}
              onClick={() =>
                splitResult &&
                onConfirm(
                  splitResult.payments,
                  extras.length > 0 ? extras : [],
                  splitResult.change,
                  appliedPromo,
                )
              }
            >
              Confirmar venta dividida
            </Button>
          ) : (
            <Button
              loading={loading}
              disabled={voucherRequired && !voucherComplete}
              onClick={() =>
                onConfirm(
                  [
                    {
                      method,
                      amount: payTotal,
                      // Voucher de tarjeta: se adjunta si es obligatorio o si el
                      // cajero cargó algún dato (siempre en débito/crédito).
                      ...(isCardMethod && (voucherRequired || voucherHasData)
                        ? { card_voucher: voucher }
                        : {}),
                    },
                  ],
                  extras.length > 0 ? extras : [],
                  change,
                  appliedPromo,
                )
              }
            >
              Confirmar venta
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
