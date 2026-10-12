import { describe, expect, it } from "vitest";
import {
  dayKey,
  matchChanged,
  matchSettlement,
  normRef,
  type MatchLine,
  type PosCandidate,
} from "@/supabase/functions/_shared/settlementMatch";

const line = (over: Partial<MatchLine> & { id: string }): MatchLine => ({
  provider_key: "mercadopago",
  external_id: null,
  order_id: null,
  external_reference: null,
  operation_at: "2026-10-10T15:00:00Z",
  gross: 1000,
  refunded: 0,
  ...over,
});

const cand = (over: Partial<PosCandidate> & { payment_id: string | null }): PosCandidate => ({
  sale_id: over.payment_id ? `sale-${over.payment_id}` : null,
  intent_id: null,
  provider_key: "mercadopago",
  amount: 1000,
  created_at: "2026-10-10T15:00:00Z",
  ...over,
});

const byLine = (r: ReturnType<typeof matchSettlement>, id: string) => r.lines.find((l) => l.line_id === id)!;

describe("normRef / dayKey", () => {
  it("normaliza ceros, espacios y mayúsculas", () => {
    expect(normRef(" 000123 ")).toBe("123");
    expect(normRef("ab-12")).toBe("AB12");
    expect(normRef("")).toBeNull();
    expect(normRef("0")).toBe("0");
  });
  it("el día es el de Argentina", () => {
    expect(dayKey("2026-10-11T02:00:00Z")).toBe("2026-10-10");
  });
});

