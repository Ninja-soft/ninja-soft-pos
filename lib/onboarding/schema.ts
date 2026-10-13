// =============================================================================
// Recorridos guiados y sugerencias (F15 · H70, H74 · ADR-089): esquema de la
// configuración que el staff edita en /internal/onboarding. Espejo de
// onboarding_steps_valid y onboarding_audience_valid (migración
// 20261108300100): un test compara las reglas con casos de los dos lados.
// =============================================================================
import { z } from "zod";

export const ONBOARDING_EVENTS = [
  "registro",
  "primer_login",
  "sin_productos",
  "sin_caja_abierta",
  "sin_primera_venta",
  "trial_por_vencer",
  "venta_fallida",
  "manual",
] as const;
export type OnboardingEvent = (typeof ONBOARDING_EVENTS)[number];

export const EVENT_LABELS: Record<OnboardingEvent, string> = {
  registro: "Registro (primera semana)",
  primer_login: "Primer ingreso del usuario",
  sin_productos: "Sin productos",
  sin_caja_abierta: "Sin caja abierta",
  sin_primera_venta: "Sin primera venta",
  trial_por_vencer: "Prueba por vencer (3 días)",
  venta_fallida: "Venta fallida",
  manual: "Manual o correctivo",
};

/** Eventos que avisa el navegador (no son un estado del negocio). */
export const PUSH_EVENTS: readonly OnboardingEvent[] = ["venta_fallida"];

export const PLACEMENTS = ["tooltip", "spotlight", "modal"] as const;
export type Placement = (typeof PLACEMENTS)[number];

export const PLACEMENT_LABELS: Record<Placement, string> = {
  tooltip: "Globo junto al elemento",
  spotlight: "Foco (oscurece el resto)",
  modal: "Ventana centrada",
};

export const STATUSES = ["draft", "published", "paused", "archived"] as const;
export type ConfigStatus = (typeof STATUSES)[number];

export const STATUS_LABELS: Record<ConfigStatus, string> = {
  draft: "Borrador",
  published: "Publicado",
  paused: "Pausado",
  archived: "Archivado",
};

export const AUDIENCE_ROLES = ["owner", "manager", "cashier", "viewer"] as const;
export const ROLE_LABELS: Record<string, string> = {
  owner: "Dueño",
  manager: "Encargado",
  cashier: "Cajero",
  viewer: "Solo lectura",
};

const EM_DASH = String.fromCharCode(0x2014);
const NO_EM_DASH = (s: string) => !s.includes(EM_DASH);
const SLUG = /^[a-z0-9][a-z0-9-]{1,59}$/;
const STEP_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ROUTE = /^\/[a-z0-9/_-]*$/;
const HREF = /^\/[a-z0-9/_?=&.-]*$/;

export const tourActionSchema = z.object({
  label: z.string().min(2).max(40),
  href: z.string().regex(HREF, "Sólo rutas internas, por ejemplo /productos"),
});

export const tourStepSchema = z
  .object({
    id: z.string().regex(STEP_ID),
    title: z.string().min(2).max(80).refine(NO_EM_DASH, "Sin em dash"),
    body: z.string().max(400).refine(NO_EM_DASH, "Sin em dash").optional(),
    placement: z.enum(PLACEMENTS).default("tooltip"),
    anchor: z.string().regex(SLUG).optional(),
    route: z.string().regex(ROUTE).optional(),
    advance: z.enum(["next", "click"]).default("next"),
    block: z.boolean().optional(),
    action: tourActionSchema.nullish(),
  })
  .superRefine((s, ctx) => {
    if (s.placement !== "modal" && !s.anchor) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Un globo o foco necesita un ancla", path: ["anchor"] });
    }
    if (s.advance === "click" && !s.anchor) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Avanzar al tocar necesita un ancla", path: ["advance"] });
    }
  });
export type TourStep = z.infer<typeof tourStepSchema>;

export const tourStepsSchema = z
  .array(tourStepSchema)
  .min(1)
  .max(20)
  .superRefine((steps, ctx) => {
    const seen = new Set<string>();
    steps.forEach((s, i) => {
      if (seen.has(s.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Id de paso repetido", path: [i, "id"] });
      seen.add(s.id);
    });
  });

export const audienceSchema = z
  .object({
    plans: z.array(z.string().min(1).max(60)).max(50).optional(),
    statuses: z.array(z.string().min(1).max(60)).max(50).optional(),
    industries: z.array(z.string().min(1).max(60)).max(50).optional(),
    roles: z.array(z.enum(AUDIENCE_ROLES)).max(50).optional(),
    features: z.array(z.string().min(1).max(60)).max(50).optional(),
    min_days: z.number().min(0).max(3650).optional(),
    max_days: z.number().min(0).max(3650).optional(),
  })
  .strict()
  .refine((a) => a.min_days === undefined || a.max_days === undefined || a.min_days <= a.max_days, {
    message: "Mínimo de días mayor que el máximo",
  });
export type Audience = z.infer<typeof audienceSchema>;

export const tourDraftSchema = z.object({
  key: z.string().regex(SLUG),
  title: z.string().min(3).max(120).refine(NO_EM_DASH),
  description: z.string().max(500).refine(NO_EM_DASH).optional(),
  trigger_event: z.enum(ONBOARDING_EVENTS),
  priority: z.number().int().min(0).max(100),
  audience: audienceSchema,
  steps: tourStepsSchema,
});
export type TourDraft = z.infer<typeof tourDraftSchema>;

export const nudgeDraftSchema = z
  .object({
    key: z.string().regex(SLUG),
    title: z.string().min(3).max(80).refine(NO_EM_DASH, "Sin em dash"),
    body: z.string().max(300).refine(NO_EM_DASH, "Sin em dash").optional(),
    event: z.enum(ONBOARDING_EVENTS),
    audience: audienceSchema,
    priority: z.number().int().min(0).max(100),
    cooldown_hours: z.number().int().min(1).max(720),
    max_impressions: z.number().int().min(1).max(50),
    starts_at: z.string().nullable().optional(),
    expires_at: z.string().nullable().optional(),
    cta_label: z.string().min(2).max(40).nullable().optional(),
    cta_href: z
      .string()
      .regex(/^(\/[a-z0-9/_?=&.-]*|tour:[a-z0-9][a-z0-9-]{1,59})$/, "Ruta interna o tour:clave")
      .nullable()
      .optional(),
    support_fallback: z.boolean(),
  })
  .refine((n) => !n.cta_label === !n.cta_href, { message: "El botón necesita texto y destino", path: ["cta_href"] })
  .refine((n) => !n.starts_at || !n.expires_at || n.expires_at > n.starts_at, {
    message: "La expiración tiene que ser posterior al inicio",
    path: ["expires_at"],
  });
export type NudgeDraft = z.infer<typeof nudgeDraftSchema>;

/** Primer mensaje de error legible de un parse de Zod. */
export function firstIssue(err: z.ZodError): string {
  const i = err.issues[0];
  if (!i) return "Datos inválidos";
  const path = i.path.length ? `${i.path.join(".")}: ` : "";
  return `${path}${i.message}`;
}

/** Anclas data-tour que existen en la UI (un test las busca en el TSX). */
export const KNOWN_ANCHORS = [
  "pos-caja",
  "pos-buscar",
  "pos-favoritos",
  "pos-cobrar",
  "caja-abrir-confirmar",
  "productos-nuevo",
  "config-medios-pago",
] as const;
