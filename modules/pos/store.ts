"use client";

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { SaleLineModifierGroup } from "@/modules/products/modifiers";
import type { ServicePeriod } from "@/lib/catalog/mode";
import type { CartSaleUnit } from "@/lib/products/catalogCodes";

export interface CartLine {
  lineId: string; // id local de la línea (estable; soporta ítems sin producto)
  productId: string | null; // null = ítem de monto libre (venta rápida)
  // Categoría del producto (F9 · H53 alcance por categoría): viaja con la línea
  // para que el motor de promociones pueda matchear promos de categoría en el POS.
  // null en ítems sin producto (venta rápida/pack) o si el origen no la trae.
  categoryId?: string | null;
  name: string;
  sku: string | null;
  unitPrice: number;
  quantity: number;
  discount: number; // descuento por línea (monto)
  unit: string; // 'un' por defecto; 'kg' = ítem por peso
  serial?: string | null; // N° de serie (producto serializado)
  variantId?: string | null; // variante (producto con has_variants)
  variantLabel?: string; // ej. "M / Rojo" para mostrar en el carrito
  warrantyMonths?: number; // garantía de fábrica del producto (H28): > 0 ⇒ elegible para garantía extendida
  // Modificadores elegidos (H37): tamaños/sabores/toppings. El unitPrice ya
  // incluye los deltas; este snapshot es para mostrar y persistir en la venta.
  modifiers?: SaleLineModifierGroup[] | null;
  modifiersLabel?: string; // ej. "Frutilla, Crema (+200), Dulce de leche"
  // Pack vendido en esta línea (H41): service_packs.id. La línea entra por su
  // precio; al confirmar, create_sale acredita el saldo de sesiones al cliente.
  packId?: string | null;
  // Línea CUBIERTA por una sesión de pack (H41): customer_pack_credits.id. La
  // línea no se cobra (lineSubtotal = 0) y create_sale consume una sesión. Se
  // conserva unitPrice para mostrar el valor tachado ("cubierto por el pack").
  packCreditId?: string | null;
  // Línea de REGALO por compra (F9 · H54): promotions.id que la generó. Es un
  // producto a $0 que el motor agrega solo al cumplirse las condiciones; se quita
  // sola si el carrito deja de calificar. No editable por el cajero.
  giftPromoId?: string | null;
  // Cambio manual de precio (F18 · H100, ADR-056): el cajero puso otro precio
  // con motivo. listPrice es el precio con el que entró la línea (lista +
  // modificadores); el servidor lo recalcula y pide PIN de 'cambio_precio'
  // según la política. Sin priceOverride, el precio es el de lista.
  priceOverride?: boolean;
  overrideReason?: string | null;
  listPrice?: number | null;
  // Servicios profesionales (ADR-116). undefined = lo del servicio (detalle y
  // aclaraciones por defecto, los completa create_sale); un valor = lo que
  // eligió el cajero para este renglón.
  lineDetail?: string | null;
  clarificationIds?: string[];
  // Aclaración libre del renglón (lote, dirección, N° de muestra, normativa).
  lineNote?: string | null;
  // ADR-151: precio a definir al cobrar. El cajero lo cargó al agregar la
  // línea; el servidor lo acepta porque el producto está en modo libre (no por
  // esta marca) y valida mínimo y máximo. No se reprecia ni se fusiona.
  openPrice?: { min: number | null; max: number | null; suggested: number | null } | null;
  // F24 · H163 (ADR-177): línea vendida por bulto (caja, pack). quantity va en
  // bultos y unitPrice es el precio del bulto; al cobrar se expande a unidades
  // del artículo (expandSaleUnitLine). variantLabel muestra "Caja x 12".
  saleUnit?: CartSaleUnit | null;
}

/** ¿El renglón tiene datos de servicio propios? (no se fusiona con otro). */
export function lineHasServiceEdits(l: CartLine): boolean {
  return Boolean(l.lineNote) || l.lineDetail !== undefined || l.clarificationIds !== undefined;
}

