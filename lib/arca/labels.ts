// Facturación electrónica ARCA (F3 · ADR-072): textos, estados, glosario y
// modelo del asistente. PURO (sin React ni red): lo usan la pantalla de
// Configuración > Facturación electrónica, el monitor, el detalle de la venta
// y el ticket.

import type { BadgeTone } from "@/components/ui/Badge";

export type ArcaEnv = "homologacion" | "produccion";
export type AuthMode = "propio" | "delegado";
export type FiscalStatus =
  | "pendiente"
  | "enviando"
  | "aprobado"
  | "rechazado"
  | "requiere_accion"
  | "cancelado";

export const ENV_LABEL: Record<ArcaEnv, string> = {
  homologacion: "Modo prueba",
  produccion: "Facturando en real",
};

export const ENV_SHORT: Record<ArcaEnv, string> = {
  homologacion: "Prueba",
  produccion: "Real",
};

export const STATUS_INFO: Record<FiscalStatus, { label: string; tone: BadgeTone; hint: string }> = {
  pendiente: {
    label: "Pendiente",
    tone: "neutral",
    hint: "La factura está en la cola y se pide a ARCA en segundo plano.",
  },
  enviando: { label: "Enviando", tone: "info", hint: "NinjaSoft está pidiendo el CAE a ARCA." },
  aprobado: { label: "Aprobada", tone: "success", hint: "ARCA autorizó la factura." },
  rechazado: {
    label: "Rechazada",
    tone: "danger",
    hint: "ARCA rechazó la factura. Revisá el motivo, corregí y reprocesá.",
  },
  requiere_accion: {
    label: "Requiere acción",
    tone: "warning",
    hint: "Falta algo para poder facturar. Mirá el detalle para saber qué hacer.",
  },
  cancelado: { label: "Cancelada", tone: "neutral", hint: "La venta se anuló antes de facturar." },
};

export function statusInfo(status: string | null | undefined) {
  return STATUS_INFO[(status ?? "pendiente") as FiscalStatus] ?? STATUS_INFO.pendiente;
}

export const ORIGIN_LABEL: Record<string, string> = {
  sale: "Venta",
  return: "Devolución",
  void: "Anulación",
};

// ---------------------------------------------------------------------------
// Glosario: cada término técnico que aparece en pantalla tiene su explicación
// simple (tooltip <Term />).
// ---------------------------------------------------------------------------
export type GlossaryKey =
  | "homologacion"
  | "produccion"
  | "certificado"
  | "csr"
  | "clave_privada"
  | "punto_venta"
  | "cae"
  | "caea"
  | "wsass"
  | "alias"
  | "wsfe"
  | "cuit_representada"
  | "delegacion"
  | "contingencia"
  | "clave_fiscal";

export const GLOSSARY: Record<GlossaryKey, { term: string; text: string }> = {
  homologacion: {
    term: "Homologación",
    text: "Es el modo de prueba de ARCA. Las facturas no tienen validez fiscal: sirve para probar todo sin riesgo antes de facturar en serio.",
  },
  produccion: {
    term: "Producción",
    text: "Es el modo real: cada factura que se emite vale ante ARCA y entra en tus declaraciones.",
  },
  certificado: {
    term: "Certificado",
    text: "Es la llave que autoriza a NinjaSoft a facturar en tu nombre. Lo emite ARCA a partir de un pedido que genera NinjaSoft.",
  },
  csr: {
    term: "Pedido de certificado (CSR)",
    text: "Un texto que genera NinjaSoft y que pegás en ARCA para que te devuelva el certificado. No es secreto: podés copiarlo tranquilo.",
  },
  clave_privada: {
    term: "Clave privada",
    text: "La otra mitad del certificado. La genera y la guarda NinjaSoft cifrada en el servidor; nunca viaja a tu navegador ni hace falta que la veas.",
  },
  punto_venta: {
    term: "Punto de venta",
    text: "Es un número de caja fiscal que das de alta en ARCA (por ejemplo 0003). Cada factura lleva ese número adelante: 00003-00000012.",
  },
  cae: {
    term: "CAE",
    text: "Código de Autorización Electrónico: el número que devuelve ARCA y que hace válida la factura. Sale impreso en el ticket con su vencimiento y el QR.",
  },
  caea: {
    term: "CAEA",
    text: "Código de Autorización Electrónico Anticipado: un código que ARCA entrega por quincena, por adelantado, para seguir facturando aunque ARCA no responda. Después se informan esas facturas.",
  },
  wsass: {
    term: "WSASS",
    text: "Autogestión de certificados de homologación: el servicio de ARCA donde se crean los certificados de prueba.",
  },
  alias: {
    term: "Alias",
    text: "El nombre con el que ARCA reconoce a tu certificado (por ejemplo ninjapos20123456789). Lo vas a ver al autorizar el servicio.",
  },
  wsfe: {
    term: "wsfe",
    text: "El nombre técnico del servicio de Facturación Electrónica de ARCA. Es el que hay que autorizar para el certificado.",
  },
  cuit_representada: {
    term: "CUIT representada",
    text: "La CUIT en cuyo nombre se emiten las facturas: la de tu negocio.",
  },
  delegacion: {
    term: "Delegación",
    text: "Autorizás desde ARCA a NinjaSoft a facturar por vos. No hace falta certificado propio: es la opción más simple.",
  },
  contingencia: {
    term: "Contingencia",
    text: "Plan B para cuando ARCA no responde: la factura sale igual con el CAEA de la quincena y se informa a ARCA después.",
  },
  clave_fiscal: {
    term: "Clave fiscal",
    text: "Tu usuario y contraseña para entrar a ARCA. Para estos trámites hace falta nivel 3 o superior.",
  },
};

