// Información explicativa de cada feature del catálogo.
// La usa el editor de planes para mostrar un tooltip por funcionalidad:
//   - desc:   qué hace / qué habilita el módulo.
//   - impact: qué implica desactivarlo en el plan.
//   - minPlan: plan global más bajo donde la funcionalidad viene incluida
//              (referencia comercial; "Add-on" cuando no viene en ningún plan).
//   - requires: features de plan de las que depende (deben estar activas en el
//              mismo plan para que esta funcione). El editor de planes lo avisa.
//   - needs:   requisito operativo que no es de plan (p. ej. conectar la cuenta
//              del proveedor). Se muestra como "Requiere: …".
//
// `minPlan` se calculó a partir de la matriz real de planes globales
// (Start → Pro → Business → Enterprise) tomando el primer plan donde el módulo
// está activo. asistente_ia no viene en ningún plan: se contrata como add-on.

export interface FeatureInfo {
  desc: string;
  impact: string;
  minPlan: string;
  requires?: string[];
  needs?: string;
}

export const FEATURE_INFO: Record<string, FeatureInfo> = {
  // ── Ventas ────────────────────────────────────────────────────────────────
  pos: {
    desc: "Pantalla de punto de venta para cargar productos y cobrar. Es el corazón operativo del sistema.",
    impact: "Sin POS el negocio no puede registrar ventas: prácticamente ningún plan debería desactivarlo.",
    minPlan: "Start",
  },
  caja: {
    desc: "Apertura y cierre de caja con arqueo: controla el efectivo del turno y los movimientos de entrada/salida.",
    impact: "Si se desactiva, no hay control de caja ni cierres de turno; el efectivo queda sin conciliar.",
    minPlan: "Start",
  },
  devoluciones: {
    desc: "Devoluciones y notas de crédito sobre ventas: permite reintegrar productos y emitir el comprobante de devolución.",
    impact: "Sin esto el cajero no puede procesar devoluciones desde el sistema; habría que hacerlas por fuera.",
    minPlan: "Pro",
  },
  garantias: {
    desc: "Gestión de garantías de productos: registro de cobertura, plazos y reclamos de garantía por venta.",
    impact: "Se ocultan las garantías en el POS y la ficha del producto; no se registran coberturas.",
    minPlan: "Business",
  },
  cuenta_corriente: {
    desc: "Cuentas corrientes de clientes: ventas a crédito, saldos, pagos a cuenta y estado de deuda por cliente.",
    impact: "Desactivado, no se puede vender en cuenta corriente ni llevar el saldo deudor de los clientes.",
    minPlan: "Business",
  },
  promociones: {
    desc: "Promociones y combos: arma ofertas (2x1, packs, precios promocionales) que el POS aplica automáticamente.",
    impact: "Sin promociones el POS no aplica combos ni descuentos automáticos por campaña.",
    minPlan: "Pro",
  },
  descuentos: {
    desc: "Descuentos manuales en la venta: permite al cajero/encargado aplicar un descuento puntual al total o al ítem.",
    impact: "Si se desactiva, no se pueden cargar descuentos manuales durante el cobro.",
    minPlan: "Pro",
  },
  agenda: {
    desc: "Agenda y turnos: agenda de servicios por profesional (peluquería, estética, servicios) para reservar turnos y cobrarlos desde el POS.",
    impact: "Desactivada, no se pueden agendar turnos ni cobrar servicios desde la agenda; el negocio opera sólo por mostrador.",
    // Hoy es básica (incluida en todo plan; un plan puede apagarla). La idea
    // comercial diferida (ver ADR-026) es moverla a Pro+ como diferenciador.
    minPlan: "Start",
  },
  packs: {
    desc: "Paquetes y sesiones: bonos de sesiones prepagas por cliente (p. ej. 10 sesiones), que el POS acredita y consume al cobrar.",
    impact: "Desactivado, no se pueden vender packs de sesiones ni llevar el saldo de sesiones del cliente.",
    // Igual que agenda: hoy básica; candidata a Pro+ en el rediseño de planes
    // (ver ADR-026).
    minPlan: "Start",
  },
  pos_quick_keys_pro: {
    desc: "Teclas rápidas Pro: hasta 48 botones de un toque en la pantalla de venta, con color por tecla para encontrarlos al instante. El diseño del POS (presets, grilla, carrito, acento) es gratis en todos los planes.",
    impact: "Sin la función se pueden armar hasta 12 teclas rápidas sin color; el resto del diseño del POS sigue disponible.",
    minPlan: "Pro",
    requires: ["pos"],
  },

  // ── Pagos ─────────────────────────────────────────────────────────────────
  efectivo: {
    desc: "Cobro en efectivo: medio de pago básico, calcula vuelto e impacta en la caja.",
    impact: "Casi siempre activo; sin efectivo el POS pierde el medio de pago más común.",
    minPlan: "Start",
  },
  transferencia: {
    desc: "Cobro por transferencia bancaria: registra el pago como transferencia para la conciliación.",
    impact: "Desactivado, no se puede registrar la transferencia como medio de pago en la venta.",
    minPlan: "Start",
  },
  modo: {
    desc: "Cobros con MODO: habilita el medio de pago MODO (QR / billetera) en el POS.",
    impact: "Sin esto MODO no aparece como medio de pago disponible al cobrar.",
    minPlan: "Business",
  },
  mobbex: {
    desc: "Cobros con Mobbex: pasarela de pago con tarjetas y cuotas vía Mobbex.",
    impact: "Desactivado, Mobbex no figura como medio de pago ni se generan sus links/QR de cobro.",
    minPlan: "Business",
  },
  mercado_pago: {
    desc: "Cobros con Mercado Pago por QR y link de pago: conecta la cuenta del negocio, cobra con un QR único por venta en la caja del local o manda el link por WhatsApp. El Point (terminal) es una función aparte.",
    impact: "Sin esto no se puede cobrar con Mercado Pago ni vincular la cuenta del comercio.",
    minPlan: "Pro",
  },
  mercadopago_point: {
    desc: "Cobros con Mercado Point: terminal presencial de Mercado Pago para cobrar con tarjeta en el mostrador.",
    impact: "Desactivado, no se puede usar la terminal Point de Mercado Pago como medio de cobro.",
    minPlan: "Pro",
    needs: "Conectar la cuenta de Mercado Pago (la misma conexión sirve para QR, link y Point).",
  },
  payway: {
    desc: "Cobros con Payway (Prisma) por link de pago y QR: el cliente paga con tarjeta y cuotas desde su celular. El Point (terminal) es una función aparte.",
    impact: "Sin esto Payway no figura como medio de pago disponible al cobrar.",
    minPlan: "Pro",
  },
  getnet: {
    desc: "Cobros con Getnet (Santander) por link de pago y QR desde el celular del cliente: el cliente paga con tarjeta en el checkout de Getnet y la venta se cierra sola al aprobarse. El Point (terminal) es una función aparte.",
    impact: "Desactivado, no se puede cobrar con Getnet desde el POS.",
    minPlan: "Pro",
    needs: "Conectar la cuenta de Getnet con el Client ID y Client Secret del Portal Getnet (no hay ambiente de prueba: los cobros son reales).",
  },
  nave: {
    desc: "Cobros con Nave (Banco Galicia) por QR interoperable y link de pago. El Point (terminal) es una función aparte.",
    impact: "Sin esto Nave no aparece como medio de pago al cobrar.",
    minPlan: "Pro",
    needs: "Conectar la cuenta de Nave (Client ID, Client Secret y punto de venta) y pasarle a Nave la URL de notificaciones.",
  },
  gocuotas: {
    desc: "Cobros con GO Cuotas por QR y link de pago: el cliente paga en 2 a 4 cuotas sin interés con su tarjeta de débito y la venta se cierra sola al aprobarse. Monto mínimo por cobro: $1.500.",
    impact: "Desactivado, GO Cuotas no aparece como medio de pago al cobrar.",
    minPlan: "Pro",
    needs: "Conectar la cuenta de GO Cuotas con la API Key de la sucursal (Sucursales, Editar, Ver ApiKeys de la sucursal).",
  },
  directo: {
    desc: "Cobros con crédito Directo: el cliente financia la compra en cuotas fijas sin tarjeta. El cobro se hace en el portal de comercios de Directo (QR o link) y el POS registra el número de operación.",
    impact: "Desactivado, Directo no aparece como medio de pago al cobrar.",
    minPlan: "Pro",
    needs: "Tener cuenta de comercio en Directo; el cobro se hace en su portal y en el POS se registra el número de operación",
  },
  payway_point: {
    desc: "Cobros con el Point de Payway: el POS manda el monto a la terminal y el cliente paga con tarjeta en el mostrador.",
    impact: "Desactivado, la terminal de Payway no queda integrada al cobro del POS.",
    minPlan: "Pro",
    needs: "Conectar la cuenta de Payway y habilitar la integración de terminales con Payway.",
  },
  getnet_point: {
    desc: "Cobros con el Point de Getnet: el POS manda el monto a la terminal y el cliente paga con tarjeta en el mostrador.",
    impact: "Desactivado, la terminal de Getnet no queda integrada al cobro del POS.",
    minPlan: "Pro",
    needs: "Conectar la cuenta de Getnet y habilitar la integración de terminales con Getnet.",
  },
  nave_point: {
    desc: "Cobros con el Point de Nave: el POS manda el monto a la terminal Nave y el cliente paga con tarjeta, contactless o QR.",
    impact: "Desactivado, la terminal de Nave no queda integrada al cobro del POS.",
    minPlan: "Pro",
    needs: "Conectar la cuenta de Nave (la misma conexión sirve para QR, link y Point) y cargar el ID de punto de venta de cada terminal.",
  },
  fiserv: {
    desc: "Cobros con Fiserv (Posnet / Clover): pasarela presencial de tarjetas vía terminales Fiserv/Clover.",
    impact: "Desactivado, las terminales Fiserv/Clover no quedan disponibles como medio de cobro.",
    minPlan: "Business",
  },
  pagos360: {
    desc: "Cobros con Pagos360: links de pago y DEBIN para cobrar a distancia o por débito inmediato.",
    impact: "Sin esto no se pueden generar links de pago ni cobros DEBIN con Pagos360.",
    minPlan: "Business",
  },

  // ── Catálogo ────────────────────────────────────────────────────────────────
  productos: {
    desc: "Catálogo de productos: alta, edición, precios y códigos de los artículos que se venden.",
    impact: "Sin catálogo no hay productos que cargar en la venta; es base del sistema.",
    minPlan: "Start",
  },
  stock: {
    desc: "Control de stock e inventario: descuenta existencias al vender y permite ajustes y movimientos de stock.",
    impact: "Desactivado, las ventas no descuentan stock y no hay control de inventario.",
    minPlan: "Start",
  },
  categorias: {
    desc: "Categorías de productos: organiza el catálogo en categorías para filtrar y reportar por rubro.",
    impact: "Sin categorías el catálogo queda plano, sin agrupar ni filtrar por tipo de producto.",
    minPlan: "Start",
  },
  variantes: {
    desc: "Variantes de producto (talle, color, etc.): un producto con múltiples combinaciones y stock por variante.",
    impact: "Desactivado, cada combinación debe cargarse como producto separado; no hay matriz de variantes.",
    minPlan: "Pro",
  },
  listas_precios: {
    desc: "Múltiples listas de precios: precios distintos por lista (mayorista, minorista, etc.) aplicables según el cliente.",
    impact: "Sin esto sólo existe un precio por producto; no se pueden manejar listas diferenciadas.",
    minPlan: "Business",
  },
  catalogo_publico: {
    desc: "Catálogo web público: una vitrina online del comercio con sus productos y precios, compartible por link.",
    impact: "Desactivado, no se publica el catálogo web del negocio.",
    minPlan: "Pro",
  },
  importacion_excel: {
    desc: "Importación desde Excel: carga masiva de productos y precios a partir de una planilla.",
    impact: "Sin esto la carga de productos es sólo manual, uno por uno.",
    minPlan: "Pro",
  },

  // ── Clientes ────────────────────────────────────────────────────────────────
  clientes: {
    desc: "Gestión de clientes: alta y ficha de clientes para asociarlos a ventas, deudas y comprobantes.",
    impact: "Desactivado, no se puede registrar ni asociar clientes a las ventas.",
    minPlan: "Start",
  },
  grupos_clientes: {
    desc: "Grupos de clientes: segmenta clientes en grupos para precios, promociones o reportes por segmento.",
    impact: "Sin grupos no se puede segmentar la base de clientes ni aplicar reglas por grupo.",
    minPlan: "Pro",
  },
  roles_permisos: {
    desc: "Roles y permisos: define qué puede hacer cada usuario (cajero, encargado, dueño) dentro del sistema.",
    impact: "Desactivado, no hay control granular de permisos por usuario más allá del rol base.",
    minPlan: "Business",
  },

  // ── Tickets ─────────────────────────────────────────────────────────────────
  tickets_pro: {
    desc: "Diseñador avanzado de tickets: personaliza el formato del comprobante (logo, leyendas, layout, QR).",
    impact: "Sin esto el ticket usa el formato estándar, sin personalización avanzada.",
    minPlan: "Pro",
  },
  email_comprobantes: {
    desc: "Envío de comprobantes por email: manda el ticket/comprobante de la venta al correo del cliente.",
    impact: "Desactivado, no se pueden enviar comprobantes por email desde el sistema.",
    minPlan: "Start",
  },

  // ── Reportes ────────────────────────────────────────────────────────────────
  reportes: {
    desc: "Reportes de ventas y métricas: totales por período, productos y medios de pago para seguir el negocio.",
    impact: "Sin reportes el negocio pierde la vista de ventas y métricas básicas.",
    minPlan: "Start",
  },
  export_xlsx: {
    desc: "Exportar reportes a Excel: descarga los reportes en formato XLSX para analizarlos o compartirlos.",
    impact: "Desactivado, los reportes sólo se ven en pantalla, sin exportación a Excel.",
    minPlan: "Pro",
  },
  metricas_avanzadas: {
    desc: "Métricas y dashboards avanzados: análisis más profundo (tendencias, comparativas, indicadores) del negocio.",
    impact: "Sin esto sólo quedan los reportes básicos; no hay dashboards avanzados.",
    minPlan: "Business",
  },

  // ── Integraciones ──────────────────────────────────────────────────────────
  multi_sucursal: {
    desc: "Multi-sucursal: opera y consolida varias sucursales bajo el mismo negocio, con stock y ventas por local.",
    impact: "Desactivado, el negocio se maneja como una sola sucursal.",
    minPlan: "Business",
  },
  api_publica: {
    desc: "API pública: acceso programático a los datos del negocio para integraciones externas a medida.",
    impact: "Sin esto no se puede integrar el sistema con software de terceros vía API.",
    minPlan: "Enterprise",
  },
  facturacion_afip: {
    desc: "Facturación electrónica AFIP/ARCA: emite comprobantes fiscales (factura A/B/C) integrados con AFIP.",
    impact: "Desactivado, el sistema sólo emite comprobantes no fiscales; no factura ante AFIP.",
    minPlan: "Pro",
  },

  // ── Extras ──────────────────────────────────────────────────────────────────
  asistente_ia: {
    desc: "Asistente con IA para el POS: responde consultas y ayuda a operar el negocio con inteligencia artificial.",
    impact: "Se gestiona como add-on: se contrata aparte y no se incluye marcándolo en el plan.",
    minPlan: "Add-on",
  },
  notificaciones: {
    desc: "Notificaciones in-app: avisos dentro del sistema (cobros, vencimientos, novedades) para el equipo del negocio.",
    impact: "Desactivado, el negocio no recibe avisos internos dentro de la app.",
    minPlan: "Start",
  },
  auditoria: {
    desc: "Registro de auditoría: deja traza de las acciones críticas (quién hizo qué y cuándo) dentro del negocio.",
    impact: "Sin auditoría no queda registro de las acciones sensibles del equipo.",
    minPlan: "Business",
  },
  backup: {
    desc: "Copias de seguridad: respaldos de los datos del negocio para recuperación ante incidentes.",
    impact: "Desactivado, el negocio no cuenta con la función de backups gestionados.",
    minPlan: "Enterprise",
  },
  soporte_prioritario: {
    desc: "Soporte prioritario: atención preferente y tiempos de respuesta (SLA) reducidos ante consultas o incidentes.",
    impact: "Sin esto el negocio recibe el soporte estándar, sin prioridad ni SLA reducido.",
    minPlan: "Business",
  },
  personalizacion_marca: {
    desc: "Personalización de marca: logo, colores y branding del comercio aplicados en tickets, catálogo y comprobantes.",
    impact: "Desactivado, se usa la presentación estándar sin el branding del comercio.",
    minPlan: "Pro",
  },
  panel_dueno: {
    desc: "Panel del dueño: vista exclusiva para el dueño con indicadores y controles de alto nivel del negocio.",
    impact: "Sin esto el dueño no tiene su panel dedicado de gestión y métricas.",
    minPlan: "Pro",
  },
};

// Dependencias directas de plan de una feature (vacío si no depende de otra).
export function featureRequires(key: string): string[] {
  return FEATURE_INFO[key]?.requires ?? [];
}

// Fallback para una key sin copy explícita (no debería pasar con el catálogo
// actual, pero evita undefined si se agrega una feature nueva en la DB).
export function featureInfo(key: string): FeatureInfo | null {
  return FEATURE_INFO[key] ?? null;
}
