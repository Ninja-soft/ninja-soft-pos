// Entregas de una venta (ADR-136). PURO: sin React ni Supabase.
//
// El POS arma un reparto por renglón: cuántas unidades salen de dónde (salón,
// un depósito vendible de la sucursal o un depósito o salón de otra sucursal
// habilitado para esta) y cómo se entregan (se lo lleva ahora, retira en una
// sucursal o envío). Las asignaciones se agrupan en entregas (una por
// modalidad, origen y lugar de retiro) y viajan a pos_sale_create_fulfilled,
// que valida lo mismo en el servidor (espejo de sus reglas).
import { roleErrorMessage } from "@/lib/permissions/errors";

export type FulfillmentMode = "ahora" | "retiro" | "envio";

export const FULFILLMENT_MODE_LABEL: Record<FulfillmentMode, string> = {
  ahora: "Se lo lleva ahora",
  retiro: "Retira en sucursal",
  envio: "Envío a domicilio",
};

/** Máximo de entregas por venta (igual que el servidor). */
export const MAX_DELIVERIES = 10;

/** Fila de warehouse_sources: desde dónde se puede vender un producto. */
export interface FulfillmentSource {
  product_id: string;
  variant_id: string | null;
  store_id: string;
  store_name: string;
  /** null = salón de una sucursal sin depósitos cargados. */
  warehouse_id: string | null;
  warehouse_name: string;
  kind: string;
  own_store: boolean;
  sale_priority: number;
  available: number;
}

/** Renglón del carrito agrupado por producto y variante. */
export interface FulfillmentLine {
  key: string;
  productId: string;
  variantId: string | null;
  name: string;
  quantity: number;
  /** Kits y productos sin control de stock sólo salen del salón propio. */
  localOnly: boolean;
}

export interface Allocation {
  id: string;
  key: string;
  qty: number;
  sourceStoreId: string;
  /** null = salón de la sucursal de origen. */
  sourceWarehouseId: string | null;
  mode: FulfillmentMode;
  /** Retiro: dónde retira (por defecto, la sucursal de origen). */
  fulfillmentStoreId: string | null;
}

/** Datos de cada entrega (por grupo). */
export interface DeliveryInfo {
  pickupName?: string;
  shipAddress?: string;
  notes?: string;
}

export interface DeliveryGroup {
  groupKey: string;
  mode: FulfillmentMode;
  originStoreId: string;
  fulfillmentStoreId: string;
  allocations: Allocation[];
}

export interface FulfillmentRules {
  /** Sucursal del turno (la que vende). */
  storeId: string;
  /** order_config: retiro y envío habilitados (y expedición en el plan). */
  retiroEnabled: boolean;
  envioEnabled: boolean;
  /** order_config.delivery_types.retiro.cross_branch: retirar en otra sucursal que la de origen. */
  retiroCrossBranch: boolean;
}

export interface PlanPayload {
  deliveries: {
    mode: FulfillmentMode;
    fulfillment_store_id: string | null;
    pickup_name: string | null;
    ship_address: string | null;
    notes: string | null;
    items: {
      product_id: string;
      variant_id: string | null;
      qty: number;
      source_store_id: string;
      source_warehouse_id: string | null;
    }[];
  }[];
}

export function lineKey(productId: string, variantId: string | null | undefined): string {
  return `${productId}|${variantId ?? ""}`;
}

/** Renglones del carrito (con producto, sin servicios) sumados por producto y variante. */
export function fulfillmentLines(
  lines: { productId: string | null; variantId?: string | null; name: string; variantLabel?: string | null; quantity: number }[],
  info: (productId: string) => { service: boolean; localOnly: boolean } | null,
): FulfillmentLine[] {
  const map = new Map<string, FulfillmentLine>();
  for (const l of lines) {
    if (!l.productId) continue;
    const meta = info(l.productId);
    if (!meta || meta.service) continue;
    const key = lineKey(l.productId, l.variantId ?? null);
    const cur = map.get(key);
    if (cur) cur.quantity = round3(cur.quantity + Number(l.quantity || 0));
    else
      map.set(key, {
        key,
        productId: l.productId,
        variantId: l.variantId ?? null,
        name: l.variantLabel ? `${l.name} (${l.variantLabel})` : l.name,
        quantity: round3(Number(l.quantity || 0)),
        localOnly: meta.localOnly,
      });
  }
  return [...map.values()].filter((l) => l.quantity > 0);
}

