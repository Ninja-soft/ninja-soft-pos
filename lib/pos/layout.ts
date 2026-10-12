// Diseño del POS (pos_settings.pos_layout + override por usuario en
// users.settings.pos_layout). Es un FLAG-OPERATIVO (CLAUDE.md §6): el dueño
// elige cómo se ve su pantalla de venta, sin costo de plan. La única parte con
// gating de plan son las teclas rápidas "pro" (más de QUICK_KEYS_BASE_MAX o con
// color por tecla → feature `pos_quick_keys_pro`, validado por trigger en
// pos_settings).
//
// Todo lo que se lee de la base pasa por `sanitizeLayout`: un valor inválido
// (o de una versión futura) se descarta campo por campo y cae al default del
// preset, nunca rompe la pantalla.

import { z } from "zod";

export const POS_PRESETS = ["mostrador", "boutique", "salon", "caja_rapida"] as const;
export type PosPreset = (typeof POS_PRESETS)[number];

export const QUICK_KEYS_BASE_MAX = 12;
export const QUICK_KEYS_PRO_MAX = 48;
export const QUICK_KEY_COLORS = ["flame", "gold", "violet", "ocean", "mint", "rose", "slate"] as const;
export type QuickKeyColor = (typeof QUICK_KEY_COLORS)[number];

export const POS_ACCENTS = ["fire", "violet", "ocean", "mint"] as const;
export type PosAccent = (typeof POS_ACCENTS)[number];

const quickKeySchema = z.object({
  productId: z.string().uuid(),
  label: z.string().trim().max(24).optional(),
  color: z.enum(QUICK_KEY_COLORS).optional(),
});
export type QuickKey = z.infer<typeof quickKeySchema>;

const paymentsSchema = z.object({
  order: z.array(z.string().max(40)).max(20),
  hidden: z.array(z.string().max(40)).max(40),
  pinned: z.array(z.string().max(40)).max(3),
  quickCash: z.array(z.number().positive().max(10_000_000)).max(6),
});

// Forma COMPLETA (resuelta). Lo guardado es un subconjunto (override).
export const posLayoutSchema = z.object({
  preset: z.enum(POS_PRESETS),
  density: z.enum(["compact", "comfortable", "spacious"]),
  tileSize: z.enum(["s", "m", "l"]),
  columns: z.enum(["auto", "3", "4", "5", "6", "8"]),
  categoryBar: z.enum(["top", "left", "hidden"]),
  showImages: z.boolean(),
  showStock: z.boolean(),
  cartSide: z.enum(["right", "left"]),
  mobileCart: z.enum(["sticky_bar", "tabs"]),
  quickKeys: z.array(quickKeySchema).max(QUICK_KEYS_PRO_MAX),
  accent: z.enum(POS_ACCENTS),
  fontScale: z.number().min(0.85).max(1.25),
  payments: paymentsSchema,
  keypad: z.boolean(),
  tipPresets: z.array(z.number().min(0).max(100)).max(5),
});
export type PosLayout = z.infer<typeof posLayoutSchema>;
export type PosLayoutOverride = Partial<PosLayout>;

const BASE: PosLayout = {
  preset: "mostrador",
  density: "comfortable",
  tileSize: "m",
  columns: "auto",
  categoryBar: "top",
  showImages: false,
  showStock: true,
  cartSide: "right",
  mobileCart: "sticky_bar",
  quickKeys: [],
  accent: "fire",
  fontScale: 1,
  payments: { order: [], hidden: [], pinned: [], quickCash: [] },
  keypad: false,
  tipPresets: [10, 15, 20],
};

// Defaults de cada preset: el dueño elige un preset y después ajusta encima.
export const PRESET_DEFAULTS: Record<PosPreset, PosLayout> = {
  mostrador: { ...BASE, preset: "mostrador", density: "compact", tileSize: "s" },
  boutique: {
    ...BASE,
    preset: "boutique",
    tileSize: "l",
    categoryBar: "left",
    showImages: true,
    density: "spacious",
  },
  salon: { ...BASE, preset: "salon", tileSize: "m", showStock: false },
  caja_rapida: {
    ...BASE,
    preset: "caja_rapida",
    density: "compact",
    tileSize: "s",
    categoryBar: "hidden",
    keypad: true,
    tipPresets: [],
  },
};

export const PRESET_INFO: Record<
  PosPreset,
  { name: string; tagline: string; bestFor: string; requiresDining?: boolean }
