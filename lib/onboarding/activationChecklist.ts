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

// Orden de la puesta en marcha (ADR-150): Marca → Ticket → Email → Medios de
// pago (el paso más importante, destacado) → Productos → Caja → Primera venta →
// Equipo → Facturación ARCA → pasos del rubro (salón, agenda) → Escuela.
// "fiscal" y "mp" quedan como señales (las usa el panel interno) pero ya no
// son pasos: los datos fiscales van dentro de Marca y Mercado Pago dentro de
// Medios de pago.
export type ChecklistKey =
  | "marca"
  | "ticket"
  | "email"
  | "pagos"
  | "producto"
  | "caja"
  | "venta"
  | "equipo"
  | "arca"
  | "mesas"
  | "agenda"
  | "escuela"
  | "fiscal"
  | "mp";

export type ChecklistStatus = Partial<Record<ChecklistKey, boolean>>;

export interface ChecklistStep {
  key: ChecklistKey;
  label: string;
  desc: string;
  cta: string;
  href: string;
  /** Artículo de ayuda que explica el paso (content/help). */
  helpId: string | null;
  /** Paso clave: se muestra destacado aunque no sea el siguiente. */
  highlight?: boolean;
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

const isServices = (ctx: ChecklistContext) => ctx.profile?.vertical === "servicios";

const STEP_DEFS: StepDef[] = [
  {
    key: "marca",
    label: "Tu marca",
    desc: "Subí tu logo y completá los datos del negocio: salen en tickets, facturas y el catálogo.",
    cta: "Subir logo",
    href: "/configuracion?seccion=marca",
    helpId: null,
    when: always,
  },
  {
    key: "ticket",
    label: "Diseño de ticket",
    desc: "Elegí cómo se ve el comprobante que entregás.",
    cta: "Elegir diseño",
    href: "/configuracion?seccion=tickets",
    helpId: null,
    when: always,
  },
  {
    key: "email",
    label: "Email de comprobantes",
    desc: "Elegí desde qué email les llegan a tus clientes los tickets y las facturas.",
    cta: "Configurar email",
    href: "/configuracion?seccion=email",
    helpId: null,
    when: always,
  },
  {
    key: "pagos",
    label: "Medios de pago",
    desc: "Conectá Mercado Pago, tu posnet o tu cuenta para transferencias y cobrá como quieran tus clientes.",
    cta: "Configurar cobros",
    href: "/configuracion?seccion=pagos",
    helpId: "pos-medios-de-pago",
    highlight: true,
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
    key: "caja",
    label: "Abrí la caja",
    desc: "Abrí un turno de caja con el efectivo inicial para controlar el día.",
    cta: "Abrir caja",
    href: "/caja",
    helpId: "caja-abrir",
    when: (ctx) => feature(ctx, "caja"),
  },
  {
    key: "venta",
    label: "Primera venta",
    desc: "Cerrá una venta de prueba y mirá cómo sale el comprobante.",
    cta: "Vender",
    href: "/pos",
    helpId: "pos-cobrar-venta",
    when: always,
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
    when: (ctx) => isServices(ctx) && feature(ctx, "agenda"),
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
];

// Copy por rubro: un estudio o consultora carga servicios, no productos.
function adaptToProfile(step: ChecklistStep, ctx: ChecklistContext): ChecklistStep {
  if (step.key === "producto" && isServices(ctx)) {
    return {
      ...step,
      label: "Cargá tus servicios",
      desc: "Sumá tus honorarios por hora, visita, informe o análisis.",
    };
  }
  return step;
}

/** Perfil a usar: el aplicado; si no hay, el sugerido por el rubro del alta. */
export function checklistProfile(appliedKey: string | null | undefined, industry: string | null | undefined) {
  return getProfile(appliedKey) ?? getProfile(profileForVertical(industry));
}

export function buildActivationChecklist(ctx: ChecklistContext): ChecklistStep[] {
  return STEP_DEFS.filter((s) => s.when(ctx)).map(({ when: _when, ...step }) => adaptToProfile(step, ctx));
}

/**
 * Estado de los pasos a partir de las señales de la base. Con la migración
 * 20261218100000 sin aplicar, onboarding_status no trae marca/email/pagos:
 * Medios de pago cae a "Mercado Pago conectado" y los otros dos quedan
 * pendientes (nunca se marcan sin un dato real).
 */
export function checklistStatusFromSignals(signals: Record<string, unknown>): ChecklistStatus {
  const b = (k: string) => signals[k] === true;
  const has = (k: string) => typeof signals[k] === "boolean";
  return {
    marca: b("marca"),
    ticket: b("ticket"),
    email: b("email"),
    pagos: has("pagos") ? b("pagos") : b("mp"),
    producto: b("producto"),
    caja: b("caja"),
    venta: b("venta"),
    equipo: b("equipo"),
    arca: b("arca"),
    mesas: b("mesas"),
    agenda: b("agenda"),
    escuela: b("escuela"),
    fiscal: b("fiscal"),
    mp: b("mp"),
  };
}

/** Primer paso pendiente (en el orden de la puesta en marcha) o null. */
export function nextPendingStep(steps: readonly ChecklistStep[], status: ChecklistStatus): ChecklistStep | null {
  return steps.find((s) => status[s.key] !== true) ?? null;
}

/** Pasos que pasaron a completos respecto de los que ya se sabían hechos. */
export function newlyCompletedSteps(
  steps: readonly ChecklistStep[],
  status: ChecklistStatus,
  knownDone: readonly string[],
): ChecklistStep[] {
  const known = new Set(knownDone);
  return steps.filter((s) => status[s.key] === true && !known.has(s.key));
}

export function checklistProgress(steps: readonly ChecklistStep[], status: ChecklistStatus) {
  const done = steps.filter((s) => status[s.key] === true).length;
  const total = steps.length;
  return { done, total, pct: total === 0 ? 100 : Math.round((done / total) * 100), allDone: done === total };
}

export const CHECKLIST_KEYS: readonly ChecklistKey[] = STEP_DEFS.map((s) => s.key);
