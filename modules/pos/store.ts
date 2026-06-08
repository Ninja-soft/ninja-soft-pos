"use client";

import { create } from "zustand";
import type { SaleLineModifierGroup } from "@/modules/products/modifiers";

export interface CartLine {
  lineId: string; // id local de la línea (estable; soporta ítems sin producto)
  productId: string | null; // null = ítem de monto libre (venta rápida)
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
}

interface CartState {
  lines: CartLine[];
  discountTotal: number; // descuento global (monto)
  addProduct: (
    p: {
      id: string;
      name: string;
      sku: string | null;
      price: number;
      unit?: string;
      warrantyMonths?: number;
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
  }) => void;
  addWeighed: (
    p: { id: string; name: string; sku: string | null; price: number },
    weight: number,
  ) => void;
  addSerialized: (
    p: { id: string; name: string; sku: string | null; price: number; warrantyMonths?: number },
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
  }) => void;
  addFreeAmount: (p: { name?: string; amount: number }) => void;
  // Vende un pack (H41): línea por su precio que, al confirmar, acredita las
  // sesiones al cliente (create_sale, extra kind='pack'). Cada pack es su propia
  // línea (no fusiona); cantidad 1.
  addPack: (p: { packId: string; name: string; price: number }) => void;
  // Cubre una línea con una sesión de pack (H41): la línea pasa a precio 0 y se
  // marca con el crédito que la cubre. Al confirmar, create_sale consume una
  // sesión (extra kind='pack_session'). Quitar la cobertura la vuelve a cobrar.
  coverLineWithPack: (lineId: string, packCreditId: string) => void;
  uncoverLine: (lineId: string) => void;
  setQuantity: (lineId: string, quantity: number) => void;
  setLineDiscount: (lineId: string, discount: number) => void;
  removeLine: (lineId: string) => void;
  setDiscountTotal: (amount: number) => void;
  clear: () => void;
}

export const useCartStore = create<CartState>((set) => ({
  lines: [],
  discountTotal: 0,
  addProduct: (p, qty = 1) =>
    set((state) => {
      const add = qty > 0 ? qty : 1;
      // Línea sin variante: identidad por producto. No fusiona con líneas de
      // variante del mismo producto (esas llevan variantId).
      const existing = state.lines.find(
        (l) => l.productId === p.id && !l.variantId && l.unit !== "kg" && !l.serial,
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
  removeLine: (lineId) =>
    set((state) => ({
      lines: state.lines.filter((l) => l.lineId !== lineId),
    })),
  setDiscountTotal: (amount) => set({ discountTotal: amount }),
  clear: () => set({ lines: [], discountTotal: 0 }),
}));

export function lineSubtotal(l: CartLine): number {
  // Línea cubierta por una sesión de pack (H41): no se cobra.
  if (l.packCreditId) return 0;
  return l.unitPrice * l.quantity - l.discount;
}
export function cartSubtotal(lines: CartLine[]): number {
  return lines.reduce((acc, l) => acc + lineSubtotal(l), 0);
}