interface CartState {
  lines: CartLine[];
  discountTotal: number; // descuento global (monto)
  // ADR-116: período del servicio y vencimiento del pago (venta con servicios).
  // null = el de hoy.
  servicePeriod: ServicePeriod | null;
  setServicePeriod: (p: ServicePeriod | null) => void;
  // ADR-116: detalle, aclaraciones y nota del renglón.
  setLineService: (
    lineId: string,
    v: { lineDetail?: string | null; clarificationIds?: string[]; lineNote?: string | null },
  ) => void;
  addProduct: (
    p: {
      id: string;
      name: string;
      sku: string | null;
      price: number;
      unit?: string;
      warrantyMonths?: number;
      categoryId?: string | null;
    },
    // Cantidad a sumar (H36: botones de cantidad rápida +1/+2/x6/x12). Default 1.
    qty?: number,
  ) => void;
  addVariant: (p: {
    id: string;
    name: string;
    sku: string | null;
    price: number;
    variantId: string;
    variantLabel: string;
    warrantyMonths?: number;
    categoryId?: string | null;
  }) => void;
  addWeighed: (
    p: { id: string; name: string; sku: string | null; price: number; categoryId?: string | null },
    weight: number,
  ) => void;
  addSerialized: (
    p: {
      id: string;
      name: string;
      sku: string | null;
      price: number;
      warrantyMonths?: number;
      categoryId?: string | null;
    },
    serial: string,
  ) => void;
  // Agrega un producto con modificadores (H37). unitPrice = base + suma de deltas
  // (lo calcula el caller con los modificadores elegidos). No fusiona con otras
  // líneas: cada combinación de modificadores es su propia línea.
  addWithModifiers: (p: {
    id: string;
    name: string;
    sku: string | null;
    price: number; // ya ajustado (base + deltas)
    modifiers: SaleLineModifierGroup[];
    modifiersLabel: string;
    warrantyMonths?: number;
    categoryId?: string | null;
  }) => void;
  addFreeAmount: (p: { name?: string; amount: number }) => void;
  // ADR-151: producto con precio a definir al cobrar. Siempre línea propia.
  addOpenPrice: (
    p: { id: string; name: string; sku: string | null; unit?: string; warrantyMonths?: number; categoryId?: string | null },
    price: number,
    range: { min: number | null; max: number | null; suggested: number | null },
    qty?: number,
  ) => void;
  // ADR-151: cambia el precio cargado de una línea de precio libre (sin motivo).
  setOpenLinePrice: (lineId: string, price: number) => void;
  // Vende un pack (H41): línea por su precio que, al confirmar, acredita las
  // sesiones al cliente (create_sale, extra kind='pack'). Cada pack es su propia
  // línea (no fusiona); cantidad 1.
  addPack: (p: { packId: string; name: string; price: number }) => void;
  // H163: vende el artículo por bulto (unidad de venta con coeficiente). Se
  // fusiona con la línea del mismo bulto.
  addSaleUnit: (
    p: { id: string; name: string; sku: string | null; warrantyMonths?: number; categoryId?: string | null },
    unit: CartSaleUnit,
    packPrice: number,
    qty?: number,
  ) => void;
  // Cubre una línea con una sesión de pack (H41): la línea pasa a precio 0 y se
  // marca con el crédito que la cubre. Al confirmar, create_sale consume una
  // sesión (extra kind='pack_session'). Quitar la cobertura la vuelve a cobrar.
  coverLineWithPack: (lineId: string, packCreditId: string) => void;
  uncoverLine: (lineId: string) => void;
  setQuantity: (lineId: string, quantity: number) => void;
  setLineDiscount: (lineId: string, discount: number) => void;
  // Precio manual de una línea con motivo (ADR-056). Volver al precio de lista
  // (price == listPrice) borra la marca.
  setLinePrice: (lineId: string, price: number, reason: string) => void;
  // Precios que mandó el servidor (price_mismatch): reprecia esas líneas.
  applyServerPrices: (changes: { lineId: string; to: number; saleUnit?: CartSaleUnit }[]) => void;
  removeLine: (lineId: string) => void;
  setDiscountTotal: (amount: number) => void;
  // Reconcilia las líneas de REGALO (F9 · H54) con lo que el motor calcula: agrega
  // las que faltan, actualiza cantidad/producto, y quita las que ya no aplican.
  // Una línea de regalo por promo (identidad por giftPromoId). Las líneas normales
  // no se tocan. unitPrice siempre 0 (es un regalo).
  syncGiftLines: (
    gifts: {
      promoId: string;
      productId: string;
      name: string;
      sku: string | null;
      quantity: number;
    }[],
  ) => void;
  clear: () => void;
  // H159 (ADR-172): de quién es el carrito guardado ("negocio:usuario"). Si
  // entra otra persona u otro negocio en la pestaña, se vacía.
  ownerKey: string | null;
  claimOwner: (key: string) => void;
}

