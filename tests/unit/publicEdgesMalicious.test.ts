// @vitest-environment node
// SEC-28: matriz de cuerpos maliciosos contra la lógica pura de las Edges
// públicas (supabase/functions/_shared/*). Por cada proveedor: monto distinto,
// cobro / intent ajeno, id con caracteres de path o uuid inválido y firma
// adulterada (donde hay firma) → nunca "approved". Registro de qué Edge usa qué
// defensa: supabase/security/public-edges.json; las que no tienen lógica
// extraíble están en docs/security-reviews/2026-11-edges-publicas.md.
import { describe, expect, it } from "vitest";
import * as talo from "@/supabase/functions/_shared/talo";
import * as viumi from "@/supabase/functions/_shared/viumi";
import * as ualabis from "@/supabase/functions/_shared/ualabis";
import * as dlocalgo from "@/supabase/functions/_shared/dlocalgo";
import * as clover from "@/supabase/functions/_shared/clover";
import * as nave from "@/supabase/functions/_shared/nave";
import * as payway from "@/supabase/functions/_shared/payway";
import * as getnet from "@/supabase/functions/_shared/getnet";
import * as getnetApi from "@/supabase/functions/_shared/getnet_api";
import * as gocuotas from "@/supabase/functions/_shared/gocuotas";
import * as directo from "@/supabase/functions/_shared/directo";
import * as mobbex from "@/supabase/functions/_shared/mobbex";
import { signMpWebhook, verifyMpSignature } from "@/supabase/functions/_shared/mpSignature";
import { parseNotification as parseMlNotification } from "@/supabase/functions/_shared/mercadolibre/notifications";
import { buildSignatureHeader, verifySignatureHeader } from "@/supabase/functions/_shared/deliveryChannels/signature";
import { getAdapter } from "@/supabase/functions/_shared/deliveryChannels/registry";

const INTENT = "6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";
const OTHER = "11111111-2222-4333-8444-555555555555";
const PATHY = ["../x", "1/../../admin", "a b", "x?y=1", ""];

describe("Talo (talo_webhook)", () => {
  const PAY = "VAR-user-6f1c2b9e";
  const pay = (o: Record<string, unknown> = {}) => ({
    data: {
      id: PAY,
      external_id: INTENT,
      payment_status: "SUCCESS",
      price: { amount: 1250.5, currency: "ARS" },
      transaction_fields: { total_paid: { amount: 1250.5 } },
      ...o,
    },
  });
  const exp = { amount: 1250.5, intentId: INTENT, paymentId: PAY };

  it("control: el pago propio con el monto exacto acredita", () => {
    expect(talo.decideIntentUpdate(pay(), exp).status).toBe("approved");
  });
  it("monto distinto, intent ajeno o pago ajeno → no acredita", () => {
    expect(talo.decideIntentUpdate(pay({ price: { amount: 1, currency: "ARS" } }), exp).status).not.toBe("approved");
    expect(talo.decideIntentUpdate(pay({ transaction_fields: { total_paid: { amount: 1 } } }), exp).status).not.toBe("approved");
    expect(talo.decideIntentUpdate(pay({ price: { amount: 1250.5, currency: "USD" } }), exp).status).not.toBe("approved");
    expect(talo.decideIntentUpdate(pay({ external_id: OTHER }), exp)).toMatchObject({ status: "pending", reason: "reference_mismatch" });
    expect(talo.decideIntentUpdate(pay({ id: "VAR-otro-pago" }), exp)).toMatchObject({ status: "pending", reason: "payment_mismatch" });
  });
  it("paymentId con caracteres de path → el cuerpo se descarta", () => {
    for (const id of PATHY) expect(talo.parseWebhook({ paymentId: id }), id).toBeNull();
  });
});

describe("Viumi (viumi_webhook)", () => {
  const ORDER = "613d8938-8dab-41fd-9905-09d52e5312d0";
  const order = (o: Record<string, unknown> = {}) => ({
    data: {
      id: ORDER,
      attributes: {
        uuid: ORDER,
        status: "SUCCESS",
        payment: { status: "APPROVED" },
        payments: [{ status: "APPROVED" }],
        price: { amount: 125050, currency: "032" },
        ...o,
      },
    },
  });
  const exp = { amount: 1250.5, orderUuid: ORDER };

  it("control: la orden propia con el monto exacto acredita", () => {
    expect(viumi.decideIntentUpdate(order(), exp).status).toBe("approved");
  });
  it("monto distinto u orden ajena → no acredita", () => {
    expect(viumi.decideIntentUpdate(order({ price: { amount: 100, currency: "032" } }), exp).status).not.toBe("approved");
    expect(viumi.decideIntentUpdate(order({ uuid: OTHER }), exp)).toMatchObject({ status: "pending", reason: "order_mismatch" });
  });
  it("uuid de orden con caracteres de path → el cuerpo se descarta; ?intent= no-uuid no pasa", () => {
    for (const id of PATHY) expect(viumi.parseWebhook({ data: { order: { uuid: id } } }), id).toBeNull();
    expect(viumi.UUID_RE.test(`${INTENT}' or 1=1`)).toBe(false);
    expect(viumi.UUID_RE.test("not-a-uuid")).toBe(false);
  });
});

