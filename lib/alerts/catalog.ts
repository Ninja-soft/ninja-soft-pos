// =============================================================================
// Catálogo de alertas programadas (F24 · H162, ADR-176).
//
// ESPEJO de alert_catalog() en supabase/migrations/20270114100000_h162_alertas.sql
// (tests/unit/alertsCatalog.test.ts compara los dos: tipos, etiquetas,
// severidad, frecuencia, umbrales con su valor por defecto y su rango). El
// servidor es la barrera: valida los umbrales al guardar y evalúa las reglas.
// =============================================================================

export type AlertKind =
  | "stock_bajo"
  | "stock_negativo"
  | "venta_bajo_costo"
  | "deuda_vencida"
  | "cheques_por_vencer"
  | "facturas_compra_por_vencer"
  | "caja_sin_cerrar"
  | "comprobantes_sin_cae"
  | "mercaderia_parada"
  | "ajustes_grandes"
  | "descuentos_altos"
  | "presupuestos_por_vencer"
  | "clientes_inactivos"
  | "aumento_costo"
  | "certificado_arca"
  | "anulaciones";

export type AlertFrequency = "hourly" | "daily" | "weekly";
export type AlertSeverity = "info" | "warning" | "critical";
export type AlertRole = "owner" | "manager" | "cashier" | "viewer";

export interface AlertParamDef {
  label: string;
  /** Unidad que se muestra al lado del número. */
  unit: string;
  default: number;
  min: number;
  max: number;
  hint?: string;
}

export interface AlertKindDef {
  label: string;
  description: string;
  severity: AlertSeverity;
  url: string;
  frequency: AlertFrequency;
  hour: number;
  weekdays: number[];
  /** Singular y plural de lo que cuenta (para "Stock bajo: 5 productos"). */
  noun: [string, string];
  /** Rubro en la pantalla de configuración. */
  group: "Stock" | "Ventas" | "Caja y facturación" | "Cobranzas y pagos" | "Clientes";
  params: Record<string, AlertParamDef>;
}

const HOURS = (def: number): AlertParamDef => ({
  label: "Mirar las últimas",
  unit: "horas",
  default: def,
  min: 1,
  max: 168,
});

