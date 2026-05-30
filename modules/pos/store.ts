"use client";

import { create } from "zustand";

export interface CartLine {
  productId: string;
  name: string;
  sku: string | null;
  unitPrice: number;
  quantity: number;
  discount: number; // descuento por línea (monto)
}

interface CartState {
  lines: CartLine[];
  discountTotal: number; // descuento global (monto)
  addProduct: (p: {
    id: string;
    name: string;
    sku: string | null;
    price: number;
  }) => void;
  setQuantity: (productId: string, quantity: number) => void;
  setLineDiscount: (productId: string, discount: number) => void;
  removeLine: (productId: string) => void;
  setDiscountTotal: (amount: number) => void;
  clear: () => void;
}

export const useCartStore = create<CartState>((set) => ({
  lines: [],
  discountTotal: 0,
  addProduct: (p) =>
    set((state) => {
      const existing = state.lines.find((l) => l.productId === p.id);
      if (existing) {
        return {
          lines: state.lines.map((l) =>
            l.productId === p.id ? { ...l, quantity: l.quantity + 1 } : l,
          ),
        };
      }
      return {
        lines: [
          ...state.lines,
          {
            productId: p.id,
            name: p.name,
            sku: p.sku,
            unitPrice: p.price,
            quantity: 1,
            discount: 0,
          },
        ],
      };
    }),
  setQuantity: (productId, quantity) =>
    set((state) => ({
      lines: state.lines
        .map((l) => (l.productId === productId ? { ...l, quantity } : l))
        .filter((l) => l.quantity > 0),
    })),
  setLineDiscount: (productId, discount) =>
    set((state) => ({
      lines: state.lines.map((l) =>
        l.productId === productId ? { ...l, discount } : l,
      ),
    })),
  removeLine: (productId) =>
    set((state) => ({
      lines: state.lines.filter((l) => l.productId !== productId),
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