/** Orígenes de un renglón, en el orden en que conviene tomarlos. */
export function sourcesFor(sources: FulfillmentSource[], line: Pick<FulfillmentLine, "productId" | "variantId" | "localOnly">): FulfillmentSource[] {
  return sources
    .filter((s) => s.product_id === line.productId && (s.variant_id ?? null) === (line.variantId ?? null))
    .filter((s) => !line.localOnly || (s.own_store && s.kind === "principal"))
    .sort(
      (a, b) =>
        Number(b.own_store) - Number(a.own_store) ||
        Number(b.kind === "principal" && b.own_store) - Number(a.kind === "principal" && a.own_store) ||
        a.sale_priority - b.sale_priority ||
        Number(b.available) - Number(a.available) ||
        a.store_name.localeCompare(b.store_name, "es"),
    );
}

let seq = 0;
const newId = () => `a${++seq}-${Math.random().toString(36).slice(2, 7)}`;

/**
 * Reparto sugerido: el salón propio primero, después los depósitos vendibles
 * de la sucursal (por prioridad) y por último las otras sucursales (retiro en
 * esa sucursal). Lo que no alcanza queda en el salón propio (el servidor
 * decide si se puede vender sin stock).
 */
export function suggestAllocations(lines: FulfillmentLine[], sources: FulfillmentSource[], storeId: string): Allocation[] {
  const out: Allocation[] = [];
  for (const line of lines) {
    let need = line.quantity;
    for (const s of sourcesFor(sources, line)) {
      if (need <= 0) break;
      const avail = Math.max(Number(s.available) || 0, 0);
      if (avail <= 0) continue;
      const qty = round3(Math.min(need, avail));
      need = round3(need - qty);
      out.push(allocationFrom(line.key, qty, s, storeId));
    }
    if (need > 0) {
      const own = out.find((a) => a.key === line.key && a.sourceStoreId === storeId && a.sourceWarehouseId === null && a.mode === "ahora");
      if (own) own.qty = round3(own.qty + need);
      else
        out.push({ id: newId(), key: line.key, qty: need, sourceStoreId: storeId, sourceWarehouseId: null, mode: "ahora", fulfillmentStoreId: null });
    }
  }
  return out;
}

function allocationFrom(key: string, qty: number, s: FulfillmentSource, storeId: string): Allocation {
  const own = s.store_id === storeId;
  return {
    id: newId(),
    key,
    qty,
    sourceStoreId: s.store_id,
    sourceWarehouseId: own && s.kind === "principal" ? null : s.warehouse_id,
    mode: own ? "ahora" : "retiro",
    fulfillmentStoreId: own ? null : s.store_id,
  };
}

/** Todo sale del salón propio y se lleva ahora: no hace falta un plan (venta normal). */
export function isTrivialPlan(allocations: Allocation[], storeId: string): boolean {
  return allocations.every((a) => a.mode === "ahora" && a.sourceStoreId === storeId && a.sourceWarehouseId === null);
}

/** Clave de la entrega: modalidad, origen y lugar de retiro. */
export function groupKeyOf(a: Allocation): string {
  const ful = a.mode === "retiro" ? (a.fulfillmentStoreId ?? a.sourceStoreId) : a.mode === "envio" ? a.sourceStoreId : "";
  return `${a.mode}|${a.sourceStoreId}|${ful}`;
}

/** Agrupa las asignaciones en entregas ("ahora" primero). */
export function groupDeliveries(allocations: Allocation[], storeId: string): DeliveryGroup[] {
  const map = new Map<string, DeliveryGroup>();
  for (const a of allocations) {
    if (!(a.qty > 0)) continue;
    const k = groupKeyOf(a);
    let g = map.get(k);
    if (!g) {
      g = {
        groupKey: k,
        mode: a.mode,
        originStoreId: a.sourceStoreId,
        fulfillmentStoreId:
          a.mode === "retiro" ? (a.fulfillmentStoreId ?? a.sourceStoreId) : a.mode === "envio" ? a.sourceStoreId : storeId,
        allocations: [],
      };
      map.set(k, g);
    }
    g.allocations.push(a);
  }
  return [...map.values()].sort((x, y) => Number(y.mode === "ahora") - Number(x.mode === "ahora"));
}

