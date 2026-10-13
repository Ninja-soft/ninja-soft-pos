// Runbooks operativos para soporte (F16 · H85, ADR-091).
//
// Qué revisar, cómo reintentar, cómo escalar y cómo cerrar cada incidente
// típico, sin consultar SQL: cada paso apunta a una pantalla del panel
// interno o del negocio (entrando "como el negocio", ADR-084). Viven en el
// repo y se versionan con el código; tests/unit/runbooks.test.ts valida que
// cada runbook esté completo y que sus rutas existan.

export type RunbookArea = "pagos" | "fiscal" | "integraciones" | "cajas" | "stock" | "ventas";
export type RunbookSeverity = "critica" | "alta" | "media";

export interface RunbookStep {
  text: string;
  /** Pantalla donde se hace el paso (ruta de la app). */
  href?: string;
}

export interface Runbook {
  id: string;
  area: RunbookArea;
  severity: RunbookSeverity;
  title: string;
  /** Cómo se ve el problema (lo que reporta el cliente o muestra un tablero). */
  symptoms: string[];
  /** Dónde se detecta. */
  detect: RunbookStep[];
  check: RunbookStep[];
  retry: RunbookStep[];
  escalate: RunbookStep[];
  close: RunbookStep[];
  /** Alertas del cockpit del negocio que llevan a este runbook. */
  cockpitAlerts?: string[];
}

export const RUNBOOK_AREA_LABEL: Record<RunbookArea, string> = {
  pagos: "Pagos",
  fiscal: "Facturación",
  integraciones: "Integraciones",
  cajas: "Cajas y equipos",
  stock: "Stock",
  ventas: "Ventas",
};

export const RUNBOOK_SEVERITY_LABEL: Record<RunbookSeverity, string> = {
  critica: "Crítica",
  alta: "Alta",
  media: "Media",
};

const CLOSE_COMMON: RunbookStep = {
  text: "Dejá el resumen del incidente (causa, negocios afectados y qué se hizo) en la ficha del negocio y avisale al cliente que quedó resuelto.",
  href: "/internal/tenants",
};

