// Cockpit de comercio unificado (F16 · H76, ADR-091).
//
// Tipos de la respuesta de commerce_cockpit() y helpers PUROS: etiquetas de
// canal, participación por canal y alertas operativas con SLA. El servidor
// devuelve números; acá se decide qué es una alerta y con qué severidad,
// igual que lib/branches/monitorAlerts.ts para el monitor de sucursales.

export type SaleChannel =
  | "mostrador"
  | "salon"
  | "delivery"
  | "takeaway"
  | "whatsapp"
  | "telefono"
  | "qr"
  | "link"
  | "retiro"
  | "offline";

export const CHANNEL_LABEL: Record<SaleChannel, string> = {
  mostrador: "Mostrador",
  salon: "Salón",
  delivery: "Delivery",
  takeaway: "Take away",
  whatsapp: "WhatsApp",
  telefono: "Teléfono",
  qr: "Pedido por QR",
  link: "Link o QR de pago",
  retiro: "Retiro en tienda",
  offline: "Sin conexión",
};

export function channelLabel(channel: string): string {
  return CHANNEL_LABEL[channel as SaleChannel] ?? channel;
}

export interface CockpitChannelRow {
  channel: string;
  sales: number;
  total: number;
}

export interface CockpitStoreRow {
  store_id: string;
  name: string;
  short_name: string | null;
  color: string | null;
  sales: number;
  total: number;
}

export interface CommerceCockpit {
  range: { from: string; to: string };
  scope: "all" | "stores";
  channels: CockpitChannelRow[];
  stores: CockpitStoreRow[];
  orders: {
    delivery_open: number | null;
    delivery_late: number | null;
    delivery_oldest_at: string | null;
    reservations_open: number;
    reservations_ready: number;
    reservations_expiring: number;
    reservations_old_unprepared: number;
    transfers_pending: number;
    transfers_late: number;
    transfers_in_transit: number;
  };
  payments: {
    rejected: number;
    paid_not_completed: number;
    waiting: number;
    disputes_open: number;
  };
  fiscal: { blocked: number; pending_late: number };
  returns: { count: number; total: number; review_items: number };
  stock: {
    reserved_units: number;
    in_transit_units: number;
    negative: number;
    out_with_sales: number;
    below_min: number;
  };
  registers: { open: number; silent: number };
  risk: { flags_pending: number } | null;
}

export interface ChannelShare extends CockpitChannelRow {
  label: string;
  share: number; // 0..1 sobre el total vendido
}

/** Participación de cada canal en el total vendido (mayor primero). */
export function channelShares(rows: CockpitChannelRow[]): ChannelShare[] {
  const total = rows.reduce((acc, r) => acc + Number(r.total || 0), 0);
  return [...rows]
    .map((r) => ({
      ...r,
      sales: Number(r.sales || 0),
      total: Number(r.total || 0),
      label: channelLabel(r.channel),
      share: total > 0 ? Number(r.total || 0) / total : 0,
    }))
    .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
}

// ── Alertas con SLA ─────────────────────────────────────────────────────────

export type CockpitAlertKind =
  | "pedido_demorado"
  | "reserva_sin_preparar"
  | "reserva_por_vencer"
  | "traslado_demorado"
  | "stock_negativo"
  | "stock_roto"
  | "pago_sin_conciliar"
  | "pago_rechazado"
  | "contracargo_abierto"
  | "factura_bloqueada"
  | "factura_demorada"
  | "devolucion_a_revisar"
  | "caja_sin_senal"
  | "riesgo_pendiente";

export type CockpitAlertLevel = "danger" | "warning" | "info";

export interface CockpitAlert {
  kind: CockpitAlertKind;
  level: CockpitAlertLevel;
  title: string;
  detail: string;
  count: number;
  href: string;
}

/**
 * SLA por defecto. Los plazos que dependen del reloj (pedido prometido,
 * reserva sin preparar a las 4 h, factura pendiente más de 1 h, caja sin señal
 * 10 min) los aplica el servidor; acá van los umbrales de cantidad.
 */
export interface CockpitSla {
  rejectedPaymentsWarn: number;
  rejectedPaymentsDanger: number;
}

export const DEFAULT_COCKPIT_SLA: CockpitSla = {
  rejectedPaymentsWarn: 1,
  rejectedPaymentsDanger: 5,
};