/**
 * Errores que el servidor rechazaría (mensajes en criollo). Del lado del POS
 * la suma de cada renglón tiene que dar exacto lo vendido.
 */
export function checkAllocations(
  lines: FulfillmentLine[],
  allocations: Allocation[],
  rules: FulfillmentRules,
  info: Record<string, DeliveryInfo> = {},
): string[] {
  const errors: string[] = [];
  for (const line of lines) {
    const mine = allocations.filter((a) => a.key === line.key);
    if (mine.some((a) => !(a.qty > 0))) errors.push(`${line.name}: cada parte tiene que tener una cantidad mayor que 0.`);
    const sum = round3(mine.reduce((t, a) => t + (Number(a.qty) || 0), 0));
    if (sum !== round3(line.quantity)) {
      errors.push(`${line.name}: repartiste ${fmt(sum)} de ${fmt(line.quantity)}.`);
    }
    if (line.localOnly && mine.some((a) => a.sourceStoreId !== rules.storeId || a.sourceWarehouseId !== null)) {
      errors.push(`${line.name}: los combos y lo que no controla stock salen del salón de esta sucursal.`);
    }
  }
  for (const a of allocations) {
    if (a.mode === "ahora" && a.sourceStoreId !== rules.storeId) errors.push("Lo que sale de otra sucursal no se lo lleva ahora: elegí retiro o envío.");
    if (a.mode === "retiro" && !rules.retiroEnabled) errors.push("El retiro en sucursal está apagado en Configuración.");
    if (a.mode === "envio" && !rules.envioEnabled) errors.push("El envío está apagado en Configuración.");
    if (a.mode === "retiro" && (a.fulfillmentStoreId ?? a.sourceStoreId) !== a.sourceStoreId && !rules.retiroCrossBranch) {
      errors.push("Retirar en otra sucursal que la de origen está apagado en Configuración.");
    }
  }
  const groups = groupDeliveries(allocations, rules.storeId);
  if (groups.length > MAX_DELIVERIES) errors.push(`Hasta ${MAX_DELIVERIES} entregas por venta.`);
  for (const g of groups) {
    if (g.mode === "envio" && (info[g.groupKey]?.shipAddress ?? "").trim().length < 5) {
      errors.push("Cargá el domicilio de cada envío.");
    }
  }
  return [...new Set(errors)];
}

/** Payload de pos_sale_create_fulfilled. */
export function buildPlan(
  lines: FulfillmentLine[],
  allocations: Allocation[],
  storeId: string,
  info: Record<string, DeliveryInfo> = {},
): PlanPayload {
  const byKey = new Map(lines.map((l) => [l.key, l]));
  return {
    deliveries: groupDeliveries(allocations, storeId).map((g) => {
      const i = info[g.groupKey] ?? {};
      return {
        mode: g.mode,
        fulfillment_store_id: g.mode === "retiro" ? g.fulfillmentStoreId : null,
        pickup_name: g.mode === "retiro" ? (i.pickupName?.trim() || null) : null,
        ship_address: g.mode === "envio" ? (i.shipAddress?.trim() || null) : null,
        notes: i.notes?.trim() || null,
        items: g.allocations
          .filter((a) => byKey.has(a.key))
          .map((a) => {
            const l = byKey.get(a.key)!;
            return {
              product_id: l.productId,
              variant_id: l.variantId,
              qty: round3(a.qty),
              source_store_id: a.sourceStoreId,
              source_warehouse_id: a.sourceWarehouseId,
            };
          }),
      };
    }),
  };
}

