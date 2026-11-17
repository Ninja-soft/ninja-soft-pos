// =============================================================================
// SEC-43 (ADR-187): clave de idempotencia del cobro online.
//
// El POS manda `p_client_request_id` a create_sale (o dentro de p_sale a
// pos_sale_create_fulfilled). Si se corta la red después de que el servidor
// grabó la venta, el reintento del MISMO cobro manda la MISMA clave y el
// servidor devuelve la venta existente en lugar de duplicarla.
//
// Reglas:
//   - La clave nace en el primer "Cobrar" del carrito.
//   - Se reusa mientras el carrito sea el mismo (reintentos, PIN de
//     supervisor, cambio de medio de pago después de un error).
//   - Cambia si cambia el carrito (otro cobro) y se descarta cuando la venta
//     se confirma: la venta siguiente, aunque sea idéntica, lleva otra clave.
// =============================================================================

export type SaleRequestKey = { key: string; cart: string };

/** Lo que define "el mismo cobro": renglones, cliente y origen de la venta. */
export type SaleCartIdentity = {
  items: readonly unknown[];
  customerId: string | null;
  tableOrderId: string | null;
  deliveryOrderId: string | null;
  appointmentId: string | null;
  reservationId: string | null;
};

/** Firma estable del carrito (JSON con claves ordenadas). */
export function saleCartSignature(cart: SaleCartIdentity): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v as Record<string, unknown>)
              .sort()
              .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
          )
        : v;
  return JSON.stringify(sort(cart));
}

export function newSaleRequestId(): string {
  return globalThis.crypto.randomUUID();
}

/** Clave para este intento: la anterior si el carrito no cambió; si no, una nueva. */
export function nextSaleRequestKey(
  prev: SaleRequestKey | null,
  cart: string,
  newId: () => string = newSaleRequestId,
): SaleRequestKey {
  return prev && prev.cart === cart ? prev : { key: newId(), cart };
}
