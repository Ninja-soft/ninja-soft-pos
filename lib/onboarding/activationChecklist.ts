// Checklist de activación dinámico por rubro (F15 · H71 parcial · ADR-086).
//
// Reutiliza lo que ya existe y no lo duplica:
//  * Perfiles por rubro (ADR-075): los flags del perfil aplicado (o el sugerido
//    por el rubro del alta) deciden los pasos propios del rubro (salón, agenda).
//  * onboarding_status(): los cinco pasos base de la "Puesta en marcha".
//  * onboarding_activation_status() (migración 20261108100200): señales nuevas
//    del negocio (caja, equipo, salón, agenda, ARCA, Escuela). Las métricas de
//    activación de plataforma (primer cobro, recurrencia) siguen en
//    internal_tenant_activation (ADR-082) y no se repiten acá.
//
// Lógica pura para testear qué pasos ve cada rubro y plan.
import { getProfile, profileForVertical, type BusinessProfile } from "@/lib/profiles/businessProfiles";

export type ChecklistKey =
  | "fiscal"
  | "producto"
  | "mp"
  | "ticket"
  | "caja"
  | "equipo"
  | "mesas"
  | "agenda"
  | "arca"
  | "escuela"
  | "venta";

export type ChecklistStatus = Partial<Record<ChecklistKey, boolean>>;

export interface ChecklistStep {
  key: ChecklistKey;
  label: string;
  desc: string;
  cta: string;
  href: string;
  /** Artículo de ayuda que explica el paso (content/help). */
  helpId: string | null;
}

interface StepDef extends ChecklistStep {
  /** Cuándo aplica el paso al negocio. */
  when: (ctx: ChecklistContext) => boolean;
}

export interface ChecklistContext {
  profile: BusinessProfile | null;
  features: Record<string, boolean>;
}

const hasFlag = (ctx: ChecklistContext, flag: string) => Boolean(ctx.profile?.flags.includes(flag as never));
// Optimista como el gating de plan: una feature que no vino en el mapa no se oculta.
const feature = (ctx: ChecklistContext, key: string) => ctx.features[key] !== false;
const always = () => true;

const STEP_DEFS: StepDef[] = [
  {
    key: "fiscal",
    label: "Datos del negocio",
    desc: "Razón social, CUIT y condición de IVA para tus comprobantes.",
    cta: "Completar",
    href: "/configuracion?seccion=marca",
    helpId: null,
    when: always,
  },
  {
    key: "producto",
    label: "Cargá productos",
    desc: "Sumá tu primer artículo o importá tu lista desde Excel.",
    cta: "Cargar",
    href: "/productos",
    helpId: "productos-alta",
    when: always,
  },
  {
    key: "mp",
    label: "Medios de pago",
    desc: "Conectá Mercado Pago y cobrá con QR desde el POS.",
    cta: "Conectar",
    href: "/configuracion?seccion=pagos",
    helpId: "pos-medios-de-pago",
    when: always,
  },
  {
    key: "ticket",
    label: "Diseño de ticket",
    desc: "Elegí cómo se ve el comprobante que entregás.",
    cta: "Elegir",
    href: "/configuracion?seccion=tickets",
    helpId: null,
    when: always,
  },
  {
    key: "mesas",
    label: "Armá el salón",
    desc: "Cargá tus mesas para tomar pedidos y mandar comandas a la cocina.",
    cta: "Ir al salón",
    href: "/salon",
    helpId: "mesas-comandas",
    when: (ctx) => hasFlag(ctx, "dining_enabled"),
  },
  {
    key: "agenda",
    label: "Primer turno en la agenda",
    desc: "Cargá un profesional y agendá un turno de prueba.",
    cta: "Ir a la agenda",
    href: "/agenda",
    helpId: "agenda-turnos",
    when: (ctx) => ctx.profile?.vertical === "servicios" && feature(ctx, "agenda"),
  },
  {
    key: "caja",
    label: "Abrí la caja",
    desc: "Abrí un turno de caja con el efectivo inicial para controlar el día.",
    cta: "Abrir caja",
    href: "/caja",
    helpId: "caja-abrir",
    when: (ctx) => feature(ctx, "caja"),
  },
  {
    key: "equipo",
    label: "Invitá a tu equipo",
    desc: "Sumá a tu cajero o encargado con su propio usuario y rol.",
    cta: "Invitar",
    href: "/dashboard-team",
    helpId: "usuarios-permisos",
    when: always,
  },
  {
    key: "escuela",
    label: "Certificá a tu cajero",
    desc: "El curso POS básico de la Escuela deja a tu equipo listo para cobrar.",
    cta: "Ver curso",
    href: "/escuela/pos-basico",
    helpId: null,
    when: (ctx) => feature(ctx, "escuela"),
  },
  {
    key: "arca",
    label: "Facturación ARCA",
    desc: "Terminá el asistente y pasá a producción para emitir facturas electrónicas.",
    cta: "Configurar",
    href: "/configuracion?seccion=facturacion",
    helpId: "arca-facturacion",
    // Sólo si el plan la incluye: "AFIP cuando aplique".
    when: (ctx) => ctx.features.facturacion_afip === true,
  },
  {
    key: "venta",
    label: "Primera venta",
    desc: "Cerrá una venta de prueba y dejá todo listo.",
    cta: "Vender",
    href: "/pos",
    helpId: "pos-cobrar-venta",
    when: always,
  },
];

/** Perfil a usar: el aplicado; si no hay, el sugerido por el rubro del alta. */
export function checklistProfile(appliedKey: string | null | undefined, industry: string | null | undefined) {
  return getProfile(appliedKey) ?? getProfile(profileForVertical(industry));
}

export function buildActivationChecklist(ctx: ChecklistContext): ChecklistStep[] {
  return STEP_DEFS.filter((s) => s.when(ctx)).map(({ when: _when, ...step }) => step);
}

export function checklistProgress(steps: readonly ChecklistStep[], status: ChecklistStatus) {
  const done = steps.filter((s) => status[s.key] === true).length;
  const total = steps.length;
  return { done, total, pct: total === 0 ? 100 : Math.round((done / total) * 100), allDone: done === total };
}

export const CHECKLIST_KEYS: readonly ChecklistKey[] = STEP_DEFS.map((s) => s.key);
