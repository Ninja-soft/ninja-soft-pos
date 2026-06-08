"use client";

import { create } from "zustand";

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
  addFreeAmount: (p: { name?: string; amount: number }) => void;
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
  return l.unitPrice * l.quantity - l.discount;
}
export function cartSubtotal(lines: CartLine[]): number {
  return lines.reduce((acc, l) => acc + lineSubtotal(l), 0);
}
