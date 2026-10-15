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
  balanza: {
    desc: "Balanza y códigos pesables: el POS lee las etiquetas de la balanza etiquetadora (EAN-13 con prefijo 20 a 29 y precio o peso embebido, con el formato de cada sucursal) y el peso en vivo de la balanza conectada a la caja (Web Serial o puente local), con peso estable y tara.",
    impact: "Desactivado, los productos por kilo se cargan tipeando el peso y las etiquetas de balanza no se reconocen.",
    minPlan: "Start",
    requires: ["pos"],
    needs: "Para el peso en vivo: una balanza con salida a PC y Chrome o Edge de escritorio (o el puente local).",
  },
  cajon_dinero: {
    desc: "Cajón de dinero: se abre solo al cobrar en efectivo y con el botón Abrir cajón según la política de la sucursal (permitido, con PIN de supervisor o prohibido). Cada apertura queda auditada con usuario, caja, turno y motivo.",
    impact: "Desactivado, el cajón no se abre desde el sistema (queda la llave).",
    minPlan: "Start",
    requires: ["caja"],
    needs: "Un cajón enchufado a la impresora térmica de la caja (pulso ESC/POS por USB, serie o el puente local).",
  },
  impuestos_iva: {
    desc: "IVA por alícuota y condición fiscal: catálogo cerrado (21, 10,5, 27, 5, 2,5, 0 %, exento y no gravado) por producto y variante, listas con o sin IVA, datos fiscales del negocio y del cliente con CUIT o DNI validado, desglose de neto e IVA en cada venta, tipo de comprobante que corresponde (A, B, C, M o E), IVA contenido en el ticket B y reporte de IVA ventas.",
    impact: "Desactivado, el IVA queda fijo en 21 % y no se pueden cargar los datos fiscales del negocio (las ventas siguen funcionando).",
    minPlan: "Start",
  },
  padron_arca: {
    desc: "Verificar clientes en ARCA: al cargar un CUIT o CUIL (en Clientes o desde el POS) se consulta el padrón de ARCA con el certificado de NinjaSoft y se completan razón social, condición frente al IVA, domicilio fiscal y jurisdicción, con las actividades, el estado de la CUIT y la factura que le corresponde. También trae los datos del propio negocio en Configuración › Marca. El cliente queda marcado como verificado (con la fecha) o cargado a mano.",
    impact: "Desactivado, los datos fiscales se cargan a mano y el servidor no marca clientes como verificados en ARCA.",
    minPlan: "Start",
    requires: ["impuestos_iva"],
  },
  impuestos_internos: {
    desc: "Impuestos internos por producto: monto fijo por unidad, porcentaje sobre el precio (tasa nominal, que integra su propia base) o sobre el costo, incluido en el precio o adicional, discriminados en cada venta y fuera de la base del IVA.",
    impact: "Desactivado, los internos no se discriminan: todo el precio se toma como neto más IVA (el servidor rechaza cargarlos).",
    minPlan: "Pro",
    requires: ["impuestos_iva"],
    needs: "Para bebidas alcohólicas, tabaco, electrónica y otros rubros alcanzados por la Ley 24.674.",
  },
  percepciones_retenciones: {
    desc: "Agente de percepción y retención: regímenes de IVA e IIBB por jurisdicción (ARBA, AGIP y otras), padrones importados con la alícuota de cada CUIT y su vigencia, exclusiones con certificado, mínimos de base y de monto; la percepción se suma a la venta como línea aparte. Como agente de retención, la orden de pago calcula Ganancias (RG 830, con acumulado mensual, mínimo no sujeto y escala), IVA, IIBB y SUSS, emite el certificado en PDF y arma los archivos para SICORE y ARBA. Como sujeto, registra las retenciones y percepciones sufridas (Mercado Pago y otras liquidaciones, SIRCREB, SIRTAC, clientes, Mis Retenciones) con su asiento y liquida Ingresos Brutos por jurisdicción con el saldo a favor.",
    impact: "Desactivado, no se perciben ni se calculan retenciones (el servidor no las calcula ni numera certificados), no se pueden importar padrones y no se registran retenciones sufridas ni se liquida Ingresos Brutos.",
    minPlan: "Business",
    requires: ["impuestos_iva"],
    needs: "Estar designado agente por ARCA o la provincia y descargar el padrón del organismo (ARBA lo entrega con la clave CIT del agente).",
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
  presupuestos: {
    desc: "Presupuestos de productos y servicios: número propio, validez, condiciones, revisiones, PDF A4 y ticket con tu marca, envío por WhatsApp o email con un link para que el cliente lo acepte, y conversión en venta con un click desde el POS.",
    impact: "Sin esto no se pueden emitir presupuestos: las cotizaciones se arman fuera del sistema y la venta se carga a mano.",
    minPlan: "Pro",
  },
  pedidos_despacho: {
    desc: "Pedidos de salón y expedición: el vendedor arma el pedido en el POS con el stock reservado por los minutos que elijas, la caja lo levanta y lo cobra (queda el vendedor para las comisiones y la cajera), y expedición lo arma y lo entrega o despacha. Retiro en el momento, retiro en sucursal con código o a nombre, envío a domicilio enganchado con Envíos y retiro en otra sucursal configurable.",
    impact: "Desactivado, no se guardan pedidos ni hay cola de expedición: el vendedor y la caja vuelven a pasarse el carrito a mano (el servidor lo rechaza).",
    minPlan: "Pro",
    requires: ["pos"],
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
    desc: "Promociones: 2x1 y NxM, segunda unidad al %, descuentos por cantidad, combos a precio fijo y promos por medio de pago, tarjeta o banco con días y horarios, por categoría, marca, producto, lista o sucursal, con topes y combinables. El POS las aplica solas, el servidor las vuelve a calcular al cobrar y el ticket muestra cada una.",
    impact: "Sin promociones el POS no aplica combos ni descuentos automáticos por campaña y el servidor rechaza descuentos de promoción. Los cupones siguen funcionando.",
    minPlan: "Pro",
  },
  aprobaciones_comerciales: {
    desc: "Aprobación de cambios comerciales: lo que un encargado cambia en promociones de alto impacto (por porcentaje o por monto) y en recargos o planes de cuotas queda pendiente hasta que el dueño lo aprueba, con vencimiento, aviso y todo el circuito auditado.",
    impact: "Desactivado, los cambios de los encargados se aplican directo, sin aprobación del dueño.",
    minPlan: "Business",
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
  agenda_recursos: {
    desc: "Recursos de agenda: cargá sillas, cabinas, boxes o equipos, asigná cada turno a un recurso, mirá la agenda del día por recurso y evitá dos turnos en el mismo lugar a la misma hora (el sistema lo bloquea).",
    impact: "Desactivada, la agenda se organiza sólo por profesional y no se controla la doble reserva de sillas o cabinas.",
    minPlan: "Pro",
    requires: ["agenda"],
  },
  agenda_senas: {
    desc: "Señas de turnos: cobrá una seña al reservar (en efectivo, transferencia, tarjeta o QR, entra a tu caja) y el POS la descuenta sola al cobrar el turno, sin cobrarla dos veces. Lo que sobra o la seña de un turno cancelado se devuelve con motivo.",
    impact: "Desactivada, no se pueden cobrar señas al reservar; el turno se cobra entero en el momento (el servidor lo rechaza).",
    minPlan: "Pro",
    requires: ["agenda"],
  },
  lista_espera: {
    desc: "Lista de espera: anotá a quien quiere un turno que hoy no tenés libre (servicio, profesional preferido, fecha y franja), avisale por WhatsApp cuando se libera y pasalo a turno con un toque.",
    impact: "Desactivada, no se puede anotar clientes en espera; los huecos se llenan a mano.",
    minPlan: "Start",
    requires: ["agenda"],
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
  comisiones_estimadas: {
    desc: "Comisiones estimadas por medio de pago: cargás lo que te cobra cada procesador (por medio, por procesador y por cuotas, en % más un fijo por cobro y con o sin IVA) y Reportes te muestra, para el período y la sucursal, cuánto cobraste con cada medio, cuánto se lleva el procesador y cuánto te queda. Suma las propinas por medio. No hace falta conectar ninguna cuenta.",
    impact: "Desactivado, Reportes muestra el total por medio de pago sin comisiones ni neto, y el servidor rechaza cargar comisiones o pedir el reporte.",
    minPlan: "Pro",
  },
  alertas_contracargos: {
    desc: "Alertas de contracargos y devoluciones de Mercado Pago: todos los días (y al instante si Mercado Pago avisa) revisa tus cobros y te avisa a vos y a tus encargados cuando un comprador desconoce un pago (contracargo), abre un reclamo o cuando se hace una devolución desde Mercado Pago que no está registrada en el POS. Marca esas ventas en Ventas (\"Contracargo\", \"Devuelto por MP\", filtro \"Con alertas\") y muestra el plazo para presentar la documentación. Con la conciliación de procesadores, además, suma estados, totales y neto efectivo por devoluciones y contracargos.",
    impact: "Desactivado, los contracargos y las devoluciones hechas desde Mercado Pago sólo se ven entrando a la cuenta de Mercado Pago; se puede perder el plazo para presentar la documentación.",
    minPlan: "Start",
    needs: "Mercado Pago conectado en Medios de pago. Para el aviso al instante, conexión por OAuth (por token manual llega con la revisión diaria).",
  },
  reintegro_mp: {
    desc: "Reintegro por Mercado Pago: en una devolución, la plata vuelve a la tarjeta o a la cuenta de Mercado Pago con la que pagó el cliente (QR, link o Point), total o parcial, hasta lo cobrado por ese pago menos lo ya devuelto. Lo hace un supervisor o un cajero con PIN de supervisor, con motivo; queda el id de la devolución de Mercado Pago, auditado, en el detalle del cobro, en la ficha del cliente y en la conciliación como \"Devuelto (POS)\" (sin aviso de devolución desde Mercado Pago). Si Mercado Pago no puede (saldo insuficiente, plazo vencido, pago en disputa), se devuelve en efectivo o con un vale.",
    impact: "Desactivado, las devoluciones de ventas cobradas con Mercado Pago se reintegran en efectivo o con un vale; devolver a la tarjeta hay que hacerlo a mano desde Mercado Pago.",
    minPlan: "Pro",
    requires: ["mercado_pago"],
    needs: "Mercado Pago conectado y \"Permitir devolver el dinero por Mercado Pago\" prendido por el dueño en Medios de pago. La plata sale del saldo de la cuenta de Mercado Pago.",
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
    desc: "Cobros con Getnet (Santander) por link de pago y QR desde el celular del cliente: el cliente paga con tarjeta en la página de Getnet (Web Checkout) y la venta se cierra sola al aprobarse. El checkout propio con tu marca y el Point (terminal) son funciones aparte.",
    impact: "Desactivado, no se puede cobrar con Getnet desde el POS.",
    minPlan: "Pro",
    needs: "Conectar Getnet con las credenciales que dicen Web Checkout / Plugin Magento / Plugin WooCommerce (Client ID y Client Secret). Se pueden probar en el ambiente de prueba de Getnet antes de cobrar de verdad.",
  },
  getnet_checkout_propio: {
    desc: "Checkout propio con Getnet: el QR o el link abren tu página de pago de NinjaPOS, con tu logo y tu color. El cliente elige la tarjeta y las cuotas de tus Planes (con el interés de cada opción a la vista), carga la tarjeta y paga; Getnet procesa el cobro y la venta se cierra sola. Es lo mismo que el checkout de Payway.",
    impact: "Desactivado, con Getnet sólo se cobra con la página de Getnet (QR y link de Web Checkout).",
    minPlan: "Pro",
    requires: ["getnet"],
    needs: "Las credenciales que dicen Checkout API / Plugin VTEX cargadas en Getnet (no son las de Web Checkout) y planes de cuotas de Getnet. Se habilita cuando NinjaPOS completa la certificación PCI que pide Getnet para cargar la tarjeta en una página propia.",
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
  depositos: {
    desc: "Depósitos internos: dentro de cada sucursal, el salón de ventas y los depósitos que quieras (reserva, devoluciones, merma) con su stock, movimientos internos que quedan en tránsito, recepción parcial con faltantes y sobrantes con motivo, conteo por depósito, reposición del salón sugerida por mínimos e importación desde Excel.",
    impact: "Desactivado, el stock de cada sucursal es un solo número: no se distingue lo que está en el salón de lo que está en el depósito (el servidor lo rechaza).",
    minPlan: "Pro",
    requires: ["stock"],
  },
  reservas_stock: {
    desc: "Reservas de stock y retiro en tienda: apartá productos para un cliente en cualquier sucursal (también desde otra, con su stock), con vencimiento, preparación y entrega validada con código de 6 dígitos o documento contra la venta cobrada en el POS. Lo reservado se resta del disponible para reservar y se ve en el cockpit.",
    impact: "Desactivado, no se puede apartar stock para un cliente ni registrar retiros en tienda (el servidor lo rechaza).",
    minPlan: "Pro",
    requires: ["stock"],
  },
  alertas_margen: {
    desc: "Alertas de margen: productos que se venden bajo costo, bajo el precio mínimo o con margen menor al mínimo del negocio, con el precio sugerido para volver al mínimo y aviso en la campana cuando un costo nuevo deja un producto debajo.",
    impact: "Desactivado, no hay lista de márgenes bajos ni aviso cuando sube un costo (el servidor lo rechaza).",
    minPlan: "Start",
    requires: ["productos"],
  },
  conteo_ciclico: {
    desc: "Conteo cíclico: cada día el sistema propone qué contar por sucursal según la clase ABC (lo que más vende se cuenta más seguido), ajusta las diferencias y mide la exactitud de cada conteo.",
    impact: "Desactivado, el stock se cuenta a mano o por importación, sin rotación ABC ni exactitud por conteo (el servidor lo rechaza).",
    minPlan: "Pro",
    requires: ["stock"],
  },
  garantias_serie: {
    desc: "Garantías por número de serie: buscás un IMEI o una serie y ves la venta, el cliente, la garantía de fábrica y la extendida con su vencimiento, y abrís y seguís el reclamo de posventa.",
    impact: "Desactivado, no se consulta la garantía por serie ni se registran reclamos (el servidor lo rechaza).",
    minPlan: "Pro",
    requires: ["productos"],
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
  contabilidad: {
    desc: "Contabilidad: plan de cuentas con plantilla argentina y centros de costo por sucursal; asientos automáticos desde ventas por medio de cobro, cobranzas de cuenta corriente, devoluciones, cierres de caja, compras, órdenes de pago, tesorería, liquidaciones de procesadores y contracargos, con mapeos configurables; asientos manuales, cierre mensual que bloquea el período, Libro Diario, Mayor, sumas y saldos, estado de resultados, IVA ventas y compras, y export para el estudio (Tango, Holistor, Xubio, Colppy o CSV a medida).",
    impact: "Desactivado, no se generan asientos ni se puede cargar ni exportar la contabilidad (el servidor lo rechaza). Lo ya generado queda guardado y se ve al volver a activarla.",
    minPlan: "Business",
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
  costo_final: {
    desc: "Costo final y utilidad en la ficha del producto: lo que se suma al costo de compra (impuestos internos y percepciones no recuperables, flete, otros, en % o en pesos), el costo final, la utilidad objetivo con markup sobre costo o margen sobre precio, el precio sugerido y la ganancia real en pesos y en %. Las listas sobre costo y el margen mínimo pueden usar el costo final.",
    impact: "Desactivado, el servidor rechaza cargar componentes del costo o utilidad objetivo; lo cargado se conserva y el costo final queda igual al de compra para lo nuevo.",
    minPlan: "Start",
  },
  precios_usd: {
    desc: "Costos en dólares: el costo del producto se carga en USD y se pasa a pesos con la cotización oficial venta del día (la trae NinjaSoft todos los días) o la que cargue el negocio. Actualizar precios por dólar en lote (por categorías, marcas, proveedores y listas) manteniendo la ganancia o con la utilidad objetivo, con vista previa, alertas y deshacer, y reglas automáticas cuando el dólar se mueve más de un % con aprobación del dueño.",
    impact: "Desactivado, no se pueden cargar costos nuevos en dólares ni actualizar por dólar; las reglas automáticas dejan de correr. Los productos que ya estaban en dólares conservan su costo en pesos.",
    minPlan: "Pro",
  },
  catalogo_publico: {
    desc: "Catálogo web público: una vitrina online del comercio con sus productos y precios, compartible por link.",
    impact: "Desactivado, no se publica el catálogo web del negocio.",
    minPlan: "Pro",
  },
  catalogo_pedidos: {
    desc: "Pedidos desde el catálogo web: el cliente arma el carrito con variantes y stock disponible, elige retiro en sucursal o envío a domicilio, deja sus datos y confirma. El pedido entra al POS y a Pedidos con el stock reservado, te llega un aviso, la caja lo cobra y expedición lo entrega; el cliente lo sigue con un link y puede escribirte por WhatsApp.",
    impact: "Desactivado, el catálogo queda como vitrina: el cliente ve productos y precios pero no puede pedir (el servidor lo rechaza).",
    minPlan: "Pro",
    requires: ["catalogo_publico", "pedidos_despacho"],
  },
  importacion_excel: {
    desc: "Importación desde Excel: carga y actualización masiva de productos, clientes, stock por sucursal, listas de precios, sucursales, garantías y motivos de devolución con plantilla, revisión previa (qué se crea, qué se actualiza y qué filas tienen errores), confirmación y auditoría. Lo que cada importación escribe sigue pidiendo su propia función del plan.",
    impact: "Sin esto la carga de productos, clientes, stock y precios es sólo manual, uno por uno.",
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
  clientes_360: {
    desc: "Ficha del cliente 360: en una página propia, todo lo del cliente: datos y datos fiscales, indicadores (total comprado, cantidad de compras, frecuencia, ticket promedio, última compra, sucursal de alta y compras por sucursal), segmentos automáticos (nuevo, frecuente, VIP, en riesgo, inactivo, con deuda), línea de tiempo unificada con filtros (ventas, devoluciones, cobranzas y movimientos de cuenta corriente, vales, cobros en espera, reintegros por Mercado Pago, contracargos y notas internas), productos y medios de pago preferidos, gráficos de compras por mes y exportación a Excel.",
    impact: "Desactivado, queda el historial básico del cliente (vale, compras y devoluciones) en la lista de clientes.",
    minPlan: "Pro",
    requires: ["clientes"],
  },
  roles_permisos: {
    desc: "Roles y permisos: define qué puede hacer cada usuario (cajero, encargado, dueño) dentro del sistema.",
    impact: "Desactivado, no hay control granular de permisos por usuario más allá del rol base.",
    minPlan: "Business",
  },

  // ── Tickets ─────────────────────────────────────────────────────────────────
  tickets_pro: {
    desc: "Personalización de comprobantes: modelos de factura A4 (Moderno, Minimal, Corporativo, Ejecutivo, Elegante, Bloques de color, Compacto de una hoja y Catálogo con fotos) y de ticket (Compacto, Destacado, Moderno, Minimal), tipografía, densidad, bordes rectos, posición del logo, estilo del encabezado y separadores, fotos de producto, color y logo propios y leyendas propias.",
    impact: "Sin esto se usan los modelos Clásicos de factura A4 y ticket, con el color y el logo de tu marca, que igual cumplen todo lo que pide ARCA.",
    minPlan: "Pro",
  },
  comprobantes_sin_sello: {
    desc: "Comprobantes sin sello NinjaSoft: oculta la leyenda “Un software de Ninja Soft” y su logo del pie de facturas, notas de crédito y tickets.",
    impact: "Sin esto los comprobantes llevan al pie el sello “Un software de Ninja Soft”.",
    minPlan: "Business",
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
    minPlan: "Pro",
    needs: "Mercado Pago conectado (Medios de pago) para la sincronización automática; para Payway y otros, el archivo de liquidación del portal del adquirente.",
  },
  cockpit_comercio: {
    desc: "Cockpit de comercio unificado: en una pantalla, qué canal vende (mostrador, salón, delivery, WhatsApp, links de pago, retiro en tienda, sin conexión) por sucursal, qué pedidos, reservas y traslados faltan surtir, qué cobros fallaron o no se concilian, qué facturas están bloqueadas, cuánto stock está reservado o en camino, y alertas con plazo (pedido demorado, quiebre de stock, caja sin señal).",
    impact: "Desactivado, cada dato se mira en su pantalla (ventas, delivery, cobros, facturación, stock) sin una vista central ni alertas cruzadas (el servidor lo rechaza).",
    minPlan: "Business",
  },
  prevencion_fraude: {
    desc: "Prevención de fraude: señales por persona (anulaciones, descuentos altos, devoluciones, cobros rechazados y diferencias de caja), reglas con los umbrales del negocio y marca automática de las devoluciones y anulaciones de riesgo para revisarlas con nota, todo en la auditoría.",
    impact: "Desactivado, las devoluciones y anulaciones no se puntúan ni se marcan, y no hay vista de riesgo por persona (el servidor lo rechaza). El PIN de supervisor sigue funcionando.",
    minPlan: "Business",
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
  // ── Envíos y logística (ADR-103) ──────────────────────────────────────────
  envios: {
    desc: "Envíos con etiquetas de logísticas integradas: creás el envío desde una venta del POS, un pedido o a mano, cotizás entre las logísticas que conectaste (con tu contrato, por negocio o por sucursal), imprimís la etiqueta en PDF o la mandás a la térmica (ZPL), y el estado se actualiza solo con su línea de tiempo. Cancelación, reintentos sin duplicar envíos, impresión por lote y un simulador para probar sin contrato.",
    impact: "Desactivado, no se cotizan ni se crean envíos y el servidor rechaza cada operación; los envíos ya creados se pueden seguir mirando.",
    minPlan: "Pro",
    needs: "Contrato con cada logística (usuario y clave de su API). El simulador no necesita nada.",
  },
  andreani: {
    desc: "Andreani con tu contrato: cotización a domicilio y a sucursal, alta de la orden, etiqueta PDF térmica, sucursales de retiro por código postal y seguimiento automático. Credenciales por negocio o por sucursal, ambiente de prueba y producción.",
    impact: "Desactivado, Andreani no aparece para cotizar ni crear envíos (el servidor lo rechaza).",
    minPlan: "Pro",
    requires: ["envios"],
    needs: "Usuario y contraseña de la API de Andreani, número de cliente y un contrato por servicio (los da tu ejecutivo de cuentas).",
  },
  correo_argentino: {
    desc: "Correo Argentino (MiCorreo para pymes o PAQ.AR para empresas). Próximamente: se pueden dejar cargadas las credenciales.",
    impact: "Desactivado, no se puede conectar Correo Argentino.",
    minPlan: "Pro",
    requires: ["envios"],
    needs: "Cuenta MiCorreo con credenciales de API, o Agreement y API key de PAQ.AR.",
  },
  oca: {
    desc: "OCA e-Pak. Próximamente: se pueden dejar cargadas las credenciales.",
    impact: "Desactivado, no se puede conectar OCA.",
    minPlan: "Pro",
    requires: ["envios"],
    needs: "Cuenta e-Pak con CUIT y una operativa por servicio.",
  },
  enviopack: {
    desc: "Envíopack, agregador con varios carriers en una sola cuenta (útil sin contrato propio con cada logística). Próximamente: se pueden dejar cargadas las credenciales.",
    impact: "Desactivado, no se puede conectar Envíopack.",
    minPlan: "Business",
    requires: ["envios"],
    needs: "Cuenta Envíopack con API key y secret key.",
  },
  api_publica: {
    desc: "API pública v1: API REST versionada para conectar tu tienda online, ERP o planillas. Credenciales OAuth2 por integración con permisos por alcance (productos, stock, precios, ventas y clientes), secreto que se muestra una vez, rotación, revocación y último uso. Productos y precios en lote hasta 500 por pedido con Idempotency-Key, stock por sucursal con motivo, ventas por rango (sólo lectura), límite de pedidos por minuto y todo en la auditoría.",
    impact: "Desactivado, no se emiten tokens y la API rechaza cada pedido (el servidor lo exige); las credenciales existentes se pueden ver y revocar.",
    minPlan: "Enterprise",
    needs: "Un sistema que se integre por HTTP y guarde el client_id y el secreto de forma segura.",
  },
  mercadolibre: {
    desc: "Mercado Libre integrado al POS: conectás una o varias cuentas (OAuth seguro, renovación automática y aviso para reconectar), importás tus publicaciones y las vinculás con tus productos por SKU o código de barras, o publicás desde la ficha del producto con la categoría sugerida, los datos que pide la categoría y validación previa. Publicación rápida en lote: elegís productos (búsqueda o escáner), la categoría se sugiere sola por título y código de barras (con el catálogo de Mercado Libre), los datos se completan desde la ficha y lo usado antes, y sólo completás lo que falta en una grilla. Varios tipos de publicación (Clásica y Premium) del mismo producto, cada uno con su recargo o su lista de precios, redondeo y precio mínimo, y excepciones por producto. Visitas de 30 días y calidad por publicación. El stock publicable sale de la sucursal o depósito que elijas (con reserva de seguridad) y el precio de una lista propia del canal o de un margen sobre el precio del POS, sin pisar la automatización de precios de Mercado Libre. Cada orden pagada entra sola como venta del canal Mercado Libre con su comisión y envío, descuenta el stock una sola vez y una cancelación la revierte. Facturación ARCA al pagarse, al despacharse o a mano, con la letra según el comprador, y el PDF subido a la venta en Mercado Libre. Etiquetas de envío en PDF o ZPL de a 50, bloqueo por riesgo de fraude y bandeja de preguntas.",
    impact: "Desactivado, no se conectan cuentas, no se publican ni sincronizan publicaciones y las órdenes no entran como ventas (el servidor lo exige); lo ya registrado se puede consultar.",
    minPlan: "Pro",
    needs: "Una cuenta de Mercado Libre del dueño (usuario administrador, no colaborador) y la app de Mercado Libre de NinjaSoft configurada.",
  },
  mercadolibre_gestor: {
    desc: "Gestor de Mercado Libre: métricas de reputación como las de un vendedor grande (nivel, MercadoLíder, ventas, calificaciones y, para reclamos, cancelaciones y despachos con demora, cuánto margen te queda antes de perder el verde), evolución diaria y los casos que afectan la reputación. Posventa con los reclamos, mediaciones y devoluciones y su vencimiento: responder con adjuntos y plantillas, pedir la mediación de Mercado Libre, aceptar la devolución u ofrecer un reintegro parcial con confirmación, y los mensajes de la venta. Embudos de ventas y de posventa con etapas propias y asignación al equipo. Avisos en el centro de notificaciones.",
    impact: "Desactivado, no se ven métricas, posventa ni embudos y el servidor rechaza responder reclamos, cambiar etapas o guardar plantillas; la integración de Mercado Libre sigue igual.",
    minPlan: "Pro",
    requires: ["mercadolibre"],
    needs: "Una cuenta de Mercado Libre conectada.",
  },
  integracion_nubceo: {
    desc: "Integración con NubCeo: cada venta viaja sola a NubCeo con sus cobros (tarjeta, QR, transferencia, cupón, lote, autorización, n° de comercio) para conciliarla contra las liquidaciones. Ritmo y ventana horaria configurables, modo solo simular, mapeo de campos y medios, monitor de lo enviado con reintentos, anulaciones que se borran de NubCeo, devoluciones como nota de crédito e importación de los asientos contables que arma NubCeo.",
    impact: "Desactivado, no se mandan ventas a NubCeo ni se importan asientos (el servidor lo rechaza); lo ya enviado se puede seguir mirando.",
    minPlan: "Business",
    needs: "Credenciales de la API de NubCeo (API key, API secret y tenant) y el código de sucursal cabecera de cada sucursal.",
  },
  canales_delivery: {
    desc: "Canales de delivery: los pedidos de PedidosYa, Rappi, Uber Eats y Mercado Pago Delivery entran solos al tablero de Delivery de la sucursal, mandan la comanda a cocina (al instante si se aceptan solos, o al tocar Aceptar con el tiempo de preparación), avisan a la app aceptado, rechazado, listo y retirado con reintentos, muestran al repartidor (nombre, teléfono, cuánto falta y mapa) y se facturan solos al retirarse o con un botón, con la facturación electrónica del negocio. Si la app cancela, se anula la comanda y, si ya estaba facturado, sale la nota de crédito. Mapeo de productos con sugerencias por nombre y SKU, comisión estimada por pedido y un simulador para probar todo sin la app.",
    impact: "Desactivado, no se conectan apps de delivery, el servidor no procesa los pedidos que mandan ni las acciones sobre ellos y no se puede cobrar con el medio Plataforma; los pedidos ya recibidos se siguen viendo.",
    minPlan: "Pro",
    needs: "Delivery activado en Operación y el alta como integración con cada app (PedidosYa, Rappi, Uber Eats); el simulador funciona sin trámite.",
  },
  facturacion_afip: {
    desc: "Facturación electrónica con ARCA (ex AFIP): factura A, B y C y notas de crédito con CAE por cada venta, devolución o anulación, con el tipo de comprobante según la condición fiscal del negocio y del cliente. Asistente paso a paso (certificado generado en NinjaSoft, punto de venta, prueba en homologación y paso a producción con checklist), cola con reintentos que nunca frena la venta, contingencia con CAEA si ARCA no responde, QR fiscal en el ticket, monitor de comprobantes y Libro IVA Digital del mes (archivos de ventas y compras para importar en el Portal IVA, con revisión previa).",
    impact: "Desactivado, el sistema sólo emite comprobantes no fiscales, el servidor no encola ni emite facturas y no genera el Libro IVA Digital (lo ya emitido se puede seguir consultando).",
    minPlan: "Pro",
    requires: ["impuestos_iva"],
    needs: "Clave fiscal de ARCA nivel 3 del titular para autorizar el certificado y dar de alta un punto de venta Web Services.",
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
  escuela: {
    desc: "Escuela NinjaSoft: cursos cortos por rol (POS básico, caja y arqueo, primeros pasos, facturación ARCA) con lecciones, checklist, prueba corta y certificado. El dueño ve el avance de su equipo.",
    impact: "Desactivada, el equipo sigue teniendo la ayuda de cada pantalla pero no puede hacer cursos ni certificarse.",
    minPlan: "Start",
  },
  tours: {
    desc: "Recorridos guiados: pasos sobre la pantalla (primer cobro, recorrido por rubro como heladería) con foco en el botón a tocar y \"hacer ahora\". NinjaSoft los actualiza sin que el negocio tenga que hacer nada.",
    impact: "Desactivado, nadie del negocio ve recorridos; la ayuda y la Escuela siguen disponibles.",
    minPlan: "Start",
  },
  sugerencias: {
    desc: "Sugerencias de uso: avisos cortos según lo que pasa en el negocio (sin productos, caja cerrada, prueba por vencer, cobro fallido), con límite por día para no molestar.",
    impact: "Desactivado, el negocio no recibe sugerencias en pantalla; los anuncios de la campana siguen llegando.",
    minPlan: "Start",
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
