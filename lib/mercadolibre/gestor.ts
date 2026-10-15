// Gestor de Mercado Libre (H141 · ADR-132): secciones y puesta en marcha.
// PURO: lo usan la pantalla, los estados vacíos y los tests.

export type GestorSection = "items" | "orders" | "questions" | "shipments" | "postsale" | "boards" | "metrics" | "config";

export interface SectionInfo {
  key: GestorSection;
  label: string;
  /** Qué se hace ahí, en una línea. */
  summary: string;
  /** Feature que la habilita además de `mercadolibre` (null = sólo la base). */
  feature: "mercadolibre_gestor" | null;
}

export const GESTOR_SECTIONS: SectionInfo[] = [
  {
    key: "items",
    label: "Publicaciones",
    summary: "Publicá rápido desde tu catálogo, en Clásica y Premium con el precio de cada tipo, y pausá, activá o sincronizá lo publicado.",
    feature: null,
  },
  {
    key: "orders",
    label: "Ventas",
    summary: "Las ventas de Mercado Libre entran solas al POS con su comisión, descuentan stock y se facturan como elijas.",
    feature: null,
  },
  {
    key: "questions",
    label: "Preguntas",
    summary: "Respondé las preguntas de los compradores sin salir del POS.",
    feature: null,
  },
  {
    key: "shipments",
    label: "Envíos",
    summary: "Estado de cada envío e impresión de etiquetas en PDF o para la Zebra.",
    feature: null,
  },
  {
    key: "postsale",
    label: "Posventa",
    summary: "Reclamos, mediaciones y devoluciones con su vencimiento: respondé, pedí la mediación de Mercado Libre o aceptá la devolución.",
    feature: "mercadolibre_gestor",
  },
  {
    key: "boards",
    label: "Embudos",
    summary: "Tableros de ventas y de posventa: mové cada caso de etapa y asignalo a alguien del equipo.",
    feature: "mercadolibre_gestor",
  },
  {
    key: "metrics",
    label: "Métricas",
    summary: "Tu reputación, cuánto margen te queda antes de perder el verde y los casos que la afectan.",
    feature: "mercadolibre_gestor",
  },
  {
    key: "config",
    label: "Configuración",
    summary: "Precios por tipo de publicación, stock publicable, facturación, plantillas, umbrales y avisos.",
    feature: null,
  },
];

export const sectionInfo = (k: GestorSection) => GESTOR_SECTIONS.find((s) => s.key === k)!;

export interface SetupInput {
  status: string;
  storeId: string | null;
  rulesCount: number;
  invoiceMode: string;
  invoiceConfirmed: boolean;
  /** Llegó al menos una notificación por webhook (los tópicos están tildados). */
  webhookSeen: boolean;
}

export interface SetupStep {
  key: "account" | "stock" | "prices" | "invoice" | "topics";
  label: string;
  hint: string;
  done: boolean;
}

/** Checklist de puesta en marcha de una cuenta recién conectada. */
export function setupSteps(i: SetupInput): SetupStep[] {
  return [
    {
      key: "account",
      label: "Cuenta conectada",
      hint: i.status === "active" ? "Lista para publicar y recibir ventas." : "Reconectá la cuenta desde Configuración.",
      done: i.status === "active",
    },
    {
      key: "stock",
      label: "Sucursal del stock",
      hint: "De qué sucursal o depósito sale el stock que publicás y dónde se descuentan las ventas.",
      done: Boolean(i.storeId),
    },
    {
      key: "prices",
      label: "Precios por tipo de publicación",
      hint: "Recargo o lista de precios para Clásica y Premium.",
      done: i.rulesCount > 0,
    },
    {
      key: "invoice",
      label: "Facturación de las ventas",
      hint: "Al pagarse, al despacharse, a mano o sin factura.",
      done: i.invoiceConfirmed || (i.invoiceMode !== "manual" && i.invoiceMode !== ""),
    },
    {
      key: "topics",
      label: "Notificaciones de Mercado Libre",
      hint: "Llega la primera notificación cuando NinjaSoft tiene los tópicos activos. Mientras tanto, todo se revisa cada 10 minutos.",
      done: i.webhookSeen,
    },
  ];
}

/** Se muestra mientras falte algo y la cuenta tenga menos de 30 días. */
export function showSetup(steps: SetupStep[], connectedAt: string, now = Date.now()): boolean {
  const days = (now - Date.parse(connectedAt)) / 86_400_000;
  return steps.some((s) => !s.done) && Number.isFinite(days) && days < 30;
}
