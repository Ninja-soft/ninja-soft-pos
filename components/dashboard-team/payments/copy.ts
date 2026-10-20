// Textos de la configuración de medios de pago (voseo, corto, sin guion largo).

// URL de notificaciones que el dueño informa a Nave en el onboarding (Nave la
// registra de su lado; no viaja por request).
export function naveWebhookUrl(supabaseUrl: string | undefined = process.env.NEXT_PUBLIC_SUPABASE_URL): string {
  let host = "";
  try {
    host = supabaseUrl ? new URL(supabaseUrl).host : "";
  } catch {
    host = "";
  }
  return `https://${host}/functions/v1/nave_webhook`;
}

export const NAVE_WEBHOOK_URL = naveWebhookUrl();

// Mail listo para mandar a Nave: pide registrar la URL de notificaciones en
// sandbox y producción, y las credenciales que el dueño carga en el paso 1.
export const NAVE_INTEGRATIONS_EMAIL = "integraciones@navenegocios.com";

export function naveRegistrationEmail(businessName: string | null | undefined, webhookUrl = NAVE_WEBHOOK_URL) {
  const name = businessName?.trim() || "mi negocio";
  const subject = `Registro de URL de notificaciones - ${name}`;
  const body = [
    "Hola, equipo de Integraciones de Nave:",
    "",
    `Les escribo de ${name}. Usamos NinjaSoft POS para cobrar con Nave y necesitamos que registren nuestra URL de notificaciones (webhook) en los ambientes de sandbox y de producción:`,
    "",
    webhookUrl,
    "",
    "Además, les pedimos:",
    "1. Client ID y Client Secret (sandbox y producción).",
    "2. El ID de punto de venta (pos_id) para cobrar con QR y link de pago.",
    "3. Los IDs de las terminales Nave Point que vamos a usar.",
    "",
    "Muchas gracias.",
    name,
  ].join("\n");
  const mailto = `mailto:${NAVE_INTEGRATIONS_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  const text = `Para: ${NAVE_INTEGRATIONS_EMAIL}\nAsunto: ${subject}\n\n${body}`;
  return { to: NAVE_INTEGRATIONS_EMAIL, subject, body, mailto, text };
}

// Resumen de una línea por canal (bajo el título del canal).
export const CHANNEL_SUMMARY: Record<string, string> = {
  cash: "Entra al arqueo de caja",
  transfer: "A tu CBU, CVU o alias, con los datos en pantalla",
  mercadopago: "Un QR por venta en la pantalla o un link por WhatsApp",
  mercadopago_point: "Tarjeta, contactless y cuotas en tu lector Point",
  payway: "Checkout de Payway con tus planes de cuotas",
  payway_point: "Terminal Payway integrada al POS",
  getnet: "QR y link con el checkout de Getnet, con crédito o débito",
  getnet_point: "Terminal Getnet integrada al POS",
  nave: "QR interoperable: lo paga cualquier billetera",
  nave_point: "Tarjeta, contactless o QR en tu terminal Nave",
  modo: "Pagan con MODO o la app de su banco",
  mobbex: "Checkout de Mobbex con tarjetas y cuotas",
  pagos360: "Tarjeta, débito, DEBIN o efectivo",
  fiserv: "Cobrás en tu terminal Fiserv y cargás el cupón en el POS",
  fiserv_point: "El monto viaja a tu terminal Clover: tarjeta, contactless y cuotas",
  gocuotas: "2 a 4 cuotas sin interés con débito",
  directo: "QR y link de Directo, o registro manual de la operación",
  ualabis: "Link de pago y QR por API, o registro de tu QR, POS o Tap",
  viumi: "Link de pago y QR con el checkout de Viumi",
  talo: "Un CVU y un alias por venta: se confirma solo al llegar la plata",
};

// Explicación desplegable por canal: qué pasa al activarlo y cómo es el cobro.
export type Explain = { activa: string; pasos?: string[] };

export const CHANNEL_INFO: Record<string, Explain> = {
  cash: {
    activa: "Aparece como forma de pago en el POS. Lo cobrado entra al arqueo de caja.",
    pasos: [
      "En el POS tocás Cobrar y elegís Efectivo.",
      "Recibís la plata y das el vuelto.",
      "La venta suma al cierre de caja (Z).",
    ],
  },
  transfer: {
    activa:
      "Aparece como forma de pago en el POS. Cargá tus cuentas y el POS muestra banco, titular, CBU / CVU y alias para que el cliente transfiera (también en la pantalla del cliente).",
    pasos: [
      "En el POS tocás Cobrar y elegís Transferencia.",
      "El cliente transfiere a la cuenta que muestra la pantalla.",
      "Verificás que la plata llegó, cargás el n° de operación si lo pedís y tocás Ya transfirió.",
    ],
  },
  mercadopago: {
    activa:
      "Suma Cobrar con QR y con link en el POS. La plata entra a tu cuenta de Mercado Pago. Configurá la caja QR una vez para mostrar un QR único por venta.",
    pasos: [
      "En el POS tocás Cobrar con QR o Link.",
      "El cliente escanea con su billetera o abre el link.",
      "Al acreditarse, la venta se cierra sola.",
    ],
  },
  mercadopago_point: {
    activa:
      "El cobro viaja a tu lector Point y el cliente paga con tarjeta ahí. Los Planes de Mercado Pago (cuotas y recargo por tarjeta) se configuran acá.",
    pasos: [
      "Vinculá el lector desde la app de Mercado Pago y ponelo en modo PDV.",
      "En el POS tocás Cobrar con Point y elegís el lector.",
      "Al aprobarse, la venta se registra sola como débito o crédito.",
    ],
  },
  payway: {
    activa:
      "El QR o el link abren el checkout de tu tienda Payway: el cliente carga la tarjeta y elige las cuotas de tus Planes.",
    pasos: [
      "En el POS tocás Cobrar con Payway.",
      "El cliente escanea el QR o abre el link y paga.",
      "Al aprobarse, la venta se cierra sola.",
    ],
  },
  getnet: {
    activa:
      "Con las credenciales de Web Checkout / Plugin Magento / Plugin WooCommerce el cliente paga en la página de Getnet desde el QR o el link.",
    pasos: [
      "En el POS elegís Getnet: QR o Link.",
      "El cliente escanea el QR o abre el link y paga.",
      "Al aprobarse, la venta se cierra sola.",
    ],
  },
  nave: {
    activa: "Un QR interoperable (lo paga cualquier billetera o app bancaria) y un link de pago.",
    pasos: [
      "En el POS elegís cobrar con Nave.",
      "El cliente escanea el QR o abre el link y paga.",
      "Nave nos avisa, verificamos el pago y la venta se cierra sola.",
    ],
  },
  nave_point: {
    activa: "El POS manda el monto a la terminal y el cliente paga con tarjeta, contactless o QR.",
    pasos: [
      "Cargá el ID de cada terminal al conectar Nave.",
      "En el POS elegís Nave Point y la terminal.",
      "Al aprobarse, la venta se registra sola.",
    ],
  },
  fiserv: {
    activa:
      "Suma Tarjeta en posnet al POS: cobrás en tu terminal Posnet o Clover y cargás los datos del cupón. No hace falta conectar nada.",
    pasos: [
      "En el POS elegís Tarjeta en posnet.",
      "Cobrás en la terminal Fiserv.",
      "Cargás el cupón y la venta queda como débito o crédito.",
    ],
  },
  fiserv_point: {
    activa:
      "El POS manda el monto a tu terminal Clover (Flex o Mini) y el cliente paga ahí con tarjeta, contactless o en cuotas.",
    pasos: [
      "Conectá Fiserv con el Merchant ID y el token de Clover.",
      "En cada terminal abrí la app Cloud Pay Display y dejala abierta.",
      "En el POS elegís Clover Point y la terminal: al aprobarse, la venta se registra sola.",
    ],
  },
  modo: {
    activa: "El cliente paga con MODO o la app de su banco y la plata entra a tu cuenta de comercio.",
    pasos: [
      "En el POS tocás Cobrar con QR · MODO.",
      "El cliente escanea con MODO y paga.",
      "Al acreditarse, la venta se cierra sola.",
    ],
  },
  mobbex: {
    activa: "El cliente paga con tarjeta o saldo en el checkout de Mobbex. La plata entra a tu cuenta.",
    pasos: [
      "En el POS tocás Cobrar con Mobbex.",
      "El cliente escanea el QR o abre el link y paga.",
      "Al acreditarse, la venta se cierra sola.",
    ],
  },
  gocuotas: {
    activa:
      "El cliente paga en 2 a 4 cuotas sin interés con su débito, desde el QR o el link. El cobro mínimo es de $1.500.",
    pasos: [
      "En el POS elegís cobrar con GO Cuotas.",
      "El cliente escanea el QR o abre el link y elige las cuotas.",
      "GO Cuotas nos avisa, verificamos la orden y la venta se cierra sola.",
    ],
  },
  ualabis: {
    activa:
      "Conectada la API, el POS arma un link de pago de Ualá Bis (también como QR) y la venta se cierra sola al acreditarse. Sin conectar, o para tu QR, POS Mini, POS Pro o Tap en tu celu, cobrás en la app de Ualá y cargás el número de operación.",
    pasos: [
      "En el POS elegís Ualá Bis: Link, QR o QR, POS o Tap.",
      "Con Link o QR el cliente paga con tarjeta en el checkout de Ualá Bis. El QR se escanea con la cámara del celular: no lo leen las billeteras virtuales (no es interoperable).",
      "Ualá nos avisa, verificamos la orden y la venta se cierra sola.",
    ],
  },
  viumi: {
    activa:
      "El POS arma un link de pago de Viumi (también como QR) y la venta se cierra sola al acreditarse. Las devoluciones se hacen desde la app o el panel de Viumi.",
    pasos: [
      "En el POS elegís Viumi: Link o QR.",
      "El cliente abre el link o escanea el QR con la cámara del celular y paga con tarjeta en el checkout de Viumi.",
      "Viumi nos avisa, verificamos la orden y la venta se cierra sola.",
    ],
  },
  talo: {
    activa:
      "Cada venta tiene su propio CVU y alias de Talo. El cliente transfiere desde cualquier banco o billetera y la venta se cierra sola cuando Talo confirma la plata, sin pedir comprobante.",
    pasos: [
      "En el POS elegís Transferencia, Talo.",
      "El cliente transfiere el total al CVU o alias que aparece en pantalla, o abre el link o el QR de Talo.",
      "Talo nos avisa, verificamos el pago y la venta se cierra sola. Si transfiere de menos, el POS muestra cuánto falta.",
    ],
  },
  pagos360: {
    activa: "Se genera una solicitud de pago y el cliente paga desde el link o el QR.",
    pasos: [
      "En el POS tocás Cobrar con Pagos360.",
      "El cliente abre el link o escanea el QR y paga.",
      "Al acreditarse, la venta se cierra sola.",
    ],
  },
};

// =============================================================================
// Capacidades de cobro por canal (badges en cada fila).
//   qr    → el cliente escanea un QR desde su celular.
//   link  → le mandás un link de pago (WhatsApp, mail).
//   point → terminal de tarjeta en el mostrador.
// =============================================================================
export type ChannelCap = "qr" | "link" | "point";

export const CHANNEL_CAPS: Record<string, ChannelCap[]> = {
  mercadopago: ["qr", "link"],
  mercadopago_point: ["point"],
  payway: ["qr", "link"],
  payway_point: ["point"],
  getnet: ["qr", "link"],
  getnet_point: ["point"],
  nave: ["qr", "link"],
  nave_point: ["point"],
  modo: ["qr"],
  mobbex: ["qr", "link"],
  pagos360: ["qr", "link"],
  gocuotas: ["qr", "link"],
  directo: ["qr", "link"],
  ualabis: ["qr", "link"],
  viumi: ["qr", "link"],
  talo: ["qr", "link"],
  fiserv: ["point"],
  fiserv_point: ["point"],
};

export const CAP_COPY: Record<ChannelCap, { label: string; legend: string }> = {
  qr: { label: "QR", legend: "El cliente escanea con su celular" },
  link: { label: "Link de pago", legend: "Se lo mandás por WhatsApp" },
  point: { label: "Point", legend: "Terminal de tarjeta en el mostrador" },
};

// Título de la fila según el canal.
export const CHANNEL_TITLE = {
  qr_link: "Cobro desde el celular",
  point: "Terminal en el mostrador",
  manual: "Cobro en su portal",
} as const;

// Por qué un canal sigue en "Próximamente" (relevamiento 2026-10, ver
// docs/payments/research-points-2026-10.md). Honesto: depende del proveedor.
export const CHANNEL_SOON_REASON: Record<string, string> = {
  payway_point:
    "Integración directa: Payway todavía no publica una API para mandar el cobro desde el POS a sus terminales; cuando la publique, el monto va a viajar solo a la terminal.",
  getnet_point:
    "Integración directa: Getnet ofrece integrar terminales sólo a partners y no confirmó que esté disponible en Argentina; mientras tanto el cobro se registra con el cupón.",
};

// Terminales sin integración directa que HOY ya se cobran con el posnet
// offline (Tarjeta en posnet, ADR-054): el cajero cobra en la terminal y carga
// el cupón. La fila deja de ser un "Próximamente" vacío y lleva a configurar
// los datos del cupón.
export const OFFLINE_TERMINAL: Record<string, { brand: string; today: string }> = {
  payway_point: {
    brand: "Payway",
    today:
      "Ya podés cobrar con tu terminal Payway: en el POS elegís Tarjeta en posnet, pasás la tarjeta en la terminal y cargás los datos del cupón. Queda registrado con su lote y autorización para conciliar.",
  },
  getnet_point: {
    brand: "Getnet",
    today:
      "Ya podés cobrar con tu terminal Getnet: en el POS elegís Tarjeta en posnet, pasás la tarjeta en la terminal y cargás los datos del cupón. Queda registrado con su lote y autorización para conciliar.",
  },
};

// Títulos propios de algunos canales (pisan al del canal).
export const CHANNEL_TITLE_BY_KEY: Record<string, string> = {
  fiserv: "Posnet o Clover sin integrar",
  fiserv_point: "Clover Point · Terminal en el mostrador",
};

// =============================================================================
// Guía de conexión por proveedor (modal Conectar). Texto corto, voseo.
//   steps    → mini pasos numerados (ícono + acción).
//   where    → ruta dentro del panel del proveedor ("Dónde lo encuentro").
//   note     → aclaración neutra (ambientes, credenciales).
//   warning  → aviso importante (relleno tonal).
// =============================================================================
export type GuideIcon = "login" | "key" | "paste" | "mail" | "store" | "settings" | "code" | "bell";

export type ConnectGuide = {
  steps: { icon: GuideIcon; text: string }[];
  where: string;
  note?: string;
  warning?: { title: string; text: string };
};

export const CONNECT_GUIDE: Record<string, ConnectGuide> = {
  modo: {
    steps: [
      { icon: "mail", text: "Abrí el email de alta que te mandó MODO." },
      { icon: "key", text: "Copiá el Username y el Password." },
      { icon: "paste", text: "Pegalos acá abajo." },
    ],
    where: "Email de alta de MODO",
    note: "Si terminan en -preprod, son credenciales de prueba.",
  },
  nave: {
    steps: [
      { icon: "login", text: "Entrá a Nave y abrí Integraciones." },
      { icon: "key", text: "Copiá Client ID, Client Secret y el ID de punto de venta." },
      { icon: "bell", text: "Pasale a Nave la URL de notificaciones de abajo." },
    ],
    where: "Nave › Integraciones › Sistema de gestión",
    note: "Prueba y producción usan credenciales distintas.",
  },
  payway: {
    steps: [
      { icon: "login", text: "Entrá al panel de comercio de Payway." },
      { icon: "key", text: "En Credenciales, copiá la API Key pública y la privada." },
      { icon: "store", text: "Sumá tu número de comercio (site)." },
    ],
    where: "Panel de comercio › Credenciales",
  },
  getnet: {
    steps: [
      { icon: "login", text: "Entrá al Portal Getnet o pedíselas a tu ejecutivo." },
      {
        icon: "key",
        text: "Buscá las que dicen Web Checkout, Plugin Magento o Plugin WooCommerce y copiá su Client ID y Client Secret.",
      },
      { icon: "paste", text: "Pegalos acá y, en el paso siguiente, tocá Probar credenciales. Si no pasan la prueba, no se guardan." },
    ],
    where: "Portal Getnet › Credenciales",
    // El aviso de Checkout API / Plugin VTEX lo pone el asistente debajo de la
    // tarjeta de Web Checkout (ADR-069 adenda).
  },
  pagos360: {
    steps: [
      { icon: "login", text: "Entrá al panel de Pagos360." },
      { icon: "settings", text: "Andá a Configuración › Credenciales." },
      { icon: "key", text: "Copiá la API Key y pegala acá." },
    ],
    where: "Panel › Configuración › Credenciales",
  },
  gocuotas: {
    steps: [
      { icon: "login", text: "Entrá al panel de GO Cuotas." },
      { icon: "store", text: "Abrí Sucursales › Editar › Ver ApiKeys." },
      { icon: "key", text: "Copiá la API Key del ambiente que vas a usar." },
    ],
    where: "Sucursales › Editar › Ver ApiKeys",
    note: "Hay una API Key de producción y otra de prueba.",
  },
  directo: {
    steps: [
      { icon: "mail", text: "Pedile a Directo las credenciales de integración por API." },
      { icon: "key", text: "Copiá la API Key, el usuario, la contraseña y el nombre del comercio." },
      { icon: "code", text: "Sumá la URL de la API (y la Subscription Key si te la dieron)." },
    ],
    where: "Mail de integración de Directo (comercial o soporte de comercios)",
    note: "QA y producción usan credenciales y URL distintas. Sin conectar, igual podés cobrar en su portal y registrar el número de operación.",
  },
  ualabis: {
    steps: [
      { icon: "login", text: "Entrá a la app o a la web de Ualá con tu cuenta de Ualá Bis." },
      { icon: "code", text: "Abrí Ualá Bis › Cobros online › API." },
      { icon: "key", text: "Copiá el usuario, el Client ID y el Client Secret del ambiente que vas a usar." },
    ],
    where: "Ualá Bis › Cobros online › API",
    note: "Prueba y producción tienen credenciales distintas. Sin conectar, igual podés registrar los cobros de tu QR, POS o Tap con el número de operación.",
  },
  viumi: {
    steps: [
      { icon: "mail", text: "Pedile a Viumi las credenciales de la API por mail a consultas@viumi.com.ar." },
      { icon: "key", text: "Copiá el Client ID y el Client Secret que te mandan." },
      { icon: "paste", text: "Pegalos acá y elegí el ambiente de las credenciales." },
    ],
    where: "Mail de credenciales de Viumi (consultas@viumi.com.ar)",
    note: "Prueba y producción tienen credenciales distintas. Las devoluciones se hacen desde la app o el panel de Viumi.",
  },
  talo: {
    steps: [
      { icon: "login", text: "Entrá al Dashboard de Talo (app.talo.com.ar) con tu cuenta." },
      { icon: "code", text: "Abrí Usuario › Credenciales y generá tus credenciales." },
      { icon: "key", text: "Copiá el User ID, el Client ID y el Client Secret." },
    ],
    where: "Dashboard de Talo › Usuario › Credenciales",
    note: "La cuenta de sandbox de Talo es aparte de la de producción y tiene sus propias credenciales.",
  },
  mobbex: {
    steps: [
      { icon: "login", text: "Entrá a la consola de Mobbex." },
      { icon: "code", text: "Abrí Desarrollo › Credenciales." },
      { icon: "key", text: "Copiá la API Key y el Access Token." },
    ],
    where: "Consola › Desarrollo › Credenciales",
    note: "Mobbex usa el ambiente de tu cuenta: cargá las credenciales con las que vas a cobrar.",
  },
  fiserv: {
    steps: [
      { icon: "login", text: "Entrá al Dashboard de Clover con un usuario administrador." },
      { icon: "store", text: "Copiá el Merchant ID de los datos del comercio." },
      { icon: "key", text: "Pegá el token de Clover que te dio NinjaSoft o el de tu comercio de prueba." },
    ],
    where: "Dashboard de Clover › Cuenta y configuración",
    note: "Prueba usa el sandbox de Clover con un comercio de prueba. Producción cobra en Clover Argentina.",
    warning: {
      title: "App Cloud Pay Display",
      text: "Instalala en el Dashboard (Más herramientas, buscá Cloud Pay Display, Conectar) y dejala abierta en cada terminal.",
    },
  },
  mercadopago: {
    steps: [
      { icon: "login", text: "Entrá a Mercado Pago › Tus integraciones." },
      { icon: "key", text: "Abrí Credenciales de producción y copiá el Access Token." },
      { icon: "paste", text: "Pegalo acá abajo." },
    ],
    where: "Tus integraciones › Credenciales de producción",
  },
};

// Nota de seguridad (al pie de cada formulario de credenciales).
export const SECURITY_NOTE = "Se guardan cifradas en el servidor. Nunca llegan al navegador.";
