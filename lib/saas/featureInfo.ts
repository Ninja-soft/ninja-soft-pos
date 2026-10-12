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
  multi_caja: {
    desc: "Multi-caja: varias cajas en una misma sucursal, cada una con su turno, su arqueo y su cierre Z. Cada dispositivo recuerda su caja, y cada caja puede tener su configuración propia (medios habilitados, cierre, pantalla del cliente e impresoras).",
    impact: "Desactivado, cada sucursal opera con una sola caja (la primera caja siempre está incluida).",
    minPlan: "Pro",
  },
  personal_estados: {
    desc: "Estados del personal: licencias, suspensiones con fecha de vuelta, bajas y reingresos, con motivo e historial. Quien no está activo no abre caja ni vende y la baja corta el acceso al negocio.",
    impact: "Desactivado, no se puede suspender, dar licencia ni dar de baja con historial; sólo queda borrar el acceso a mano.",
    minPlan: "Start",
  },
  pin_supervisor: {
    desc: "PIN de supervisor por acción: anulaciones, devoluciones, retiros, ingresos y descuentos por encima de un monto piden el PIN de un dueño o encargado; cierre forzado de cajas ajenas. Exigido por el servidor y auditado.",
    impact: "Desactivado, nadie puede autorizar con PIN desde la caja de otro.",
    minPlan: "Start",
  },
  pin_autenticador: {
    desc: "PIN autenticador: además del PIN fijo, cada supervisor autoriza con un PIN rotativo que cambia solo (12 h, 24 h o a medida), con PIN de un uso generados en el momento (vencen en minutos, opcionalmente atados a una acción y un monto) o con Google o Microsoft Authenticator. El dueño elige qué modos acepta cada acción. Secretos sólo en el servidor, todo auditado.",
    impact: "Desactivado, sólo vale el PIN fijo de cada supervisor.",
    minPlan: "Pro",
    requires: ["pin_supervisor"],
  },
  monitor_cajas: {
    desc: "Monitor de cajas abiertas: por sucursal, quién tiene cada caja, desde cuándo, ventas del turno y efectivo esperado, con cierre forzado.",
    impact: "Desactivado, no se ve qué cajas están abiertas ni quién las tiene.",
    minPlan: "Start",
  },
  devoluciones: {
    desc: "Devoluciones y notas de crédito sobre ventas: permite reintegrar productos y emitir el comprobante de devolución.",
    impact: "Sin esto el cajero no puede procesar devoluciones desde el sistema; habría que hacerlas por fuera.",
    minPlan: "Pro",
  },
  cobros_en_espera: {
    desc: "Cobros en espera: compartís el QR o link de pago (WhatsApp, email, SMS o copiar) y seguís vendiendo. Cuando el cliente paga, la venta se registra sola (aunque el POS esté cerrado) y te avisa para imprimir el ticket. Pestaña propia para ver, editar, reenviar, extender o cancelar, y decisión al cerrar la caja.",
    impact: "Desactivado, el QR o link se cobra sólo con la hoja abierta: no se puede dejar esperando ni mandar el link por email desde el sistema (el servidor lo rechaza).",
    minPlan: "Pro",
    needs: "Un medio de cobro por QR o link conectado (Mercado Pago, MODO, Payway, Getnet, Nave, Pagos360, GO Cuotas, Directo o Mobbex).",
  },
  garantias: {
    desc: "Gestión de garantías de productos: registro de cobertura, plazos y reclamos de garantía por venta.",
    impact: "Se ocultan las garantías en el POS y la ficha del producto; no se registran coberturas.",
    minPlan: "Business",
  },
  cuenta_corriente: {
    desc: "Cuentas corrientes de clientes: ventas a cuenta con plazos (días o corte mensual) y cuotas, cobros con medio, caja y recibo, estado de cuenta, antigüedad de deuda por vencimiento y bloqueo por mora o límite con autorización por PIN de supervisor.",
    impact: "Desactivado, no se puede vender en cuenta corriente ni llevar el saldo deudor de los clientes.",
    minPlan: "Business",
  },
  cc_punitorios: {
    desc: "Punitorios de cuenta corriente: interés por mora configurable (simple o compuesto, mensual o diario, gracia, tope y mínimo), calculado todos los días y con condonación auditada.",
    impact: "Desactivado, la deuda vencida no genera intereses; la cuenta corriente sigue funcionando.",
    minPlan: "Business",
    requires: ["cuenta_corriente"],
  },
  cc_cobranza: {
    desc: "Gestión de cobranza: recordatorios automáticos por email antes y después del vencimiento, estado de cuenta por email, promesas de pago, notas, tareas y cobrador asignado.",
    impact: "Desactivado, la cobranza se hace a mano: sin recordatorios automáticos ni seguimiento de promesas y tareas.",
    minPlan: "Business",
    requires: ["cuenta_corriente"],
    needs: "Configurar el email del negocio (Configuración, sección Email) para enviar recordatorios.",
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
    desc: "Cobro por transferencia: cargás tu cuenta (banco o billetera con su logo, titular, CBU / CVU y alias) y el POS la muestra al cobrar, también en la pantalla del cliente, con número de operación opcional u obligatorio. Cada cobro guarda la cuenta usada para conciliar. Podés omitir la pantalla y cerrar el ticket directo.",
    impact: "Desactivado, no se puede registrar la transferencia como medio de pago en la venta.",
    minPlan: "Start",
  },
  transferencia_multicuenta: {
    desc: "Varias cuentas de transferencia: más de una cuenta activa (por ejemplo un banco y una billetera, o pesos y dólares), el cajero elige en cuál transfiere el cliente y cada sucursal muestra sus propias cuentas y su cuenta por defecto.",
    impact: "Desactivado, se usa una sola cuenta (la por defecto) en todas las cajas; el servidor rechaza activar una segunda o elegir cuentas por sucursal.",
    minPlan: "Pro",
    requires: ["transferencia"],
  },
  transferencia_auto_mp: {
    desc: "Transferencias automáticas con Mercado Pago: mientras la hoja de cobro espera, el POS consulta tu cuenta de Mercado Pago y detecta la transferencia que entra a tu CVU por el monto de la venta (con tolerancia ± en pesos y tiempo de espera configurables). Muestra quién transfirió y cierra la venta sola o le avisa al cajero; si hay dos transferencias iguales o dos cajas esperando el mismo monto, pregunta. Una transferencia nunca se usa dos veces y todo queda auditado.",
    impact: "Desactivado, el cajero confirma cada transferencia a mano mirando la cuenta y cargando el n° de operación.",
    minPlan: "Pro",
    requires: ["transferencia"],
    needs: "Mercado Pago conectado en Medios de pago y una cuenta de transferencia de Mercado Pago (CVU) con la detección prendida.",
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
    desc: "Cobros con crédito Directo: el cliente financia la compra en cuotas fijas sin tarjeta. Con la API conectada, el POS muestra el QR y el link de la orden de Directo y la venta se cierra sola al aprobarse; sin conectar, se cobra en el portal de Directo y el POS registra el número de operación.",
    impact: "Desactivado, Directo no aparece como medio de pago al cobrar.",
    minPlan: "Pro",
    needs: "Cuenta de comercio en Directo. Para el cobro integrado, las credenciales de la API de Directo (API Key, usuario y contraseña del comercio y URL de la API); sin ellas se cobra en su portal y se registra el número de operación.",
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
    desc: "Cobros con terminales Fiserv (Posnet o Clover) sin integrar: se cobra en la terminal y el POS registra el cupón como débito o crédito. Es la marca de la que depende el Clover Point integrado.",
    impact: "Desactivado, las terminales Fiserv no quedan disponibles como medio de cobro ni se puede integrar Clover.",
    minPlan: "Business",
  },
  fiserv_point: {
    desc: "Cobros con Clover Point: el POS manda el monto a la terminal Clover (Flex o Mini) por Cloud Pay Display, el cliente paga con tarjeta, contactless o en cuotas y la venta se registra sola como débito o crédito.",
    impact: "Desactivado, la terminal Clover no queda integrada al cobro del POS (se puede seguir usando sin integrar).",
    minPlan: "Business",
    requires: ["fiserv"],
    needs: "Marca Fiserv conectada (el Merchant ID y el token de Clover del comercio) y la app Cloud Pay Display abierta en cada terminal.",
  },
  terminal_integrada: {
    desc: "Terminal integrada: el posnet (por cable o red) o el pinpad conectado a la PC cobra el monto que manda el POS y devuelve lote, cupón, autorización, tarjeta, últimos 4 y cuotas, que quedan en el cobro sin cargarlos a mano. Configuración, Terminales, por caja; incluye un simulador para probar sin hardware.",
    impact: "Desactivado, se cobra con Tarjeta en posnet y el cajero carga el cupón a mano.",
    minPlan: "Pro",
    needs: "Chrome o Edge de escritorio (Web Serial / WebUSB) o el puente local NinjaPOS en la PC de la caja, y la terminal en modo integrado. Payway: protocolo sin homologar todavía; Fiserv y Getnet: pendientes de la especificación del adquirente.",
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
  medidas_bultos: {
    desc: "Medidas por bulto de cada producto: alto, ancho, profundidad, peso y unidades por bulto, con volumen y m³ calculados para logística y envíos.",
    impact: "Desactivado, no se pueden cargar ni editar bultos en la ficha del producto (el servidor rechaza el alta).",
    minPlan: "Start",
    requires: ["productos"],
  },
  categorias: {
    desc: "Categorías de productos: organiza el catálogo en categorías para filtrar y reportar por rubro.",
    impact: "Sin categorías el catálogo queda plano, sin agrupar ni filtrar por tipo de producto.",
    minPlan: "Start",
  },
  stock_sucursales: {
    desc: "Stock por sucursal: cada local tiene su propio stock, con mínimo, máximo y ubicación; ajustes y conteos por sucursal y desglose en Productos.",
    impact: "Desactivado, se ve un único stock del negocio y no se ajusta ni configura por sucursal (el servidor lo rechaza).",
    minPlan: "Business",
    requires: ["multi_sucursal"],
  },
  traslados: {
    desc: "Traslados entre sucursales: programados para una fecha, con aprobación opcional, mercadería en tránsito, recepción parcial con diferencias y motivo, remito interno imprimible y sugerencias por stock bajo.",
    impact: "Desactivado, no se pueden mover productos entre sucursales desde el sistema (el servidor lo rechaza).",
    minPlan: "Business",
    requires: ["stock_sucursales"],
    needs: "Al menos dos sucursales activas.",
  },
  compras: {
    desc: "Compras y proveedores: ficha de proveedor (CUIT, condición IVA, plazo de pago, CBU), productos por proveedor con su código y último costo, órdenes de compra por sucursal con sugerencia por stock bajo, recepción parcial con diferencias, facturas y notas de crédito del proveedor, pagos y cuenta corriente con antigüedad de deuda. Cada recepción actualiza el stock de la sucursal, el último costo y el costo promedio ponderado. Incluye devoluciones al proveedor con nota de crédito, anulación de recepciones con reversa de stock y costos, órdenes de pago con imputación a facturas, pago en efectivo desde la caja propia y retenciones con certificado, trazabilidad por lote y n° de despacho hasta la venta e importación de la lista de precios del proveedor.",
    impact: "Desactivado, la mercadería se ingresa con ajustes de stock y el costo se carga a mano; no hay proveedores, órdenes, devoluciones, órdenes de pago ni cuenta corriente de proveedores (el servidor lo rechaza).",
    minPlan: "Pro",
  },
  compras_importacion: {
    desc: "Costeo de importación (modo profesional de compras): FOB, flete y seguro hasta el CIF, derechos por posición, tasa de estadística, otros tributos y gastos de nacionalización prorrateados por valor, peso, volumen o cantidad hasta el costo puesto en depósito de cada producto, con el n° de despacho guardado en el lote. El crédito fiscal se informa aparte y no se suma al costo.",
    impact: "Desactivado, las compras al exterior entran al costo del comprobante sin gastos ni tributos de importación prorrateados (el servidor lo rechaza).",
    minPlan: "Business",
    requires: ["compras"],
    needs: "Activá el modo profesional en Configuración de compras.",
  },
  tesoreria: {
    desc: "Tesorería: caja general y cuentas bancarias con saldo, movimientos, transferencias entre cuentas y conciliación manual contra el extracto; cheques y e-cheqs propios y de terceros (en cartera, entregados, depositados o rechazados) y flujo de fondos proyectado con lo que vence de proveedores y lo que entra de clientes y cheques. Las órdenes de pago pueden pagar desde un banco o con cheques.",
    impact: "Desactivado, las órdenes de pago sólo registran efectivo de la caja y transferencias con su referencia; no hay cuentas, cheques ni flujo de fondos (el servidor lo rechaza).",
    minPlan: "Business",
    requires: ["compras"],
  },
  variantes: {
    desc: "Variantes de producto (talle, color, etc.): un producto con múltiples combinaciones y stock por variante.",
    impact: "Desactivado, cada combinación debe cargarse como producto separado; no hay matriz de variantes.",
    minPlan: "Pro",
  },
  historial_precios: {
    desc: "Historial de precios: cada cambio del precio del producto, sus variantes y las listas con quién, cuándo y de dónde vino (manual, importación, masivo o lista), con gráfico en la ficha.",
    impact: "Desactivado, los cambios se siguen registrando pero no se pueden consultar.",
    minPlan: "Start",
  },
  listas_precios: {
    desc: "Múltiples listas de precios (mayorista, catálogo, tarjeta): % sobre el precio de venta y precios fijos por producto, con vigencia, precios programados por fecha, lista por cliente, grupo o sucursal, elegibles en el POS e import y export en Excel.",
    impact: "Sin esto sólo existe un precio por producto; no se pueden manejar listas diferenciadas. El asistente para actualizar el precio de venta en masa y las etiquetas a reimprimir siguen disponibles.",
    minPlan: "Business",
  },
  listas_precios_pro: {
    desc: "Listas de precios profesionales para quien compra e importa: listas derivadas de otra, sobre costo con markup o margen, en dólares con cotización (oficial, BNA, MEP o manual), escalas por cantidad, plazos de pago con recargo financiero, redondeo psicológico, margen y precio mínimo, actualización por índice o dólar y aprobación del dueño para cambios masivos.",
    impact: "Desactivado, toda lista funciona como fija (% y precios fijos); lo profesional que ya estaba cargado deja de aplicarse (no se borra) y el servidor rechaza crear lo nuevo.",
    minPlan: "Business",
    requires: ["listas_precios"],
    needs: "Activá el modo profesional en Configuración > Precios.",
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
  conciliacion_tarjetas: {
    desc: "Conciliación de tarjetas: los cobros con débito y crédito agrupados por día, número de comercio y lote, con subtotales como la liquidación del adquirente, para marcar lo que ya se acreditó y exportarlo a Excel.",
    impact: "Desactivado, los cobros con tarjeta se controlan a mano contra las liquidaciones; no se pueden marcar como conciliados.",
    minPlan: "Pro",
    needs: "Más útil con los números de comercio cargados en Medios de pago, Planes de cuotas, y con los datos del cupón (lote y cupón) de Tarjeta en posnet.",
  },
  conciliacion_procesadores: {
    desc: "Conciliación de procesadores: los cobros de Mercado Pago llegan solos todos los días por API (y con \"Actualizar ahora\"), la liquidación de Payway, Getnet, Fiserv u otro adquirente se importa desde el Excel o CSV, y se cruzan solos con tus ventas. Muestra en palabras simples cuánto vendiste, cuánto te cobraron de comisiones e impuestos, cuánto te acreditaron y cuánto falta (con fecha), y te deja resolver los cobros sin venta, las ventas sin cobro y las diferencias de monto. Exporta a Excel.",
    impact: "Desactivado, la liquidación de cada procesador se controla a mano o con un sistema aparte; los cobros con tarjeta se siguen conciliando por lote si el plan trae la conciliación de tarjetas.",
    minPlan: "Business",
    needs: "Mercado Pago conectado (Medios de pago) para la sincronización automática; para Payway y otros, el archivo de liquidación del portal del adquirente.",
  },
  metricas_avanzadas: {
    desc: "Métricas y dashboards avanzados: análisis más profundo (tendencias, comparativas, indicadores) del negocio.",
    impact: "Sin esto sólo quedan los reportes básicos; no hay dashboards avanzados.",
    minPlan: "Business",
  },

  // ── Integraciones ──────────────────────────────────────────────────────────
  multi_sucursal: {
    desc: "Multi-sucursal: varias sucursales en el mismo negocio, cada una con sus cajas, su personal (traslados y coberturas programadas) y sus ventas. Siempre se ve en qué sucursal y caja estás, y los listados filtran por sucursal. Configuración heredable por grupo y sucursal: medios de pago, recargos y n° de comercio, ticket, logo y operación del POS, con copia entre sucursales. Credenciales de cobro y planes de cuotas propios por sucursal, sucursales nuevas desde otra o desde una plantilla, y reportes comparativos entre sucursales.",
    impact: "Desactivado, el negocio opera con una sola sucursal (la primera siempre está incluida).",
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
    desc: "Asistente con IA para el POS: responde cualquier consulta sobre los datos del negocio (ventas, stock, clientes, caja, agenda y más) con acceso de solo lectura, y guarda las conversaciones de cada usuario por 15 días.",
    impact: "Se gestiona como add-on: se contrata aparte y no se incluye marcándolo en el plan.",
    minPlan: "Add-on",
  },
  notificaciones: {
    desc: "Notificaciones in-app: avisos dentro del sistema (cobros, vencimientos, novedades) para el equipo del negocio.",
    impact: "Desactivado, el negocio no recibe avisos internos dentro de la app.",
    minPlan: "Start",
  },
  auditoria: {
    desc: "Visor de auditoría: filtrá todo lo que pasa en el negocio por usuario, sucursal, acción y fecha, mirá el detalle de cada cambio y exportalo a Excel. El registro se guarda siempre, en todos los planes.",
    impact: "Sin el visor el registro se guarda igual, pero no se puede consultar ni exportar desde la app.",
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
