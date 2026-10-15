"use client";

// Cobro de un pedido de salón en el POS (F11 · H32, ADR-129): /pos?order=<id>.
// La caja lo levanta (sale_order_take: queda tomado por ella y la reserva
// validada para cobrar), el carrito se carga tal cual lo armó el vendedor
// (mismo formato que una venta pausada, ADR-106) con el vendedor en la hoja de
// cobro, y la venta viaja con {kind: 'reservation', id}: create_sale entrega
// la reserva y el pedido queda cobrado en la misma transacción. Si la reserva
// ya se liberó se cobra sin ella y sale_order_complete enlaza el pedido.
import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/components/ui/Toast";
import type { CheckoutSnapshot } from "@/components/pos/checkout/types";
import { createClient } from "@/lib/supabase/client";
import { orderErrorMessage } from "@/lib/orders/logic";
import { readPausedCart, type PausedCart } from "@/modules/paused-sales/logic";
import { ordersApi, type SaleOrder } from "./api";
import { DISPATCHES_KEY, ORDERS_KEY } from "./hooks";

const RESERVATION_ERRORS = /reservation_(expired|not_open|not_found|not_verified|items_mismatch|wrong_store)/;

export function useOrderOrigin({
  applyCart,
  resetSale,
  offline,
}: {
  applyCart: (c: PausedCart) => void;
  resetSale: () => void;
  offline: boolean;
}) {
  const { toast } = useToast();
  const router = useRouter();
  const qc = useQueryClient();
  const params = useSearchParams();
  const orderId = params.get("order");
  const [order, setOrder] = useState<SaleOrder | null>(null);
  const [checkoutRestore, setCheckoutRestore] = useState<CheckoutSnapshot | null>(null);
  const loadedRef = useRef<string | null>(null);
  const applyRef = useRef(applyCart);
  applyRef.current = applyCart;

  useEffect(() => {
    if (!orderId || loadedRef.current === orderId) return;
    loadedRef.current = orderId;
    if (offline) {
      toast({ title: "Sin conexión no se puede levantar un pedido", variant: "error" });
      router.replace("/pos");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const o = await ordersApi.take(orderId);
        if (cancelled) return;
        const cart = readPausedCart(o.cart);
        if (!cart || cart.lines.length === 0) {
          toast({ title: "Este pedido no guardó el carrito: anulalo y cargalo de nuevo", variant: "error" });
          void ordersApi.leave(o.id).catch(() => null);
          router.replace("/pos");
          return;
        }
        applyRef.current(cart);
        const sellerId = o.checkout && typeof o.checkout === "object" ? (o.checkout.professionalId ?? "") : "";
        setCheckoutRestore(
          sellerId
            ? { v: 1, lines: [], tipPct: null, tipCustom: "", warrantyId: "", warrantyLineId: "", professionalId: sellerId }
            : null,
        );
        setOrder(o);
        void qc.invalidateQueries({ queryKey: ORDERS_KEY });
        if (!o.reservation_active && o.reservation_id) {
          toast({
            title: `Pedido N° ${o.number}: la reserva de stock ya venció`,
            description: "Se cobra igual si hay stock.",
            variant: "warning",
          });
        }
      } catch (e) {
        if (cancelled) return;
        toast({ title: "No se pudo levantar el pedido", description: orderErrorMessage(e), variant: "error" });
        router.replace("/pos");
      }
    })();
    return () => {
      cancelled = true;
    };
    // router y toast son estables.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId, offline]);

  const active = Boolean(order && orderId === order.id);

  function clearState() {
    loadedRef.current = null;
    setOrder(null);
    setCheckoutRestore(null);
  }

  /** Salir sin cobrar: el pedido vuelve a la lista de la caja. */
  function exit() {
    const o = order;
    clearState();
    resetSale();
    router.replace("/pos");
    if (o) {
      void ordersApi
        .leave(o.id)
        .then(() => qc.invalidateQueries({ queryKey: ORDERS_KEY }))
        .catch(() => null);
    }
  }

  /** Después de cobrar: enlace idempotente (con la reserva ya quedó cobrado). */
  function afterSale(saleId: string | null) {
    const o = order;
    if (!o) return;
    clearState();
    router.replace("/pos");
    if (!saleId) return; // Sin conexión: el pedido queda tomado y se enlaza a mano.
    void ordersApi
      .complete(o.id, saleId)
      .then(() => {
        void qc.invalidateQueries({ queryKey: ORDERS_KEY });
        void qc.invalidateQueries({ queryKey: DISPATCHES_KEY });
      })
      .catch((e) =>
        toast({
          title: `La venta se registró, pero el pedido N° ${o.number} no quedó marcado`,
          description: orderErrorMessage(e),
          variant: "error",
        }),
      );
  }

  /**
   * La venta falló por la reserva (venció o el carrito ya no la cubre): se
   * libera y la próxima vez se cobra sin ella (el servidor sigue validando
   * el stock libre).
   */
  function onSaleError(msg: string): boolean {
    const o = order;
    if (!o || !RESERVATION_ERRORS.test(msg)) return false;
    const mismatch = msg.includes("reservation_items_mismatch");
    const release = async () => {
      if (mismatch && o.reservation_id) {
        await createClient().rpc("stock_reservation_cancel" as never, {
          p_id: o.reservation_id,
          p_reason: "Pedido cobrado con cambios en caja",
        } as never);
      }
      setOrder((cur) => (cur ? { ...cur, reservation_active: false } : cur));
    };
    if (mismatch) {
      toast({
        title: "El carrito ya no cubre el pedido reservado",
        description: "Liberá la reserva para cobrar lo que lleva el cliente.",
        variant: "warning",
        duration: 12_000,
        actions: [{ label: "Liberar y seguir", onClick: () => void release().catch(() => null) }],
      });
    } else {
      void release();
      toast({
        title: "La reserva del pedido venció",
        description: "Tocá Cobrar de nuevo: se cobra sin reserva si hay stock.",
        variant: "warning",
      });
    }
    return true;
  }

  return {
    orderId: active ? orderId : null,
    order: active ? order : null,
    active,
    /** Reserva que viaja con la venta (sólo si sigue vigente). */
    reservationId: active && order?.reservation_active ? order.reservation_id : null,
    checkoutRestore: active ? checkoutRestore : null,
    exit,
    afterSale,
    onSaleError,
  };
}