export const RUNBOOKS: Runbook[] = [
  {
    id: "caida-pagos-proveedor",
    area: "pagos",
    severity: "critica",
    title: "Caída de cobros de un proveedor",
    symptoms: [
      "Varios negocios reportan que los cobros con QR, link o Point quedan pendientes o rechazados.",
      "El proveedor aparece \"Con errores\" en Salud de webhooks.",
    ],
    detect: [
      { text: "Abrí Salud de webhooks y mirá qué proveedor tiene errores en las últimas 24 h.", href: "/internal/webhooks" },
      { text: "Revisá en Pagos si el problema es de un medio (QR, link, Point) o de todos.", href: "/internal/pagos" },
    ],
    check: [
      { text: "Confirmá en la página de estado del proveedor si hay una caída informada." },
      { text: "Entrá como el negocio afectado y mirá Cobros en espera: si hay cobros pagados sin venta, no se perdió plata.", href: "/cobros-en-espera" },
      { text: "Revisá si el error es de credenciales (vencidas o revocadas) en la configuración de medios del negocio.", href: "/configuracion" },
    ],
    retry: [
      { text: "Cuando el proveedor vuelve, reenvía los webhooks pendientes; en Cobros en espera, los pagados sin venta se registran con \"Reintentar registrar la venta\".", href: "/cobros-en-espera" },
      { text: "Si las credenciales fallan, pedile al dueño que reconecte la cuenta del proveedor." },
    ],
    escalate: [
      { text: "Si la caída supera 30 minutos o afecta a más de 5 negocios, avisá al canal de guardia y abrí ticket con el proveedor con los ids de pago." },
    ],
    close: [
      { text: "Verificá en Salud de webhooks que el proveedor vuelve a \"Sin errores\".", href: "/internal/webhooks" },
      CLOSE_COMMON,
    ],
    cockpitAlerts: ["pago_rechazado"],
  },
  {
    id: "pago-cobrado-sin-venta",
    area: "pagos",
    severity: "alta",
    title: "Cobro acreditado sin venta registrada",
    symptoms: [
      "El cliente pagó con QR o link pero la venta no aparece.",
      "El cockpit del negocio muestra \"Pagos sin conciliar\".",
    ],
    detect: [{ text: "Entrá como el negocio y abrí Cobros en espera: el cobro figura en \"Pagados sin venta\" o \"Para revisar\".", href: "/cobros-en-espera" }],
    check: [
      { text: "Compará monto y fecha con el movimiento del proveedor." },
      { text: "Confirmá que haya una caja abierta en la sucursal del cobro: la venta se registra en un turno abierto.", href: "/caja/monitor" },
    ],
    retry: [{ text: "Abrí el cobro y usá \"Reintentar registrar la venta\"; si quedó para revisar, un dueño o encargado usa \"Registrar la venta igual\".", href: "/cobros-en-espera" }],
    escalate: [{ text: "Si el reintento falla dos veces, pasá el id del cobro a desarrollo con el mensaje de error." }],
    close: [CLOSE_COMMON],
    cockpitAlerts: ["pago_sin_conciliar"],
  },
  {
    id: "factura-bloqueada",
    area: "fiscal",
    severity: "alta",
    title: "Facturas rechazadas o bloqueadas en ARCA",
    symptoms: [
      "Ventas sin CAE después de una hora.",
      "El cockpit muestra \"Facturas bloqueadas\" o el monitoreo de ARCA marca rechazos.",
    ],
    detect: [{ text: "Entrá como el negocio y abrí Configuración, Facturación electrónica: el monitoreo lista los comprobantes rechazados o que requieren acción.", href: "/configuracion" }],
    check: [
      { text: "Leé el código de error de ARCA del comprobante (certificado vencido, punto de venta no habilitado, datos del receptor)." },
      { text: "Si el negocio factura con el certificado de NinjaSoft, revisá el de la plataforma en ARCA del panel interno.", href: "/internal/arca" },
    ],
    retry: [
      { text: "Corregí el dato (receptor, punto de venta o certificado) y usá \"Reprocesar\" en el comprobante desde el monitoreo; los rechazos no se reintentan solos.", href: "/configuracion" },
      { text: "Si ARCA está caído, la contingencia CAEA sigue facturando: confirmá que el negocio la tenga activa." },
    ],
    escalate: [{ text: "Rechazos de un mismo código en varios negocios: escalá a desarrollo (posible cambio de ARCA)." }],
    close: [{ text: "Confirmá que el comprobante quedó aprobado con CAE y que el cliente lo recibió." }, CLOSE_COMMON],
    cockpitAlerts: ["factura_bloqueada", "factura_demorada"],
  },
  {
    id: "webhooks-con-errores",
    area: "integraciones",
    severity: "media",
    title: "Webhooks de una integración con errores",
    symptoms: ["Un proveedor aparece con errores aislados o constantes en Salud de webhooks."],
    detect: [{ text: "Abrí Salud de webhooks y mirá los últimos errores con su estado HTTP.", href: "/internal/webhooks" }],
    check: [
      { text: "401 o 403: firma o credencial inválida. 404: el negocio ya no existe o borró la cuenta. 5xx: error nuestro." },
      { text: "Mirá si los errores son de un solo negocio o de todos." },
    ],
    retry: [{ text: "Los proveedores reintentan solos; si el error era nuestro y ya se corrigió, pedile al proveedor el reenvío o verificá el pago desde el negocio." }],
    escalate: [{ text: "Errores 5xx sostenidos más de 15 minutos: escalá a desarrollo con el id del evento." }],
    close: [{ text: "Verificá que el proveedor vuelva a \"Sin errores\".", href: "/internal/webhooks" }, CLOSE_COMMON],
  },
  {
    id: "caja-sin-senal",
    area: "cajas",
    severity: "media",
    title: "Caja abierta sin señal",
    symptoms: ["El monitor de cajas o el cockpit muestran una caja abierta que no da señal hace más de 10 minutos."],
    detect: [{ text: "Entrá como el negocio y abrí Cajas abiertas.", href: "/caja/monitor" }],
    check: [
      { text: "Preguntá si el equipo está prendido y con internet; la caja sigue vendiendo sin conexión y sube las ventas al volver." },
      { text: "Revisá Ventas offline por ventas con problemas al sincronizar.", href: "/ventas-offline" },
    ],
    retry: [{ text: "Pedí recargar el POS; si quedó la sesión vencida, que el cajero vuelva a entrar. La caja no se cierra sola." }],
    escalate: [{ text: "Si el equipo vendió offline y las ventas no suben después de 1 hora con internet, escalá con el id de la caja." }],
    close: [{ text: "Confirmá que la caja vuelve a dar señal en el monitor.", href: "/caja/monitor" }, CLOSE_COMMON],
    cockpitAlerts: ["caja_sin_senal"],
  },
  {
    id: "ventas-offline-pendientes",
    area: "ventas",
    severity: "alta",
    title: "Ventas offline que no sincronizan",
    symptoms: ["El negocio vendió sin conexión y las ventas no aparecen o figuran con error."],
    detect: [{ text: "Entrá como el negocio y abrí Ventas offline.", href: "/ventas-offline" }],
    check: [
      { text: "Leé el motivo de cada venta con problema (precio cambiado, stock, turno cerrado)." },
      { text: "Si el turno de la caja ya se cerró, la venta se puede registrar en un turno abierto con \"Registrar en mi caja\"." },
    ],
    retry: [{ text: "Desde Ventas offline usá \"Reintentar\" (o \"Registrar en mi caja\"), \"Marcar resuelta\" o \"Descartar\" con nota en cada venta.", href: "/ventas-offline" }],
    escalate: [{ text: "Si el reintento falla con el mismo error en varias ventas, escalá con los ids de cliente offline." }],
    close: [CLOSE_COMMON],
  },
  {
    id: "stock-negativo",
    area: "stock",
    severity: "media",
    title: "Stock negativo o quiebre con ventas",
    symptoms: ["El cockpit muestra \"Stock negativo\" o \"Quiebre de stock\"."],
    detect: [{ text: "Entrá como el negocio, abrí Productos y filtrá por sucursal.", href: "/productos" }],
    check: [
      { text: "Revisá si hay recepciones de compra sin cargar o traslados en tránsito sin recibir.", href: "/traslados" },
      { text: "Mirá si hay reservas vigentes que comprometen el disponible.", href: "/reservas-stock" },
    ],
    retry: [{ text: "Recibí lo que esté en tránsito o hacé un conteo de la sucursal para corregir el saldo." }],
    escalate: [{ text: "Si el saldo no cierra con movimientos y conteo, escalá con producto y sucursal: puede ser un error de stock." }],
    close: [CLOSE_COMMON],
    cockpitAlerts: ["stock_negativo", "stock_roto"],
  },
];

