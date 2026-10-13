"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/components/ui/Toast";
import type { CheckoutPayment, PaymentExtra, Promo } from "@/components/pos/checkout/types";
import { appointmentsApi } from "@/modules/agenda/api";
import { buildSaleItemsAndExtras, type SaleArgsLine } from "@/modules/pending-charges/logic";
import { usePosMutations } from "@/modules/pos/hooks";
import { usePriceRefresh } from "@/modules/pos/screen/usePriceRefresh";
import type { CartLine } from "@/modules/pos/store";
import { formatCurrency } from "@/lib/utils/format";
import { cardVoucherErrorTitle } from "@/lib/payments/voucherRules";
import { toSalePayments } from "@/modules/pos/api";
import type { OfflineQueueEntry } from "@/lib/pos/offline/queue";
import { isNetworkError, type OfflinePos } from "@/modules/pos/offline/useOfflinePos";

// Registro de la venta (create_sale) del POS. Movido tal cual desde la página:
// mismos ítems, extras, packs, promo, cupón, mesa/delivery atómicos y el mismo
// mapeo de errores del server a mensajes.

export function saleErrorTitle(msg: string): string {
  // F18 · H100 (ADR-056): precio autoritativo y venta libre.
  if (msg.includes("price_mismatch")) return "Los precios cambiaron: revisá el carrito";
  // F9 (ADR-074): el servidor calcula las promociones.
  if (msg.includes("promo_mismatch")) return "Las promociones cambiaron: revisá el total y volvé a cobrar";
  if (msg.includes("promo_gift_invalid")) return "El regalo de la promo ya no corresponde: revisá el carrito";
  if (msg.includes("feature_not_in_plan: promociones")) return "Las promociones no están incluidas en tu plan";
  if (msg.includes("price_override_reason_required")) return "Escribí el motivo del cambio de precio";
  if (msg.includes("free_sale_not_allowed")) return "La venta libre (monto manual) está apagada en esta caja";
  if (msg.includes("free_sale_exceeds_limit")) return "La venta libre supera el tope de tu rol";
  if (msg.includes("modifier_not_found")) return "Una opción elegida ya no existe: volvé a cargar el producto";
  if (msg.includes("invalid_quantity")) return "Hay una línea con cantidad inválida";
  // F17 · H90: turno y sucursal de la caja en uso.
  if (msg.includes("shift_ambiguous")) return "Hay cajas abiertas en varias sucursales: elegí tu caja arriba";
  if (msg.includes("shift_not_open")) return "El turno de esta caja ya se cerró: abrí la caja de nuevo";
  if (msg.includes("store_not_allowed")) return "No tenés acceso a la sucursal de esta caja";
  // ADR-051: caja propia, PIN de supervisor y estado del personal.
  if (msg.includes("shift_not_owned")) return "Esta caja la tiene abierta otra persona: abrí la tuya para cobrar";
  if (msg.includes("no_open_shift")) return "No tenés una caja abierta: abrí la tuya para cobrar";
  if (msg.includes("supervisor_cancelled")) return "Cancelaste la autorización del supervisor";
  if (msg.includes("supervisor_token_invalid")) return "La autorización venció o ya se usó: pedila de nuevo";
  if (msg.includes("supervisor_required")) return "Hace falta la autorización de un supervisor";
  if (msg.includes("staff_suspended") || msg.includes("staff_on_leave") || msg.includes("staff_terminated"))
    return "Tu usuario no está habilitado para vender ahora";
  // F17 · H92/H94 (ADR-049): configuración y stock de la sucursal.
  if (msg.includes("insufficient_stock_branch")) return "No hay stock suficiente en esta sucursal";
  if (msg.includes("payment_method_disabled_in_store"))
    return "Ese medio de pago está apagado en esta sucursal o caja";
  // ADR-055: transferencias.
  if (msg.includes("transfer_reference_required")) return "Cargá el número de operación de la transferencia";
  if (msg.includes("transfer_account_not_available")) return "Esa cuenta de transferencia no está disponible en esta caja";
  // ADR-054: reglas del cupón del posnet (validadas en el servidor).
  if (msg.includes("card_voucher_required") || msg.includes("card_voucher_invalid"))
    return cardVoucherErrorTitle(msg);
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
    giftPromoId: l.giftPromoId ?? null,
    priceOverride: l.priceOverride ?? false,
    overrideReason: l.overrideReason ?? null,
    listPrice: l.listPrice ?? null,
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
  /** hadCash: la venta tuvo un cobro en efectivo (cajón, ADR-063). */
  onSuccess: (r: { saleId: string; change: number; hadCash: boolean }) => void;
  /** Venta offline (ADR-077): cola local, conectividad y reglas. */
  offline?: Pick<OfflinePos, "isOffline" | "saveSale" | "markServerDown"> | null;
  /** La venta quedó guardada sin conexión (ticket provisorio). */
  onOfflineSuccess?: (r: { entry: OfflineQueueEntry; change: number; hadCash: boolean }) => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { sale } = usePosMutations();
  const handlePriceMismatch = usePriceRefresh();

  async function handleSale(
    payments: CheckoutPayment[],
    extras?: PaymentExtra[],
    change?: number,
    appliedPromo?: Promo | null,
  ) {
    const deviceOffline = typeof navigator !== "undefined" && !navigator.onLine;
    if (ctx.offline && (ctx.offline.isOffline || deviceOffline)) {
      await handleOfflineSale(payments, extras, change, appliedPromo);
      return;
    }
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
      ctx.onSuccess({
        saleId: res.sale_id,
        change: change ?? 0,
        hadCash: payments.some((p) => p.method === "cash" && p.amount > 0),
      });
    } catch (e) {
      // ADR-077: no llegó a NinjaSoft. No se guarda sola (pudo haber entrado):
      // el POS pasa a offline y el cajero confirma de nuevo.
      if (ctx.offline && isNetworkError(e)) {
        ctx.offline.markServerDown();
        toast({
          title: "Se cortó la conexión con NinjaSoft",
          description: "Revisá en Ventas si la venta entró. Si no, confirmá de nuevo y se guarda sin conexión.",
          variant: "error",
        });
        return;
      }
      // ADR-056: el servidor mandó otro precio → se reprecia y se avisa.
      if (handlePriceMismatch(e, ctx.lines)) return;
      const msg = e instanceof Error ? e.message : "";
      // Promos que cambiaron (alta, baja, tope de usos): se vuelven a leer.
      if (msg.includes("promo_")) void qc.invalidateQueries({ queryKey: ["promotions"] });
      const title = saleErrorTitle(msg);
      toast({
        title,
        description: title === "No se pudo cobrar" ? msg || undefined : undefined,
        variant: "error",
      });
    }
  }

  // ADR-077: venta sin conexión. Mismo payload que create_sale, a la cola local.
  async function handleOfflineSale(
    payments: CheckoutPayment[],
    extras?: PaymentExtra[],
    change?: number,
    appliedPromo?: Promo | null,
  ) {
    if (!ctx.offline) return;
    const { items, extras: saleExtras } = buildSaleItemsAndExtras(cartToSaleLines(ctx.lines), extras);
    const promo = ctx.salePromo(appliedPromo);
    const promoDisc = promo && promo.discount > 0 ? promo.discount : 0;
    const gross = items.reduce((a, it) => a + it.unit_price * it.quantity - (it.discount ?? 0), 0);
    const total = Math.max(gross - ctx.discountTotal - promoDisc, 0);
    const res = await ctx.offline.saveSale({
      total,
      change: change ?? 0,
      payments,
      extraKinds: saleExtras.map((e) => e.kind),
      anyPriceOverride: ctx.lines.some((l) => l.priceOverride),
      hasServerOrigin: Boolean(ctx.tableOrderId || ctx.deliveryOrderId || ctx.couponId || ctx.appointmentId),
      payload: {
        items: items as unknown as Record<string, unknown>[],
        payments: toSalePayments(payments as never),
        discount_total: ctx.discountTotal,
        customer_id: ctx.customerId,
        notes: null,
        extras: saleExtras as unknown as Record<string, unknown>[],
        promo_discount: promoDisc,
        promo_id: promoDisc > 0 ? (promo?.id ?? null) : null,
        promo_name: promoDisc > 0 ? (promo?.name ?? null) : null,
      },
      lines: items.map((it, i) => ({
        name: it.name ?? ctx.lines[i]?.name ?? "Producto",
        quantity: it.quantity,
        unitPrice: it.unit_price,
        discount: it.discount ?? 0,
      })),
    });
    if (!res.ok) {
      toast({ title: res.message, variant: "error" });
      return;
    }
    toast({
      title: `Venta guardada sin conexión (${res.entry.provisional})`,
      description: `Total ${formatCurrency(res.entry.total)}. Se envía sola cuando vuelve la conexión.`,
      variant: "success",
    });
    ctx.onOfflineSuccess?.({
      entry: res.entry,
      change: change ?? 0,
      hadCash: payments.some((p) => p.method === "cash" && p.amount > 0),
    });
  }

  return { handleSale, saving: sale.isPending };
}
