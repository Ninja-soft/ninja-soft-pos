// Cupón Rapipago / Pago Fácil de Mercado Pago (ADR-180): lógica pura de la
// Edge mp_cupon, textos del POS y reglas compartidas con la Orders API.
import { describe, expect, it } from "vitest";
import {
  buildCuponOrderBody,
  cuponErrorCode,
  parsePayer,
  parseVoucher,
  splitName,
  CUPON_EXPIRATION,
} from "@/supabase/functions/_shared/mpCupon";
import { resolveOrder } from "@/supabase/functions/_shared/mpOrders";
import { cuponErrorCopy, cuponExpiryLabel, formatBarcode, validateCuponPayer } from "@/lib/payments/mpCupon";
import { defaultTtlMinutes, extendOptions, PROVIDER_MAX_TTL_MINUTES } from "@/modules/pending-charges/logic";
import { providerFeature } from "@/lib/payments/providerFeature";
import { paymentIcon } from "@/lib/payments/logos";
import { TENDER_BY_ID, resolveTenders, type ProviderStatus } from "@/lib/pos/tenders";
import { FEATURE_INFO } from "@/lib/saas/featureInfo";

const INTENT = "6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";
const TICKET =
  "https://www.mercadopago.com.ar/payments/86797024510/ticket?caller_id=1870026883&payment_method_id=rapipago&payment_id=86797024510";

// Respuesta de ejemplo de la doc (Orders API, Rapipago y Pago Fácil).
const docOrder = (over: Record<string, unknown> = {}) => ({
  id: "ORD01J6TC8BYRR0T4ZKY0QR39WGYE",
  type: "online",
  processing_mode: "automatic",
  external_reference: INTENT,
  total_amount: "50.00",
  status: "action_required",
  status_detail: "waiting_payment",
  transactions: {
    payments: [
      {
        id: "PAY01J6TC8BYRR0T4ZKY0QRTZ0E24",
        amount: "50.00",
        status: "action_required",
        status_detail: "waiting_payment",
        payment_method: {
          id: "rapipago",
          type: "ticket",
          ticket_url: TICKET,
          barcode_content: "3335008800000000006004835002100020000242462010",
          reference: "6005407530",
          verification_code: "6005407530",
        },
      },
    ],
  },
  ...over,
});

describe("pagador", () => {
  it("DNI, CUIT y nombre", () => {
    const ok = parsePayer({ email: " Ana@Mail.com ", name: "Ana María  Pérez", doc_number: "30.123.456" });
    expect(ok).toEqual({
      ok: true,
      payer: { email: "ana@mail.com", firstName: "Ana María", lastName: "Pérez", docType: "DNI", docNumber: "30123456" },
    });
    const cuit = parsePayer({ email: "a@b.co", name: "Ana Pérez", doc_number: "20-30123456-7", doc_type: "cuil" });
    expect(cuit.ok && cuit.payer.docType).toBe("CUIL");
    expect(parsePayer({ email: "a@b.co", name: "Ana Pérez", doc_number: "20301234567" }).ok && true).toBe(true);
  });

  it("errores", () => {
    expect(parsePayer({ email: "x", name: "Ana Pérez", doc_number: "30123456" })).toEqual({ ok: false, error: "payer_email_invalid" });
    expect(parsePayer({ email: "a@b.co", name: "Ana Pérez", doc_number: "123" })).toEqual({ ok: false, error: "payer_doc_invalid" });
    expect(parsePayer({ email: "a@b.co", name: "Ana", doc_number: "30123456" })).toEqual({ ok: false, error: "payer_name_invalid" });
    expect(splitName("Ana")).toEqual({ first: "Ana", last: "" });
  });
});