/** "2 se lleva ahora · 3 retira en Norte" (resumen corto para la barra del POS). */
export function planSummary(groups: DeliveryGroup[], storeName: (id: string) => string): string {
  return groups
    .map((g) => {
      const units = fmt(round3(g.allocations.reduce((t, a) => t + a.qty, 0)));
      if (g.mode === "ahora") return `${units} se lleva ahora`;
      if (g.mode === "envio") return `${units} por envío desde ${storeName(g.originStoreId)}`;
      return `${units} retira en ${storeName(g.fulfillmentStoreId)}`;
    })
    .join(" · ");
}

/** "Norte · Depósito" o "Salón de ventas" (origen en el selector). */
export function sourceLabel(s: Pick<FulfillmentSource, "store_name" | "warehouse_name" | "own_store" | "kind">): string {
  if (s.own_store) return s.kind === "principal" ? "Salón de ventas" : s.warehouse_name;
  return s.kind === "principal" ? `${s.store_name} · Salón` : `${s.store_name} · ${s.warehouse_name}`;
}

/** ¿Algún renglón no alcanza en el salón propio? (para ofrecer otras sucursales). */
export function shortInSalon(lines: FulfillmentLine[], sources: FulfillmentSource[]): FulfillmentLine[] {
  return lines.filter((l) => {
    const salon = sources.find(
      (s) => s.product_id === l.productId && (s.variant_id ?? null) === l.variantId && s.own_store && s.kind === "principal",
    );
    return !l.localOnly && (Number(salon?.available ?? 0) < l.quantity);
  });
}

const ERROR_MESSAGES: [RegExp, string][] = [
  [/feature_not_in_plan: entregas_remitos/, "Tu plan no incluye vender de otras sucursales ni partir entregas."],
  [/feature_not_in_plan: stock_sucursales/, "Vender stock de otra sucursal pide el stock por sucursal."],
  [/feature_not_in_plan: depositos/, "Vender desde un depósito pide los depósitos internos."],
  [/feature_not_in_plan: pedidos_despacho/, "El retiro y el envío pasan por Expedición, que no está en tu plan."],
  [/delivery_qty_mismatch/, "Las entregas suman más de lo vendido: revisá el reparto."],
  [/delivery_item_not_in_sale/, "Una entrega tiene un producto que no está en la venta."],
  [/delivery_mixed_origin/, "Cada entrega sale de una sola sucursal."],
  [/delivery_empty|invalid_qty/, "Revisá las cantidades de cada entrega."],
  [/ahora_requires_local/, "Lo que sale de otra sucursal no se lo lleva ahora: elegí retiro o envío."],
  [/source_not_sellable/, "Ese depósito no está habilitado para la venta."],
  [/source_not_available/, "Ese depósito no está habilitado para esta sucursal."],
  [/insufficient_source_stock: (.+)/, "No alcanza el stock en el origen elegido ($1). Actualizá y volvé a repartir."],
  [/insufficient_source_stock/, "No alcanza el stock en el origen elegido. Actualizá y volvé a repartir."],
  [/kit_cross_store/, "Los combos y lo que no controla stock salen del salón de esta sucursal."],
  [/ship_address_required/, "Cargá el domicilio de cada envío."],
  [/pickup_name_required/, "Cargá quién retira (o elegí un cliente)."],
  [/cross_branch_not_allowed/, "Retirar en otra sucursal que la de origen está apagado en Configuración."],
  [/delivery_type_disabled/, "Ese tipo de entrega está apagado en Configuración."],
  [/fulfillment_not_for_orders/, "Las mesas, el delivery y los pedidos de salón no se parten desde acá."],
  [/variant_required/, "Elegí la variante (talle o color)."],
  [/invalid_plan|invalid_delivery_mode/, "El reparto de entregas no es válido: volvé a armarlo."],
];

/** Mensaje de un error del plan (null si no es del plan: lo traduce el cobro). */
export function fulfillmentErrorMessage(e: unknown): string | null {
  const msg =
    e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e ?? "");
  for (const [re, text] of ERROR_MESSAGES) {
    const m = msg.match(re);
    if (m) return text.replace("$1", (m[1] ?? "").trim());
  }
  return roleErrorMessage(msg) ?? null;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toLocaleString("es-AR", { maximumFractionDigits: 3 });
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
