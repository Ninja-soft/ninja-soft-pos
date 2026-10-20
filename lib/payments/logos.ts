// Logos oficiales de los medios de pago (public/images/payments) y de las
// redes de tarjeta (public/images/cards). Todos con fondo transparente y
// recortados al contenido: se muestran SIN placa blanca.
//   icon     → isotipo cuadrado (chips, avatares, filas).
//   wordmark → logo horizontal completo (encabezados de modales).
//   card     → logo de la red de tarjeta (Visa, Mastercard, ...).
// Cada logo tiene, si la marca la ofrece, una variante para fondo oscuro
// (`-on-dark`). `{ on: "dark" }` la elige; el componente ThemedLogo las
// alterna solo según el tema (data-theme). Fuente única: cualquier pantalla
// que muestre un medio de pago o una tarjeta usa esto.

export type LogoSurface = "light" | "dark";
export type LogoOpts = { on?: LogoSurface };

const BASE = "/images/payments";
const CARDS = "/images/cards";
const DARK_SUFFIX = "-on-dark";

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
  // Clover (Fiserv): logo oficial de ar.clover.com (ADR-047).
  clover: "clover",
  gocuotas: "gocuotas",
  directo: "directo",
  // Ualá Bis (ADR-143): isotipo y logo oficiales (developers.ualabis.com.ar y
  // ualabis.com.ar); la variante oscura pasa el azul de "ualá" a blanco.
  ualabis: "ualabis",
  // Talo (ADR-175): isotipo y logo oficiales del encabezado de talo.com.ar
  // (SVG); la variante oscura pasa el texto "talo" a blanco (el isotipo verde
  // se lee igual en los dos fondos).
  talo: "talo",
};

// Marcas sin logo horizontal propio (son genéricos).
const NO_WORDMARK = new Set(["cash", "transfer"]);

// Logos con versión para fondo oscuro (los demás se leen bien en ambos).
const ICON_ON_DARK = new Set(["transfer", "payway", "clover", "ualabis"]);
const WORDMARK_ON_DARK = new Set(["mercadopago", "getnet", "nave", "directo", "payway", "clover", "ualabis", "talo"]);

// Canales con logo de producto propio (no el de su marca): la terminal
// integrada de Fiserv es Clover.
const LOGO_OVERRIDE: Record<string, string> = { fiserv_point: "clover" };

// provider_key (o key de marca) → marca. Los canales Point usan el logo de su
// marca, salvo los de LOGO_OVERRIDE.
export function logoBrandOf(key: string): string {
  return LOGO_OVERRIDE[key] ?? key.replace(/_point$/, "");
}

const withSurface = (path: string, hasDark: boolean, opts?: LogoOpts) =>
  opts?.on === "dark" && hasDark ? path.replace(/\.webp$/, `${DARK_SUFFIX}.webp`) : path;

export function paymentIcon(key: string, opts?: LogoOpts): string | null {
  const brand = logoBrandOf(key);
  const prefix = FILE_PREFIX[brand];
  return prefix ? withSurface(`${BASE}/${prefix}-icon.webp`, ICON_ON_DARK.has(brand), opts) : null;
}

export function paymentWordmark(key: string, opts?: LogoOpts): string | null {
  const brand = logoBrandOf(key);
  const prefix = FILE_PREFIX[brand];
  if (!prefix || NO_WORDMARK.has(brand)) return null;
  return withSurface(`${BASE}/${prefix}-wordmark.webp`, WORDMARK_ON_DARK.has(brand), opts);
}

// Isotipos que ya son un cuadrado lleno (sin aire): se muestran sin padding.
const FULL_BLEED = new Set(["fiserv"]);

export function paymentIconFullBleed(key: string): boolean {
  return FULL_BLEED.has(logoBrandOf(key));
}

// Igual que paymentIconFullBleed pero a partir de un src ya resuelto.
export function logoSrcFullBleed(src: string): boolean {
  return Array.from(FULL_BLEED).some((k) => paymentIcon(k) === src);
}

// ── Redes de tarjeta ─────────────────────────────────────────────────────────
// Claves de marca de payment_plans.brand (+ visa_debito del checkout /pagar).
const CARD_FILE: Record<string, string> = {
  visa: "visa",
  visa_debito: "visa-debito",
  master: "mastercard",
  maestro: "maestro",
  amex: "amex",
  cabal: "cabal",
  naranja: "naranja-x",
  diners: "diners-club",
};

// Mastercard (símbolo), Amex (Blue Box oficial) y Cabal (insignia) se usan
// igual en ambos fondos.
const CARD_ON_DARK = new Set(["visa", "visa_debito", "maestro", "naranja", "diners"]);

// Proporción (ancho / alto) de cada logo de tarjeta, para igualar su peso
// visual (CardBrandLogo): los apaisados se achican y los cuadrados crecen.
const CARD_ASPECT: Record<string, number> = {
  visa: 3.09,
  visa_debito: 2.11,
  master: 1.62,
  maestro: 1.29,
  amex: 1,
  cabal: 0.94,
  naranja: 4.29,
  diners: 3.78,
};

export function cardLogoAspect(brand: string): number {
  return CARD_ASPECT[brand] ?? 1.6;
}

// Ícono de app de la red (cuadrado, mismo set que soft.ninja,
// public/images/cards/app): va sobre una placa blanca redondeada
// (CardBrandLogo). Visa débito usa el de Visa.
const CARD_APP_FILE: Record<string, string> = {
  visa: "visa",
  visa_debito: "visa",
  master: "mastercard",
  maestro: "maestro",
  amex: "amex",
  cabal: "cabal",
  naranja: "naranja-x",
  diners: "diners",
};

export function cardAppIcon(brand: string | null | undefined): string | null {
  const file = brand ? CARD_APP_FILE[brand] : undefined;
  return file ? `${CARDS}/app/${file}.webp` : null;
}

export function cardLogo(brand: string | null | undefined, opts?: LogoOpts): string | null {
  if (!brand) return null;
  const file = CARD_FILE[brand];
  return file ? withSurface(`${CARDS}/${file}.webp`, CARD_ON_DARK.has(brand), opts) : null;
}

// Variante para fondo oscuro de un logo ya resuelto (p. ej. el `logo` de un
// tender). Devuelve el mismo src si la marca no tiene variante.
const DARK_SRCS = new Set<string>([
  ...Array.from(ICON_ON_DARK).map((k) => paymentIcon(k, { on: "dark" })!),
  ...Array.from(WORDMARK_ON_DARK).map((k) => paymentWordmark(k, { on: "dark" })!),
  ...Array.from(CARD_ON_DARK).map((k) => cardLogo(k, { on: "dark" })!),
]);

export function logoOnDark(src: string): string {
  const dark = src.replace(/\.webp$/, `${DARK_SUFFIX}.webp`);
  return DARK_SRCS.has(dark) ? dark : src;
}
