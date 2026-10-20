"use client";

// F24 · H159 (ADR-172): lo que el cajero saca del carrito antes de cobrar
// (un renglón o todo) queda en la auditoría y, si el negocio encendió la
// acción "cart_remove", pide PIN de supervisor desde el monto configurado. El
// servidor decide (log_cart_removal): si pide supervisor, se pide el PIN y se
// reintenta. Sin conexión no se frena la venta: se saca igual.

import { posApi } from "@/modules/pos/api";
import { SupervisorCancelled, withSupervisor } from "@/modules/security/supervisor";
import { supervisorRequiredAction } from "@/lib/security/pinPolicy";
import { lineSubtotal, type CartLine } from "@/modules/pos/store";

export type CartRemovalResult = "ok" | "cancelled" | "denied";

export function removalItems(lines: CartLine[]): { name: string; quantity: number; amount: number }[] {
  return lines.map((l) => ({
    name: l.variantLabel ? `${l.name} (${l.variantLabel})` : l.name,
    quantity: l.quantity,
    amount: Math.round(lineSubtotal(l) * 100) / 100,
  }));
}

export async function guardCartRemoval(
  kind: "line" | "clear",
  lines: CartLine[],
  registerId: string | null,
): Promise<CartRemovalResult> {
  const items = removalItems(lines);
  const amount = Math.round(items.reduce((a, i) => a + i.amount, 0) * 100) / 100;
  if (items.length === 0) return "ok";
  try {
    await withSupervisor(() => posApi.logCartRemoval(kind, items, amount, registerId), { cart_remove: amount });
    return "ok";
  } catch (e) {
    if (e instanceof SupervisorCancelled) return "cancelled";
    // El supervisor no autorizó (PIN mal, sin permiso): no se saca.
    if (supervisorRequiredAction(e) || /supervisor_|forbidden/.test(e instanceof Error ? e.message : "")) return "denied";
    // Error de red u otro: la venta no se frena.
    return "ok";
  }
}
