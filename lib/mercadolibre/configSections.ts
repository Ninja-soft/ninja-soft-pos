// Configuración de Mercado Libre por secciones (fix "publicar antibalas").
// PURO: qué secciones hay, qué explica cada una y si está configurada. Lo
// usan la pestaña Configuración, la puesta en marcha y los tests.
import { INVOICE_MODE_LABELS } from "./labels";

export type ConfigSection = "cuenta" | "publicaciones" | "envios" | "facturacion" | "posventa" | "preguntas";

export interface ConfigSectionInfo {
  key: ConfigSection;
  label: string;
  /** Qué se configura ahí, en una línea. */
  summary: string;
}

export const CONFIG_SECTIONS: ConfigSectionInfo[] = [
  { key: "cuenta", label: "Cuenta", summary: "La cuenta de Mercado Libre conectada, su estado y la sincronización con el POS." },
  {
    key: "publicaciones",
    label: "Publicaciones y precios",
    summary: "El precio de cada tipo de publicación, de qué sucursal sale el stock y cuánto se publica.",
  },
  { key: "envios", label: "Envíos", summary: "Si tu cuenta tiene Mercado Envíos, qué formas de envío podés ofrecer y el formato de las etiquetas." },
  { key: "facturacion", label: "Facturación", summary: "Cuándo se facturan las ventas de Mercado Libre y si la factura se sube sola a la venta." },
  { key: "posventa", label: "Posventa", summary: "Umbrales de reputación, avisos de reclamos y plantillas para responder reclamos y mensajes." },
  { key: "preguntas", label: "Preguntas", summary: "Respuestas rápidas para las preguntas que más se repiten." },
];

export const isConfigSection = (v: string | null | undefined): v is ConfigSection => CONFIG_SECTIONS.some((s) => s.key === v);

export type SectionState = "ok" | "missing" | "info" | "loading";

export interface ConfigStatusInput {
  status: string;
  storeId: string | null;
  rulesCount: number;
  invoiceMode: string;
  invoiceConfirmed: boolean;
  /** status.mercadoenvios de la cuenta (undefined = cargando, null = no se pudo leer). */
  mercadoEnvios: string | null | undefined;
  /** Feature `mercadolibre_gestor` (undefined = cargando). */
  gestor: boolean | undefined;
  /** Hay ajustes de posventa guardados (si no, rigen los de Mercado Libre). */
  gestorConfigured: boolean;
  questionTemplates: number;
}

export interface SectionStatus {
  state: SectionState;
  label: string;
}

/** Estado de cada sección: configurado, falta algo o sólo informativo. */
export function configStatus(i: ConfigStatusInput): Record<ConfigSection, SectionStatus> {
  const invoiceDone = i.invoiceConfirmed || (i.invoiceMode !== "manual" && i.invoiceMode !== "");
  return {
    cuenta: i.status === "active" ? { state: "ok", label: "Conectada" } : { state: "missing", label: "Reconectar" },
    publicaciones: !i.storeId
      ? { state: "missing", label: "Falta la sucursal" }
      : i.rulesCount === 0
        ? { state: "missing", label: "Faltan los precios por tipo" }
        : { state: "ok", label: "Configurado" },
    envios:
      i.mercadoEnvios === undefined
        ? { state: "loading", label: "Consultando" }
        : i.mercadoEnvios === "accepted"
          ? { state: "ok", label: "Mercado Envíos activo" }
          : i.mercadoEnvios === null
            ? { state: "info", label: "Sin datos de Mercado Libre" }
            : { state: "info", label: "Sin Mercado Envíos" },
    facturacion: invoiceDone
      ? { state: "ok", label: INVOICE_MODE_LABELS[i.invoiceMode] ?? (i.invoiceConfirmed ? "A mano" : "Configurado") }
      : { state: "missing", label: "Elegí cuándo facturar" },
    posventa:
      i.gestor === undefined
        ? { state: "loading", label: "Consultando" }
        : !i.gestor
          ? { state: "info", label: "No incluido en tu plan" }
          : i.gestorConfigured
            ? { state: "ok", label: "Configurado" }
            : { state: "info", label: "Valores de Mercado Libre" },
    preguntas:
      i.gestor === false
        ? { state: "info", label: "Respuestas rápidas en el gestor" }
        : i.questionTemplates > 0
          ? { state: "ok", label: `${i.questionTemplates} ${i.questionTemplates === 1 ? "respuesta rápida" : "respuestas rápidas"}` }
          : { state: "info", label: "Sin respuestas rápidas" },
  };
}

/** Sección de configuración que resuelve cada paso de la puesta en marcha. */
export const SETUP_TARGET: Record<"account" | "stock" | "prices" | "invoice" | "topics", ConfigSection> = {
  account: "cuenta",
  stock: "publicaciones",
  prices: "publicaciones",
  invoice: "facturacion",
  topics: "cuenta",
};

/** Formas de envío de Mercado Libre en español. */
export const SHIPPING_MODE_NAMES: Record<string, string> = {
  me2: "Mercado Envíos",
  me1: "Mercado Envíos 1 (envío propio con etiqueta de ML)",
  custom: "Envío con costo fijo",
  not_specified: "Envío a convenir",
};
