// Modo del catálogo (ADR-116). FLAG-OPERATIVO del dueño: qué vende el negocio
// (productos, servicios o ambos). Cambia el vocabulario y los campos del
// catálogo y del POS; el servidor no depende de él (el tipo de cada ítem es
// products.is_service). PURO.

export const CATALOG_MODES = ["productos", "servicios", "mixto"] as const;
export type CatalogMode = (typeof CATALOG_MODES)[number];

export function isCatalogMode(v: unknown): v is CatalogMode {
  return typeof v === "string" && (CATALOG_MODES as readonly string[]).includes(v);
}

/**
 * Modo efectivo: el elegido en Configuración (pos_settings.catalog_mode) o,
 * sin elegir, el del rubro del alta ("Servicios profesionales" → servicios).
 */
export function effectiveCatalogMode(setting: string | null | undefined, industry: string | null | undefined): CatalogMode {
  if (isCatalogMode(setting)) return setting;
  return industry === "servicios" ? "servicios" : "productos";
}

export const CATALOG_MODE_INFO: Record<CatalogMode, { label: string; help: string }> = {
  productos: { label: "Productos", help: "Catálogo con stock, códigos de barra y variantes." },
  servicios: {
    label: "Servicios",
    help: "Honorarios por hora, visita, informe o análisis, sin stock. La factura sale como servicios con el período facturado.",
  },
  mixto: { label: "Productos y servicios", help: "Las dos cosas: cada ítem dice si es producto o servicio." },
};

export interface CatalogVocab {
  /** Menú y título de la página ("Servicios"). */
  title: string;
  /** "servicio", "producto", "ítem" (minúscula, para frases). */
  one: string;
  /** "servicios", "productos", "ítems". */
  many: string;
  /** Botón de alta ("Nuevo servicio"). */
  newLabel: string;
  /** Los ítems nuevos nacen como servicio. */
  newIsService: boolean;
}

export function catalogVocab(mode: CatalogMode): CatalogVocab {
  if (mode === "servicios") {
    return { title: "Servicios", one: "servicio", many: "servicios", newLabel: "Nuevo servicio", newIsService: true };
  }
  if (mode === "mixto") {
    return { title: "Productos y servicios", one: "ítem", many: "ítems", newLabel: "Nuevo ítem", newIsService: false };
  }
  return { title: "Productos", one: "producto", many: "productos", newLabel: "Nuevo producto", newIsService: false };
}

/** Título del editor de un ítem según su tipo. */
export function itemNoun(isService: boolean): string {
  return isService ? "servicio" : "producto";
}

/** Unidades de un servicio (products.unit, hasta 10 caracteres). */
export const SERVICE_UNITS: { value: string; label: string }[] = [
  { value: "un", label: "Unidad" },
  { value: "hora", label: "Hora" },
  { value: "visita", label: "Visita" },
  { value: "informe", label: "Informe" },
  { value: "analisis", label: "Análisis" },
  { value: "muestra", label: "Muestra" },
  { value: "mes", label: "Mes" },
  { value: "servicio", label: "Servicio" },
];

/** Etiqueta de una unidad para la factura ("análisis", "hora", "unidad"). */
export function unitLabel(unit: string | null | undefined): string {
  const u = (unit ?? "").trim();
  if (!u || u === "un" || u === "unidad") return "unidad";
  const known = SERVICE_UNITS.find((x) => x.value === u);
  return known ? known.label.toLowerCase() : u;
}

/** Bloque de texto con formato simple: líneas y viñetas ("- " o "• "). */
export interface SimpleTextLine {
  bullet: boolean;
  text: string;
}

export function simpleTextLines(text: string | null | undefined): SimpleTextLine[] {
  return (text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = /^[-•*]\s+(.*)$/.exec(l);
      return m ? { bullet: true, text: m[1]!.trim() } : { bullet: false, text: l };
    });
}

/** Datos de servicio de un renglón vendido (sale_items, ADR-116). */
export interface ServiceLineText {
  detail?: string | null;
  clarifications?: string[] | null;
  note?: string | null;
}

/**
 * Texto que va debajo del nombre en la factura, en orden: descripción
 * ampliada, aclaraciones predefinidas (viñetas) y aclaración libre.
 */
export function serviceLineBlocks(l: ServiceLineText): SimpleTextLine[] {
  return [
    ...simpleTextLines(l.detail),
    ...(l.clarifications ?? []).map((c) => c.trim()).filter(Boolean).map((c) => ({ bullet: true, text: c })),
    ...simpleTextLines(l.note),
  ];
}

/** Hoy en Argentina (AAAA-MM-DD). */
export function todayAr(now: Date = new Date()): string {
  return new Date(now.getTime() - 3 * 3600_000).toISOString().slice(0, 10);
}

export interface ServicePeriod {
  from: string;
  to: string;
  due: string;
}

/** Período por defecto de una venta de servicios: hoy, hoy, hoy. */
export function defaultServicePeriod(now: Date = new Date()): ServicePeriod {
  const d = todayAr(now);
  return { from: d, to: d, due: d };
}

/** Mismo criterio que _sale_apply_service: el código del error o null. */
export function servicePeriodError(p: ServicePeriod, today: string = todayAr()): string | null {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!iso.test(p.from) || !iso.test(p.to)) return "Elegí las fechas del período";
  if (p.to < p.from) return "El período termina antes de empezar";
  if (!iso.test(p.due)) return "Elegí el vencimiento del pago";
  if (p.due < today) return "El vencimiento no puede ser anterior a hoy";
  return null;
}