// ---------------------------------------------------------------------------
// Formatos
// ---------------------------------------------------------------------------
export function formatFiscalNumber(ptoVta: number | null | undefined, nro: number | null | undefined): string {
  const p = String(Math.max(0, Math.trunc(Number(ptoVta ?? 0)))).padStart(5, "0");
  const n = String(Math.max(0, Math.trunc(Number(nro ?? 0)))).padStart(8, "0");
  return `${p}-${n}`;
}

/** AAAA-MM-DD → DD/MM/AAAA. */
export function formatFiscalDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

/** Días hasta que vence el certificado (negativo = vencido). */
export function certDaysLeft(notAfter: string | null | undefined, now: Date = new Date()): number | null {
  if (!notAfter) return null;
  const t = new Date(notAfter).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((t - now.getTime()) / 86_400_000);
}

export type CertExpiry = { days: number | null; level: "ok" | "warn" | "expired" | "none" };

/** Aviso del vencimiento: warn con 30 días o menos. */
export function certExpiry(notAfter: string | null | undefined, now: Date = new Date()): CertExpiry {
  const days = certDaysLeft(notAfter, now);
  if (days == null) return { days: null, level: "none" };
  if (days < 0) return { days, level: "expired" };
  if (days <= 30) return { days, level: "warn" };
  return { days, level: "ok" };
}

export function certExpiryText(e: CertExpiry): string {
  if (e.level === "none" || e.days == null) return "Sin certificado";
  if (e.level === "expired") return "El certificado venció";
  if (e.days === 0) return "El certificado vence hoy";
  if (e.days === 1) return "El certificado vence mañana";
  return `El certificado vence en ${e.days} días`;
}

// ---------------------------------------------------------------------------
// Checklist de producción
// ---------------------------------------------------------------------------
export const CHECKLIST_LABEL: Record<string, { label: string; help: string }> = {
  fiscal_data: {
    label: "Datos fiscales del negocio",
    help: "CUIT y condición frente al IVA cargados en Configuración > Impuestos.",
  },
  certificado: {
    label: "Certificado de producción válido",
    help: "Certificado real (emitido por Computadores) vigente y de la CUIT del negocio, o la delegación en NinjaSoft.",
  },
  homologacion_ok: {
    label: "Facturas de prueba aprobadas",
    help: "Al menos algunas facturas aprobadas en modo prueba, para asegurarse de que todo funciona.",
  },
  conexion_produccion: {
    label: "Prueba de conexión real OK",
    help: "Probar conexión en modo real en los últimos 7 días: acceso, servicio autorizado y último número.",
  },
  puntos_de_venta: {
    label: "Puntos de venta verificados",
    help: "Cada punto de venta que usan tus sucursales existe en ARCA como Web Services.",
  },
};

// ---------------------------------------------------------------------------
// Asistente
// ---------------------------------------------------------------------------
export type WizardStepKey =
  | "datos"
  | "camino"
  | "certificado"
  | "autorizar"
  | "punto_venta"
  | "prueba"
  | "contingencia"
  | "produccion";

export const WIZARD_STEPS: { key: WizardStepKey; title: string; short: string; optional?: boolean }[] = [
  { key: "datos", title: "Datos del negocio", short: "Datos" },
  { key: "camino", title: "Cómo vas a facturar", short: "Camino" },
  { key: "certificado", title: "Certificado", short: "Certificado" },
  { key: "autorizar", title: "Autorizar el servicio", short: "Autorizar" },
  { key: "punto_venta", title: "Punto de venta", short: "Punto de venta" },
  { key: "prueba", title: "Probar y activar", short: "Prueba" },
  { key: "contingencia", title: "Facturar sin conexión a ARCA", short: "Contingencia", optional: true },
  { key: "produccion", title: "Pasar a facturar en real", short: "Real" },
];

