"use client";

import { useToast } from "@/components/ui/Toast";
import type { CheckoutPayment, PaymentExtra, Promo } from "@/components/pos/checkout/types";
import { appointmentsApi } from "@/modules/agenda/api";
import { buildSaleItemsAndExtras, type SaleArgsLine } from "@/modules/pending-charges/logic";
import { usePosMutations } from "@/modules/pos/hooks";
import type { CartLine } from "@/modules/pos/store";
import { formatCurrency } from "@/lib/utils/format";

// Registro de la venta (create_sale) del POS. Movido tal cual desde la página:
// mismos ítems, extras, packs, promo, cupón, mesa/delivery atómicos y el mismo
// mapeo de errores del server a mensajes.

export function saleErrorTitle(msg: string): string {
  // F17 · H90: turno y sucursal de la caja en uso.
  if (msg.includes("shift_ambiguous")) return "Hay cajas abiertas en varias sucursales: elegí tu caja arriba";
  if (msg.includes("shift_not_open")) return "El turno de esta caja ya se cerró: abrí la caja de nuevo";
  if (msg.includes("store_not_allowed")) return "No tenés acceso a la sucursal de esta caja";
  // F17 · H92/H94 (ADR-049): configuración y stock de la sucursal.
  if (msg.includes("insufficient_stock_branch")) return "No hay stock suficiente en esta sucursal";
  if (msg.includes("payment_method_disabled_in_store"))
    return "Ese medio de pago está apagado en esta sucursal o caja";
  return msg.includes("account_inactive")
    ? "Tu suscripción venció. Renovala para volver a cobrar."
    : msg.includes("coupon_usage_exceeded")
      ? "El cupón alcanzó su límite de usos"
      : msg.includes("coupon_customer_exceeded")
        ? "Este cliente ya usó el cupón el máximo de veces"
        : msg.includes("coupon_needs_customer")
          ? "Elegí un cliente para usar este cupón"
          : msg.includes("coupon_min_amount")
            ? "El carrito no llega al monto mínimo del cupón"
            : msg.includes("coupon_expired")
              ? "El cupón está vencido"
              : msg.includes("coupon_not_yet_valid")
                ? "El cupón todavía no está vigente"
                : msg.includes("coupon_inactive")
                  ? "El cupón está inactivo"
                  : msg.includes("coupon_not_found")
                    ? "El cupón ya no existe"
                    : msg.includes("table_order_not_open")
                      ? "La mesa ya fue cobrada o cerrada"
                      : msg.includes("delivery_order_not_open")
                        ? "El pedido ya fue cobrado o cancelado"
                        : msg.includes("qr_already_charged")
                          ? "Este cobro QR ya fue registrado"
                          : msg.includes("qr_not_allowed")
                            ? "El cobro con QR no está incluido en tu plan"
                            : msg.includes("feature_not_in_plan: descuentos")
                              ? "Los descuentos no están incluidos en tu plan"
                              : msg.includes("feature_not_in_plan: garantias")
                                ? "La garantía extendida no está incluida en tu plan"
                                : msg.includes("feature_not_in_plan: cuenta_corriente")
                                  ? "La cuenta corriente no está incluida en tu plan"
                                  : msg.includes("credit_limit_exceeded")
                                    ? "Supera el límite de cuenta corriente del cliente"
                                    : msg.includes("account_overdue_blocked") || msg.includes("account_blocked")
                                      ? "La cuenta corriente del cliente está bloqueada"
                                    : msg.includes("installments_not_allowed")
                                      ? "Esa cantidad de cuotas no está habilitada"
                                    : msg.includes("override_token_invalid")
                                      ? "La autorización venció o ya se usó: pedila de nuevo"
                                    : msg.includes("override_reason_required")
                                      ? "Escribí el motivo de la autorización"
                                    : msg.includes("account_needs_customer")
                                      ? "La cuenta corriente necesita un cliente"
                                      : msg.includes("insufficient_store_credit")
                                        ? "El cliente no tiene saldo de vale suficiente"
                                        : msg.includes("pack_needs_customer")
                                          ? "Elegí un cliente para vender o usar un pack"
                                          : msg.includes("pack_no_sessions_left")
                                            ? "El pack ya no tiene sesiones disponibles"
                                            : msg.includes("pack_expired")
                                              ? "El pack del cliente está vencido"
                                              : msg.includes("pack_credit_not_found")
                                                ? "No se encontró el saldo de pack del cliente"
                                                : msg.includes("pack_not_found")
                                                  ? "No se encontró el paquete"
                                                  : "No se pudo cobrar";
}

/** Líneas del carrito → líneas de create_sale (sin campos de UI). */
export function cartToSaleLines(lines: CartLine[]): SaleArgsLine[] {
  return lines.map((l) => ({
    productId: l.productId,
    name: l.name,
    serial: l.serial ?? null,
    variantId: l.variantId ?? null,
    modifiers: l.modifiers ?? null,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    discount: l.discount,
    packId: l.packId ?? null,
    packCreditId: l.packCreditId ?? null,
  }));
}

export function usePosSale(ctx: {
  lines: CartLine[];
  discountTotal: number;
  customerId: string | null;
  tableOrderId: string | null;
  deliveryOrderId: string | null;
  appointmentId: string | null;
  salePromo: (p?: Promo | null) => Promo | null;
  couponId: string | null;
  onSuccess: (r: { saleId: string; change: number }) => void;
}) {
  const { toast } = useToast();
  const { sale } = usePosMutations();

  async function handleSale(
    payments: CheckoutPayment[],
    extras?: PaymentExtra[],
    change?: number,
    appliedPromo?: Promo | null,
  ) {
    try {
      // Mismo mapeo que el cobro en espera (ADR-048): la venta diferida es
      // idéntica a la inmediata. Recargo (H27) y garantía (H28) entran como
      // ítem; la propina (H39) va a sales.tip_amount; packs (H41) como extras.
      const { items, extras: saleExtras } = buildSaleItemsAndExtras(cartToSaleLines(ctx.lines), extras);
      const res = await sale.mutateAsync({
        items: items as never,
        payments: payments as never,
        discountTotal: ctx.discountTotal,
        customerId: ctx.customerId,
        extras: saleExtras as never,
        // Mesa (H44) y delivery (H49): create_sale los cierra en la MISMA
        // transacción (FOR UPDATE, sin doble cobro).
        tableOrderId: ctx.tableOrderId ?? null,
        deliveryOrderId: ctx.deliveryOrderId ?? null,
        // Promo (H53/H54): la final de la hoja (puede ser por medio de pago).
        promo: ctx.salePromo(appliedPromo),
        // Cupón (H54): sólo el id; create_sale lo valida, calcula y consume.
        couponId: ctx.couponId,
      });
      // Turno (H38): enlazar la venta y marcarlo 'realizado' (best-effort).
      if (ctx.appointmentId) {
        try {
          await appointmentsApi.linkSale(ctx.appointmentId, res.sale_id);
        } catch (linkErr) {
          console.warn("No se pudo enlazar el turno con la venta:", linkErr);
        }
      }
      toast({
        title: `Venta #${res.number} registrada`,
        description: `Total ${formatCurrency(res.total)}`,
        variant: "success",
      });
      ctx.onSuccess({ saleId: res.sale_id, change: change ?? 0 });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      const title = saleErrorTitle(msg);
      toast({
        title,
        description: title === "No se pudo cobrar" ? msg || undefined : undefined,
        variant: "error",
      });
    }
  }

  return { handleSale, saving: sale.isPending };
}
