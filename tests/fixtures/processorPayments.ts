// Fixtures de respuestas de las APIs de los procesadores (ADR-061), recortadas
// a los campos que usan los normalizadores. Formas tomadas de la documentación
// pública de cada API y de los pagos que ya verifican las Edge de cobro.

/** GET /v1/payments/{id} de Mercado Pago: crédito en 3 cuotas con charges_details. */
export const mpCreditPayment = {
  id: 91234567890,
  date_created: "2026-10-10T14:03:11.000-04:00",
  date_approved: "2026-10-10T14:03:12.000-04:00",
  date_last_updated: "2026-10-10T14:03:12.000-04:00",
  money_release_date: "2026-10-24T14:03:12.000-04:00",
  money_release_status: "pending",
  operation_type: "regular_payment",
  payment_method_id: "visa",
  payment_type_id: "credit_card",
  status: "approved",
  status_detail: "accredited",
  currency_id: "ARS",
  description: "Venta NinjaPos",
  external_reference: "6a3c1c35-7b7a-4f61-8f6a-0f1c2a9d1b11",
  transaction_amount: 12000,
  transaction_amount_refunded: 0,
  installments: 3,
  authorization_code: "301234",
  pos_id: "4567",
  store_id: "1234",
  order: { id: "1234567", type: "mercadopago" },
  card: { first_six_digits: "450995", last_four_digits: "3704", cardholder: { name: "APRO" } },
  payer: { email: "comprador@test.com", first_name: "Ana", last_name: "Pérez", identification: { type: "DNI", number: "30111222" } },
  transaction_details: { net_received_amount: 10944.6, total_paid_amount: 12000, installment_amount: 4000 },
  charges_details: [
    { name: "mercadopago_fee", type: "fee", accounts: { from: "collector", to: "mp" }, amounts: { original: 732, refunded: 0 } },
    { name: "iva_fee", type: "tax", accounts: { from: "collector", to: "mp" }, amounts: { original: 153.72, refunded: 0 } },
    { name: "iibb_retention", type: "tax", accounts: { from: "collector", to: "mp" }, amounts: { original: 169.68, refunded: 0 } },
    { name: "coupon_off", type: "coupon", accounts: { from: "mp", to: "payer" }, amounts: { original: 500, refunded: 0 } },
  ],
  refunds: [],
};

/** Pago con QR de dinero en cuenta, ya acreditado, sólo con fee_details (formato viejo). */
export const mpAccountMoneyPayment = {
  id: "91234567999",
  date_created: "2026-10-01T10:00:00.000-03:00",
  date_approved: "2026-10-01T10:00:01.000-03:00",
  money_release_date: "2026-10-01T10:00:01.000-03:00",
  money_release_status: "released",
  operation_type: "regular_payment",
  payment_method_id: "account_money",
  payment_type_id: "account_money",
  status: "approved",
  currency_id: "ARS",
  transaction_amount: 5000,
  transaction_amount_refunded: 0,
  installments: 1,
  fee_details: [{ type: "mercadopago_fee", amount: 40, fee_payer: "collector" }],
  taxes_amount: 10,
  transaction_details: { net_received_amount: 4950 },
};

export const mpRejectedPayment = { ...mpAccountMoneyPayment, id: 1, status: "rejected", transaction_details: { net_received_amount: 0 } };

export const mpMoneyTransfer = { ...mpAccountMoneyPayment, id: 2, operation_type: "money_transfer" };

/** GET /api/v2/payments/{id} de Payway (montos en centavos). */
export const paywayPayment = {
  id: 1234567,
  site_transaction_id: "5c2b5f0e-1a7f-4a4b-9a0d-d9a1d0b0c0aa",
  payment_method_id: 1,
  card_brand: "Visa",
  amount: 1550050,
  currency: "ars",
  status: "approved",
  status_details: { ticket: "0042", card_authorization_code: "abc123", address_validation_code: "VTE0011", error: null },
  date: "2026-10-11T12:00:00Z",
  installments: 6,
  bin: "450799",
  establishment_name: "12345678",
  site_id: "00290815",
};

/** GET /integrations/payments/{id} de Nave. */
export const navePayment = {
  id: "pay-123",
  external_payment_id: "intent-1",
  status: { name: "APPROVED", reason_code: null, date: "2026-10-11T15:00:00Z" },
  amount: { value: 2500, currency: "ARS" },
  payment_method: { card_type: "DEBIT", brand: "maestro", last_four_digits: "1111", installments: 1, authorization_code: "998877" },
  created_at: "2026-10-11T14:59:00Z",
};

/** GET /v3/merchants/{mId}/payments/{id} de Clover (centavos). */
export const cloverPayment = {
  id: "ABC123DEF456G",
  externalPaymentId: "ninjapos-intent",
  result: "SUCCESS",
  amount: 150000,
  tipAmount: 10000,
  createdTime: 1760198400000,
  tender: { label: "Credit Card" },
  cardTransaction: { cardType: "MC", last4: "4444", first6: "555555", authCode: "OK1234", type: "AUTH", referenceId: "000777", extra: { batchNumber: "15" } },
};

/** Orden de GO Cuotas. */
export const goCuotasOrder = {
  id: 98765,
  order_reference_id: "intent-go",
  status: "delivered",
  amount_in_cents: 3000000,
  number_of_installments: 4,
  created_at: "2026-10-09T12:00:00Z",
  delivered_at: "2026-10-09T12:05:00Z",
  customer: { email: "c@x.com", name: "Juan", dni: "20111222" },
};
