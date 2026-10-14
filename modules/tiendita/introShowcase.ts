// Portada de Tiendita: qué tiendas mostrar y qué número prometer.
//
// Las tiendas salen de catalog_stores (las mismas del panel interno de
// Catálogos), filtradas a las que están en algún catálogo ACTIVO vía
// catalog_store_map. El contador es la suma de catalogs.product_count de los
// catálogos activos (cada uno ya deduplicado por EAN cuando corresponde) y se
// redondea HACIA ABAJO para que "Más de N" sea siempre cierto.
import { storeIcon } from "@/lib/catalog/storeLogos";

export interface IntroStoreRow {
  key: string;
  name: string;
  logo_url: string | null;
}
export interface IntroStoreLink {
  catalog_id: string;
  store_key: string;
}
export interface IntroCatalogRow {
  id: string;
  is_active: boolean;
  product_count: number | string | null;
}

// Tono del ícono: algunos oficiales se pierden sobre un fondo del tema (letras
// blancas en claro, azul marino o violeta profundo en oscuro). La portada les
// pone una ficha de contraste sólo en los temas donde se pierden.
//   light = tinta clara (necesita ficha oscura en temas claros)
//   dark  = tinta oscura (necesita ficha clara en temas oscuros)
export type IconInk = "light" | "dark" | null;
const ICON_INK: Record<string, Exclude<IconInk, null>> = {
  BANCOR: "light",
  PROVINCIA: "light",
  MACRO: "dark",
  MEGATONE: "dark",
};

export interface IntroStore {
  key: string;
  name: string;
  /** Ícono oficial (public/tiendas/iconos) o null si no hay. */
  icon: string | null;
  /** logo_url de la tienda (fallback si no hay ícono oficial o falla). */
  logoUrl: string | null;
  /** Iniciales (último fallback). */
  initials: string;
  ink: IconInk;
}

export interface IntroShowcase {
  stores: IntroStore[];
  productCount: number;
}

export function storeInitials(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((w) => w && !/^tienda$/i.test(w));
  if (words.length === 0) return name.trim().slice(0, 2).toUpperCase();
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

export function iconInk(key: string): IconInk {
  return ICON_INK[key.toUpperCase()] ?? null;
}

export function toIntroStore(row: IntroStoreRow): IntroStore {
  return {
    key: row.key,
    name: row.name,
    icon: storeIcon(row.key),
    logoUrl: row.logo_url || null,
    initials: storeInitials(row.name),
    ink: iconInk(row.key),
  };
}

export function buildIntroShowcase(
  stores: IntroStoreRow[],
  links: IntroStoreLink[],
  catalogs: IntroCatalogRow[],
): IntroShowcase {
  const active = catalogs.filter((c) => c.is_active);
  const activeIds = new Set(active.map((c) => c.id));
  const sellable = new Set(
    links.filter((l) => activeIds.has(l.catalog_id)).map((l) => l.store_key.toUpperCase()),
  );
  // Sin relación cargada (instalación vieja / vacía) mostramos todas.
  const visible = links.length === 0 ? stores : stores.filter((s) => sellable.has(s.key.toUpperCase()));
  const productCount = active.reduce((acc, c) => {
    const n = Number(c.product_count ?? 0);
    return acc + (Number.isFinite(n) && n > 0 ? n : 0);
  }, 0);
  return { stores: visible.map(toIntroStore), productCount };
}

// Redondeo hacia abajo a 2 cifras significativas (371.601 → 370.000).
// Debajo de 1.000 queda exacto.
export function roundDownNice(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  const v = Math.floor(n);
  if (v < 1000) return v;
  const step = 10 ** (Math.floor(Math.log10(v)) - 1);
  return Math.floor(v / step) * step;
}

export interface CountLabel {
  /** "Más de" si se redondeó, "" si es exacto. */
  prefix: string;
  value: number;
  /** "productos de 13 tiendas" */
  suffix: string;
}

export function introCountLabel(productCount: number, storeCount: number): CountLabel | null {
  const value = roundDownNice(productCount);
  if (value <= 0) return null;
  const exact = value === Math.floor(productCount);
  const productos = value === 1 ? "producto" : "productos";
  const tiendas = storeCount === 1 ? "tienda" : "tiendas";
  return {
    prefix: exact ? "" : "Más de",
    value,
    suffix: storeCount > 0 ? `${productos} de ${storeCount} ${tiendas}` : productos,
  };
}

// Reparte las tiendas en filas para el marquee: cada fila arranca en otro
// punto de la lista (no se ven las mismas columnas alineadas) y se repite
// hasta tener al menos `minPerRow` fichas, para que la cinta cubra pantallas
// anchas antes de duplicarse.
export function marqueeRows<T>(items: T[], rows: number, minPerRow = 12): T[][] {
  if (items.length === 0 || rows <= 0) return [];
  const out: T[][] = [];
  for (let r = 0; r < rows; r++) {
    const shift = Math.floor((r * items.length) / rows) + r * 2;
    const rotated = items.map((_, i) => items[(i + shift) % items.length]!);
    const row: T[] = [];
    while (row.length < minPerRow) row.push(...rotated);
    out.push(row);
  }
  return out;
}
