// =============================================================================
// Sucursal nueva desde otra sucursal o desde una plantilla (F17 · H89 · H92 ·
// ADR-057). Lógica pura: qué partes se pueden copiar, cuáles vienen marcadas,
// qué trae una plantilla y cómo se cuenta el resultado. El servidor
// (store_copy_setup) vuelve a validar todo y aplica por config_override_set.
// =============================================================================

export type SetupPart = "config" | "payment_methods" | "printers" | "plans" | "staff";
export type SetupSource = "inherit" | "store" | "template";

export interface SetupPartDef {
  key: SetupPart;
  label: string;
  desc: string;
  /** Viene marcada por defecto. */
  default: boolean;
  /** Sólo se puede copiar de una sucursal real (nunca de una plantilla). */
  storeOnly?: boolean;
}

export const SETUP_PARTS: SetupPartDef[] = [
  {
    key: "config",
    label: "Operación y ticket",
    desc: "Redondeo, stock negativo, cierre de caja, display y datos del ticket que la sucursal pisa.",
    default: true,
  },
  {
    key: "payment_methods",
    label: "Medios de pago",
    desc: "Qué medios acepta, recargos, modo de planes y n° de comercio de la sucursal.",
    default: true,
  },
  {
    key: "printers",
    label: "Impresoras y perfiles",
    desc: "Las impresoras de la sucursal (sin caja) y qué documento sale por cada una.",
    default: true,
  },
  {
    key: "plans",
    label: "Planes de cuotas propios",
    desc: "Los planes y recargos que la sucursal pisa del negocio.",
    default: true,
  },
  {
    key: "staff",
    label: "Personal",
    desc: "Acceso adicional a la sucursal nueva para el personal vigente de la origen, con su rol.",
    default: false,
    storeOnly: true,
  },
];

/** Partes que se ofrecen para un origen. */
export function partsFor(source: SetupSource, templateParts?: readonly string[] | null): SetupPartDef[] {
  if (source === "inherit") return [];
  return SETUP_PARTS.filter((p) => {
    if (source === "template") {
      if (p.storeOnly) return false;
      return !templateParts || templateParts.includes(p.key);
    }
    return true;
  });
}

/** Partes marcadas por defecto para un origen. */
export function defaultParts(source: SetupSource, templateParts?: readonly string[] | null): SetupPart[] {
  return partsFor(source, templateParts)
    .filter((p) => p.default)
    .map((p) => p.key);
}

/** Lo que se manda al servidor (en el orden canónico, sin repetidos ni inválidos). */
export function normalizeParts(selected: readonly string[], source: SetupSource, templateParts?: readonly string[] | null): SetupPart[] {
  const allowed = new Set(partsFor(source, templateParts).map((p) => p.key));
  return SETUP_PARTS.map((p) => p.key).filter((k) => allowed.has(k) && selected.includes(k));
}

export interface TemplatePayload {
  overrides?: { domain: string; domain_key: string; patch: Record<string, unknown> }[];
  printers?: unknown[];
  plans?: unknown[];
}

/** Resumen de una plantilla: cuántas cosas trae de cada tipo. */
export function templateSummary(payload: TemplatePayload | null | undefined): {
  config: number;
  paymentMethods: number;
  printers: number;
  plans: number;
} {
  const ov = payload?.overrides ?? [];
  return {
    config: ov.filter((o) => o.domain === "pos_settings" || o.domain === "ticket").length,
    paymentMethods: ov.filter((o) => o.domain === "payment_method").length,
    printers: (payload?.printers ?? []).length,
    plans: (payload?.plans ?? []).length,
  };
}

export interface CopyCounts {
  overrides?: number;
  printers?: number;
  plans?: number;
  staff?: number;
  skipped?: number;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Texto del resultado de store_copy_setup. */
export function copyResultMessage(c: CopyCounts): string {
  const bits: string[] = [];
  if (c.overrides) bits.push(plural(c.overrides, "ajuste", "ajustes"));
  if (c.printers) bits.push(plural(c.printers, "impresora", "impresoras"));
  if (c.plans) bits.push(plural(c.plans, "plan", "planes"));
  if (c.staff) bits.push(plural(c.staff, "persona", "personas"));
  const main = bits.length ? `Se copiaron ${bits.join(", ")}.` : "No había nada para copiar: la sucursal hereda todo del negocio.";
  return c.skipped ? `${main} ${plural(c.skipped, "item no se pudo copiar", "items no se pudieron copiar")} (fuera del plan o ya existentes).` : main;
}