describe("Ualá Bis (ualabis_webhook)", () => {
  const ORDER = "613d8938-8dab-41fd-9905-09d52e5312d0";
  const order = (o: Record<string, unknown> = {}) => ({
    uuid: ORDER,
    external_reference: INTENT,
    status: "APPROVED",
    amount: "1250.50",
    ...o,
  });
  const exp = { amount: 1250.5, intentId: INTENT, orderUuid: ORDER };

  it("control: la orden propia con el monto exacto acredita", () => {
    expect(ualabis.decideIntentUpdate(order(), exp).status).toBe("approved");
  });
  it("monto distinto (también en centavos), intent u orden ajena → no acredita", () => {
    expect(ualabis.decideIntentUpdate(order({ amount: "1" }), exp).status).not.toBe("approved");
    // $1.250,50 informado como "125050" (centavos) no vale como pesos.
    expect(ualabis.decideIntentUpdate(order({ amount: "125050" }), exp).status).not.toBe("approved");
    expect(ualabis.decideIntentUpdate(order({ external_reference: OTHER }), exp).status).toBe("pending");
    expect(ualabis.decideIntentUpdate(order({ uuid: OTHER }), exp).status).toBe("pending");
  });
  it("uuid inválido → el cuerpo se descarta", () => {
    for (const id of PATHY) expect(ualabis.parseWebhook({ uuid: id }), id).toBeNull();
  });
});

describe("dLocal Go (dlocalgo_webhook)", () => {
  const PAY = "DP-54354";
  const CREDS = { apiKey: "MyMerchantApiKey", secretKey: "MyMerchantSecretKey" };
  const payment = (o: Record<string, unknown> = {}) => ({
    id: PAY,
    amount: 1250.5,
    currency: "ARS",
    status: "PAID",
    order_id: INTENT,
    ...o,
  });
  const exp = { amount: 1250.5, intentId: INTENT, paymentId: PAY };

  it("firma adulterada, de otra clave o ausente → inválida", async () => {
    const body = JSON.stringify({ payment_id: PAY });
    const header = `V2-HMAC-SHA256, Signature: ${await dlocalgo.expectedSignature(CREDS, body)}`;
    expect(await dlocalgo.verifySignature(CREDS, body, header)).toBe(true);
    expect(await dlocalgo.verifySignature(CREDS, body.replace(PAY, "DP-1"), header)).toBe(false);
    expect(await dlocalgo.verifySignature({ ...CREDS, secretKey: "otra-secret-key" }, body, header)).toBe(false);
    expect(await dlocalgo.verifySignature(CREDS, body, null)).toBe(false);
    expect(await dlocalgo.verifySignature(CREDS, body, "V2-HMAC-SHA256, Signature: zz")).toBe(false);
  });
  it("monto, moneda, intent o pago ajeno → no acredita", () => {
    expect(dlocalgo.decideIntentUpdate(payment(), exp).status).toBe("approved");
    expect(dlocalgo.decideIntentUpdate(payment({ amount: 1250.49 }), exp).status).not.toBe("approved");
    expect(dlocalgo.decideIntentUpdate(payment({ currency: "USD" }), exp).status).not.toBe("approved");
    expect(dlocalgo.decideIntentUpdate(payment({ order_id: OTHER }), exp).status).not.toBe("approved");
    expect(dlocalgo.decideIntentUpdate(payment({ id: "DP-1" }), exp).status).not.toBe("approved");
  });
  it("ids con caracteres de path → descartados", () => {
    for (const id of PATHY) expect(dlocalgo.parseNotification({ payment_id: id, refund_id: id }), id).toEqual({ paymentId: null, refundId: null });
  });
});

