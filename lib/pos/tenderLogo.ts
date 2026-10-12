// Fuente del logo de un medio de cobro según el tono de la superficie.
//
// Los logos se muestran con su fondo transparente directo sobre el tile (sin
// placa blanca). En temas oscuros se usa la variante `-on-dark` oficial de
// lib/payments/logos.ts (logoOnDark) cuando la marca la tiene; si no, el
// mismo logo. En la UI, TenderLogo delega en ThemedLogo, que alterna las dos
// variantes por CSS según data-theme.

import { logoOnDark } from "@/lib/payments/logos";

export type LogoTone = "light" | "dark";

export interface LogoSource {
  /** Logo resuelto por el registro de tenders (variante para fondo claro). */
  logo: string | null;
  /** Variante para fondo oscuro explícita (si no, se deriva de `logo`). */
  logoDark?: string | null;
}

export function tenderLogoSrc(t: LogoSource, tone: LogoTone): string | null {
  if (tone === "dark") {
    if (t.logoDark) return t.logoDark;
    return t.logo ? logoOnDark(t.logo) : null;
  }
  return t.logo;
}