export const ALERT_CATALOG: Record<AlertKind, AlertKindDef> = {
  stock_bajo: {
    label: "Stock bajo el mínimo",
    description: "Productos con control de stock que llegaron a su mínimo (por sucursal si elegís una).",
    severity: "warning",
    url: "/inventario",
    frequency: "daily",
    hour: 8,
    weekdays: [],
    noun: ["producto", "productos"],
    group: "Stock",
    params: {},
  },
  stock_negativo: {
    label: "Stock negativo",
    description: "Productos que quedaron con stock menor a cero: falta cargar una compra o hay un error de conteo.",
    severity: "warning",
    url: "/inventario",
    frequency: "daily",
    hour: 8,
    weekdays: [],
    noun: ["producto", "productos"],
    group: "Stock",
    params: {},
  },
  venta_bajo_costo: {
    label: "Ventas bajo costo",
    description: "Renglones vendidos a un precio menor que su costo.",
    severity: "critical",
    url: "/ventas",
    frequency: "daily",
    hour: 8,
    weekdays: [],
    noun: ["renglón", "renglones"],
    group: "Ventas",
    params: { hours: HOURS(24) },
  },
  deuda_vencida: {
    label: "Deuda vencida de clientes",
    description: "Clientes con cuenta corriente que tienen saldo vencido hace más de los días que elijas.",
    severity: "warning",
    url: "/clientes/cuentas",
    frequency: "daily",
    hour: 8,
    weekdays: [],
    noun: ["cliente", "clientes"],
    group: "Cobranzas y pagos",
    params: { days: { label: "Vencida hace más de", unit: "días", default: 30, min: 1, max: 365 } },
  },
  cheques_por_vencer: {
    label: "Cheques por vencer",
    description: "Cheques de terceros en cartera para depositar y cheques propios entregados que se debitan pronto.",
    severity: "warning",
    url: "/tesoreria",
    frequency: "daily",
    hour: 8,
    weekdays: [],
    noun: ["cheque", "cheques"],
    group: "Cobranzas y pagos",
    params: { days: { label: "Vencen en los próximos", unit: "días", default: 7, min: 0, max: 60 } },
  },
  facturas_compra_por_vencer: {
    label: "Facturas de compra por vencer",
    description: "Facturas de proveedores con saldo que vencen pronto o ya vencieron.",
    severity: "warning",
    url: "/compras",
    frequency: "daily",
    hour: 8,
    weekdays: [],
    noun: ["factura", "facturas"],
    group: "Cobranzas y pagos",
    params: { days: { label: "Vencen en los próximos", unit: "días", default: 7, min: 0, max: 60 } },
  },
  caja_sin_cerrar: {
    label: "Cajas sin cerrar",
    description: "Turnos de caja que siguen abiertos hace más de las horas que elijas.",
    severity: "warning",
    url: "/caja",
    frequency: "daily",
    hour: 8,
    weekdays: [],
    noun: ["caja", "cajas"],
    group: "Caja y facturación",
    params: { hours: { label: "Abierta hace más de", unit: "horas", default: 12, min: 1, max: 72 } },
  },
  comprobantes_sin_cae: {
    label: "Comprobantes sin CAE",
    description: "Facturas y notas de crédito de producción pendientes, rechazadas o que piden una acción.",
    severity: "critical",
    url: "/ventas",
    frequency: "hourly",
    hour: 8,
    weekdays: [],
    noun: ["comprobante", "comprobantes"],
    group: "Caja y facturación",
    params: { minutes: { label: "Sin CAE hace más de", unit: "minutos", default: 30, min: 5, max: 1440 } },
  },
  mercaderia_parada: {
    label: "Mercadería parada",
    description: "Productos con stock que no se vendieron en los últimos días: el total a costo y los 10 de más valor.",
    severity: "info",
    url: "/inventario",
    frequency: "weekly",
    hour: 8,
    weekdays: [1],
    noun: ["producto", "productos"],
    group: "Stock",
    params: { days: { label: "Sin ventas en", unit: "días", default: 60, min: 7, max: 365 } },
  },
  ajustes_grandes: {
    label: "Ajustes de stock grandes",
    description: "Ajustes de stock (aplicados o por aprobar) que superan una cantidad o un valor.",
    severity: "warning",
    url: "/inventario",
    frequency: "daily",
    hour: 8,
    weekdays: [],
    noun: ["ajuste", "ajustes"],
    group: "Stock",
    params: {
      hours: HOURS(24),
      qty: { label: "Desde", unit: "unidades", default: 50, min: 0, max: 1_000_000, hint: "0 = no mirar la cantidad." },
      value: { label: "O desde", unit: "$", default: 100_000, min: 0, max: 10_000_000_000, hint: "0 = no mirar el valor." },
    },
  },
  descuentos_altos: {
    label: "Descuentos altos",
    description: "Ventas con un descuento sobre el subtotal mayor al porcentaje que elijas.",
    severity: "warning",
    url: "/ventas",
    frequency: "daily",
    hour: 8,
    weekdays: [],
    noun: ["venta", "ventas"],
    group: "Ventas",
    params: { hours: HOURS(24), pct: { label: "Descuento desde", unit: "%", default: 20, min: 1, max: 100 } },
  },
  presupuestos_por_vencer: {
    label: "Presupuestos por vencer",
    description: "Presupuestos enviados que todavía no se aceptaron y vencen pronto.",
    severity: "info",
    url: "/presupuestos",
    frequency: "daily",
    hour: 8,
    weekdays: [],
    noun: ["presupuesto", "presupuestos"],
    group: "Ventas",
    params: { days: { label: "Vencen en los próximos", unit: "días", default: 3, min: 0, max: 60 } },
  },
  clientes_inactivos: {
    label: "Clientes que dejaron de comprar",
    description: "Clientes que compraban seguido y hace tiempo que no vuelven.",
    severity: "info",
    url: "/clientes",
    frequency: "weekly",
    hour: 8,
    weekdays: [1],
    noun: ["cliente", "clientes"],
    group: "Clientes",
    params: {
      days: { label: "Sin comprar hace", unit: "días", default: 60, min: 7, max: 730 },
      min_purchases: { label: "Con al menos", unit: "compras", default: 3, min: 1, max: 100 },
    },
  },
  aumento_costo: {
    label: "Aumentos de costo",
    description: "Productos cuyo costo subió más del porcentaje que elijas (por una compra o una lista).",
    severity: "warning",
    url: "/productos",
    frequency: "daily",
    hour: 8,
    weekdays: [],
    noun: ["producto", "productos"],
    group: "Stock",
    params: { hours: HOURS(24), pct: { label: "Aumento desde", unit: "%", default: 10, min: 1, max: 1000 } },
  },
  certificado_arca: {
    label: "Certificado de ARCA por vencer",
    description: "El certificado para facturar vence pronto: renovalo antes para no quedarte sin CAE.",
    severity: "critical",
    url: "/configuracion?seccion=facturacion",
    frequency: "daily",
    hour: 8,
    weekdays: [],
    noun: ["certificado", "certificados"],
    group: "Caja y facturación",
    params: { days: { label: "Vence en los próximos", unit: "días", default: 30, min: 1, max: 120 } },
  },
  anulaciones: {
    label: "Anulaciones",
    description: "Avisa cuando las ventas anuladas en el período llegan a la cantidad que elijas, con el detalle.",
    severity: "warning",
    url: "/ventas",
    frequency: "daily",
    hour: 8,
    weekdays: [],
    noun: ["anulación", "anulaciones"],
    group: "Ventas",
    params: { hours: HOURS(24), count: { label: "Desde", unit: "anulaciones", default: 5, min: 1, max: 1000 } },
  },
};

export const ALERT_KINDS = Object.keys(ALERT_CATALOG) as AlertKind[];

export const ALERT_GROUPS: AlertKindDef["group"][] = [
  "Stock",
  "Ventas",
  "Caja y facturación",
  "Cobranzas y pagos",
  "Clientes",
];