describe("Clover (clover_webhook)", () => {
  const EXT = INTENT.replace(/-/g, "");
  const payment = (o: Record<string, unknown> = {}) => ({
    payment: { id: "JQ2PXBQZ9QK6E", amount: 125050, tipAmount: 0, result: "SUCCESS", externalPaymentId: EXT, ...o },
  });
  const exp = { intentId: INTENT, amount: 1250.5 };

  it("X-Clover-Auth distinto → no autoriza (safeEqual)", () => {
    expect(clover.safeEqual("secreto-de-la-app", "secreto-de-la-app")).toBe(true);
    expect(clover.safeEqual("secreto-de-la-apq", "secreto-de-la-app")).toBe(false);
    expect(clover.safeEqual("", "secreto-de-la-app")).toBe(false);
  });
  it("monto distinto o intent ajeno → no acredita", () => {
    expect(clover.evaluateCloverPayment(payment(), exp).outcome).toBe("approved");
    expect(clover.evaluateCloverPayment(payment({ amount: 125049 }), exp).outcome).toBe("mismatch");
    expect(clover.evaluateCloverPayment(payment({ externalPaymentId: OTHER.replace(/-/g, "") }), exp).outcome).toBe("mismatch");
    expect(clover.evaluateCloverPayment(payment(), { ...exp, intentId: "no-es-uuid" }).outcome).toBe("mismatch");
  });
  it("merchants o pagos con ids inseguros se descartan del aviso", () => {
    const hook = clover.parseCloverWebhook({
      appId: "APP",
      merchants: { "../x": [{ objectId: "P:ABC123" }], M1ABC: [{ objectId: "P:../../y" }, { objectId: "O:ORDER1" }] },
    });
    expect(hook).toEqual({ kind: "events", merchants: [] });
  });
});

describe("Nave (nave_webhook)", () => {
  const PAY = "534eb791-de67-4a23-9667-09e1a2406103";
  const PR = "c3c9e8b1-0f6e-4c1a-9a55-1b2c3d4e5f60";
  const base = {
    id: PAY,
    external_payment_id: INTENT,
    status: { name: "APPROVED" },
    transactions: [{ transaction_type: "PURCHASE", amount: { currency: "ARS", value: "1500.00" } }],
    payment_request: { id: PR },
  };
  const exp = { intentId: INTENT, amount: 1500, paymentRequestId: PR };

  it("payment_check_url hacia otro host → se usa la URL confiable (anti-SSRF)", () => {
    const trusted = nave.resolvePaymentCheckUrl(
      { paymentId: PAY, paymentCheckUrl: `https://api.ranty.io/integrations/payments/${PAY}` },
      "prod",
      "qr",
    );
    for (const evil of [
      `https://evil.example/integrations/payments/${PAY}`,
      `https://api.ranty.io.evil.example/integrations/payments/${PAY}`,
      `http://api.ranty.io/integrations/payments/${PAY}`,
      `https://user:pw@api.ranty.io/integrations/payments/${PAY}`,
      "http://169.254.169.254/latest/meta-data",
    ]) {
      expect(nave.resolvePaymentCheckUrl({ paymentId: PAY, paymentCheckUrl: evil }, "prod", "qr"), evil).toBe(trusted);
    }
    expect(nave.resolvePaymentCheckUrl({ paymentId: "../../etc", paymentCheckUrl: "x" }, "prod", "qr")).toBeNull();
  });
  it("monto distinto, intent o payment_request ajenos → no acredita", () => {
    expect(nave.evaluatePayment(base, exp).outcome).toBe("approved");
    expect(
      nave.evaluatePayment({ ...base, transactions: [{ transaction_type: "PURCHASE", amount: { value: "1.00" } }] }, exp).outcome,
    ).toBe("mismatch");
    expect(nave.evaluatePayment({ ...base, external_payment_id: OTHER }, exp).outcome).toBe("mismatch");
    expect(nave.evaluatePayment({ ...base, transactions: undefined, payment_request: { id: "otra" } }, exp).outcome).toBe("mismatch");
  });
});

describe("Payway (payway_webhook y payway_checkout)", () => {
  const approved = { id: 12345, status: "approved", amount: 125050, site_transaction_id: INTENT };

  it("webhook: monto distinto o site_transaction_id ajeno → no acredita", () => {
    expect(payway.decidePaymentStatus(approved, 1250.5, INTENT).status).toBe("approved");
    expect(payway.decidePaymentStatus({ ...approved, amount: 100 }, 1250.5, INTENT).status).not.toBe("approved");
    expect(payway.decidePaymentStatus({ ...approved, amount: "125050" }, 1250.5, INTENT).status).toBe("approved");
    expect(payway.decidePaymentStatus({ ...approved, site_transaction_id: OTHER }, 1250.5, INTENT).status).toBe("ignore");
  });
  it("id de pago con caracteres de path → descartado", () => {
    for (const id of [...PATHY, "12/../34", -1, 1.5]) expect(payway.paywayPaymentId(id), String(id)).toBeNull();
  });
  it("checkout: approved con un monto que no es el recalculado → amount_mismatch", () => {
    expect(payway.classifyPayResponse(201, approved, 125050).kind).toBe("approved");
    expect(payway.classifyPayResponse(201, { ...approved, amount: 100 }, 125050).kind).toBe("amount_mismatch");
  });
});

