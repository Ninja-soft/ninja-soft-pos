// Logos oficiales de los medios de pago (public/images/payments).
//   icon     → isotipo cuadrado (chips, avatares, filas).
//   wordmark → logo horizontal completo (encabezados de modales).
// Fuente única: cualquier pantalla que muestre un medio de pago usa esto.

const BASE = "/images/payments";

const FILE_PREFIX: Record<string, string> = {
  cash: "efectivo",
  transfer: "transferencia",
  mercadopago: "mercado-pago",
  payway: "payway",
  getnet: "getnet",
  nave: "nave",
  modo: "modo",
  mobbex: "mobbex",
  pagos360: "pagos360",
  fiserv: "fiserv",
  gocuotas: "gocuotas",
  directo: "directo",
};

// Marcas sin logo horizontal propio (son genéricos).
const NO_WORDMARK = new Set(["cash", "transfer"]);

// provider_key (o key de marca) → marca. Los canales Point usan el logo de su
// marca.
export function logoBrandOf(key: string): string {
  return key.replace(/_point$/, "");
}

export function paymentIcon(key: string): string | null {
  const prefix = FILE_PREFIX[logoBrandOf(key)];
  return prefix ? `${BASE}/${prefix}-icon.webp` : null;
}

export function paymentWordmark(key: string): string | null {
  const brand = logoBrandOf(key);
  const prefix = FILE_PREFIX[brand];
  if (!prefix || NO_WORDMARK.has(brand)) return null;
  return `${BASE}/${prefix}-wordmark.webp`;
}

// Isotipos que ya son un cuadrado lleno (sin aire): se muestran sin padding.
const FULL_BLEED = new Set(["fiserv"]);

export function paymentIconFullBleed(key: string): boolean {
  return FULL_BLEED.has(logoBrandOf(key));
}
