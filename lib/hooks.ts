// Webhooks con dominio propio (ADR-069): los proveedores pegan a
// https://hooks.soft.ninja/<proveedor> (o https://pos.soft.ninja/hooks/<proveedor>)
// y el middleware reescribe (proxy, mismo método y cuerpo) a la Edge Function.
// Las URLs viejas de supabase.co siguen funcionando: esto es un alias, no un reemplazo.

export const HOOKS_HOST = "hooks.soft.ninja";

export const WEBHOOK_FUNCTIONS: Record<string, string> = {
  mercadopago: "mp_webhook",
  "mercadopago-orders": "mp_orders_webhook",
  "mercadopago-billing": "mp_billing_webhook",
  getnet: "getnet_webhook",
  payway: "payway_webhook",
  nave: "nave_webhook",
  gocuotas: "gocuotas_webhook",
  directo: "directo_webhook",
  ualabis: "ualabis_webhook",
  viumi: "viumi_webhook",
  talo: "talo_webhook",
  clover: "clover_webhook",
  modo: "modo_webhook",
  mobbex: "mobbex_webhook",
  catalogo: "catalog_purchase_webhook",
  // Mercado Libre (ventas, publicaciones, envíos; ADR-104). "mercadolibre" ya es Mercado Pago.
  ml: "ml_webhook",
};

// URL de destino, "not_found" (host de hooks con proveedor desconocido) o
// null (request normal de la app).
export function webhookTarget(
  host: string | null,
  pathname: string,
  search: string,
  supabaseUrl: string,
): string | "not_found" | null {
  const h = String(host ?? "").toLowerCase().split(":")[0];
  const onHooksHost = h === HOOKS_HOST;
  const parts = pathname.split("/").filter(Boolean);
  let provider: string | undefined;
  if (onHooksHost && parts.length === 1) provider = parts[0];
  else if (!onHooksHost && parts.length === 2 && parts[0] === "hooks") provider = parts[1];
  const fn = provider ? WEBHOOK_FUNCTIONS[provider.toLowerCase()] : undefined;
  if (!fn) return onHooksHost ? "not_found" : null;
  return `${supabaseUrl.replace(/\/$/, "")}/functions/v1/${fn}${search}`;
}
