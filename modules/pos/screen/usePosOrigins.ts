"use client";

import { useEffect, useMemo, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useToast } from "@/components/ui/Toast";
import { useAppointment } from "@/modules/agenda/hooks";
import { useCustomerLastSaleItems } from "@/modules/customers/hooks";
import { useTableOrder, useTableOrderItems } from "@/modules/dining/hooks";
import { useDeliveryOrder, useDeliveryOrderItems } from "@/modules/delivery/hooks";
import { productsApi } from "@/modules/products/api";
import { useCartStore } from "@/modules/pos/store";

// Orígenes de una venta del POS además del mostrador: cobro de turno (H38),
// recompra (H40), mesa (H44) y delivery (H49). Cada uno carga sus ítems en el
// carrito UNA sola vez y expone su salida. Lógica movida tal cual desde la
// página del POS (sin cambios de negocio).

type Customer = { id: string; name: string } | null;

export function usePosOrigins({
  setCustomer,
  priceFor,
}: {
  setCustomer: (c: Customer) => void;
  priceFor: (productId: string, variantId: string | null, basePrice: number) => number;
}) {
  const { toast } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  const clear = useCartStore((s) => s.clear);
  const addProduct = useCartStore((s) => s.addProduct);
  const addFreeAmount = useCartStore((s) => s.addFreeAmount);

  // Cobro desde un turno (F12 · H38): /pos?appointment=<id>. Se carga el servicio
  // del turno en el carrito (+ se permite agregar productos extra) y, al cobrar,
  // la venta queda enlazada al turno (link_appointment_sale → 'realizado').
  const appointmentId = searchParams.get("appointment");
  const { data: pendingAppt } = useAppointment(appointmentId);
  const loadedApptRef = useRef<string | null>(null);
  // Recompra rápida (F12 · H40): /pos?repeat=<customerId>.
  const repeatCustomerId = searchParams.get("repeat");
  const { data: repeatSale } = useCustomerLastSaleItems(repeatCustomerId);
  const loadedRepeatRef = useRef<string | null>(null);
  // Cobro de mesa (F13 · H44): /pos?table=<order_id>.
  const tableOrderId = searchParams.get("table");
  const { data: tableOrder } = useTableOrder(tableOrderId);
  const { data: tableItems } = useTableOrderItems(tableOrderId);
  const loadedTableRef = useRef<string | null>(null);
  // Cobro de delivery (F13 · H49): /pos?delivery=<order_id>.
  const deliveryOrderId = searchParams.get("delivery");
  const { data: deliveryOrder } = useDeliveryOrder(deliveryOrderId);
  const { data: deliveryItems } = useDeliveryOrderItems(deliveryOrderId);
  const loadedDeliveryRef = useRef<string | null>(null);

  // Turno: cargá su servicio UNA vez y seleccioná el cliente. Si el turno ya
  // tiene venta o está cancelado, no se carga.
  useEffect(() => {
    const a = pendingAppt;
    if (!a) return;
    if (loadedApptRef.current === a.id) return;
    loadedApptRef.current = a.id;
    if (a.sale_id || a.status === "cancelado") return;
    clear();
    if (a.service_product_id) {
      addProduct({
        id: a.service_product_id,
        name: a.service_name,
        sku: null,
        price: a.service_price,
        unit: "un",
      });
    } else {
      addFreeAmount({ name: a.service_name, amount: a.service_price });
    }
    if (a.customer_id && a.customers?.name) {
      setCustomer({ id: a.customer_id, name: a.customers.name });
    }
    // setCustomer es un setState estable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAppt, clear, addProduct, addFreeAmount]);

  function exitAppointmentMode() {
    loadedApptRef.current = null;
    clear();
    setCustomer(null);
    router.replace("/pos");
  }

  // Mesa: cargá los ítems del pedido UNA vez (precio snapshot del pedido).
  useEffect(() => {
    const o = tableOrder;
    if (!o) return;
    if (loadedTableRef.current === o.id) return;
    if (tableItems === undefined) return;
    if (o.status !== "abierta" || o.sale_id) {
      loadedTableRef.current = o.id;
      return;
    }
    loadedTableRef.current = o.id;
    clear();
    for (const it of tableItems ?? []) {
      const qty = it.qty > 0 ? it.qty : 1;
      if (it.product_id) {
        addProduct({ id: it.product_id, name: it.name, sku: null, price: it.unit_price, unit: "un" }, qty);
      } else {
        addFreeAmount({ name: it.name, amount: it.unit_price * qty });
      }
    }
  }, [tableOrder, tableItems, clear, addProduct, addFreeAmount]);

  function exitTableMode() {
    loadedTableRef.current = null;
    clear();
    setCustomer(null);
    router.replace("/pos");
  }

  // Delivery: espeja mesa. El costo de envío NO es línea del carrito: lo agrega
  // create_sale desde delivery_orders.delivery_fee (autoritativo).
  useEffect(() => {
    const o = deliveryOrder;
    if (!o) return;
    if (loadedDeliveryRef.current === o.id) return;
    if (deliveryItems === undefined) return;
    if (o.sale_id || o.status === "entregado" || o.status === "cancelado") {
      loadedDeliveryRef.current = o.id;
      return;
    }
    loadedDeliveryRef.current = o.id;
    clear();
    for (const it of deliveryItems ?? []) {
      const qty = it.qty > 0 ? it.qty : 1;
      if (it.product_id) {
        addProduct({ id: it.product_id, name: it.name, sku: null, price: it.unit_price, unit: "un" }, qty);
      } else {
        addFreeAmount({ name: it.name, amount: it.unit_price * qty });
      }
    }
    if (o.customer_id && o.customer_name) {
      setCustomer({ id: o.customer_id, name: o.customer_name });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deliveryOrder, deliveryItems, clear, addProduct, addFreeAmount]);

  // Costo de envío a cobrar: sólo delivery activo, abierto y con fee > 0.
  const deliveryFee = useMemo(() => {
    const o = deliveryOrder;
    if (!deliveryOrderId || !o) return 0;
    if (o.sale_id || o.status === "entregado" || o.status === "cancelado") return 0;
    if (o.order_type !== "delivery") return 0;
    return Math.max(0, Number(o.delivery_fee) || 0);
  }, [deliveryOrderId, deliveryOrder]);

  function exitDeliveryMode() {
    loadedDeliveryRef.current = null;
    clear();
    setCustomer(null);
    router.replace("/pos");
  }

  // Recompra: carga la última venta del cliente UNA vez (precio actual, omite
  // los dados de baja) y selecciona al cliente.
  useEffect(() => {
    if (!repeatCustomerId) return;
    const r = repeatSale;
    if (repeatSale === undefined) return;
    if (loadedRepeatRef.current === repeatCustomerId) return;
    loadedRepeatRef.current = repeatCustomerId;
    let cancelled = false;
    setCustomer({ id: repeatCustomerId, name: r?.customerName ?? "Cliente" });
    (async () => {
      if (!r || r.items.length === 0) {
        if (!cancelled) toast({ title: "El cliente no tiene una venta para repetir", variant: "info" });
        if (!cancelled) router.replace("/pos");
        return;
      }
      const productIds = r.items.map((it) => it.product_id).filter((id): id is string => Boolean(id));
      let current: Awaited<ReturnType<typeof productsApi.getByIds>> = [];
      try {
        current = await productsApi.getByIds(productIds);
      } catch {
        /* si falla, se tratan todos como no disponibles */
      }
      if (cancelled) return;
      const byId = new Map(current.map((p) => [p.id, p]));
      clear();
      const omitted: string[] = [];
      for (const it of r.items) {
        const qty = it.quantity > 0 ? it.quantity : 1;
        if (it.product_id) {
          const p = byId.get(it.product_id);
          if (!p) {
            omitted.push(it.product_name);
            continue;
          }
          addProduct(
            {
              id: p.id,
              name: p.name,
              sku: p.sku,
              price: priceFor(p.id, null, p.price),
              unit: p.unit,
              warrantyMonths: p.warranty_months ?? 0,
              categoryId: p.category_id,
            },
            qty,
          );
        } else {
          addFreeAmount({ name: it.product_name, amount: it.unit_price * qty });
        }
      }
      if (cancelled) return;
      router.replace("/pos");
      if (omitted.length > 0) {
        toast({
          title:
            omitted.length === 1
              ? `Se omitió "${omitted[0]}" (ya no está disponible)`
              : `Se omitieron ${omitted.length} productos que ya no están disponibles`,
          variant: "info",
        });
      }
      toast({ title: "Última venta cargada en el carrito", variant: "success" });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repeatCustomerId, repeatSale]);

  // Limpieza tras una venta cobrada: turno (enlace best-effort lo hace la venta),
  // mesa y delivery ya se cerraron atómicamente en create_sale.
  function afterSale() {
    if (appointmentId) loadedApptRef.current = null;
    if (tableOrderId) loadedTableRef.current = null;
    if (deliveryOrderId) loadedDeliveryRef.current = null;
    if (appointmentId || tableOrderId || deliveryOrderId) router.replace("/pos");
  }

  const apptActive = Boolean(
    pendingAppt && !pendingAppt.sale_id && pendingAppt.status !== "cancelado",
  );
  const tableActive = Boolean(tableOrder && tableOrder.status === "abierta" && !tableOrder.sale_id);
  const deliveryActive = Boolean(
    deliveryOrder &&
      !deliveryOrder.sale_id &&
      deliveryOrder.status !== "entregado" &&
      deliveryOrder.status !== "cancelado",
  );

  return {
    appointmentId,
    pendingAppt,
    apptActive,
    exitAppointmentMode,
    tableOrderId,
    tableOrder,
    tableActive,
    exitTableMode,
    deliveryOrderId,
    deliveryOrder,
    deliveryActive,
    exitDeliveryMode,
    deliveryFee,
    afterSale,
  };
}
