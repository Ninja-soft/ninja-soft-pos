"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Lock, PackageCheck, Split, Store, Truck, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { cn } from "@/lib/utils/cn";
import {
  buildPlan,
  checkAllocations,
  envioAllocations,
  envioGroupKey,
  groupDeliveries,
  pickupStoreOptions,
  retiroAllocations,
  shippingFeeOf,
  type DeliveryChoice,
  type DeliveryInfo,
  type FulfillmentLine,
  type FulfillmentRules,
  type FulfillmentSource,
  type PlanPayload,
} from "@/lib/stock/fulfillment";
import { useCheckoutCustomerFiscal } from "@/modules/customers/checkoutFiscal";
import type { FulfillmentState } from "../fulfillment/FulfillmentModal";
import { money } from "../ui/posStyles";
import { CheckoutFold } from "./CheckoutFold";

const selectCls =
  "h-11 w-full min-w-0 rounded-lg border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60";

export interface DeliveryApply {
  /** null = se lo lleva ahora (venta normal por create_sale). */
  choice: DeliveryChoice | null;
  state: FulfillmentState | null;
  plan: PlanPayload | null;
  /** Lo que falta para poder cobrar con esta entrega (null = listo). */
  error: string | null;
}

export interface CheckoutDeliveryProps {
  /** La hoja está abierta (habilita las consultas). */
  open: boolean;
  lines: FulfillmentLine[];
  sources: FulfillmentSource[];
  sourcesLoading: boolean;
  rules: FulfillmentRules;
  stores: { id: string; name: string }[];
  /** Por qué no se ofrece cada modalidad (plan o configuración); null = disponible. */
  locks: { retiro: string | null; envio: string | null };
  choice: DeliveryChoice | null;
  /** "2 se lleva ahora · 1 envío a Calle 12" del reparto vigente. */
  summary: string | null;
  error: string | null;
  customerId: string | null;
  customerName: string | null;
  /** Pide los orígenes con stock (warehouse_sources) al abrir el bloque. */
  onNeedSources: () => void;
  onApply: (r: DeliveryApply) => void;
  /** Abre el reparto completo (FulfillmentModal). */
  onSplit: () => void;
}

/** Arma el reparto de un atajo (todo retira en una sucursal o todo por envío). Puro. */
export function planForChoice(
  choice: DeliveryChoice,
  ctx: {
    lines: FulfillmentLine[];
    sources: FulfillmentSource[];
    rules: FulfillmentRules;
    storeName: (id: string) => string;
    customerName: string | null;
  },
): DeliveryApply {
  const { lines, sources, rules } = ctx;
  if (choice.kind === "ahora" || choice.kind === "split") return { choice: null, state: null, plan: null, error: null };
  if (choice.kind === "retiro") {
    if (!choice.storeId) return { choice, state: null, plan: null, error: "Elegí en qué sucursal retira." };
    const { allocations, missing } = retiroAllocations(lines, sources, rules.storeId, choice.storeId, rules.retiroCrossBranch);
    if (missing.length > 0) {
      return {
        choice,
        state: null,
        plan: null,
        error: `No alcanza en ${ctx.storeName(choice.storeId)}: ${missing.join(", ")}. Usá Repartir entrega.`,
      };
    }
    const pickup = choice.pickupName.trim() || ctx.customerName || "";
    const info: Record<string, DeliveryInfo> = {};
    for (const g of groupDeliveries(allocations, rules.storeId)) {
      if (g.mode === "retiro") info[g.groupKey] = { pickupName: pickup };
    }
    const errors = checkAllocations(lines, allocations, rules, info);
    if (errors.length > 0) return { choice, state: null, plan: null, error: errors[0]! };
    if (!pickup) return { choice, state: { allocations, info }, plan: null, error: "Cargá quién retira (o elegí un cliente)." };
    return { choice, state: { allocations, info }, plan: buildPlan(lines, allocations, rules.storeId, info), error: null };
  }
  const allocations = envioAllocations(lines, rules.storeId);
  const info: Record<string, DeliveryInfo> = { [envioGroupKey(rules.storeId)]: { shipAddress: choice.address } };
  const errors = checkAllocations(lines, allocations, rules, info);
  if (errors.length > 0) return { choice, state: { allocations, info }, plan: null, error: errors[0]! };
  const plan = buildPlan(lines, allocations, rules.storeId, info);
  const fee = shippingFeeOf(choice.fee);
  return { choice, state: { allocations, info }, plan: fee > 0 ? { ...plan, shipping_fee: fee } : plan, error: null };
}