/** Forma mínima de la configuración que necesita el modelo del asistente. */
export interface WizardConfigLike {
  settings: {
    enabled?: boolean;
    auth_mode?: AuthMode;
    environment?: ArcaEnv;
    last_connection_ok?: boolean | null;
    last_connection_env?: ArcaEnv | null;
    caea_enabled?: boolean;
  } | null;
  emitter: { cuit: string | null; iva_condition: string | null };
  certificates: { environment: ArcaEnv; status: string; not_after: string | null }[];
  platform: Partial<Record<ArcaEnv, { ready: boolean }>>;
  stores: { afip_pos_number: number | null }[];
}

export function wizardStepsDone(c: WizardConfigLike, now: Date = new Date()): Record<WizardStepKey, boolean> {
  const s = c.settings;
  const env: ArcaEnv = s?.environment ?? "homologacion";
  const mode: AuthMode = s?.auth_mode ?? "propio";
  const certOk =
    mode === "delegado"
      ? Boolean(c.platform[env]?.ready)
      : c.certificates.some(
          (x) => x.environment === env && x.status === "active" && (certDaysLeft(x.not_after, now) ?? -1) >= 0,
        );
  const connected = Boolean(s?.last_connection_ok) && s?.last_connection_env === env;
  return {
    datos: Boolean(c.emitter.cuit && c.emitter.iva_condition),
    camino: s != null,
    certificado: certOk,
    autorizar: certOk && connected,
    punto_venta: c.stores.length > 0 && c.stores.every((x) => x.afip_pos_number != null),
    prueba: Boolean(s?.enabled) && connected,
    contingencia: Boolean(s?.caea_enabled),
    produccion: env === "produccion",
  };
}

/** Primer paso obligatorio sin completar (o el último si está todo). */
export function currentWizardStep(c: WizardConfigLike, now: Date = new Date()): WizardStepKey {
  const done = wizardStepsDone(c, now);
  const next = WIZARD_STEPS.find((s) => !s.optional && !done[s.key]);
  return next?.key ?? "produccion";
}

/** Progreso (0 a 100) sobre los pasos obligatorios. */
export function wizardProgress(c: WizardConfigLike, now: Date = new Date()): number {
  const done = wizardStepsDone(c, now);
  const req = WIZARD_STEPS.filter((s) => !s.optional);
  return Math.round((req.filter((s) => done[s.key]).length / req.length) * 100);
}

// ---------------------------------------------------------------------------
// Errores de la pantalla (RPC)
// ---------------------------------------------------------------------------
export function arcaErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e ?? "");
  const map: [RegExp, string][] = [
    [/feature_not_in_plan/, "Tu plan no incluye la facturación electrónica."],
    [/owner_required/, "Sólo el dueño puede pasar a facturar en real."],
    [/forbidden/, "Sólo el dueño o un encargado pueden hacer esto."],
    [/fiscal_data_missing/, "Primero cargá la CUIT y la condición frente al IVA en Configuración > Impuestos."],
    [/certificate_missing/, "Falta el certificado de este modo. Completá el paso Certificado."],
    [/platform_not_configured/, "La delegación en NinjaSoft todavía no está disponible."],
    [/auth_mode_locked_in_production/, "Para cambiar de camino primero volvé al modo prueba."],
    [/caea_pto_vta_missing/, "Elegí el punto de venta exclusivo de contingencia."],
    [/caea_pto_vta_in_use/, "Ese punto de venta ya lo usa una sucursal o caja. La contingencia necesita uno propio."],
    [/checklist_incomplete/, "Todavía falta completar la lista para facturar en real."],
    [/not_enabled/, "Primero activá la facturación electrónica."],
    [/already_enqueued/, "Esa venta ya tiene su factura en la cola."],
    [/invalid_status/, "Ese comprobante no se puede reprocesar en su estado actual."],
    [/not_found/, "No se encontró."],
  ];
  for (const [re, text] of map) if (re.test(msg)) return text;
  return msg || "No se pudo completar.";
}

// ---------------------------------------------------------------------------
// Enlaces de ARCA
// ---------------------------------------------------------------------------
export const ARCA_LINKS = {
  login: "https://auth.afip.gob.ar/contribuyente_/login.xhtml",
  wsass: "https://wsass-homo.afip.gob.ar/wsass/portal/main.aspx",
} as const;