// H159 (ADR-172): el carrito sobrevive a recargar la página (sessionStorage:
// sólo esta pestaña, se borra al cerrarla). Se guardan las líneas y el
// descuento general; el precio lo vuelve a validar el servidor al cobrar.
export const CART_STORAGE_KEY = "ninjapos.cart.v1";

export const useCartStore = create<CartState>()(
  persist(
    (set) => ({
  ownerKey: null,
  claimOwner: (key) =>
    set((state) =>
      state.ownerKey === key
        ? state
        : state.ownerKey === null && state.lines.length === 0
          ? { ownerKey: key }
          : { ownerKey: key, lines: [], discountTotal: 0, servicePeriod: null },
    ),
  lines: [],
  discountTotal: 0,
  servicePeriod: null,
  setServicePeriod: (servicePeriod) => set({ servicePeriod }),
  setLineService: (lineId, v) =>
    set((state) => ({
      lines: state.lines.map((l) => (l.lineId === lineId ? { ...l, ...v } : l)),
    })),
  addProduct: (p, qty = 1) =>
    set((state) => {
      const add = qty > 0 ? qty : 1;
      // Línea sin variante: identidad por producto. No fusiona con líneas de
      // variante del mismo producto (esas llevan variantId).
      const existing = state.lines.find(
        (l) =>
          l.productId === p.id &&
          !l.variantId &&
          l.unit !== "kg" &&
          !l.serial &&
          !l.openPrice &&
          !l.saleUnit &&
          !lineHasServiceEdits(l),
      );
      if (existing) {
        return {
          lines: state.lines.map((l) =>
            l.lineId === existing.lineId ? { ...l, quantity: l.quantity + add } : l,
          ),
        };
      }
      return {
        lines: [
          ...state.lines,
          {
            lineId: crypto.randomUUID(),
            productId: p.id,
            categoryId: p.categoryId ?? null,
            name: p.name,
            sku: p.sku,
            unitPrice: p.price,
            quantity: add,
            discount: 0,
            unit: p.unit ?? "un",
            warrantyMonths: p.warrantyMonths ?? 0,
          },
        ],
      };
    }),
  addVariant: (p) =>
    set((state) => {
      // Identidad de línea por producto + variante: dos variantes distintas del
      // mismo producto son dos líneas separadas.
      const existing = state.lines.find(
        (l) => l.productId === p.id && l.variantId === p.variantId,
      );
      if (existing) {
        return {
          lines: state.lines.map((l) =>
            l.lineId === existing.lineId ? { ...l, quantity: l.quantity + 1 } : l,
          ),
        };
      }
      return {
        lines: [
          ...state.lines,
          {
            lineId: crypto.randomUUID(),
            productId: p.id,
            categoryId: p.categoryId ?? null,
            name: p.name,
            sku: p.sku,
            unitPrice: p.price,
            quantity: 1,
            discount: 0,
            unit: "un",
            variantId: p.variantId,
            variantLabel: p.variantLabel,
            warrantyMonths: p.warrantyMonths ?? 0,
          },
        ],
      };
    }),
  addWeighed: (p, weight) =>
    set((state) => {
      const existing = state.lines.find(
        (l) => l.productId === p.id && l.unit === "kg",
      );
      if (existing) {
        return {
          lines: state.lines.map((l) =>
            l.lineId === existing.lineId
              ? { ...l, quantity: l.quantity + weight }
              : l,
          ),
        };
      }
      return {
        lines: [
          ...state.lines,
          {
            lineId: crypto.randomUUID(),
            productId: p.id,
            categoryId: p.categoryId ?? null,
            name: p.name,
            sku: p.sku,
            unitPrice: p.price,
            quantity: weight,
            discount: 0,
            unit: "kg",
          },
        ],
      };
    }),
  addSerialized: (p, serial) =>
    set((state) => ({
      lines: [
        ...state.lines,
        {
          lineId: crypto.randomUUID(),
          productId: p.id,
          categoryId: p.categoryId ?? null,
          name: p.name,
          sku: p.sku,
          unitPrice: p.price,
          quantity: 1,
          discount: 0,
          unit: "un",
          serial: serial.trim(),
          warrantyMonths: p.warrantyMonths ?? 0,
        },
      ],
    })),
  addWithModifiers: (p) =>
    set((state) => ({
      // Línea propia por selección de modificadores (no fusiona): dos cafés con
      // toppings distintos son dos líneas; el unitPrice ya trae los deltas.
      lines: [
        ...state.lines,
        {
          lineId: crypto.randomUUID(),
          productId: p.id,
          categoryId: p.categoryId ?? null,
          name: p.name,
          sku: p.sku,
          unitPrice: p.price,
          quantity: 1,
          discount: 0,
          unit: "un",
          modifiers: p.modifiers,
          modifiersLabel: p.modifiersLabel,
          warrantyMonths: p.warrantyMonths ?? 0,
        },
      ],
    })),
  addFreeAmount: (p) =>
    set((state) => ({
      lines: [
        ...state.lines,
        {
          lineId: crypto.randomUUID(),
          productId: null,
          name: p.name?.trim() || "Venta rápida",
          sku: null,
          unitPrice: p.amount,
          quantity: 1,
          discount: 0,
          unit: "un",
        },
      ],
    })),
  addOpenPrice: (p, price, range, qty = 1) =>
    set((state) => ({
      lines: [
        ...state.lines,
        {
          lineId: crypto.randomUUID(),
          productId: p.id,
          categoryId: p.categoryId ?? null,
          name: p.name,
          sku: p.sku,
          unitPrice: price,
          quantity: qty > 0 ? qty : 1,
          discount: 0,
          unit: p.unit ?? "un",
          warrantyMonths: p.warrantyMonths ?? 0,
          openPrice: range,
        },
      ],
    })),
  setOpenLinePrice: (lineId, price) =>
    set((state) => ({
      lines: state.lines.map((l) => (l.lineId === lineId && l.openPrice ? { ...l, unitPrice: price } : l)),
    })),
  addPack: (p) =>
    set((state) => ({
      // Pack vendido: ítem libre (sin producto/stock) por su precio, con packId
      // para que create_sale acredite las sesiones. Línea propia (no fusiona).
      lines: [
        ...state.lines,
        {
          lineId: crypto.randomUUID(),
          productId: null,
          name: p.name,
          sku: null,
          unitPrice: p.price,
          quantity: 1,
          discount: 0,
          unit: "un",
          packId: p.packId,
        },
      ],
    })),
  coverLineWithPack: (lineId, packCreditId) =>
    set((state) => ({
      // Cubre la línea con una sesión: fija cantidad 1 (una sesión por visita) y
      // marca el crédito. El precio se conserva (se muestra tachado); el subtotal
      // efectivo lo computa lineSubtotal como 0.
      lines: state.lines.map((l) =>
        l.lineId === lineId
          ? { ...l, packCreditId, quantity: 1, discount: 0 }
          : l,
      ),
    })),
  uncoverLine: (lineId) =>
    set((state) => ({
      lines: state.lines.map((l) =>
        l.lineId === lineId ? { ...l, packCreditId: null } : l,
      ),
    })),
  setQuantity: (lineId, quantity) =>
    set((state) => ({
      lines: state.lines
        .map((l) => (l.lineId === lineId ? { ...l, quantity } : l))
        .filter((l) => l.quantity > 0),
    })),
  setLineDiscount: (lineId, discount) =>
    set((state) => ({
      lines: state.lines.map((l) =>
        l.lineId === lineId ? { ...l, discount } : l,
      ),
    })),
  setLinePrice: (lineId, price, reason) =>
    set((state) => ({
      lines: state.lines.map((l) => {
        // H163: el bulto no cambia de precio a mano (su precio es el del bulto).
        if (l.lineId !== lineId || l.saleUnit) return l;
        // La primera vez, el precio actual de la línea es el de lista.
        const listPrice = l.listPrice ?? l.unitPrice;
        const back = Math.abs(price - listPrice) <= 0.01;
        return back
          ? { ...l, unitPrice: listPrice, priceOverride: false, overrideReason: null, listPrice }
          : { ...l, unitPrice: price, priceOverride: true, overrideReason: reason.trim(), listPrice };
      }),
    })),
  addSaleUnit: (p, unit, packPrice, qty = 1) =>
    set((state) => {
      const add = qty > 0 ? Math.round(qty) : 1;
      const existing = state.lines.find(
        (l) => l.productId === p.id && l.saleUnit?.id === unit.id && !lineHasServiceEdits(l),
      );
      if (existing) {
        return {
          lines: state.lines.map((l) =>
            l.lineId === existing.lineId ? { ...l, quantity: l.quantity + add } : l,
          ),
        };
      }
      return {
        lines: [
          ...state.lines,
          {
            lineId: crypto.randomUUID(),
            productId: p.id,
            categoryId: p.categoryId ?? null,
            name: p.name,
            sku: p.sku,
            unitPrice: packPrice,
            quantity: add,
            discount: 0,
            unit: "un",
            variantLabel: `${unit.label} x ${unit.units}`,
            warrantyMonths: p.warrantyMonths ?? 0,
            saleUnit: unit,
          },
        ],
      };
    }),
  applyServerPrices: (changes) =>
    set((state) => ({
      lines: state.lines.map((l) => {
        const c = l.openPrice ? undefined : changes.find((x) => x.lineId === l.lineId);
        if (!c) return l;
        // H163: en el bulto, el precio del servidor es el unitario.
        return c.saleUnit ? { ...l, unitPrice: c.to, saleUnit: c.saleUnit } : { ...l, unitPrice: c.to, listPrice: c.to };
      }),
    })),
  removeLine: (lineId) =>
    set((state) => ({
      lines: state.lines.filter((l) => l.lineId !== lineId),
    })),
  setDiscountTotal: (amount) => set({ discountTotal: amount }),
  syncGiftLines: (gifts) =>
    set((state) => {
      const desired = new Map(gifts.map((g) => [g.promoId, g]));
      const seen = new Set<string>();
      const next: CartLine[] = [];
      for (const l of state.lines) {
        if (l.giftPromoId) {
          const g = desired.get(l.giftPromoId);
          if (!g) continue; // el carrito dejó de calificar → se quita el regalo
          seen.add(l.giftPromoId);
          next.push({
            ...l,
            productId: g.productId,
            name: g.name,
            sku: g.sku,
            unitPrice: 0,
            quantity: g.quantity,
            discount: 0,
          });
        } else {
          next.push(l);
        }
      }
      // Regalos nuevos (promo que recién empezó a aplicar): al final del carrito.
      for (const g of gifts) {
        if (seen.has(g.promoId)) continue;
        next.push({
          lineId: crypto.randomUUID(),
          productId: g.productId,
          giftPromoId: g.promoId,
          name: g.name,
          sku: g.sku,
          unitPrice: 0,
          quantity: g.quantity,
          discount: 0,
          unit: "un",
        });
      }
      return { lines: next };
    }),
  clear: () => set({ lines: [], discountTotal: 0, servicePeriod: null }),
    }),
    {
      name: CART_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => {
        try {
          return window.sessionStorage;
        } catch {
          return { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
        }
      }),
      partialize: (s) => ({ lines: s.lines, discountTotal: s.discountTotal, ownerKey: s.ownerKey }),
      // Se rehidrata en el POS al montar (evita diferencias con el HTML del servidor).
      skipHydration: true,
    },
  ),
);

export function lineSubtotal(l: CartLine): number {
  // Línea cubierta por una sesión de pack (H41): no se cobra.
  if (l.packCreditId) return 0;
  return l.unitPrice * l.quantity - l.discount;
}
export function cartSubtotal(lines: CartLine[]): number {
  return lines.reduce((acc, l) => acc + lineSubtotal(l), 0);
}
