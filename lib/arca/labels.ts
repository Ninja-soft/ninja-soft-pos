// Facturación electrónica ARCA (F3 · ADR-072): textos, estados, glosario y
// modelo del asistente. PURO (sin React ni red): lo usan la pantalla de
// Configuración > Facturación electrónica, el monitor, el detalle de la venta
// y el ticket.

import type { BadgeTone } from "@/components/ui/Badge";
import { humanError } from "@/supabase/functions/_shared/arca/errors";

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
  settings: (ConnectionSettingsLike & {
    enabled?: boolean;
    auth_mode?: AuthMode;
    environment?: ArcaEnv;
    caea_enabled?: boolean;
  }) | null;
  emitter: { cuit: string | null; iva_condition: string | null };
  certificates: { environment: ArcaEnv; status: string; not_after: string | null }[];
  platform: Partial<Record<ArcaEnv, { ready: boolean }>>;
  stores: { afip_pos_number: number | null }[];
  /** Checklist del servidor: de acá sale cuántas facturas de prueba aprobó ARCA. */
  checklist?: { items: { key: string; ok?: boolean; count?: number }[] };
}

// ---------------------------------------------------------------------------
// Conexión por ambiente (ADR-149). Cada ambiente guarda su última prueba
// completa (arca_settings.connection_by_env); probar producción ya no pisa lo
// hecho en homologación. Sin la migración se cae a last_connection_*.
// ---------------------------------------------------------------------------
export interface ConnectionStep {
  key: string;
  ok: boolean;
  code?: string | null;
  message?: string | null;
}

export interface ConnectionState {
  ok: boolean;
  at: string | null;
  code: string | null;
  message: string | null;
  steps: ConnectionStep[];
  /** Puntos de venta Web Services que listó ARCA en esa prueba (null = no se supo). */
  pos: number[] | null;
}

export interface ConnectionSettingsLike {
  last_connection_at?: string | null;
  last_connection_ok?: boolean | null;
  last_connection_env?: ArcaEnv | null;
  last_connection_message?: string | null;
  connection_by_env?: Partial<Record<ArcaEnv, Partial<ConnectionState> | null>> | null;
}

/** Código probable a partir del texto de ARCA (datos viejos sin código). */
export function inferArcaCode(message: string | null | undefined): string | null {
  const m = String(message ?? "");
  if (/no autorizado a acceder al servicio/i.test(m)) return "coe.notAuthorized";
  if (/expired|vencid/i.test(m) && /cert/i.test(m)) return "cms.cert.expired";
  if (/untrusted|no es confiable/i.test(m)) return "cms.cert.untrusted";
  if (/generationTime/i.test(m)) return "xml.generationTime.invalid";
  return null;
}

export function connectionFor(s: ConnectionSettingsLike | null | undefined, env: ArcaEnv): ConnectionState | null {
  const e = s?.connection_by_env?.[env];
  if (e && typeof e === "object" && "ok" in e) {
    return {
      ok: Boolean(e.ok),
      at: e.at ?? null,
      code: e.code ?? (e.ok ? null : inferArcaCode(e.message)),
      message: e.message ?? null,
      steps: Array.isArray(e.steps) ? e.steps : [],
      pos: Array.isArray(e.pos) ? e.pos : null,
    };
  }
  if (s?.last_connection_env === env && (s.last_connection_at || s.last_connection_ok != null)) {
    const ok = Boolean(s.last_connection_ok);
    return {
      ok,
      at: s.last_connection_at ?? null,
      code: ok ? null : inferArcaCode(s.last_connection_message),
      message: s.last_connection_message ?? null,
      steps: [],
      pos: null,
    };
  }
  return null;
}

/** Facturas aprobadas en homologación (prueban que el acceso de prueba funciona). */
function homoApproved(c: WizardConfigLike): number {
  return c.checklist?.items.find((i) => i.key === "homologacion_ok")?.count ?? 0;
}

/**
 * ¿El ambiente está conectado? La última prueba guardada de ESE ambiente
 * manda; si nunca se probó, en homologación alcanza con facturas aprobadas.
 */
export function envConnected(c: WizardConfigLike, env: ArcaEnv): boolean {
  const conn = connectionFor(c.settings, env);
  if (conn) return conn.ok || (env === "homologacion" && authStepOk(conn) && homoApproved(c) > 0);
  return env === "homologacion" && homoApproved(c) > 0;
}