export const FREQUENCY_LABEL: Record<AlertFrequency, string> = {
  hourly: "Cada hora",
  daily: "Todos los días",
  weekly: "Algunos días",
};

export const ROLE_LABEL: Record<AlertRole, string> = {
  owner: "Dueño",
  manager: "Encargados",
  cashier: "Cajeros",
  viewer: "Solo lectura",
};

/** 0 = domingo ... 6 = sábado (como Date.getDay y extract(dow)). */
export const WEEKDAY_SHORT = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

export function isAlertKind(k: string): k is AlertKind {
  return Object.prototype.hasOwnProperty.call(ALERT_CATALOG, k);
}

export function defaultParams(kind: AlertKind): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, d] of Object.entries(ALERT_CATALOG[kind].params)) out[k] = d.default;
  return out;
}

/** Errores por umbral (mismo criterio que alert_rule_save). Vacío = válido. */
export function validateParams(kind: AlertKind, params: Record<string, unknown>): Record<string, string> {
  const errors: Record<string, string> = {};
  const defs = ALERT_CATALOG[kind].params;
  for (const [k, v] of Object.entries(params)) {
    const d = defs[k];
    if (!d) {
      errors[k] = "Umbral desconocido.";
      continue;
    }
    if (typeof v !== "number" || !Number.isFinite(v)) {
      errors[k] = "Tiene que ser un número.";
    } else if (v < d.min || v > d.max) {
      errors[k] = `Entre ${d.min} y ${d.max.toLocaleString("es-AR")}.`;
    }
  }
  return errors;
}

/** Título de la notificación (espejo del runner): "Stock bajo el mínimo: 5 productos". */
export function alertTitle(kind: AlertKind, n: number): string {
  const def = ALERT_CATALOG[kind];
  return `${def.label}: ${n} ${n === 1 ? def.noun[0] : def.noun[1]}`;
}

// Argentina no tiene horario de verano desde 2009: UTC-3 fijo.
const AR_OFFSET_MS = -3 * 3_600_000;

/**
 * Próxima corrida en hora de Argentina. ESPEJO de alert_next_run() en SQL.
 * hourly: la próxima hora en punto. daily: hoy a `hour` si todavía no pasó,
 * si no mañana. weekly: el próximo día permitido a `hour` (sin días = todos).
 */
export function nextRunAt(frequency: AlertFrequency, hour: number, weekdays: number[], from: Date): Date {
  const h = Math.max(0, Math.min(23, Number.isFinite(hour) ? Math.trunc(hour) : 8));
  const local = new Date(from.getTime() + AR_OFFSET_MS); // "reloj" de Argentina en campos UTC
  if (frequency === "hourly") {
    const t = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), local.getUTCHours() + 1);
    return new Date(t - AR_OFFSET_MS);
  }
  for (let i = 0; i <= 7; i++) {
    const cand = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + i, h));
    if (cand.getTime() <= local.getTime()) continue;
    if (frequency === "weekly" && weekdays.length > 0 && !weekdays.includes(cand.getUTCDay())) continue;
    return new Date(cand.getTime() - AR_OFFSET_MS);
  }
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1, h) - AR_OFFSET_MS);
}

/** "Todos los días a las 8", "Lun y Jue a las 8", "Cada hora". */
export function scheduleLabel(frequency: AlertFrequency, hour: number, weekdays: number[]): string {
  if (frequency === "hourly") return "Cada hora";
  const at = `a las ${hour}`;
  if (frequency === "daily" || weekdays.length === 0 || weekdays.length === 7) return `Todos los días ${at}`;
  const days = [...weekdays].sort((a, b) => a - b).map((d) => WEEKDAY_SHORT[d]);
  const list = days.length === 1 ? days[0] : `${days.slice(0, -1).join(", ")} y ${days[days.length - 1]}`;
  return `${list} ${at}`;
}

const ERRORS: [RegExp, string][] = [
  [/feature_not_in_plan/, "Las alertas programadas no están incluidas en tu plan."],
  [/forbidden|42501/, "No tenés permiso para esto: lo puede hacer el dueño o quien edita la configuración."],
  [/invalid_kind/, "Ese tipo de alerta no existe."],
  [/param_out_of_range|invalid_param/, "Revisá los umbrales: hay un valor fuera de rango."],
  [/invalid_frequency/, "Elegí cada cuánto corre."],
  [/invalid_hour/, "La hora tiene que estar entre 0 y 23."],
  [/weekdays_required|invalid_weekdays/, "Elegí al menos un día."],
  [/invalid_store/, "Esa sucursal no es de tu negocio."],
  [/audience_required/, "Elegí a quién le llega: algún rol o alguna persona."],
  [/invalid_user|invalid_audience/, "Revisá a quién le llega: hay una persona que ya no está en el equipo."],
  [/rule_exists/, "Ya hay una alerta de ese tipo para esa sucursal."],
  [/rule_not_found/, "La alerta ya no existe. Actualizá la página."],
];

export function alertErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e ?? "");
  for (const [re, text] of ERRORS) if (re.test(msg)) return text;
  return "No se pudo completar. Probá de nuevo en un rato.";
}
