// Proveedor de cobro (payment_providers.key) → feature de plan que lo habilita.
// ESPEJO de la función SQL payment_method_plan_key (gating real en el trigger de
// `payments`); la UI lo usa sólo para mostrar/ocultar. Un proveedor sin entrada
// no está gateado por plan. Cada canal Point tiene su propia feature, separada
// del QR + link de su marca.
export const PROVIDER_FEATURE: Record<string, string> = {
  mercadopago: "mercado_pago",
  mercadopago_point: "mercadopago_point",
  modo: "modo",
  mobbex: "mobbex",
  payway: "payway",
  payway_point: "payway_point",
  getnet: "getnet",
  getnet_point: "getnet_point",
  fiserv: "fiserv",
  // Clover Point (ADR-047): terminal Clover integrada; depende de `fiserv`.
  fiserv_point: "fiserv_point",
  pagos360: "pagos360",
  nave: "nave",
  nave_point: "nave_point",
  gocuotas: "gocuotas",
  // Directo (ADR-041): QR + link por API (method 'qr' + intent directo) o
  // respaldo manual (payments.method = 'directo'); ambos caminos los gatea el
  // trigger vía payment_method_plan_key('directo').
  directo: "directo",
};

export function providerFeature(provider: string): string | null {
  return PROVIDER_FEATURE[provider] ?? null;
}
