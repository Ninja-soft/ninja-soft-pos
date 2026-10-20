// Etiquetas legibles de los medios de pago (payments.method). Una sola fuente
// para ticket, caja, reportes y cierres Z.
export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  cash: "Efectivo",
  debit: "Débito",
  credit: "Crédito",
  transfer: "Transferencia",
  qr: "QR",
  store_credit: "Vale",
  account: "Cuenta corriente",
  other: "Otro",
  directo: "Directo",
  // ADR-143: QR, POS o Tap de Ualá Bis registrados con número de operación.
  ualabis: "Ualá Bis",
  sena: "Seña",
  mercadolibre: "Mercado Libre",
  // ADR-102: lo cobró una app de delivery por cuenta del local (sin caja).
  plataforma: "App de delivery",
  // H160 (ADR-179): cheque y e-cheq del cliente; efectivo en dólares.
  cheque: "Cheque",
  echeq: "E-cheq",
  cash_usd: "Dólares",
};