describe("Getnet (getnet_webhook y getnet_checkout)", () => {
  const order = (status: string, cents: string) => ({
    status,
    data: { attributes: { items: [{ unitPrice: { amount: cents }, quantity: 1 }] } },
  });

  it("webhook: monto distinto o sin monto → no acredita", () => {
    expect(getnet.decideIntentUpdate(order("APPROVED", "125050"), 1250.5).status).toBe("approved");
    expect(getnet.decideIntentUpdate(order("APPROVED", "125049"), 1250.5).status).toBe("rejected");
    expect(getnet.decideIntentUpdate({ status: "APPROVED" }, 1250.5).status).toBe("pending");
  });
  it("id de orden con caracteres de path → descartado", () => {
    for (const id of PATHY) expect(getnet.extractWebhookOrderId({ data: { order: { uuid: id } } }), id).toBeNull();
  });
  it("checkout: APPROVED con un monto que no es el recalculado → amount_mismatch", () => {
    expect(getnetApi.classifyApiPayResponse(200, { status: "APPROVED", payment_id: "p1", amount: 125050 }, 125050).kind).toBe("approved");
    expect(getnetApi.classifyApiPayResponse(200, { status: "APPROVED", payment_id: "p1", amount: 100 }, 125050).kind).toBe(
      "amount_mismatch",
    );
  });
  it("checkout: sólo intents del checkout propio", () => {
    expect(getnetApi.isOwnCheckoutIntent(`https://pos.soft.ninja/pagar/${INTENT}?p=getnet`)).toBe(true);
    expect(getnetApi.isOwnCheckoutIntent("https://checkout.getnet.com.ar/x")).toBe(false);
    expect(getnetApi.isOwnCheckoutIntent(null)).toBe(false);
  });
});

describe("GO Cuotas (gocuotas_webhook)", () => {
  const order = (o: Record<string, unknown> = {}) => ({
    id: 3674033,
    amount_in_cents: 125050,
    status: "approved",
    order_reference_id: INTENT,
    ...o,
  });

  it("monto distinto o referencia ajena → no acredita", () => {
    expect(gocuotas.decideIntentUpdate(order(), 1250.5, INTENT).status).toBe("approved");
    expect(gocuotas.decideIntentUpdate(order({ amount_in_cents: 100 }), 1250.5, INTENT).status).not.toBe("approved");
    expect(gocuotas.decideIntentUpdate(order({ amount_in_cents: "125050" }), 1250.5, INTENT).status).not.toBe("approved");
    expect(gocuotas.decideIntentUpdate(order({ order_reference_id: OTHER }), 1250.5, INTENT).status).not.toBe("approved");
  });
  it("order_id con caracteres de path → descartado", () => {
    for (const id of PATHY) expect(gocuotas.extractWebhookHint({ order_id: id }).orderId, id).toBeNull();
  });
});

describe("Directo (directo_webhook)", () => {
  it("orden ajena → no acredita", () => {
    const st = { status: "Success", merchantOrderId: "GSPN891045", amount: "1250.50" };
    expect(directo.decideIntentUpdate(st, { merchantOrderId: "GSPN891045", amount: 1250.5 }).status).toBe("approved");
    expect(directo.decideIntentUpdate(st, { merchantOrderId: "OTRA", amount: 1250.5 }).status).toBe("pending");
    expect(directo.decideIntentUpdate({ ...st, merchantOrderId: undefined }, { merchantOrderId: "GSPN891045", amount: 1250.5 }).status).toBe(
      "pending",
    );
  });
  it("monto distinto: aprueba el crédito pero lo marca (ADR-181, por diseño)", () => {
    const d = directo.decideIntentUpdate(
      { status: "Success", merchantOrderId: "A1", amount: "1" },
      { merchantOrderId: "A1", amount: 1250.5 },
    );
    expect(d.status).toBe("approved");
    expect(d.credit?.capital_differs).toBe(true);
  });
  it("notification_id con caracteres de path → descartado", () => {
    for (const id of PATHY) expect(directo.extractNotificationId({ notification_id: id }), id).toBeNull();
  });
});

