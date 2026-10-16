"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { Check, Home, Lock, MapPin, PackageCheck, Plus, Split, Store, Truck, UserPlus, UserSearch, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
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
import {
  addressProblem,
  addressWarning,
  formatShipTo,
  shortShipTo,
  zoneFee,
  zoneForLocality,
  type CustomerAddress,
  type GeoAddress,
} from "@/lib/geo/address";
import { useCheckoutCustomerFiscal } from "@/modules/customers/checkoutFiscal";
import { useCustomerAddresses } from "@/modules/geo/api";
import { useDeliveryZones } from "@/modules/delivery/hooks";
import { useFeature } from "@/modules/saas/gating";
import type { FulfillmentState } from "../fulfillment/FulfillmentModal";
import { money } from "../ui/posStyles";
import { CheckoutFold } from "./CheckoutFold";
import { useCheckoutTabs } from "./CheckoutTabs";

const AddressAutocomplete = dynamic(
  () => import("@/components/geo/AddressAutocomplete").then((m) => m.AddressAutocomplete),
  { ssr: false },
);

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
  /** ADR-157: para enviar hace falta el cliente (el buscador y el alta rápida del cobro). */
  onPickCustomer?: () => void;
  onNewCustomer?: () => void;
  /** Total de la venta sin el envío (zonas con envío sin cargo desde un monto). */
  saleTotal?: number;
  offline?: boolean;
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
    /** ADR-157: el envío lleva cliente (el servidor también lo exige). */
    customerId?: string | null;
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
  const address = choice.shipTo && !choice.addressId ? formatShipTo(choice.shipTo) || choice.address : choice.address;
  const info: Record<string, DeliveryInfo> = {
    [envioGroupKey(rules.storeId)]: {
      shipAddress: address,
      notes: choice.notes,
      addressId: choice.addressId ?? null,
      shipTo: choice.shipTo ?? null,
      saveToCustomer: choice.saveToCustomer,
    },
  };
  if (!ctx.customerId) {
    return { choice, state: { allocations, info }, plan: null, error: "Para enviar elegí o cargá un cliente." };
  }
  if (choice.shipTo && !choice.addressId) {
    const problem = addressProblem(choice.shipTo);
    if (problem) return { choice, state: { allocations, info }, plan: null, error: problem };
  }
  const errors = checkAllocations(lines, allocations, rules, info);
  if (errors.length > 0) return { choice, state: { allocations, info }, plan: null, error: errors[0]! };
  const plan = buildPlan(lines, allocations, rules.storeId, info);
  const fee = shippingFeeOf(choice.fee);
  return { choice, state: { allocations, info }, plan: fee > 0 ? { ...plan, shipping_fee: fee } : plan, error: null };
}

/** Selección de la dirección del envío: una guardada, el domicilio cargado o una nueva. */
type AddressPick = { kind: "saved"; id: string } | { kind: "fiscal" } | { kind: "new" };

