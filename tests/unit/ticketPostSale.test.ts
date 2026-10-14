// ADR-111: estados del ticket después de cobrar y auto-imprimir sin ventana.
import { describe, expect, it } from "vitest";
import {
  AUTHORIZING_SLOW_MS,
  postSalePhase,
  previewVisible,
  silentStep,
  type PostSaleDocLike,
} from "@/lib/tickets/postSale";

const base = { saleLoaded: true, docsSettled: true, elapsedMs: 0 };
const doc = (d: Partial<PostSaleDocLike>): PostSaleDocLike => ({ status: "pendiente", ...d });

describe("postSalePhase", () => {
  it("carga mientras falta la venta o los comprobantes", () => {
    expect(postSalePhase({ ...base, saleLoaded: false, doc: null }).kind).toBe("loading");
    expect(postSalePhase({ ...base, docsSettled: false, doc: null }).kind).toBe("loading");
  });

  it("venta no fiscal: se muestra directo", () => {
    expect(postSalePhase({ ...base, doc: null })).toEqual({ kind: "ready", fiscal: "none" });
    expect(postSalePhase({ ...base, doc: doc({ status: "cancelado" }) })).toEqual({ kind: "ready", fiscal: "none" });
  });

  it("autorizando: pendiente o enviando sin error", () => {
    expect(postSalePhase({ ...base, doc: doc({ status: "pendiente" }) })).toEqual({ kind: "authorizing", slow: false });
    expect(postSalePhase({ ...base, doc: doc({ status: "enviando" }) })).toEqual({ kind: "authorizing", slow: false });
    // "presupuesto" = el worker sólo lo dejó para la próxima vuelta.
    expect(postSalePhase({ ...base, doc: doc({ last_error_code: "presupuesto" }) }).kind).toBe("authorizing");
  });

  it("autorizando lento después del plazo", () => {
    expect(postSalePhase({ ...base, elapsedMs: AUTHORIZING_SLOW_MS, doc: doc({}) })).toEqual({
      kind: "authorizing",
      slow: true,
    });
  });

  it("CAE aprobado y contingencia CAEA", () => {
    expect(postSalePhase({ ...base, doc: doc({ status: "aprobado", cae: "123", cbte_nro: 5 }) })).toEqual({
      kind: "ready",
      fiscal: "cae",
    });
    expect(
      postSalePhase({ ...base, doc: doc({ status: "aprobado", cae: "9", cbte_nro: 1, emission_type: "CAEA", last_error_code: "500" }) }),
    ).toEqual({ kind: "ready", fiscal: "caea" });
  });

  it("aprobado sin CAE todavía no se muestra", () => {
    expect(postSalePhase({ ...base, doc: doc({ status: "aprobado", cae: null, cbte_nro: null }) }).kind).toBe("authorizing");
  });

  it("ARCA caído: reintentando con el error y el próximo intento", () => {
    expect(
      postSalePhase({
        ...base,
        doc: doc({ status: "pendiente", last_error_code: "wsaa_timeout", last_error_msg: "sin respuesta", next_attempt_at: "2026-10-13T21:30:00Z" }),
      }),
    ).toEqual({ kind: "retrying", errorCode: "wsaa_timeout", errorMsg: "sin respuesta", nextAttemptAt: "2026-10-13T21:30:00Z" });
  });

  it("rechazado o requiere acción: falla", () => {
    expect(postSalePhase({ ...base, doc: doc({ status: "rechazado", last_error_code: "10015" }) })).toMatchObject({
      kind: "failed",
      status: "rechazado",
      errorCode: "10015",
    });
    expect(postSalePhase({ ...base, doc: doc({ status: "requiere_accion" }) })).toMatchObject({
      kind: "failed",
      status: "requiere_accion",
    });
  });
});

describe("previewVisible", () => {
  it("sólo con el comprobante listo o el provisorio pedido", () => {
    expect(previewVisible({ kind: "ready", fiscal: "none" }, false)).toBe(true);
    expect(previewVisible({ kind: "authorizing", slow: false }, false)).toBe(false);
    expect(previewVisible({ kind: "authorizing", slow: true }, true)).toBe(true);
    expect(previewVisible({ kind: "loading" }, true)).toBe(false);
  });
});

describe("silentStep (Imprimir ticket al cobrar)", () => {
  it("espera mientras carga o autoriza", () => {
    expect(silentStep({ kind: "loading" })).toBe("wait");
    expect(silentStep({ kind: "authorizing", slow: false })).toBe("wait");
  });
  it("imprime con el comprobante listo (no fiscal, CAE o CAEA)", () => {
    expect(silentStep({ kind: "ready", fiscal: "none" })).toBe("print");
    expect(silentStep({ kind: "ready", fiscal: "cae" })).toBe("print");
    expect(silentStep({ kind: "ready", fiscal: "caea" })).toBe("print");
  });
  it("abre la ventana si ARCA falla, tarda o la impresión falla", () => {
    expect(silentStep({ kind: "authorizing", slow: true })).toBe("show");
    expect(silentStep({ kind: "retrying", errorCode: "x", errorMsg: null, nextAttemptAt: null })).toBe("show");
    expect(silentStep({ kind: "failed", status: "rechazado", errorCode: null, errorMsg: null })).toBe("show");
    expect(silentStep({ kind: "ready", fiscal: "none" }, { printFailed: true })).toBe("show");
  });
});
