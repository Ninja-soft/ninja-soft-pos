// Precio autoritativo del servidor (F18 · H100, ADR-056). PURO.
//
// create_sale (y el trigger de mesas y delivery) rechaza la línea cuyo precio no
// coincide con el de lista (+ modificadores) con el error
//   price_mismatch:{"items":[{"product_id","variant_id","expected","received"}]}
// Acá se lee ese error, se reprecia el carrito y se arma el aviso. Las líneas
// con precio cambiado a mano (priceOverride), los regalos y las cubiertas por un
// pack no se tocan: esas las decide el servidor por su lado. H163: en la línea
// por bulto el servidor manda el precio unitario y se recalcula el del bulto.

import { repriceSaleUnit, type CartSaleUnit } from "@/lib/products/catalogCodes";

export interface PriceMismatch {
  productId: string;
  variantId: string | null;
  expected: number;
  received: number | null;
}

/** Si el error es un price_mismatch, las líneas con su precio esperado; si no, null. */
export function parsePriceMismatch(err: unknown): PriceMismatch[] | null {
  const msg =
    err instanceof Error ? err.message : String((err as { message?: string } | null)?.message ?? err ?? "");
  const at = msg.indexOf("price_mismatch:");
  if (at < 0) return null;
  const raw = msg.slice(at + "price_mismatch:".length).trim();
  try {
    const data = JSON.parse(raw) as { items?: unknown };
    const items = Array.isArray(data.items) ? data.items : [];
    const out: PriceMismatch[] = [];
    for (const it of items as Record<string, unknown>[]) {
      const productId = typeof it.product_id === "string" ? it.product_id : null;
      const expected = Number(it.expected);
      if (!productId || !Number.isFinite(expected)) continue;
      out.push({
        productId,
        variantId: typeof it.variant_id === "string" ? it.variant_id : null,
        expected,
        received: it.received == null ? null : Number(it.received),
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** Línea mínima del carrito que se puede repreciar. */
export interface RepriceableLine {
  lineId: string;
  productId: string | null;
  variantId?: string | null;
  name: string;
  unitPrice: number;
  priceOverride?: boolean;
  giftPromoId?: string | null;
  packCreditId?: string | null;
  /** ADR-151: precio a definir al cobrar: lo decide el servidor por el producto. */
  openPrice?: unknown;
  /** H163: línea por bulto. */
  saleUnit?: CartSaleUnit | null;
}

export interface RepriceChange {
  lineId: string;
  name: string;
  from: number;
  to: number;
  /** H163: el bulto con el precio unitario nuevo. */
  saleUnit?: CartSaleUnit;
}

/**
 * Cambios a aplicar en el carrito: cada línea del producto (y variante) con el
 * precio que manda el servidor. Una línea por cambio (sin duplicar avisos).
 */
export function repriceChanges(lines: RepriceableLine[], mismatches: PriceMismatch[]): RepriceChange[] {
  const out: RepriceChange[] = [];
  for (const l of lines) {
    if (!l.productId || l.priceOverride || l.giftPromoId || l.packCreditId || l.openPrice) continue;
    const m = mismatches.find(
      (x) => x.productId === l.productId && (x.variantId ?? null) === (l.variantId ?? null),
    );
    if (!m) continue;
    if (l.saleUnit) {
      if (Math.abs(m.expected - l.saleUnit.basePrice) <= 0.01) continue;
      const r = repriceSaleUnit(l.saleUnit, m.expected);
      out.push({ lineId: l.lineId, name: l.name, from: l.unitPrice, to: r.to, saleUnit: r.saleUnit });
      continue;
    }
    if (Math.abs(m.expected - l.unitPrice) <= 0.01) continue;
    out.push({ lineId: l.lineId, name: l.name, from: l.unitPrice, to: m.expected });
  }
  return out;
}

/** "El precio de Yerba cambió a $1.250" (o el resumen si son varios). */
export function priceChangedMessage(changes: RepriceChange[], format: (n: number) => string): string {
  if (changes.length === 0) return "Los precios cambiaron: revisá el carrito";
  if (changes.length === 1) return `El precio de ${changes[0]!.name} cambió a ${format(changes[0]!.to)}`;
  return `Cambiaron ${changes.length} precios: revisá el carrito antes de cobrar`;
}

/**
 * Error al cargar un ítem de mesa o delivery (el trigger valida el precio y la
 * venta libre). Título amigable y si hay que refrescar precios.
 */
export function orderItemError(
  err: unknown,
  name: string,
  format: (n: number) => string,
): { title: string; description?: string; refresh: boolean } {
  const mm = parsePriceMismatch(err);
  if (mm && mm.length > 0) {
    return {
      title: `El precio de ${name} cambió a ${format(mm[0]!.expected)}`,
      description: "Actualizamos los precios: volvé a agregarlo.",
      refresh: true,
    };
  }
  const msg = err instanceof Error ? err.message : String((err as { message?: string } | null)?.message ?? "");
  if (msg.includes("free_sale_not_allowed")) {
    return { title: "La venta libre (monto manual) está apagada", refresh: false };
  }
  return { title: "No se pudo agregar", description: msg || undefined, refresh: false };
}

/** Desvío porcentual contra el precio de lista (lo que autoriza el PIN). */
export function priceDeviationPct(listPrice: number, price: number): number {
  if (!(listPrice > 0)) return 100;
  // Hacia arriba a 2 decimales: el token tiene que cubrir lo que calcula el servidor.
  return Math.ceil((Math.abs(price - listPrice) / listPrice) * 10000 - 1e-9) / 100;
}
