// Verticales / rubros del negocio. Cada rubro habilita un set de funciones del
// POS. El rubro vive en tenants.industry; estas features se derivan de él.
// Ver CLAUDE.md §3 (feature flags) y docs/01-mvp.md (verticales).

export const VERTICALS = [
  "kiosco",
  "textil",
  "retail",
  "restaurante",
  "pyme",
  "otro",
] as const;

export type Vertical = (typeof VERTICALS)[number];

export const VERTICAL_LABELS: Record<Vertical, string> = {
  kiosco: "Kiosco / almacén",
  textil: "Textil / indumentaria",
  retail: "Retail",
  restaurante: "Restaurante",
  pyme: "Pyme",
  otro: "Otro",
};

export const VERTICAL_DESCRIPTIONS: Record<Vertical, string> = {
  kiosco: "Venta rápida por código o monto, por peso y combos.",
  textil: "Productos con variantes de talle y color.",
  retail: "Tienda general con categorías y stock simple.",
  restaurante: "Mesas, comandas y división de cuenta.",
  pyme: "Configuración general para pequeñas empresas.",
  otro: "Sin adaptaciones específicas de rubro.",
};

// Funciones que un rubro puede habilitar.
export type VerticalFeature =
  | "quickSale" // venta rápida sin stock (frecuentes + monto libre)
  | "byWeight" // productos por peso / balanza
  | "combos" // combos y promociones
  | "variants" // variantes talle/color
  | "tables"; // mesas / comandas

export const VERTICAL_FEATURES: Record<Vertical, VerticalFeature[]> = {
  kiosco: ["quickSale", "byWeight", "combos"],
  textil: ["variants"],
  retail: [],
  restaurante: ["tables", "combos"],
  pyme: [],
  otro: [],
};

export function isVertical(value: string | null | undefined): value is Vertical {
  return !!value && (VERTICALS as readonly string[]).includes(value);
}

// ¿El rubro habilita una función?
export function verticalHas(
  industry: string | null | undefined,
  feature: VerticalFeature,
): boolean {
  if (!isVertical(industry)) return false;
  return VERTICAL_FEATURES[industry].includes(feature);
}

// Lista de features activas para un rubro (para UI/diagnóstico).
export function verticalFeatures(
  industry: string | null | undefined,
): VerticalFeature[] {
  return isVertical(industry) ? VERTICAL_FEATURES[industry] : [];
}