/** ¿La prueba pasó el acceso (WSAA)? Con pasos guardados se mira ese paso. */
export function authStepOk(conn: ConnectionState | null): boolean {
  if (!conn) return false;
  if (conn.ok) return true;
  const w = conn.steps.find((x) => x.key === "wsaa");
  if (w) return w.ok;
  if (conn.steps.some((x) => x.key === "certificado" && !x.ok)) return false;
  // Datos viejos sin pasos: si el error no es de acceso, el acceso anduvo.
  return Boolean(conn.code) && !isAccessCode(conn.code);
}

function isAccessCode(code: string | null | undefined): boolean {
  const c = String(code ?? "").toLowerCase();
  return /^(coe|cms|xml|ns\d*:)/.test(c) || ["ta_ya_emitido", "certificado_faltante", "certificado_ilegible", "cuit_distinta", "sin_respuesta", "fiscal_data_missing"].includes(c);
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
  const connected = envConnected(c, env);
  return {
    datos: Boolean(c.emitter.cuit && c.emitter.iva_condition),
    camino: s != null,
    certificado: certOk,
    autorizar: certOk && (connected || authStepOk(connectionFor(s, env))),
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
// Guía para pasar a facturar en real (ADR-149). Cada paso con su estado real,
// derivado de lo que guardó el servidor (checklist, certificados y la última
// prueba de producción), así se ve dónde quedó aunque se salga y se vuelva.
// ---------------------------------------------------------------------------
export type ProdStepKey = "pruebas" | "certificado" | "autorizar" | "punto_venta" | "prueba_real" | "activar";
export type ProdStepState = "ok" | "todo" | "error" | "locked";

export interface ProdStep {
  key: ProdStepKey;
  state: ProdStepState;
  /** Código del error (ARCA o propio) cuando state = error. */
  code?: string | null;
  /** Qué pasó y qué hacer, en lenguaje simple. */
  title?: string;
  action?: string;
  /** Puntos de venta usados que ARCA no lista como Web Services. */
  missing?: number[];
}

export interface ProductionConfigLike extends WizardConfigLike {
  certificates: { environment: ArcaEnv; status: string; not_after: string | null; cuit?: string | null; subject?: string | null }[];
  checklist: { ready: boolean; items: { key: string; ok?: boolean; count?: number; min?: number; required?: boolean; pos?: number[]; verified?: number[] }[] };
  can_owner?: boolean;
}

export const PROD_STEP_LABEL: Record<ProdStepKey, string> = {
  pruebas: "Facturas de prueba aprobadas",
  certificado: "Certificado de producción",
  autorizar: "Autorizar el servicio en ARCA",
  punto_venta: "Punto de venta de producción",
  prueba_real: "Prueba de conexión real",
  activar: "Facturar en real",
};

export const PROD_STATE_LABEL: Record<ProdStepState, { label: string; tone: BadgeTone }> = {
  ok: { label: "Listo", tone: "success" },
  todo: { label: "Falta", tone: "warning" },
  error: { label: "Con error", tone: "danger" },
  locked: { label: "Después", tone: "neutral" },
};

function withHelp(step: ProdStep, fallback?: string | null): ProdStep {
  if (step.state !== "error") return step;
  const h = humanError(step.code ?? null, fallback ?? null);
  return { ...step, title: step.title ?? h.title, action: step.action ?? h.action };
}

export function productionSteps(c: ProductionConfigLike, now: Date = new Date()): ProdStep[] {
  const s = c.settings;
  const deleg = s?.auth_mode === "delegado";
  const item = (k: string) => c.checklist.items.find((i) => i.key === k);
  const conn = connectionFor(s, "produccion");
  const step = (k: string) => conn?.steps.find((x) => x.key === k) ?? null;
  const out: ProdStep[] = [];

  // 1. Facturas de prueba (sólo con certificado propio).
  const homo = item("homologacion_ok");
  out.push({ key: "pruebas", state: deleg || homo?.ok ? "ok" : "todo" });

  // 2. Certificado de producción.
  const certOk = Boolean(item("certificado")?.ok);
  let cert: ProdStep = { key: "certificado", state: certOk ? "ok" : "todo" };
  if (!deleg) {
    const active = c.certificates.find((x) => x.environment === "produccion" && x.status === "active");
    const certStep = step("certificado");
    if (active && c.emitter.cuit && active.cuit && active.cuit !== c.emitter.cuit) {
      cert = { key: "certificado", state: "error", code: "cuit_distinta" };
    } else if (active && (certDaysLeft(active.not_after, now) ?? -1) < 0) {
      cert = { key: "certificado", state: "error", code: "cms.cert.expired" };
    } else if (!certOk && certStep && !certStep.ok && certStep.code !== "certificado_faltante") {
      cert = { key: "certificado", state: "error", code: certStep.code ?? null };
    }
  }
  out.push(withHelp(cert));
  const certReady = cert.state === "ok";

  // 3. Autorizar wsfe para el alias (o la delegación): lo prueba el login WSAA.
  let auth: ProdStep;
  if (!certReady) auth = { key: "autorizar", state: "locked" };
  else if (!conn) auth = { key: "autorizar", state: "todo" };
  else if (authStepOk(conn)) auth = { key: "autorizar", state: "ok" };
  else {
    const w = step("wsaa");
    const code = w?.code ?? conn.code ?? inferArcaCode(conn.message);
    auth = { key: "autorizar", state: "error", code };
  }
  out.push(withHelp(auth, conn?.message));
  const authReady = auth.state === "ok";

  // 4. Puntos de venta de producción (Web Services, mismo número que la sucursal).
  const posItem = item("puntos_de_venta");
  const used = c.stores.map((x) => x.afip_pos_number).filter((x): x is number => x != null);
  let pv: ProdStep;
  if (c.stores.length === 0 || used.length < c.stores.length) {
    pv = { key: "punto_venta", state: "todo", code: "sin_punto_de_venta" };
  } else if (posItem?.ok) {
    pv = { key: "punto_venta", state: "ok" };
  } else if (!authReady) {
    pv = { key: "punto_venta", state: "locked" };
  } else {
    const listed = conn?.pos ?? (posItem?.verified?.length ? posItem.verified : null);
    const pvStep = step("pv_sucursales");
    const missing = listed ? used.filter((n) => !listed.includes(n)) : [];
    if (missing.length) pv = { key: "punto_venta", state: "error", code: "pv_no_habilitado", missing: [...new Set(missing)] };
    else if (pvStep && !pvStep.ok) pv = { key: "punto_venta", state: "error", code: pvStep.code ?? "pv_no_habilitado" };
    else pv = { key: "punto_venta", state: "todo" };
  }
  out.push(withHelp(pv));

  // 5. Prueba real completa (acceso, FEDummy, puntos de venta, último comprobante).
  const testOk = Boolean(item("conexion_produccion")?.ok);
  let test: ProdStep;
  if (testOk && conn?.ok !== false) test = { key: "prueba_real", state: "ok" };
  else if (!authReady) test = { key: "prueba_real", state: "locked" };
  else if (conn && !conn.ok) {
    const failed = conn.steps.find((x) => !x.ok && x.key !== "pv_sucursales");
    test = failed ? { key: "prueba_real", state: "error", code: failed.code ?? null } : { key: "prueba_real", state: pv.state === "error" ? "locked" : "todo" };
  } else test = { key: "prueba_real", state: "todo" };
  out.push(withHelp(test, conn?.message));

  // 6. Interruptor.
  const live = s?.environment === "produccion";
  out.push({ key: "activar", state: live ? "ok" : c.checklist.ready ? "todo" : "locked" });
  return out;
}

/** El primer paso que falta o tiene error (el que conviene abrir). */
export function currentProdStep(steps: ProdStep[]): ProdStepKey {
  return (steps.find((x) => x.state === "error" || x.state === "todo") ?? steps[steps.length - 1])?.key ?? "activar";
}

/** Alias del certificado (CN del subject). */
export function aliasOf(subject: string | null | undefined): string | null {
  const m = /CN=([^,]+)/.exec(subject ?? "");
  return m ? (m[1] as string).trim() : null;
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
    [/not_saved/, "No se guardó: sólo el dueño o un encargado pueden cambiarlo. Volvé a entrar y probá de nuevo."],
    [/Failed to fetch|NetworkError|network/i, "No hay conexión con NinjaSoft. Revisá internet y probá de nuevo."],
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
