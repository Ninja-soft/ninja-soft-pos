// Carrito del POS abierto sin conexión (H65, ADR-087). Es una versión
// reducida del POS: productos simples de la foto local al precio de la foto,
// sin variantes, series, modificadores, descuentos, clientes ni promociones.
// Arma el mismo payload de create_sale que la venta offline del POS completo
// (ADR-077) y el servidor revalida todo al sincronizar.

import type { OfflineSaleInput } from "@/modules/pos/offline/useOfflinePos";

export interface ShellProduct {
  id: string;
  name: string;
  price: number;
  unit?: string | null;
  has_variants?: boolean | null;
  is_serialized?: boolean | null;
  is_active?: boolean | null;
}

export interface ShellLine {
  productId: string;
  name: string;
  unitPrice: number;
  quantity: number;
  unit: string;
}

export type ShellMethod = "cash" | "transfer" | "debit" | "credit";

export const SHELL_METHODS: { id: ShellMethod; label: string }[] = [
  { id: "cash", label: "Efectivo" },
  { id: "transfer", label: "Transferencia" },
  { id: "debit", label: "Débito (posnet)" },
  { id: "credit", label: "Crédito (posnet)" },
];

const r2 = (n: number) => Math.round(n * 100) / 100;

/** ¿Se puede vender este producto en el POS sin conexión? null = sí. */
export function shellProductBlock(p: ShellProduct): string | null {
  if (p.is_active === false) return "Producto inactivo";
  if (p.has_variants) return "Tiene variantes: necesita conexión";
  if (p.is_serialized) return "Lleva número de serie: necesita conexión";
  if (!(Number(p.price) > 0)) return "Sin precio";
  return null;
}

export function addShellLine(lines: ShellLine[], p: ShellProduct, qty = 1): ShellLine[] {
  if (shellProductBlock(p)) return lines;
  const i = lines.findIndex((l) => l.productId === p.id);
  if (i >= 0) return lines.map((l, k) => (k === i ? { ...l, quantity: r2(l.quantity + qty) } : l));
  return [...lines, { productId: p.id, name: p.name, unitPrice: Number(p.price), quantity: qty, unit: p.unit ?? "u" }];
}

/** Cantidad nueva (0 o menos quita la línea). Por unidad, entera; por kg, hasta 3 decimales. */
export function setShellQty(lines: ShellLine[], productId: string, qty: number): ShellLine[] {
  if (!Number.isFinite(qty) || qty <= 0) return lines.filter((l) => l.productId !== productId);
  return lines.map((l) =>
    l.productId === productId
      ? { ...l, quantity: l.unit === "kg" ? Math.round(qty * 1000) / 1000 : Math.max(1, Math.round(qty)) }
      : l,
  );
}

export function shellTotal(lines: ShellLine[]): number {
  return r2(lines.reduce((a, l) => a + l.unitPrice * l.quantity, 0));
}

export interface ShellPaymentInput {
  method: ShellMethod;
  /** Efectivo recibido (para el vuelto). */
  received?: number | null;
  reference?: string | null;
  voucher?: { lote: string; cupon: string; autorizacion: string } | null;
}

export type ShellSaleBuild = { ok: true; input: OfflineSaleInput } | { ok: false; message: string };

/** Carrito + cobro → venta offline (mismo payload que el POS completo). */
export function buildShellSale(lines: ShellLine[], pay: ShellPaymentInput): ShellSaleBuild {
  if (lines.length === 0) return { ok: false, message: "El carrito está vacío" };
  const total = shellTotal(lines);
  let change = 0;
  if (pay.method === "cash" && pay.received != null) {
    if (pay.received + 0.001 < total) return { ok: false, message: "El efectivo recibido no alcanza" };
    change = r2(pay.received - total);
  }
  const payment: Record<string, unknown> = { method: pay.method, amount: total };
  if (pay.method === "transfer" && pay.reference?.trim()) payment.reference = pay.reference.trim();
  if (pay.method === "debit" || pay.method === "credit") {
    const v = pay.voucher;
    if (!v || !v.lote.trim() || !v.cupon.trim()) return { ok: false, message: "Cargá el lote y el cupón del posnet" };
    payment.card_voucher = { lote: v.lote.trim(), cupon: v.cupon.trim(), autorizacion: v.autorizacion.trim() };
  }
  const items = lines.map((l) => ({
    product_id: l.productId,
    quantity: l.quantity,
    unit_price: l.unitPrice,
    discount: 0,
  }));
  return {
    ok: true,
    input: {
      total,
      change,
      payments: [
        {
          method: pay.method,
          amount: total,
          card_voucher: (payment.card_voucher as { origen?: string } | undefined) ?? null,
        },
      ],
      extraKinds: [],
      anyPriceOverride: false,
      hasServerOrigin: false,
      payload: {
        items,
        payments: [payment],
        discount_total: 0,
        customer_id: null,
        notes: null,
        extras: [],
        promo_discount: 0,
        promo_id: null,
        promo_name: null,
      },
      lines: lines.map((l) => ({ name: l.name, quantity: l.quantity, unitPrice: l.unitPrice, discount: 0 })),
    },
  };
}
