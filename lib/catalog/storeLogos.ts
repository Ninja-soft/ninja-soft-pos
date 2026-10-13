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

export function storeIcon(storeKey: string | null | undefined): string | null {
  if (!storeKey) return null;
  return STORE_ICONS[storeKey.toUpperCase()] ?? null;
}