// Bloque "Entrega" de la hoja de cobro (ADR-146): por defecto se lo lleva
// ahora; atajos para que todo retire en otra sucursal o vaya por envío (con
// costo opcional como renglón) y "Repartir entrega" para partirla
// (FulfillmentModal, ADR-136). Usa el mismo plan y el mismo RPC del servidor.
// ADR-157: en la pestaña Envío el envío pide cliente, ofrece sus direcciones
// guardadas o una nueva con autocompletar y mapa, y sugiere el costo por la
// zona de la localidad.
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
  onPickCustomer,
  onNewCustomer,
  saleTotal = 0,
  offline = false,
}: CheckoutDeliveryProps) {
  const [expanded, setExpanded] = useState(false);
  const tabs = useCheckoutTabs();
  const shown = tabs ? tabs.tab === "envio" : expanded;
  const kind = choice?.kind ?? "ahora";
  const fiscal = useCheckoutCustomerFiscal(customerId, open);
  const customerAddress = fiscal.data?.address?.trim() || "";
  const storeName = (id: string) => stores.find((s) => s.id === id)?.name ?? "Otra sucursal";
  // ADR-157: direcciones con mapa (BASE). Apagada, la dirección es texto.
  const geoOn = useFeature("direcciones_geo") !== false;
  const saved = useCustomerAddresses(customerId, open && kind === "envio" && geoOn);
  const savedList: CustomerAddress[] = useMemo(() => (geoOn ? (saved.data ?? []) : []), [saved.data, geoOn]);
  const zones = useDeliveryZones(false);

  // Borradores de cada atajo (sobreviven a cambiar de opción).
  const [pickupStore, setPickupStore] = useState(choice?.kind === "retiro" ? choice.storeId : "");
  const [pickupName, setPickupName] = useState(choice?.kind === "retiro" ? choice.pickupName : "");
  const [address, setAddress] = useState(choice?.kind === "envio" ? choice.address : "");
  const [feeStr, setFeeStr] = useState(choice?.kind === "envio" && choice.fee > 0 ? String(choice.fee) : "");
  const [feeTouched, setFeeTouched] = useState(false);
  const [pick, setPick] = useState<AddressPick | null>(null);
  const [draft, setDraft] = useState<GeoAddress | null>(null);
  const [saveToCustomer, setSaveToCustomer] = useState(true);
  const [notes, setNotes] = useState(choice?.kind === "envio" ? (choice.notes ?? "") : "");

  useEffect(() => {
    if (shown) onNeedSources();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);

  const options = useMemo(
    () => pickupStoreOptions(lines, sources, rules.storeId, stores, rules.retiroCrossBranch),
    [lines, sources, rules.storeId, stores, rules.retiroCrossBranch],
  );

  function apply(next: DeliveryChoice) {
    onApply(planForChoice(next, { lines, sources, rules, storeName, customerName, customerId }));
  }

  // ── Envío: dirección elegida → choice ──────────────────────────────────────
  const pickedAddress: Partial<GeoAddress> | null =
    pick?.kind === "saved" ? (savedList.find((a) => a.id === pick.id) ?? null) : pick?.kind === "new" ? draft : null;
  const zone = useMemo(
    () => zoneForLocality(zones.data ?? [], pickedAddress?.locality ?? null),
    [zones.data, pickedAddress?.locality],
  );
  const suggestedFee = zone ? zoneFee(zone, saleTotal) : null;

  function envioChoice(p: {
    pick?: AddressPick | null;
    draft?: GeoAddress | null;
    fee?: string;
    save?: boolean;
    notes?: string;
  }): DeliveryChoice {
    const pk = p.pick !== undefined ? p.pick : pick;
    const dr = p.draft !== undefined ? p.draft : draft;
    const sv = p.save ?? saveToCustomer;
    const fee = shippingFeeOf(p.fee ?? feeStr);
    const nt = p.notes ?? notes;
    if (pk?.kind === "saved") {
      const a = savedList.find((x) => x.id === pk.id);
      return { kind: "envio", address: formatShipTo(a), fee, addressId: pk.id, notes: nt };
    }
    if (pk?.kind === "new" && !geoOn) return { kind: "envio", address: address, fee, notes: nt };
    if (pk?.kind === "new") {
      return { kind: "envio", address: formatShipTo(dr), fee, shipTo: dr ?? null, saveToCustomer: sv, notes: nt };
    }
    if (pk?.kind === "fiscal") return { kind: "envio", address: customerAddress, fee, notes: nt };
    return { kind: "envio", address: address, fee, notes: nt };
  }

  /** Lo que conviene elegir al entrar al envío o al cambiar de cliente. */
  function defaultPick(): AddressPick {
    const def = savedList.find((a) => a.is_default) ?? savedList[0];
    if (def) return { kind: "saved", id: def.id };
    if (customerAddress) return { kind: "fiscal" };
    return { kind: "new" };
  }

  // Llegaron las direcciones o cambió el cliente: la predeterminada.
  useEffect(() => {
    if (choice?.kind !== "envio" || saved.isLoading) return;
    const stillThere = pick?.kind === "saved" ? savedList.some((a) => a.id === pick.id) : pick?.kind === "new" ? true : pick?.kind === "fiscal" ? Boolean(customerAddress) : false;
    if (stillThere) return;
    const next = defaultPick();
    setPick(next);
    apply(envioChoice({ pick: next }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId, savedList, saved.isLoading, customerAddress]);

  // Costo sugerido por la zona (si no lo escribió a mano).
  useEffect(() => {
    if (choice?.kind !== "envio" || feeTouched || suggestedFee == null) return;
    const next = suggestedFee > 0 ? String(suggestedFee) : "";
    if (next === feeStr) return;
    setFeeStr(next);
    apply(envioChoice({ fee: next }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestedFee, zone?.id]);

  // Los orígenes llegan después de elegir "Retira en otra sucursal": se rearma.
  useEffect(() => {
    if (choice?.kind !== "retiro" || sourcesLoading) return;
    const store = choice.storeId || options.find((o) => o.complete)?.storeId || "";
    if (store !== pickupStore) setPickupStore(store);
    apply({ kind: "retiro", storeId: store, pickupName: choice.pickupName });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourcesLoading, sources]);

  // Cambió el cliente: quién retira por defecto y el envío (que lo exige).
  useEffect(() => {
    if (choice?.kind === "retiro") apply(choice);
    if (choice?.kind === "envio") apply(envioChoice({}));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerName, customerId]);

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
    const next = pick ?? (saved.isLoading ? null : defaultPick());
    setPick(next);
    if (!next && customerAddress && !address) setAddress(customerAddress);
    apply(envioChoice({ pick: next }));
  }

  const fee = choice?.kind === "envio" ? shippingFeeOf(choice.fee) : 0;
  const envioText = choice?.kind === "envio" ? (shortShipTo(choice.shipTo) || choice.address) : "";
  const closedSummary = error
    ? "Falta completar la entrega"
    : kind === "ahora"
      ? "Se lo lleva ahora"
      : kind === "envio"
        ? `Envío${envioText ? ` a ${envioText}` : ""}${fee > 0 ? ` · ${money(fee)}` : ""}`
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

  const addrChip = (p: AddressPick, Icon: LucideIcon, title: string, detail: string | null) => {
    const on =
      pick?.kind === p.kind && (p.kind !== "saved" || (pick?.kind === "saved" && pick.id === p.id));
    return (
      <button
        key={p.kind === "saved" ? p.id : p.kind}
        type="button"
        role="radio"
        aria-checked={on}
        onClick={() => {
          setPick(p);
          setFeeTouched(false);
          apply(envioChoice({ pick: p }));
        }}
        className={cn(
          "flex min-h-11 w-full items-center gap-2.5 rounded-lg border border-border px-3 py-2 text-left text-sm transition-colors hover:bg-fg-6",
          on && "choice-on",
        )}
      >
        <Icon size={15} className="shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{title}</span>
          {detail && <span className="block truncate text-xs text-muted-foreground">{detail}</span>}
        </span>
        {on && <Check size={16} className="shrink-0 text-success" aria-hidden />}
      </button>
    );
  };

  const noStores = !sourcesLoading && options.length === 0;
  const warn = pick?.kind === "new" ? addressWarning(draft) : null;

  return (
    <CheckoutFold
      className="mt-2"
      icon={Truck}
      title="Entrega"
      summary={closedSummary}
      tone={error ? "warning" : undefined}
      open={expanded}
      onToggle={() => setExpanded((o) => !o)}
      tab="envio"
    >
      {tabs && <h3 className="font-display text-lg font-bold tracking-tight">¿Cómo se entrega?</h3>}
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

      {kind === "envio" && !customerId && (
        <div className="space-y-2.5 rounded-lg bg-warning/10 px-3 py-3">
          <p className="text-sm font-medium">Para enviar, elegí el cliente</p>
          <p className="text-xs text-muted-foreground">Con el cliente quedan su teléfono y sus direcciones para la próxima.</p>
          <div className="grid grid-cols-2 gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={onPickCustomer} disabled={!onPickCustomer}>
              <UserSearch size={15} aria-hidden /> Elegir cliente
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={onNewCustomer} disabled={!onNewCustomer || offline}>
              <UserPlus size={15} aria-hidden /> Nuevo cliente
            </Button>
          </div>
        </div>
      )}

      {kind === "envio" && customerId && (
        <div className="space-y-3">
          <div role="radiogroup" aria-label="Dirección de entrega" className="space-y-1.5">
            <p className="text-sm font-medium text-muted-foreground">Dirección de {customerName ?? "el cliente"}</p>
            {saved.isLoading && <p className="text-xs text-muted-foreground">Buscando sus direcciones…</p>}
            {savedList.map((a) =>
              addrChip(
                { kind: "saved", id: a.id },
                MapPin,
                `${a.label ? `${a.label} · ` : ""}${shortShipTo(a)}`,
                [a.locality, a.is_default ? "Predeterminada" : null].filter(Boolean).join(" · ") || null,
              ),
            )}
            {customerAddress && addrChip({ kind: "fiscal" }, Home, "Domicilio cargado", customerAddress)}
            {addrChip({ kind: "new" }, Plus, "Otra dirección", "Buscala o marcala en el mapa")}
          </div>

          {pick?.kind === "new" && !geoOn && (
            <Input
              label="Domicilio de entrega"
              placeholder="Calle, número, localidad"
              value={address}
              maxLength={300}
              onChange={(e) => {
                setAddress(e.target.value);
                apply({ kind: "envio", address: e.target.value, fee: shippingFeeOf(feeStr), notes });
              }}
            />
          )}
          {pick?.kind === "new" && geoOn && (
            <div className="space-y-2">
              <AddressAutocomplete
                value={draft}
                autoFocus={!draft}
                onChange={(a) => {
                  setDraft(a);
                  setFeeTouched(false);
                  apply(envioChoice({ draft: a }));
                }}
              />
              {warn && <p className="text-xs text-warning">{warn}</p>}
              <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm">
                <Checkbox
                  checked={saveToCustomer}
                  aria-label="Guardar en el cliente para la próxima"
                  onCheckedChange={(v) => {
                    setSaveToCustomer(v);
                    apply(envioChoice({ save: v }));
                  }}
                />
                Guardar en el cliente para la próxima
              </label>
            </div>
          )}

          <div className="grid gap-2 sm:grid-cols-[10rem_minmax(0,1fr)]">
            <Input
              label="Costo de envío"
              inputMode="decimal"
              placeholder="Sin cargo"
              value={feeStr}
              hint={
                zone
                  ? `Zona ${zone.name}${suggestedFee === 0 && zone.free_from ? ": sin cargo por el monto" : ""}`
                  : undefined
              }
              onChange={(e) => {
                setFeeStr(e.target.value);
                setFeeTouched(true);
                apply(envioChoice({ fee: e.target.value }));
              }}
            />
            <Input
              label="Notas para el repartidor"
              placeholder="Horario, timbre, quién recibe"
              value={notes}
              maxLength={300}
              onChange={(e) => {
                setNotes(e.target.value);
                apply(envioChoice({ notes: e.target.value }));
              }}
            />
          </div>
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
          Queda en Expedición con la dirección y el mapa. Después de cobrar podés hacer el remito.
          {fee > 0 ? " El costo se suma a la venta como renglón Envío." : ""}
        </p>
      )}
    </CheckoutFold>
  );
}
CheckoutDeliveryBlock.displayName = "CheckoutDeliveryBlock";
