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
  pagos360: "pagos360",
  nave: "nave",
  nave_point: "nave_point",
  gocuotas: "gocuotas",
  // Directo es un tender manual (payments.method = 'directo'): el trigger lo
  // gatea por el método (payment_method_plan_key('directo')).
  directo: "directo",
};

export function providerFeature(provider: string): string | null {
  return PROVIDER_FEATURE[provider] ?? null;
}
