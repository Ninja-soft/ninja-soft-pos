// Textos de la configuración de medios de pago (voseo, corto, sin guion largo).

// URL de notificaciones que el dueño informa a Nave en el onboarding (Nave la
// registra de su lado; no viaja por request).
export const NAVE_WEBHOOK_URL = `${process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""}/functions/v1/nave_webhook`;

// Resumen de una línea por canal (bajo el título del canal).
export const CHANNEL_SUMMARY: Record<string, string> = {
  cash: "Entra al arqueo de caja",
  transfer: "Confirmás vos que llegó la plata",
  mercadopago: "Un QR por venta en la pantalla o un link por WhatsApp",
  mercadopago_point: "Tarjeta, contactless y cuotas en tu lector Point",
  payway: "Checkout de Payway con tus planes de cuotas",
  payway_point: "Terminal Payway integrada al POS",
  getnet: "Checkout de Getnet con crédito o débito",
  getnet_point: "Terminal Getnet integrada al POS",
  nave: "QR interoperable: lo paga cualquier billetera",
  nave_point: "Tarjeta, contactless o QR en tu terminal Nave",
  modo: "Pagan con MODO o la app de su banco",
  mobbex: "Checkout de Mobbex con tarjetas y cuotas",
  pagos360: "Tarjeta, débito, DEBIN o efectivo",
  fiserv: "Terminales Posnet y Clover",
  gocuotas: "2 a 4 cuotas sin interés con débito",
  directo: "QR y link de Directo, o registro manual de la operación",
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
    activa: "Aparece como forma de pago en el POS para cobrar por transferencia a tu cuenta.",
    pasos: [
      "El cliente transfiere a tu CBU o alias.",
      "Verificás que la plata haya llegado.",
      "Registrás la venta (la confirmación es manual).",
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
    activa: "El cliente paga con crédito o débito en el checkout de Getnet, desde el QR o el link.",
    pasos: [
      "En el POS elegís cobrar con Getnet.",
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
  fiserv: ["point"],
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
      { icon: "login", text: "Entrá al Portal Getnet." },
      { icon: "key", text: "En Credenciales, copiá el Client ID y el Client Secret." },
      { icon: "paste", text: "Pegalos acá abajo." },
    ],
    where: "Portal Getnet › Credenciales",
    warning: {
      title: "Sin ambiente de prueba",
      text: "Getnet no tiene sandbox: desde el primer cobro, la plata es real.",
    },
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
  mobbex: {
    steps: [
      { icon: "login", text: "Entrá a la consola de Mobbex." },
      { icon: "code", text: "Abrí Desarrollo › Credenciales." },
      { icon: "key", text: "Copiá la API Key y el Access Token." },
    ],
    where: "Consola › Desarrollo › Credenciales",
    note: "Mobbex usa el ambiente de tu cuenta: cargá las credenciales con las que vas a cobrar.",
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