export const RUNBOOK_SECTIONS: { key: keyof Pick<Runbook, "detect" | "check" | "retry" | "escalate" | "close">; label: string }[] = [
  { key: "detect", label: "Dónde se ve" },
  { key: "check", label: "Qué revisar" },
  { key: "retry", label: "Cómo reintentar" },
  { key: "escalate", label: "Cuándo escalar" },
  { key: "close", label: "Cómo cerrar" },
];

export function runbookById(id: string): Runbook | undefined {
  return RUNBOOKS.find((r) => r.id === id);
}

/** Runbooks que atienden una alerta del cockpit. */
export function runbooksForAlert(kind: string): Runbook[] {
  return RUNBOOKS.filter((r) => r.cockpitAlerts?.includes(kind));
}

const SEVERITY_ORDER: Record<RunbookSeverity, number> = { critica: 0, alta: 1, media: 2 };

/** Filtra por texto (título o síntoma) y área; ordena por severidad. */
export function searchRunbooks(query: string, area: RunbookArea | "todas" = "todas"): Runbook[] {
  const q = query
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  const norm = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "");
  return RUNBOOKS.filter((r) => area === "todas" || r.area === area)
    .filter((r) => !q || norm(r.title).includes(q) || r.symptoms.some((s) => norm(s).includes(q)))
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.title.localeCompare(b.title));
}