describe("order", () => {
  it("cuerpo de la doc: online, automatic, ticket y vencimiento P3D sólo en el pago", () => {
    const p = parsePayer({ email: "a@b.co", name: "Ana Pérez", doc_number: "30123456" });
    if (!p.ok) throw new Error("payer");
    const body = buildCuponOrderBody({ intentId: INTENT, amount: 50, method: "pagofacil", payer: p.payer });
    expect(body).toMatchObject({
      type: "online",
      processing_mode: "automatic",
      total_amount: "50.00",
      external_reference: INTENT,
      payer: { email: "a@b.co", first_name: "Ana", last_name: "Pérez", identification: { type: "DNI", number: "30123456" } },
      transactions: {
        payments: [{ amount: "50.00", expiration_time: CUPON_EXPIRATION, payment_method: { id: "pagofacil", type: "ticket" } }],
      },
    });
    expect("expiration_time" in body).toBe(false);
  });

  it("cupón de la respuesta (o null mientras procesa)", () => {
    const v = parseVoucher(docOrder(), new Date("2026-10-20T12:00:00Z"));
    expect(v).toEqual({
      payment_method: "rapipago",
      ticket_url: TICKET,
      barcode_content: "3335008800000000006004835002100020000242462010",
      reference: "6005407530",
      verification_code: "6005407530",
      expires_at: "2026-10-23T12:00:00.000Z",
    });
    expect(parseVoucher({ id: "x", status: "processing" })).toBeNull();
    expect(parseVoucher(docOrder({ transactions: { payments: [{ payment_method: { id: "visa", ticket_url: TICKET } }] } }))).toBeNull();
  });

  it("action_required queda pendiente; processed con monto exacto acredita (regla de siempre)", () => {
    const ctx = { intentId: INTENT, expectedAmount: 50 };
    expect(resolveOrder(docOrder() as never, ctx).status).toBe("pending");
    const paid = docOrder({
      status: "processed",
      status_detail: "accredited",
      transactions: { payments: [{ id: "PAY1", amount: "50.00", status: "processed" }] },
    });
    expect(resolveOrder(paid as never, ctx).status).toBe("approved");
    expect(resolveOrder({ ...paid, total_amount: "40.00", transactions: { payments: [{ id: "PAY1", amount: "40.00", status: "processed" }] } } as never, ctx).status).toBe("rejected");
    expect(resolveOrder(docOrder({ status: "expired" }) as never, ctx).status).toBe("expired");
  });

  it("errores de la API", () => {
    expect(cuponErrorCode(401, "")).toBe("mp_cupon_auth_failed");
    expect(cuponErrorCode(400, '{"errors":[{"code":"invalid_identification"}]}')).toBe("mp_cupon_payer_rejected");
    expect(cuponErrorCode(400, "payment_method not available")).toBe("mp_cupon_method_unavailable");
    expect(cuponErrorCode(500, "x")).toBe("mp_error");
  });
});

describe("POS", () => {
  it("validación del formulario y textos", () => {
    expect(validateCuponPayer({ email: "a@b.co", name: "Ana Pérez", docNumber: "30123456" })).toEqual({});
    const e = validateCuponPayer({ email: "a", name: "Ana", docNumber: "12" });
    expect(Object.keys(e).sort()).toEqual(["docNumber", "email", "name"]);
    expect(formatBarcode("33350088000")).toBe("3335 0088 000");
    expect(cuponExpiryLabel("2026-10-26T15:00:00Z")).toMatch(/^Vence el lunes 26\/10$/);
    expect(cuponErrorCopy("payer_doc_invalid")).toContain("DNI");
    expect(cuponErrorCopy("otro")).toBeNull();
  });

  it("cobro en espera: arranca con el tope de 3 días", () => {
    expect(PROVIDER_MAX_TTL_MINUTES.mp_cupon).toBe(4320);
    expect(defaultTtlMinutes("mp_cupon")).toBe(4320);
    expect(extendOptions("mp_cupon").map((o) => o.minutes)).toContain(4320);
    expect(defaultTtlMinutes("dlocalgo")).toBe(1440);
  });

  it("tender del grupo Mercado Pago con su propia feature", () => {
    const t = TENDER_BY_ID["mercadopago:cupon"];
    expect(t).toMatchObject({ group: "mercadopago", provider: "mercadopago", connection: "mercadopago", qrProvider: "mp_cupon", featureKey: "cupones_efectivo" });
    expect(providerFeature("mp_cupon")).toBe("cupones_efectivo");
    expect(paymentIcon("mp_cupon")).toBe(paymentIcon("mercadopago"));
    expect(FEATURE_INFO.cupones_efectivo?.requires).toEqual(["mercado_pago"]);
    const mp: ProviderStatus = { provider_key: "mercadopago", enabled: true, connected: true };
    const ids = (f: Record<string, boolean>) =>
      resolveTenders({ providers: [mp], features: f, hasCustomer: false, storeCreditBalance: 0 }).map((x) => x.id);
    expect(ids({ mercado_pago: true, cupones_efectivo: true })).toContain("mercadopago:cupon");
    expect(ids({ mercado_pago: true, cupones_efectivo: false })).not.toContain("mercadopago:cupon");
  });
});