describe("Mobbex (mobbex_webhook)", () => {
  const p = (o: Partial<mobbex.MobbexPayment> = {}): mobbex.MobbexPayment => ({
    id: "OP1",
    reference: INTENT,
    code: "200",
    total: 1250.5,
    requestedTotal: 1250.5,
    ...o,
  });
  const decide = (payment: mobbex.MobbexPayment | null) =>
    mobbex.decideMobbex({ payment, intentId: INTENT, expectedAmount: 1250.5, webhookType: "checkout" });

  it("monto distinto, intent ajeno u operación inexistente → no acredita", () => {
    expect(decide(p()).status).toBe("approved");
    expect(decide(p({ requestedTotal: 1, total: 1 })).status).toBeNull();
    expect(decide(p({ reference: OTHER })).status).toBeNull();
    expect(decide(null).status).toBeNull();
  });
});

describe("Mercado Pago x-signature (mp_webhook, mp_orders_webhook, mp_billing_webhook)", () => {
  const SECRET = "clave-secreta-del-webhook";
  const now = 1_790_000_000_000;
  const ts = String(now);

  it("firma de otro data.id, de otra clave, vencida o ausente → no válida", async () => {
    const sig = await signMpWebhook(SECRET, "123456", "req-1", ts);
    const base = { secret: SECRET, signature: sig, requestId: "req-1", dataId: "123456", nowMs: now };
    expect(await verifyMpSignature(base)).toBe("valid");
    expect(await verifyMpSignature({ ...base, dataId: "999999" })).toBe("invalid");
    expect(await verifyMpSignature({ ...base, requestId: "req-2" })).toBe("invalid");
    expect(await verifyMpSignature({ ...base, secret: "otra-clave" })).toBe("invalid");
    expect(await verifyMpSignature({ ...base, nowMs: now + 11 * 60_000 })).toBe("expired");
    expect(await verifyMpSignature({ ...base, signature: null })).toBe("missing");
    expect(await verifyMpSignature({ ...base, secret: "" })).toBe("invalid");
  });
});

describe("Mercado Libre (ml_webhook)", () => {
  const n = (o: Record<string, unknown> = {}) => ({
    _id: "abcdef12-3456",
    topic: "orders_v2",
    resource: "/orders/2000001234567",
    user_id: 123456789,
    application_id: 555,
    attempts: 1,
    sent: "2026-11-17T10:00:00.000Z",
    ...o,
  });

  it("otra app, recurso fuera del patrón o tópico desconocido → descartado", () => {
    expect(parseMlNotification(n(), "555").ok).toBe(true);
    expect(parseMlNotification(n({ application_id: 999 }), "555")).toEqual({ ok: false, reason: "wrong_application" });
    expect(parseMlNotification(n(), null)).toEqual({ ok: false, reason: "wrong_application" });
    expect(parseMlNotification(n({ resource: "/orders/../users/me" }), "555")).toEqual({ ok: false, reason: "invalid_resource" });
    expect(parseMlNotification(n({ topic: "admin" }), "555")).toEqual({ ok: false, reason: "unknown_topic" });
    expect(parseMlNotification(n({ user_id: "1; drop" }), "555")).toEqual({ ok: false, reason: "invalid_payload" });
  });
});

describe("Canales de delivery (delivery_channel_webhook)", () => {
  const SECRET = "secreto-de-la-conexion";
  const NOW = 1_790_000_000_000;

  it("cuerpo adulterado, otra clave o firma vieja → no válida", async () => {
    const body = JSON.stringify({ event: "order.created", id: "e1", total: 1000 });
    const header = await buildSignatureHeader(SECRET, body, NOW / 1000);
    expect(await verifySignatureHeader(header, SECRET, body, NOW)).toBe(true);
    expect(await verifySignatureHeader(header, SECRET, body.replace("1000", "1"), NOW)).toBe(false);
    expect(await verifySignatureHeader(header, "otro-secreto", body, NOW)).toBe(false);
    expect(await verifySignatureHeader(header, SECRET, body, NOW + 301_000)).toBe(false);
    expect(await verifySignatureHeader(header, "", body, NOW)).toBe(false);
  });
  it("proveedores sin contrato confirmado rechazan todo (fail closed)", async () => {
    for (const p of ["pedidosya", "ubereats", "mp_delivery"]) {
      const adapter = getAdapter(p);
      expect(adapter, p).not.toBeNull();
      const ok = await adapter!.verifySignature(
        { headers: new Headers(), rawBody: "{}", ip: "203.0.113.1" } as never,
        {} as never,
      );
      expect(ok, p).toBe(false);
    }
    expect(getAdapter("desconocido")).toBeNull();
  });
});
