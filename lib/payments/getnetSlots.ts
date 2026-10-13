// Getnet: dos juegos de credenciales en la misma conexión (ADR-069). Cada
// slot es opcional, por ambiente y por sucursal (ADR-057). Lógica pura para el
// wizard de conexión, el POS y los tests.
//
//   * web_checkout: "Web Checkout / Plugin Magento / Plugin WooCommerce".
//     QR y link: el cliente paga en la página de Getnet.
//   * checkout_api: "Checkout API / Plugin VTEX". Checkout propio /pagar con
//     la marca del negocio (como Payway).

export type GetnetSlot = "web_checkout" | "checkout_api";

export type GetnetSlotDef = {
  key: GetnetSlot;
  /** Cómo lo llama el portal de Getnet (título de la tarjeta). */
  title: string;
  /** Nombre corto para botones y avisos. */
  short: string;
  /** Para qué sirve, en una línea. */
  purpose: string;
  /** Qué credenciales cargar (cómo las llama Getnet). */
  credentials: string;
  /** Claves del secreto de este slot (para guardar y borrar sin pisar el otro). */
  keys: string[];
};

export const GETNET_SLOTS: GetnetSlotDef[] = [
  {
    key: "web_checkout",
    title: "Web Checkout / Plugin Magento / Plugin WooCommerce",
    short: "Web Checkout",
    purpose: "Para cobrar con QR o link: el cliente paga en la página de Getnet.",
    credentials:
      "Estas son las credenciales que tenés que cargar. Las encontrás en el portal de Getnet como Web Checkout, Plugin Magento o Plugin WooCommerce.",
    keys: [
      "client_id",
      "client_secret",
      "api_profile",
      "environment",
      "customer_email",
      "customer_document",
      "customer_address",
      "customer_postal_code",
      "customer_city",
    ],
  },
  {
    key: "checkout_api",
    title: "Checkout API / Plugin VTEX",
    short: "Checkout API",
    purpose:
      "Para tu propio checkout con tu marca (como Payway): el cliente carga la tarjeta en NinjaPos y elige cuotas.",
    credentials: "Usá las credenciales que dicen Checkout API / Plugin VTEX.",
    keys: ["api_client_id", "api_client_secret", "api_environment", "api_channel_entry", "api_seller_id"],
  },
];

/** Aviso fijo del asistente (ADR-069 adenda): las de Checkout API no sirven. */
export const GETNET_VTEX_WARNING =
  "No uses las de Checkout API / Plugin VTEX: no funcionan para cobrar con QR ni link desde NinjaSoft.";

/** Mismo texto que la Edge (SLOT_MISMATCH_COPY.web_checkout). */
export const GETNET_VTEX_IN_WEB_CHECKOUT =
  "Estas credenciales son de Checkout API / Plugin VTEX. Cargá las de Web Checkout / Plugin Magento / Plugin WooCommerce.";

/**
 * Tarjetas que muestra el asistente. La de Checkout API sólo aparece con el
 * checkout propio habilitado (flag PCI que expone la Edge getnet como
 * booleano). Apagado: una sola tarjeta, Web Checkout.
 */
export function visibleGetnetSlots(ownCheckoutEnabled: boolean): GetnetSlotDef[] {
  return GETNET_SLOTS.filter((s) => s.key === "web_checkout" || ownCheckoutEnabled);
}

/** Error de set_payment_secret al guardar Getnet → texto del asistente. */
export function getnetSaveError(code: string | undefined): string | null {
  switch (code) {
    case "getnet_checkout_api_credentials":
      return GETNET_VTEX_IN_WEB_CHECKOUT;
    case "getnet_invalid_credentials":
      return "Getnet rechazó el Client ID / Client Secret. Revisá que sean las de Web Checkout / Plugin Magento / Plugin WooCommerce y el ambiente.";
    case "checkout_api_unavailable":
      return "Las credenciales de Checkout API / Plugin VTEX no se pueden cargar: el checkout propio con Getnet no está habilitado. Cargá las de Web Checkout / Plugin Magento / Plugin WooCommerce.";
    default:
      return null;
  }
}

export const GETNET_SLOT_BY_KEY: Record<GetnetSlot, GetnetSlotDef> = Object.fromEntries(
  GETNET_SLOTS.map((s) => [s.key, s]),
) as Record<GetnetSlot, GetnetSlotDef>;

type Cfg = Record<string, unknown> | null | undefined;

/**
 * Slots cargados según tenant_payment_methods.config. Una conexión vieja (de
 * antes de los slots) sólo tenía Web Checkout: `connected` sin flags = Web
 * Checkout.
 */
export function getnetSlotsOf(config: Cfg): Record<GetnetSlot, boolean> {
  const c = config ?? {};
  const hasFlags = "web_checkout_connected" in c || "checkout_api_connected" in c;
  return {
    web_checkout: hasFlags ? c.web_checkout_connected === true : c.connected === true,
    checkout_api: c.checkout_api_connected === true,
  };
}

/** Slots de una credencial de sucursal a partir de sus claves (payment_secret_scopes). */
export function getnetSlotsFromKeys(keys: string[]): Record<GetnetSlot, boolean> {
  const k = new Set(keys);
  return {
    web_checkout: k.has("client_id") && k.has("client_secret"),
    checkout_api: k.has("api_client_id") && k.has("api_client_secret"),
  };
}

/**
 * Secretos a guardar para un slot. Los campos del formulario del slot
 * Checkout API usan las claves api_*; el ambiente va con el prefijo del slot.
 * `remove`: claves del MISMO slot que no vinieron (se borran con merge para no
 * dejar datos viejos), nunca las del otro slot.
 */
export function getnetSlotSave(
  slot: GetnetSlot,
  typed: Record<string, string>,
  env: "prod" | "test",
): { secrets: Record<string, string>; remove: string[] } {
  const secrets: Record<string, string> = {};
  for (const [k, v] of Object.entries(typed)) {
    const t = v.trim();
    if (t) secrets[k] = t;
  }
  if (slot === "checkout_api") secrets.api_environment = env;
  else secrets.environment = secrets.environment ?? env;
  const keep = new Set([
    ...Object.keys(secrets),
    // Datos opcionales del comprador: sólo se reemplazan si se tipearon.
    ...(slot === "web_checkout"
      ? ["customer_email", "customer_document", "customer_address", "customer_postal_code", "customer_city"]
      : ["api_seller_id", "api_channel_entry"]),
  ]);
  const remove = GETNET_SLOT_BY_KEY[slot].keys.filter((k) => !keep.has(k));
  return { secrets, remove };
}

/** Claves a borrar para desconectar sólo un slot. */
export function getnetSlotClearKeys(slot: GetnetSlot): string[] {
  return [...GETNET_SLOT_BY_KEY[slot].keys];
}

/** Error de la Edge getnet → mensaje del POS (slots). */
export function getnetSlotError(code: string | undefined): string | null {
  switch (code) {
    case "web_checkout_not_connected":
      return "Para cobrar con QR o link de Getnet cargá las credenciales de Web Checkout / Plugin Magento / Plugin WooCommerce (las de Checkout API / Plugin VTEX no sirven).";
    case "checkout_api_not_connected":
      return "Para el checkout propio de Getnet cargá las credenciales de Checkout API en Medios de pago.";
    case "checkout_api_unavailable":
      return "El checkout propio con Getnet todavía no está habilitado en NinjaPos. Cobrá con QR o link de Getnet.";
    default:
      return null;
  }
}
