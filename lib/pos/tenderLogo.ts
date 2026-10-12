// Fuente del logo de un medio de cobro según el tono de la superficie.
//
// Los logos se muestran con su fondo transparente directo sobre el tile (sin
// placa blanca). En temas oscuros se pide la variante para fondo oscuro. Hoy
// lib/payments/logos.ts sólo expone un isotipo por marca: este helper es el
// único punto a tocar cuando lleguen las variantes claras/oscuras
// (paymentIcon con opción de tema) y los logos de tarjetas de
// public/images/cards/.

export type LogoTone = "light" | "dark";

export interface LogoSource {
  /** Logo resuelto por el registro de tenders (variante para fondo claro). */
  logo: string | null;
  /** Variante para fondo oscuro, si existe. */
  logoDark?: string | null;
}

export function tenderLogoSrc(t: LogoSource, tone: LogoTone): string | null {
  if (tone === "dark" && t.logoDark) return t.logoDark;
  return t.logo;
}