// Bloque "Entrega" de la hoja de cobro (ADR-146): por defecto se lo lleva
// ahora; atajos para que todo retire en otra sucursal o vaya por envío (con
// costo opcional como renglón) y "Repartir entrega" para partirla
// (FulfillmentModal, ADR-136). Usa el mismo plan y el mismo RPC del servidor.
export function CheckoutDeliveryBlock({
  open,
  lines,
  sources,
  sourcesLoading,
  rules,
  stores,
  locks,
  choice,
  summary,
  error,
  customerId,
  customerName,
  onNeedSources,
  onApply,
  onSplit,
}: CheckoutDeliveryProps) {
  const [expanded, setExpanded] = useState(false);
  const kind = choice?.kind ?? "ahora";
  const fiscal = useCheckoutCustomerFiscal(customerId, open);
  const customerAddress = fiscal.data?.address?.trim() || "";
  const storeName = (id: string) => stores.find((s) => s.id === id)?.name ?? "Otra sucursal";

  // Borradores de cada atajo (sobreviven a cambiar de opción).
  const [pickupStore, setPickupStore] = useState(choice?.kind === "retiro" ? choice.storeId : "");
  const [pickupName, setPickupName] = useState(choice?.kind === "retiro" ? choice.pickupName : "");
  const [address, setAddress] = useState(choice?.kind === "envio" ? choice.address : "");
  const [feeStr, setFeeStr] = useState(choice?.kind === "envio" && choice.fee > 0 ? String(choice.fee) : "");

  useEffect(() => {
    if (expanded) onNeedSources();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  const options = useMemo(
    () => pickupStoreOptions(lines, sources, rules.storeId, stores, rules.retiroCrossBranch),
    [lines, sources, rules.storeId, stores, rules.retiroCrossBranch],
  );

  function apply(next: DeliveryChoice) {
    onApply(planForChoice(next, { lines, sources, rules, storeName, customerName }));
  }

  // Los orígenes llegan después de elegir "Retira en otra sucursal": se rearma.
  useEffect(() => {
    if (choice?.kind !== "retiro" || sourcesLoading) return;
    const store = choice.storeId || options.find((o) => o.complete)?.storeId || "";
    if (store !== pickupStore) setPickupStore(store);
    apply({ kind: "retiro", storeId: store, pickupName: choice.pickupName });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourcesLoading, sources]);

  // Cambió el cliente: quién retira por defecto y el domicilio del envío.
  useEffect(() => {
    if (choice?.kind === "retiro") apply(choice);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerName]);
  useEffect(() => {
    if (choice?.kind === "envio" && !address.trim() && customerAddress) {
      setAddress(customerAddress);
      apply({ ...choice, address: customerAddress });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerAddress]);

  function choose(k: DeliveryChoice["kind"]) {
    if (k === "split") {
      onSplit();
      return;
    }
    if (k === "ahora") return apply({ kind: "ahora" });
    if (k === "retiro") {
      const store = pickupStore || options.find((o) => o.complete)?.storeId || "";
      setPickupStore(store);
      return apply({ kind: "retiro", storeId: store, pickupName });
    }
    const addr = address || customerAddress;
    setAddress(addr);
    apply({ kind: "envio", address: addr, fee: shippingFeeOf(feeStr) });
  }

  const fee = choice?.kind === "envio" ? shippingFeeOf(choice.fee) : 0;
  const closedSummary = error
    ? "Falta completar la entrega"
    : kind === "ahora"
      ? "Se lo lleva ahora"
      : `${summary ?? ""}${fee > 0 ? ` · envío ${money(fee)}` : ""}`;

  const opt = (
    k: DeliveryChoice["kind"],
    Icon: LucideIcon,
    label: string,
    detail: string,
    lock: string | null = null,
  ) => {
    const on = kind === k;
    return (
      <button
        type="button"
        role="radio"
        aria-checked={on}
        disabled={Boolean(lock)}
        onClick={() => choose(k)}
        className={cn(
          "flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors",
          lock ? "cursor-not-allowed opacity-60" : "hover:bg-fg-6",
          on && "choice-on",
        )}
      >
        {lock ? (
          <Lock size={15} className="shrink-0 text-muted-foreground" aria-hidden />
        ) : (
          <Icon size={15} className="shrink-0 text-muted-foreground" aria-hidden />
        )}
        <span className="min-w-0 flex-1">
          <span className="block font-medium">{label}</span>
          <span className="block truncate text-xs text-muted-foreground">{lock ?? detail}</span>
        </span>
        {on && <Check size={16} className="shrink-0 text-success" aria-hidden />}
      </button>
    );
  };

  const noStores = !sourcesLoading && options.length === 0;

  return (
    <CheckoutFold
      className="mt-2"
      icon={Truck}
      title="Entrega"
      summary={closedSummary}
      tone={error ? "warning" : undefined}
      open={expanded}
      onToggle={() => setExpanded((o) => !o)}
    >
      <div role="radiogroup" aria-label="Cómo se entrega" className="space-y-1">
        {opt("ahora", PackageCheck, "Se lo lleva ahora", "Todo sale del mostrador")}
        {opt(
          "retiro",
          Store,
          "Retira en otra sucursal",
          "Con el stock de esa sucursal",
          locks.retiro ?? (noStores && kind !== "retiro" ? "No hay otra sucursal con stock para esta venta" : null),
        )}
        {opt("envio", Truck, "Envío a domicilio", "Sale de esta sucursal", locks.envio)}
        {opt("split", Split, "Repartir entrega", "Parte se lleva y parte retira o se envía")}
      </div>

      {kind === "retiro" && (
        <div className="space-y-2">
          {sourcesLoading ? (
            <p className="text-xs text-muted-foreground">Buscando stock en otras sucursales…</p>
          ) : (
            <div>
              <label htmlFor="pickup-store" className="mb-2 block text-sm font-medium text-muted-foreground">
                Sucursal donde retira
              </label>
              <select
                id="pickup-store"
                className={selectCls}
                value={pickupStore}
                onChange={(e) => {
                  setPickupStore(e.target.value);
                  apply({ kind: "retiro", storeId: e.target.value, pickupName });
                }}
              >
                {!pickupStore && <option value="">Elegí una sucursal</option>}
                {options.map((o) => (
                  <option key={o.storeId} value={o.storeId} disabled={!o.complete} className="bg-popover text-popover-foreground">
                    {o.storeName}
                    {o.complete ? " · tiene todo" : ` · falta ${o.missing.join(", ")}`}
                  </option>
                ))}
              </select>
            </div>
          )}
          <Input
            label="Retira a nombre de"
            placeholder={customerName ?? "Nombre y apellido"}
            value={pickupName}
            maxLength={120}
            onChange={(e) => {
              setPickupName(e.target.value);
              apply({ kind: "retiro", storeId: pickupStore, pickupName: e.target.value });
            }}
          />
        </div>
      )}

      {kind === "envio" && (
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_8.5rem]">
          <Input
            label="Domicilio de entrega"
            placeholder="Calle, número, localidad"
            value={address}
            maxLength={300}
            onChange={(e) => {
              setAddress(e.target.value);
              apply({ kind: "envio", address: e.target.value, fee: shippingFeeOf(feeStr) });
            }}
          />
          <Input
            label="Costo de envío"
            inputMode="decimal"
            placeholder="Opcional"
            value={feeStr}
            onChange={(e) => {
              setFeeStr(e.target.value);
              apply({ kind: "envio", address, fee: shippingFeeOf(e.target.value) });
            }}
          />
        </div>
      )}

      {kind === "split" && (
        <div className="flex items-center justify-between gap-2 rounded-lg bg-fg-4 px-3 py-2 text-[13px]">
          <span className="min-w-0 truncate">{summary}</span>
          <Button type="button" variant="ghost" size="sm" className="h-7 shrink-0 px-2 text-xs" onClick={onSplit}>
            Cambiar
          </Button>
        </div>
      )}

      {error && kind !== "ahora" && <p role="status" className="text-xs font-medium text-warning">{error}</p>}
      {kind === "envio" && !error && (
        <p className="text-xs text-muted-foreground">
          Queda en Expedición. Después de cobrar podés hacer el remito.
          {fee > 0 ? " El costo se suma a la venta como renglón Envío." : ""}
        </p>
      )}
    </CheckoutFold>
  );
}
CheckoutDeliveryBlock.displayName = "CheckoutDeliveryBlock";
