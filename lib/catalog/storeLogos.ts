// Íconos oficiales de las tiendas de origen del catálogo (los pasó el dueño,
// 13/10/2026). Cuadrados 256x256 con transparencia, en public/tiendas/iconos.
// La clave es el id de tienda del feed del scraper (catalog_stores.key).
// Usar estos antes que el logo_url que trae el feed: son los oficiales.
export const STORE_ICONS: Record<string, string> = {
  COTO: "/tiendas/iconos/coto.webp",
  CARREFOUR: "/tiendas/iconos/carrefour.webp",
  JUMBO: "/tiendas/iconos/jumbo.webp",
  DIA: "/tiendas/iconos/dia.webp",
  EASY: "/tiendas/iconos/easy.webp",
  FRAVEGA: "/tiendas/iconos/fravega.webp",
  MEGATONE: "/tiendas/iconos/megatone.webp",
  PROVINCIA: "/tiendas/iconos/provincia.webp",
  BNA: "/tiendas/iconos/bna.webp",
  CIUDAD: "/tiendas/iconos/ciudad.webp",
  MACRO: "/tiendas/iconos/macro.webp",
  BANCOR: "/tiendas/iconos/bancor.webp",
  GALICIA: "/tiendas/iconos/galicia.webp",
};

// Variantes por tono de fondo, SIN placa blanca: algunos oficiales tienen una
// tinta que se pierde sobre el fondo del tema (14/10/2026, a pedido del dueño
// se sacaron las "fichas de contraste" blancas). Se generaron recoloreando sólo
// esa tinta y conservando el alfa:
//   dark  = ícono para temas oscuros (ninja-dark, ninja-noir)
//   light = ícono para temas claros (ninja-light, ninja-sand)
// Si una tienda no tiene variante para un tono, se usa el ícono base.
export type IconTone = "dark" | "light";
export const STORE_ICON_VARIANTS: Record<string, Partial<Record<IconTone, string>>> = {
  // "Macro" en azul marino → claro en oscuro (el magenta queda igual).
  MACRO: { dark: "/tiendas/iconos/macro-claro.webp" },
  // La "B" blanca → oscura en claro (el naranja queda igual).
  BANCOR: { light: "/tiendas/iconos/bancor-oscuro.webp" },
  // "Provincia" en blanco → verde oscuro en claro.
  PROVINCIA: { light: "/tiendas/iconos/provincia-oscuro.webp" },
};

const LIGHT_THEMES = new Set(["ninja-light", "ninja-sand"]);

/** Tono de fondo de un tema (sin tema = oscuro, el default de la app). */
export function themeTone(theme: string | null | undefined): IconTone {
  return theme && LIGHT_THEMES.has(theme) ? "light" : "dark";
}

/**
 * Ícono oficial de la tienda. Con `theme` (o `tone`) devuelve la variante que
 * se lee sobre ese fondo, si existe; sin opciones, el ícono base.
 */
export function storeIcon(
  storeKey: string | null | undefined,
  opts?: { theme?: string | null; tone?: IconTone },
): string | null {
  if (!storeKey) return null;
  const key = storeKey.toUpperCase();
  const base = STORE_ICONS[key] ?? null;
  if (!base || !opts) return base;
  const tone = opts.tone ?? themeTone(opts.theme);
  return STORE_ICON_VARIANTS[key]?.[tone] ?? base;
}