describe("matchSettlement", () => {
  it("cruza por id de pago, por orden y por referencia externa (intent)", () => {
    const r = matchSettlement(
      [
        line({ id: "l1", external_id: "111" }),
        line({ id: "l2", order_id: "ORD-2" }),
        line({ id: "l3", external_reference: "intent-3" }),
      ],
      [
        cand({ payment_id: "p1", intent_id: "intent-1", provider_payment_id: "111" }),
        cand({ payment_id: "p2", intent_id: "intent-2", provider_order_id: "ORD-2" }),
        cand({ payment_id: "p3", intent_id: "intent-3", provider_payment_id: "PAY01X" }),
      ],
    );
    expect(r.lines.map((l) => [l.line_id, l.payment_id, l.match_status, l.match_method])).toEqual([
      ["l1", "p1", "matched", "provider_id"],
      ["l2", "p2", "matched", "provider_id"],
      ["l3", "p3", "matched", "provider_id"],
    ]);
    expect(r.unmatchedPayments).toEqual([]);
  });

  it("monto distinto = diferencia; venta anulada con devolución total = conciliado", () => {
    const r = matchSettlement(
      [
        line({ id: "l1", external_id: "1", gross: 1000 }),
        line({ id: "l2", external_id: "2", gross: 500, refunded: 500 }),
        line({ id: "l3", external_id: "3", gross: 700 }),
      ],
      [
        cand({ payment_id: "p1", provider_payment_id: "1", amount: 950 }),
        cand({ payment_id: "p2", provider_payment_id: "2", amount: 500, sale_voided: true }),
        cand({ payment_id: "p3", provider_payment_id: "3", amount: 700, sale_voided: true }),
      ],
    );
    expect(byLine(r, "l1")).toMatchObject({ match_status: "amount_diff", diff_amount: 50 });
    expect(byLine(r, "l2")).toMatchObject({ match_status: "matched", diff_amount: 0 });
    // Cobrado y nunca devuelto sobre una venta anulada: plata de más.
    expect(byLine(r, "l3")).toMatchObject({ match_status: "amount_diff", diff_amount: 700 });
  });

  it("intent aprobado sin venta queda como cobro sin venta con el intent", () => {
    const r = matchSettlement(
      [line({ id: "l1", external_id: "9" })],
      [cand({ payment_id: null, intent_id: "intent-9", provider_payment_id: "9" })],
    );
    expect(byLine(r, "l1")).toMatchObject({ match_status: "missing_in_pos", intent_id: "intent-9", payment_id: null });
  });

  it("prefiere el cobro con venta sobre el intent huérfano del mismo pago", () => {
    const r = matchSettlement(
      [line({ id: "l1", external_id: "9" })],
      [
        cand({ payment_id: null, intent_id: "intent-a", provider_payment_id: "9" }),
        cand({ payment_id: "p1", intent_id: "intent-b", provider_payment_id: "9" }),
      ],
    );
    expect(byLine(r, "l1").payment_id).toBe("p1");
  });

  it("tarjeta: comercio + lote + cupón con ceros a la izquierda", () => {
    const r = matchSettlement(
      [line({ id: "l1", provider_key: "payway", lote: "015", cupon: "0042", comercio: "00012345", gross: 2000 })],
      [
        cand({ payment_id: "p0", lote: "15", cupon: "42", comercio: "99999", amount: 2000 }),
        cand({ payment_id: "p1", lote: "15", cupon: "42", comercio: "12345", amount: 2000 }),
      ],
    );
    expect(byLine(r, "l1")).toMatchObject({ payment_id: "p1", match_method: "voucher", match_status: "matched" });
    expect(r.unmatchedPayments.map((c) => c.payment_id)).toEqual(["p0"]);
  });

  it("autorización + últimos 4 dentro de la tolerancia de fecha", () => {
    const r = matchSettlement(
      [line({ id: "l1", autorizacion: "ab12", last4: "4444", operation_at: "2026-10-11T10:00:00Z" })],
      [
        cand({ payment_id: "p1", autorizacion: "AB12", last4: "1111" }),
        cand({ payment_id: "p2", autorizacion: "AB12", last4: "4444", created_at: "2026-10-10T20:00:00Z" }),
      ],
    );
    expect(byLine(r, "l1")).toMatchObject({ payment_id: "p2", match_method: "authorization" });
  });

  it("monto y día sólo con pareja única de los dos lados", () => {
    const r = matchSettlement(
      [
        line({ id: "solo", provider_key: "getnet", gross: 1234 }),
        line({ id: "a", provider_key: "getnet", gross: 500 }),
        line({ id: "b", provider_key: "getnet", gross: 500 }),
      ],
      [
        cand({ payment_id: "p1", amount: 1234 }),
        cand({ payment_id: "p2", amount: 500 }),
        cand({ payment_id: "p3", amount: 500 }),
        // Con id del procesador no entra por monto (ya tuvo su chance exacta).
        cand({ payment_id: "p4", amount: 1234, provider_payment_id: "zzz" }),
      ],
    );
    expect(byLine(r, "solo")).toMatchObject({ payment_id: "p1", match_method: "amount_date" });
    expect(byLine(r, "a").match_status).toBe("missing_in_pos");
    expect(byLine(r, "b").match_status).toBe("missing_in_pos");
    expect(r.unmatchedPayments.map((c) => c.payment_id).sort()).toEqual(["p2", "p3", "p4"]);
  });

  it("no cruza por monto otro día ni con últimos 4 distintos", () => {
    const r = matchSettlement(
      [line({ id: "l1", gross: 800, last4: "1234" }), line({ id: "l2", gross: 900, operation_at: "2026-10-12T15:00:00Z" })],
      [cand({ payment_id: "p1", amount: 800, last4: "9999" }), cand({ payment_id: "p2", amount: 900 })],
    );
    expect(byLine(r, "l1").match_status).toBe("missing_in_pos");
    expect(byLine(r, "l2").match_status).toBe("missing_in_pos");
  });

  it("respeta líneas manuales e ignoradas y no reusa su cobro", () => {
    const r = matchSettlement(
      [
        line({ id: "m", external_id: "1", match_method: "manual", match_status: "matched", payment_id: "p2" }),
        line({ id: "i", external_id: "5", match_status: "ignored" }),
        line({ id: "auto", external_id: "2" }),
      ],
      [cand({ payment_id: "p2", provider_payment_id: "2" }), cand({ payment_id: "p5", provider_payment_id: "5" })],
    );
    expect(byLine(r, "m")).toMatchObject({ payment_id: "p2", match_method: "manual" });
    expect(byLine(r, "i").match_status).toBe("ignored");
    expect(byLine(r, "auto").match_status).toBe("missing_in_pos");
    expect(r.unmatchedPayments.map((c) => c.payment_id)).toEqual(["p5"]);
  });

  it("matchChanged detecta cambios de estado o de cobro", () => {
    const l = line({ id: "x", match_status: "missing_in_pos", match_method: null, payment_id: null, intent_id: null, diff_amount: 1000 });
    expect(
      matchChanged(l, { line_id: "x", match_status: "missing_in_pos", match_method: null, payment_id: null, intent_id: null, sale_id: null, diff_amount: 1000 }),
    ).toBe(false);
    expect(
      matchChanged(l, { line_id: "x", match_status: "matched", match_method: "provider_id", payment_id: "p", intent_id: null, sale_id: "s", diff_amount: 0 }),
    ).toBe(true);
  });
});