const LEVEL_ORDER: Record<CockpitAlertLevel, number> = { danger: 0, warning: 1, info: 2 };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Alertas operativas del cockpit, ordenadas por severidad y cantidad. */
export function cockpitAlerts(c: CommerceCockpit, sla: CockpitSla = DEFAULT_COCKPIT_SLA): CockpitAlert[] {
  const out: CockpitAlert[] = [];
  const push = (a: CockpitAlert) => {
    if (a.count > 0) out.push(a);
  };

  push({
    kind: "pedido_demorado",
    level: "danger",
    count: c.orders.delivery_late ?? 0,
    title: "Pedidos demorados",
    detail: `${plural(c.orders.delivery_late ?? 0, "pedido pasó", "pedidos pasaron")} el horario prometido sin entregarse.`,
    href: "/delivery",
  });
  push({
    kind: "reserva_sin_preparar",
    level: "warning",
    count: c.orders.reservations_old_unprepared,
    title: "Reservas sin preparar",
    detail: `${plural(c.orders.reservations_old_unprepared, "reserva lleva", "reservas llevan")} más de 4 horas sin prepararse.`,
    href: "/reservas-stock",
  });
  push({
    kind: "reserva_por_vencer",
    level: "info",
    count: c.orders.reservations_expiring,
    title: "Reservas por vencer",
    detail: `${plural(c.orders.reservations_expiring, "reserva vence", "reservas vencen")} en las próximas 24 horas.`,
    href: "/reservas-stock",
  });
  push({
    kind: "traslado_demorado",
    level: "warning",
    count: c.orders.transfers_late,
    title: "Traslados demorados",
    detail: `${plural(c.orders.transfers_late, "traslado programado no salió", "traslados programados no salieron")} en su fecha.`,
    href: "/traslados",
  });
  push({
    kind: "stock_negativo",
    level: "danger",
    count: c.stock.negative,
    title: "Stock negativo",
    detail: `${plural(c.stock.negative, "producto tiene", "productos tienen")} stock por debajo de cero: revisá conteos y recepciones.`,
    href: "/productos",
  });
  push({
    kind: "stock_roto",
    level: "warning",
    count: c.stock.out_with_sales,
    title: "Quiebre de stock",
    detail: `${plural(c.stock.out_with_sales, "producto se agotó", "productos se agotaron")} y se vendieron en los últimos 7 días.`,
    href: "/productos",
  });
  push({
    kind: "pago_sin_conciliar",
    level: "danger",
    count: c.payments.paid_not_completed,
    title: "Pagos sin conciliar",
    detail: `${plural(c.payments.paid_not_completed, "cobro entró", "cobros entraron")} sin venta registrada o piden revisión.`,
    href: "/cobros-en-espera",
  });
  const rejected = c.payments.rejected;
  if (rejected >= sla.rejectedPaymentsWarn) {
    push({
      kind: "pago_rechazado",
      level: rejected >= sla.rejectedPaymentsDanger ? "danger" : "warning",
      count: rejected,
      title: "Cobros rechazados",
      detail: `${plural(rejected, "cobro con terminal, QR o link fue rechazado", "cobros con terminal, QR o link fueron rechazados")} en el período.`,
      href: "/caja/monitor",
    });
  }
  push({
    kind: "contracargo_abierto",
    level: "warning",
    count: c.payments.disputes_open,
    title: "Contracargos abiertos",
    detail: `${plural(c.payments.disputes_open, "reclamo espera", "reclamos esperan")} respuesta o documentación.`,
    href: "/reportes/conciliacion",
  });
  push({
    kind: "factura_bloqueada",
    level: "danger",
    count: c.fiscal.blocked,
    title: "Facturas bloqueadas",
    detail: `${plural(c.fiscal.blocked, "comprobante quedó rechazado", "comprobantes quedaron rechazados")} o sin reintentos.`,
    href: "/ventas",
  });
  push({
    kind: "factura_demorada",
    level: "warning",
    count: c.fiscal.pending_late,
    title: "Facturas demoradas",
    detail: `${plural(c.fiscal.pending_late, "comprobante lleva", "comprobantes llevan")} más de 1 hora sin CAE.`,
    href: "/ventas",
  });
  push({
    kind: "devolucion_a_revisar",
    level: "info",
    count: c.returns.review_items,
    title: "Devoluciones a revisar",
    detail: `${plural(c.returns.review_items, "artículo devuelto espera", "artículos devueltos esperan")} revisión antes de volver al stock.`,
    href: "/devoluciones",
  });
  push({
    kind: "caja_sin_senal",
    level: "warning",
    count: c.registers.silent,
    title: "Cajas sin señal",
    detail: `${plural(c.registers.silent, "caja abierta no da", "cajas abiertas no dan")} señal hace más de 10 minutos.`,
    href: "/caja/monitor",
  });
  if (c.risk) {
    push({
      kind: "riesgo_pendiente",
      level: "warning",
      count: c.risk.flags_pending,
      title: "Operaciones para revisar",
      detail: `${plural(c.risk.flags_pending, "devolución o anulación quedó marcada", "devoluciones o anulaciones quedaron marcadas")} por riesgo.`,
      href: "/riesgo",
    });
  }

  return out.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || b.count - a.count);
}

/** Resumen de una línea para la cabecera del cockpit. */
export function cockpitHeadline(alerts: CockpitAlert[]): string {
  if (alerts.length === 0) return "Todo en orden";
  const danger = alerts.filter((a) => a.level === "danger").length;
  if (danger > 0) return `${plural(danger, "alerta urgente", "alertas urgentes")}`;
  return `${plural(alerts.length, "alerta", "alertas")} para mirar`;
}

const ERRORS: [RegExp, string][] = [
  [/feature_not_in_plan: cockpit_comercio/, "Tu plan no incluye el cockpit de comercio unificado."],
  [/forbidden/, "Sólo el dueño o un encargado ven el cockpit."],
  [/range_too_long/, "Elegí un período de hasta 92 días."],
  [/invalid_range/, "El período no es válido."],
];

export function cockpitErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e ?? "");
  for (const [re, text] of ERRORS) if (re.test(msg)) return text;
  return "No se pudo cargar el cockpit. Probá de nuevo.";
}