> = {
  mostrador: {
    name: "Mostrador",
    tagline: "Grilla densa y cobro en un toque",
    bestFor: "Kioscos, almacenes y minimercados",
  },
  boutique: {
    name: "Boutique",
    tagline: "Fotos grandes y categorías a un costado",
    bestFor: "Indumentaria, calzado y regalería",
  },
  salon: {
    name: "Salón",
    tagline: "Mesas, carta y cuenta en una sola pantalla",
    bestFor: "Bares, restaurantes y cafeterías",
    requiresDining: true,
  },
  caja_rapida: {
    name: "Caja rápida",
    tagline: "Escáner, PLU y teclado numérico primero",
    bestFor: "Supermercados, verdulerías y servicios",
  },
};

const KEYS = Object.keys(posLayoutSchema.shape) as (keyof PosLayout)[];

// Ajustes que dependen del preset (densidad, grilla, carrito…).
export const PRESET_VISUAL_KEYS = [
  "density",
  "tileSize",
  "columns",
  "categoryBar",
  "showImages",
  "showStock",
  "cartSide",
  "mobileCart",
  "keypad",
] as const satisfies readonly (keyof PosLayout)[];

/**
 * Valida un override guardado campo por campo. Lo inválido se descarta (no
 * rompe ni pisa el default). `allowQuickKeys=false` lo saca del resultado (el
 * override por usuario no puede traer teclas rápidas: son del negocio).
 */
export function sanitizeLayout(raw: unknown, opts: { allowQuickKeys?: boolean } = {}): PosLayoutOverride {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const src = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of KEYS) {
    if (!(key in src)) continue;
    if (key === "quickKeys" && opts.allowQuickKeys === false) continue;
    const field = posLayoutSchema.shape[key];
    if (key === "payments") {
      // payments se valida por sub-campo para no perder todo por uno malo.
      const p = src.payments;
      if (!p || typeof p !== "object") continue;
      const pv: Record<string, unknown> = {};
      for (const sub of Object.keys(paymentsSchema.shape) as (keyof typeof paymentsSchema.shape)[]) {
        const r = paymentsSchema.shape[sub].safeParse((p as Record<string, unknown>)[sub]);
        if (r.success) pv[sub] = r.data;
      }
      out.payments = pv;
      continue;
    }
    const r = field.safeParse(src[key]);
    if (r.success) out[key] = r.data;
  }
  return out as PosLayoutOverride;
}

/**
 * Layout efectivo: defaults del preset ← override del negocio ← override del
 * usuario. El preset del usuario (si lo eligió) decide qué defaults aplican.
 */
export function resolveLayout(business: unknown, user?: unknown): PosLayout {
  const b = sanitizeLayout(business);
  const u = sanitizeLayout(user, { allowQuickKeys: false });
  const preset = u.preset ?? b.preset ?? "mostrador";
  // Si el usuario eligió OTRO preset, los ajustes visuales del negocio (pensados
  // para su preset) no se arrastran: quedan los defaults del preset elegido.
  if (u.preset && u.preset !== (b.preset ?? "mostrador")) {
    for (const k of PRESET_VISUAL_KEYS) delete b[k];
  }
  const base = PRESET_DEFAULTS[preset];
  const payments = {
    ...base.payments,
    ...(b.payments ?? {}),
    ...(u.payments ?? {}),
  };
  return { ...base, ...b, ...u, preset, payments, quickKeys: b.quickKeys ?? base.quickKeys };
}

/** ¿El layout necesita la feature pos_quick_keys_pro? (espejo del trigger). */
export function layoutNeedsQuickKeysPro(layout: Pick<PosLayout, "quickKeys">): boolean {
  return (
    layout.quickKeys.length > QUICK_KEYS_BASE_MAX ||
    layout.quickKeys.some((k) => Boolean(k.color))
  );
}

/** Columnas de la grilla para `columns` + tamaño de tile (CSS min px). */
export function tileMinWidth(tileSize: PosLayout["tileSize"], preset: PosPreset): number {
  if (preset === "boutique") return tileSize === "s" ? 128 : tileSize === "m" ? 146 : 160;
  return tileSize === "s" ? 118 : tileSize === "m" ? 148 : 182;
}

export const ACCENT_GRADIENT: Record<PosAccent, { from: string; via: string; to: string; ink: string }> = {
  fire: { from: "#FF4B22", via: "#FF8A1F", to: "#FFD21F", ink: "#0B0720" },
  violet: { from: "#5B2EFF", via: "#7C4DFF", to: "#B79CFF", ink: "#FFFFFF" },
  ocean: { from: "#0369A1", via: "#0EA5E9", to: "#67E8F9", ink: "#04121C" },
  mint: { from: "#047857", via: "#10B981", to: "#6EE7B7", ink: "#03140E" },
};
