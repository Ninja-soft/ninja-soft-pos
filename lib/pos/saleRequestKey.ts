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
//   - Se reusa mientras las líneas base del carrito sean las mismas
//     (reintentos, PIN de supervisor, cambio de medio de pago o de cuotas
//     después de un error). El recargo del medio y la garantía no son parte
//     de la firma: los decide el servidor con la huella.
//   - Cambia si cambia el carrito (otro cobro). Se descarta SÓLO cuando la
//     venta se confirma (online o guardada sin conexión): vaciar el carrito
//     o un sale_request_mismatch no la borran. Después de un mismatch, el
//     cajero la rota a mano ("Es una venta nueva") si de verdad es otra venta.
//   - Si el cobro online se cortó y el cajero lo guarda sin conexión, la venta
//     offline lleva la misma clave: si la online había entrado, la
//     sincronización la reconoce y no duplica.
//   - Los pagos NO son parte del carrito: cambiar el medio de pago reusa la
//     clave y el servidor detecta la venta ya hecha (sale_request_mismatch).
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

// Persistencia de la clave pendiente (sessionStorage): sobrevive a una recarga
// o un remount del POS en la misma pestaña. Sin storage disponible, sigue en
// memoria y el servidor igual controla la huella.
export const SALE_REQUEST_STORAGE_KEY = "ninja.pos.saleRequestKey";

type KeyStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function sessionStore(): KeyStorage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function loadSaleRequestKey(store: KeyStorage | null = sessionStore()): SaleRequestKey | null {
  try {
    const raw = store?.getItem(SALE_REQUEST_STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<SaleRequestKey>;
    return typeof v.key === "string" && typeof v.cart === "string" ? { key: v.key, cart: v.cart } : null;
  } catch {
    return null;
  }
}

export function saveSaleRequestKey(k: SaleRequestKey | null, store: KeyStorage | null = sessionStore()): void {
  try {
    if (k) store?.setItem(SALE_REQUEST_STORAGE_KEY, JSON.stringify(k));
    else store?.removeItem(SALE_REQUEST_STORAGE_KEY);
  } catch {
    // Storage lleno o bloqueado: la clave queda sólo en memoria.
  }
}

/** Clave pendiente que corresponde a este carrito (para la venta offline después de un corte). */
export function pendingSaleRequestKey(prev: SaleRequestKey | null, cart: string): string | null {
  return prev && prev.cart === cart ? prev.key : null;
}

/**
 * sale_request_mismatch: la clave ya tiene una venta registrada con otros
 * datos. Devuelve el mensaje para el cajero (con el número si vino) o null.
 */
export function saleRequestMismatchMessage(msg: string): string | null {
  if (!msg.includes("sale_request_mismatch")) return null;
  const n = msg.match(/sale_request_mismatch:\s*(\d+)/)?.[1];
  return `Esta venta ya se registró${n ? ` (N° ${n})` : ""} con otros datos. Revisá Ventas antes de volver a cobrar.`;
}

// ---------------------------------------------------------------------------
// Ciclo de vida de la clave del POS.
//   attempt   → la del carrito (nextSaleRequestKey).
//   confirmed → null: la venta quedó (online o guardada sin conexión).
//   new_sale  → otra clave para el mismo carrito (acción explícita del cajero
//               después de un sale_request_mismatch).
//   cart_cleared / mismatch → la misma: puede ser el reintento de un cobro
//               que sí entró.
// ---------------------------------------------------------------------------
export type SaleKeyEvent = "attempt" | "confirmed" | "new_sale" | "cart_cleared" | "mismatch";

export function saleKeyAfter(
  event: SaleKeyEvent,
  prev: SaleRequestKey | null,
  cart: string,
  newId: () => string = newSaleRequestId,
): SaleRequestKey | null {
  switch (event) {
    case "attempt":
      return nextSaleRequestKey(prev, cart, newId);
    case "confirmed":
      return null;
    case "new_sale":
      return { key: newId(), cart };
    default:
      return prev;
  }
}

/**
 * Clave estable para un pedido identificado por `name` (p. ej. una línea de
 * conciliación), guardada en sessionStorage hasta que se confirma.
 */
export function stableRequestId(name: string, store: KeyStorage | null = sessionStore(), newId = newSaleRequestId): string {
  const storageKey = `${SALE_REQUEST_STORAGE_KEY}:${name}`;
  try {
    const v = store?.getItem(storageKey);
    if (v) return v;
  } catch {
    // sin storage: clave sólo en memoria.
  }
  const id = newId();
  try {
    store?.setItem(storageKey, id);
  } catch {
    // idem
  }
  return id;
}

export function clearStableRequestId(name: string, store: KeyStorage | null = sessionStore()): void {
  try {
    store?.removeItem(`${SALE_REQUEST_STORAGE_KEY}:${name}`);
  } catch {
    // idem
  }
}
