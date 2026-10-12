// Textos de la configuración de medios de pago (voseo, sin guion largo).

// URL de notificaciones que el dueño informa a Nave en el onboarding (Nave la
// registra de su lado; no viaja por request).
export const NAVE_WEBHOOK_URL = `${process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""}/functions/v1/nave_webhook`;

// Resumen de una línea por canal (bajo el nombre del canal).
export const CHANNEL_SUMMARY: Record<string, string> = {
  cash: "Entra al arqueo de caja",
  transfer: "Confirmás vos que llegó la plata",
  mercadopago: "QR único por venta en el mostrador o link por WhatsApp",
  mercadopago_point: "Terminal Point: tarjeta, contactless y cuotas",
  payway: "QR o link a tu checkout con tus cuotas",
  payway_point: "Terminal Point de Payway integrada al POS",
  getnet: "QR o link al checkout de Getnet",
  getnet_point: "Terminal Point de Getnet integrada al POS",
  nave: "QR interoperable o link de pago",
  nave_point: "Terminal Nave: tarjeta, contactless o QR",
  modo: "QR para pagar con MODO o la app del banco",
  mobbex: "QR o link al checkout de Mobbex",
  pagos360: "Link o QR: tarjeta, débito, DEBIN o efectivo",
  fiserv: "Terminales Posnet y Clover",
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
      "Habilita Cobrar con QR en el POS. La plata entra a tu cuenta de Mercado Pago. Configurá la caja QR una sola vez para cobrar con un QR único por venta.",
    pasos: [
      "En el POS tocás Cobrar con QR.",
      "El cliente escanea con Mercado Pago o su billetera, o le mandás el link.",
      "Al acreditarse, la venta se cierra sola.",
    ],
  },
  mercadopago_point: {
    activa:
      "Habilita Cobrar con Point: el cobro viaja a tu lector y el cliente paga con tarjeta ahí. Los Planes de Mercado Pago (cuotas y recargo por tarjeta) se configuran acá.",
    pasos: [
      "Vinculá el lector desde la app de Mercado Pago y ponelo en modo PDV.",
      "En el POS tocás Cobrar con Point y elegís el lector.",
      "Al aprobarse, la venta se registra sola como débito o crédito.",
    ],
  },
  payway: {
    activa:
      "Habilita Cobrar con link: el QR abre el checkout de tu tienda, donde el cliente carga la tarjeta y elige las cuotas de tus Planes.",
    pasos: [
      "En el POS tocás Cobrar con link · Payway.",
      "El cliente escanea el QR o abre el link y paga.",
      "Al aprobarse, la venta se cierra sola.",
    ],
  },
  getnet: {
    activa:
      "Habilita el cobro con Getnet por QR y link: el cliente paga con crédito o débito en el checkout de Getnet.",
    pasos: [
      "En el POS elegís cobrar con Getnet.",
      "El cliente escanea el QR o abre el link y paga.",
      "Al aprobarse, la venta se cierra sola.",
    ],
  },
  nave: {
    activa:
      "Habilita el cobro con Nave: un QR interoperable (lo paga cualquier billetera o app bancaria) y un link de pago.",
    pasos: [
      "En el POS elegís cobrar con Nave.",
      "El cliente escanea el QR o abre el link y paga.",
      "Nave nos avisa, verificamos el pago y la venta se cierra sola.",
    ],
  },
  nave_point: {
    activa:
      "Habilita la terminal Nave Point: el POS manda el monto y el cliente paga con tarjeta, contactless o QR.",
    pasos: [
      "Cargá el ID de cada terminal al conectar Nave.",
      "En el POS elegís Nave Point y la terminal.",
      "Al aprobarse, la venta se registra sola.",
    ],
  },
  modo: {
    activa:
      "Habilita Cobrar con QR · MODO. El cliente paga con MODO o la app de su banco y la plata entra a tu cuenta de comercio.",
    pasos: [
      "En el POS tocás Cobrar con QR · MODO.",
      "El cliente escanea con MODO y paga.",
      "Al acreditarse, la venta se cierra sola.",
    ],
  },
  mobbex: {
    activa: "Habilita Cobrar con QR · Mobbex. La plata entra a tu cuenta de Mobbex.",
    pasos: [
      "En el POS tocás Cobrar con QR · Mobbex.",
      "El cliente escanea el QR y paga con tarjeta o saldo.",
      "Al acreditarse, la venta se cierra sola.",
    ],
  },
  pagos360: {
    activa:
      "Habilita Cobrar con link: se genera una solicitud de pago y el cliente paga desde el link o el QR.",
    pasos: [
      "En el POS tocás Cobrar con link · Pagos360.",
      "El cliente abre el link o escanea el QR y paga.",
      "Al acreditarse, la venta se cierra sola.",
    ],
  },
};
