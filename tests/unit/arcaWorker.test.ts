// @vitest-environment node
// Cola fiscal (ADR-072): cada caso del worker con una base falsa y un ARCA
// falso que responde fixtures. Nunca se llama a ARCA.
import { describe, expect, it } from "vitest";
import { createWsfeClient, type FetchLike } from "@/supabase/functions/_shared/arca/client";
import {
  informCaeaDocument,
  planDocument,
  processDocument,
  type AuthOutcome,
  type CaeaIssued,
  type Snapshot,
  type WorkerDeps,
} from "@/supabase/functions/_shared/arca/worker";
import { runCaeaTasks, type CaeaTasks } from "@/supabase/functions/_shared/arca/caeaTasks";
import { caeaPeriodsToRequest, nextQuincena, quincenaOf } from "@/supabase/functions/_shared/arca/caea";
import { decodeQrUrl } from "@/supabase/functions/_shared/arca/qr";
import * as F from "../fixtures/arcaSoap";

const NOW = new Date("2026-10-13T13:00:00Z");

function snap(over: Partial<Snapshot["document"]> = {}, extra: Partial<Snapshot> = {}): Snapshot {
  return {
    document: {
      id: "doc-1",
      tenant_id: "t1",
      sale_id: "s1",
      origin: "sale",
      environment: "homologacion",
      cbte_letter: "B",
      cbte_tipo: 6,
      pto_vta: 3,
      cbte_nro: null,
      cbte_fch: null,
      imp_total: 121,
      doc_tipo: null,
      doc_nro: null,
      status: "enviando",
      attempts: 1,
      ...over,
    },
    sale: {
      id: "s1",
      created_at: "2026-10-13T12:30:00Z",
      total: 121,
      cbte_letter: "B",
      receptor: { iva_condition: "consumidor_final", arca_condition_id: 5, arca_doc_type: 99, doc_number: "0" },
    },
    tax_lines: [{ kind: "iva", tax: "iva", rate_code: "21", rate: 21, base: 100, amount: 21, arca_id: 5 }],
    has_services: false,
    has_goods: true,
    return_total: null,
    credited_total: 0,
    assoc: null,
    emitter: { cuit: "30500000003", iva_condition: "responsable_inscripto" },
    last_fch: null,
    settings: { max_attempts: 10, auth_mode: "propio", caea_enabled: false, caea_pto_vta: null, caea_timeout_seconds: 10 },
    ...extra,
  };
}

type Route = string | (() => string) | "timeout" | "network";

function fakeArca(routes: Record<string, Route | Route[]>) {
  const calls: { op: string; body: string }[] = [];
  const fetcher: FetchLike = async (_url, init) => {
    const op = (init.headers.SOAPAction ?? "").replace(/"/g, "").split("/").pop() ?? "";
    calls.push({ op, body: init.body });
    let r = routes[op];
    if (Array.isArray(r)) r = r.length > 1 ? (r.shift() as Route) : (r[0] as Route);
    if (r === undefined) throw new Error(`sin fixture para ${op}`);
    if (r === "timeout") {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }
    if (r === "network") throw new TypeError("fetch failed");
    const text = typeof r === "function" ? r() : r;
    return { status: 200, text: async () => text };
  };
  return { fetcher, calls };
}

function harness(s: Snapshot, routes: Record<string, Route | Route[]>, auth: AuthOutcome = { ok: true, auth: { token: "T", sign: "S", cuit: "30500000003" } }, caea: CaeaIssued | null = null) {
  const arca = fakeArca(routes);
  const log: { fn: string; p: Record<string, unknown> }[] = [];
  let current = s;
  const deps: WorkerDeps = {
    now: () => NOW,
    auth: async () => auth,
    wsfe: () => createWsfeClient({ fetch: arca.fetcher, endpoints: { wsaa: "http://localhost/wsaa", wsfe: "http://localhost/wsfe" } }),
    cuitFor: () => "30500000003",
    db: {
      snapshot: async () => current,
      markSending: async (_id, p) => {
        log.push({ fn: "markSending", p });
        current = { ...current, document: { ...current.document, cbte_nro: p.cbte_nro as number } };
      },
      applyResult: async (_id, p) => void log.push({ fn: "applyResult", p }),
      caeaIssue: async (_id, p) => {
        log.push({ fn: "caeaIssue", p });
        return caea;
      },
      setQr: async (_id, url) => void log.push({ fn: "setQr", p: { url } }),
      informResult: async (_id, p) => void log.push({ fn: "informResult", p }),
    },
  };
  return { deps, log, calls: arca.calls };
}

const last = (log: { fn: string; p: Record<string, unknown> }[], fn: string) => [...log].reverse().find((x) => x.fn === fn)?.p;

describe("processDocument", () => {
  it("éxito: concilia la numeración, guarda el número antes y aprueba con CAE y QR", async () => {
    const h = harness(snap(), { FECompUltimoAutorizado: F.ULTIMO(11), FECAESolicitar: F.CAE_APROBADO(12) });
    const r = await processDocument(h.deps, "doc-1");
    expect(r.outcome).toBe("aprobado");
    expect(h.calls.map((c) => c.op)).toEqual(["FECompUltimoAutorizado", "FECAESolicitar"]);
    expect(last(h.log, "markSending")).toMatchObject({ cbte_nro: 12, cbte_fch: "2026-10-13", doc_tipo: 99, imp_total: 121 });
    expect(String(last(h.log, "markSending")?.request_xml)).not.toContain("<ar:Token>T<");
    const res = last(h.log, "applyResult")!;
    expect(res).toMatchObject({ outcome: "aprobado", cbte_nro: 12, cae: "76412345678901", cae_vto: "2026-10-23" });
    expect(decodeQrUrl(String(res.qr_url))).toMatchObject({ cuit: 30500000003, ptoVta: 3, tipoCmp: 6, nroCmp: 12, importe: 121, tipoCodAut: "E", codAut: 76412345678901 });
    expect(h.calls[1]?.body).toContain("<ar:CbteDesde>12</ar:CbteDesde>");
  });

  it("rechazo con observaciones: rechazado, sin número consumido", async () => {
    const s = snap({ cbte_letter: "A", cbte_tipo: 1 }, {});
    s.sale.receptor = { iva_condition: "responsable_inscripto", arca_condition_id: 1, arca_doc_type: 80, doc_number: "30712345671" };
    const h = harness(s, { FECompUltimoAutorizado: F.ULTIMO(3, 3, 1), FECAESolicitar: F.CAE_RECHAZADO_OBS(4) });
    const r = await processDocument(h.deps, "doc-1");
    expect(r.outcome).toBe("rechazado");
    const res = last(h.log, "applyResult")!;
    expect(res).toMatchObject({ outcome: "rechazado", error_code: "10013" });
    expect(res.keep_number).toBeUndefined();
    expect(String(res.error_msg)).toContain("10242");
    expect((res.observations as unknown[]).length).toBe(2);
  });

  it("error transitorio de ARCA: reintenta con backoff", async () => {
    const h = harness(snap({ attempts: 3 }), { FECompUltimoAutorizado: F.ULTIMO(11), FECAESolicitar: F.CAE_TRANSITORIO });
    const r = await processDocument(h.deps, "doc-1");
    expect(r.outcome).toBe("reintentar");
    const res = last(h.log, "applyResult")!;
    expect(res).toMatchObject({ outcome: "reintentar", error_code: "501" });
    expect(new Date(String(res.next_attempt_at)).getTime() - NOW.getTime()).toBe(4 * 60_000);
  });

  it("numeración desfasada (10016): reintenta enseguida sin guardar el número", async () => {
    const h = harness(snap(), { FECompUltimoAutorizado: F.ULTIMO(11), FECAESolicitar: F.CAE_NUMERACION });
    const r = await processDocument(h.deps, "doc-1");
    expect(r).toEqual({ outcome: "reintentar", detail: "10016" });
    const res = last(h.log, "applyResult")!;
    expect(res.keep_number).toBeUndefined();
    expect(new Date(String(res.next_attempt_at)).getTime() - NOW.getTime()).toBe(10_000);
  });

  it("timeout del pedido de CAE: resultado incierto, guarda el número y no usa CAEA", async () => {
    const s = snap({}, { settings: { caea_enabled: true, caea_pto_vta: 90, caea_timeout_seconds: 5 } });
    const h = harness(s, { FECompUltimoAutorizado: F.ULTIMO(11), FECAESolicitar: "timeout" }, undefined, {
      caea: "31423456789012", caea_id: "c1", pto_vta: 90, cbte_nro: 1, cbte_fch: "2026-10-13", fch_vig_hasta: "2026-10-15",
    });
    const r = await processDocument(h.deps, "doc-1");
    expect(r.outcome).toBe("reintentar");
    expect(last(h.log, "applyResult")).toMatchObject({ keep_number: true, error_code: "sin_respuesta" });
    expect(h.log.some((x) => x.fn === "caeaIssue")).toBe(false);
  });

  it("recuperación: el número ya tenía CAE en ARCA (FECompConsultar) y no se emite otra factura", async () => {
    const h = harness(snap({ cbte_nro: 12, cbte_fch: "2026-10-13" }), {
      FECompUltimoAutorizado: F.ULTIMO(12),
      FECompConsultar: F.CONSULTA(12, "76412345678901", "121"),
    });
    const r = await processDocument(h.deps, "doc-1", true);
    expect(r.outcome).toBe("recuperado");
    expect(h.calls.map((c) => c.op)).toEqual(["FECompUltimoAutorizado", "FECompConsultar"]);
    expect(last(h.log, "applyResult")).toMatchObject({ outcome: "aprobado", cbte_nro: 12, cae: "76412345678901" });
  });

  it("recuperación: el número no llegó a ARCA, se emite normal", async () => {
    const h = harness(snap({ cbte_nro: 12 }), {
      FECompUltimoAutorizado: [F.ULTIMO(11), F.ULTIMO(11)],
      FECAESolicitar: F.CAE_APROBADO(12),
    });
    const r = await processDocument(h.deps, "doc-1", true);
    expect(r.outcome).toBe("aprobado");
    expect(h.calls.map((c) => c.op)).toEqual(["FECompUltimoAutorizado", "FECompUltimoAutorizado", "FECAESolicitar"]);
  });

  it("ARCA caído (último autorizado sin respuesta) y CAEA vigente: se emite al instante con CAEA", async () => {
    const s = snap({}, { settings: { caea_enabled: true, caea_pto_vta: 90, caea_timeout_seconds: 5 } });
    const h = harness(s, { FECompUltimoAutorizado: "network" }, undefined, {
      caea: "31423456789012", caea_id: "c1", pto_vta: 90, cbte_nro: 7, cbte_fch: "2026-10-13", fch_vig_hasta: "2026-10-15",
    });
    const r = await processDocument(h.deps, "doc-1");
    expect(r.outcome).toBe("caea");
    expect(last(h.log, "caeaIssue")).toMatchObject({ error_code: "sin_respuesta", imp_total: 121, doc_tipo: 99 });
    expect(decodeQrUrl(String(last(h.log, "setQr")?.url))).toMatchObject({ ptoVta: 90, nroCmp: 7, tipoCodAut: "A", codAut: 31423456789012 });
    expect(h.log.some((x) => x.fn === "applyResult")).toBe(false);
  });

  it("WSAA caído y CAEA vigente: CAEA (la venta ya está hecha, el cajero no espera)", async () => {
    const s = snap({}, { settings: { caea_enabled: true, caea_pto_vta: 90 } });
    const h = harness(s, {}, { ok: false, kind: "transient", code: "sin_respuesta", message: "WSAA no respondió" }, {
      caea: "31423456789012", caea_id: "c1", pto_vta: 90, cbte_nro: 1, cbte_fch: "2026-10-13", fch_vig_hasta: "2026-10-15",
    });
    expect((await processDocument(h.deps, "doc-1")).outcome).toBe("caea");
  });

  it("ARCA caído sin CAEA: queda pendiente y reintenta", async () => {
    const h = harness(snap(), { FECompUltimoAutorizado: "timeout" });
    const r = await processDocument(h.deps, "doc-1");
    expect(r.outcome).toBe("reintentar");
    expect(last(h.log, "applyResult")).toMatchObject({ outcome: "reintentar", error_code: "sin_respuesta" });
  });

  it("CAEA activo pero sin CAEA vigente: queda pendiente", async () => {
    const s = snap({}, { settings: { caea_enabled: true, caea_pto_vta: 90 } });
    const h = harness(s, { FECompUltimoAutorizado: "network" }, undefined, null);
    expect((await processDocument(h.deps, "doc-1")).outcome).toBe("reintentar");
  });

  it("TA ya emitido sin cache: requiere acción, sin loop", async () => {
    const h = harness(snap(), {}, { ok: false, kind: "action", code: "ta_ya_emitido", message: "esperar" });
    const r = await processDocument(h.deps, "doc-1");
    expect(r.outcome).toBe("requiere_accion");
    expect(last(h.log, "applyResult")).toMatchObject({ outcome: "requiere_accion", error_code: "ta_ya_emitido" });
    expect(h.calls).toHaveLength(0);
  });

  it("CUIT no autorizada (600): requiere acción", async () => {
    const h = harness(snap(), { FECompUltimoAutorizado: F.ULTIMO_ERR("600", "ValidacionDeToken: No aparecio CUIT en lista de relaciones") });
    expect((await processDocument(h.deps, "doc-1")).outcome).toBe("requiere_accion");
  });

  it("factura A sin CUIT del receptor: requiere acción sin llamar a ARCA", async () => {
    const s = snap({ cbte_letter: "A", cbte_tipo: 1 });
    s.sale.receptor = { iva_condition: "responsable_inscripto", arca_doc_type: 99 };
    const h = harness(s, {});
    expect((await processDocument(h.deps, "doc-1")).outcome).toBe("requiere_accion");
    expect(h.calls).toHaveLength(0);
  });

  it("nota de crédito de una devolución: proporcional y con el comprobante asociado", async () => {
    const s = snap(
      { origin: "return", cbte_tipo: 8, imp_total: 60.5 },
      { return_total: 60.5, assoc: { cbte_tipo: 6, pto_vta: 3, cbte_nro: 12, cbte_fch: "2026-10-12", imp_total: 121 } },
    );
    const h = harness(s, { FECompUltimoAutorizado: F.ULTIMO(4, 3, 8), FECAESolicitar: F.CAE_APROBADO(5) });
    await processDocument(h.deps, "doc-1");
    const body = h.calls[1]?.body ?? "";
    expect(body).toContain("<ar:CbteTipo>8</ar:CbteTipo>");
    expect(body).toContain("<ar:ImpTotal>60.50</ar:ImpTotal>");
    expect(body).toContain("<ar:ImpNeto>50.00</ar:ImpNeto>");
    expect(body).toContain("<ar:ImpIVA>10.50</ar:ImpIVA>");
    expect(body).toContain("<ar:Nro>12</ar:Nro><ar:Cuit>30500000003</ar:Cuit><ar:CbteFch>20261012</ar:CbteFch>");
  });

  it("anulación: NC por lo que no acreditaron las devoluciones", () => {
    const s = snap({ origin: "void", cbte_tipo: 8 }, { credited_total: 21, assoc: { cbte_tipo: 6, pto_vta: 3, cbte_nro: 12, cbte_fch: "2026-10-12", imp_total: 121 } });
    const p = planDocument(s);
    expect(p.ok && p.plan.breakdown.ImpTotal).toBe(100);
    const none = planDocument(snap({ origin: "void", cbte_tipo: 8 }, { credited_total: 121 }));
    expect(none).toEqual({ ok: false, code: "nada_para_acreditar" });
  });
});

describe("contingencia CAEA", () => {
  const caeaSnap = () =>
    snap({ emission_type: "CAEA", cae: "31423456789012", cbte_nro: 7, pto_vta: 90, cbte_fch: "2026-10-13", status: "aprobado", approved_at: "2026-10-13T13:00:05Z" });

  it("informe posterior OK", async () => {
    const h = harness(caeaSnap(), { FECAEARegInformativo: F.CAEA_INFORMADO(7) });
    expect((await informCaeaDocument(h.deps, "doc-1")).outcome).toBe("informado");
    const body = h.calls[0]?.body ?? "";
    expect(body).toContain("<ar:CAEA>31423456789012</ar:CAEA>");
    expect(body).toContain("<ar:CbteFchHsGen>20261013100005</ar:CbteFchHsGen>");
    expect(body).toContain("<ar:PtoVta>90</ar:PtoVta>");
    expect(last(h.log, "informResult")).toMatchObject({ outcome: "informado" });
  });

  it("informe rechazado: el comprobante pasa a requerir acción", async () => {
    const h = harness(caeaSnap(), { FECAEARegInformativo: F.CAEA_INFORME_RECHAZADO(7) });
    expect((await informCaeaDocument(h.deps, "doc-1")).outcome).toBe("rechazado");
    expect(last(h.log, "informResult")).toMatchObject({ outcome: "rechazado", error_code: "1504" });
  });

  it("informe sin respuesta: reintenta", async () => {
    const h = harness(caeaSnap(), { FECAEARegInformativo: "timeout" });
    expect((await informCaeaDocument(h.deps, "doc-1")).outcome).toBe("reintentar");
  });

  it("quincenas: la vigente y la próxima dentro de los 5 días previos", () => {
    expect(quincenaOf("20261013")).toEqual({ periodo: 202610, orden: 1, desde: "20261001", hasta: "20261015" });
    expect(nextQuincena(quincenaOf("20261220"))).toMatchObject({ periodo: 202701, orden: 1, desde: "20270101" });
    expect(quincenaOf("20260220").hasta).toBe("20260228");
    expect(caeaPeriodsToRequest("20261005", [{ periodo: 202610, orden: 1 }])).toEqual([]);
    expect(caeaPeriodsToRequest("20261011", [{ periodo: 202610, orden: 1 }]).map((q) => q.orden)).toEqual([2]);
    expect(caeaPeriodsToRequest("20261013", []).map((q) => `${q.periodo}/${q.orden}`)).toEqual(["202610/1", "202610/2"]);
  });

  it("tareas: pide el CAEA (o lo consulta si ya estaba), sincroniza numeración, informa y declara sin movimiento", async () => {
    const h = harness(caeaSnap(), {
      FECAEASolicitar: [F.CAEA_OTORGADO(202610, 2), F.CAEA_YA_SOLICITADO],
      FECAEAConsultar: F.CAEA_CONSULTA(202610, 1, "31423456789000"),
      FECompUltimoAutorizado: F.ULTIMO(6, 90, 6),
      FECAEARegInformativo: F.CAEA_INFORMADO(7),
      FECAEASinMovimientoInformar: F.CAEA_SIN_MOV_OK,
    });
    const stored: Record<string, unknown>[] = [];
    const synced: number[][] = [];
    const sinMov: [string, boolean][] = [];
    let checked = "";
    const tasks: CaeaTasks = {
      environment: "homologacion",
      pto_vta: 90,
      request: [{ periodo: 202610, orden: 2 }, { periodo: 202610, orden: 1 }],
      inform: ["doc-1"],
      sin_movimiento: [{ id: "c0", caea: "31423456789999", environment: "homologacion" }],
    };
    const run = await runCaeaTasks(
      h.deps,
      {
        tasks: async () => tasks,
        store: async (_e, p) => void stored.push(p),
        seriesSync: async (_e, pv, tipo, lastNro) => void synced.push([pv, tipo, lastNro]),
        sinMovimiento: async (id, ok) => void sinMov.push([id, ok]),
        checked: async (_n, m) => void (checked = m),
      },
      "responsable_inscripto",
    );
    expect(run).toMatchObject({ obtained: 2, informed: 1, sinMovimiento: 1, errors: [] });
    expect(stored.map((x) => x.caea)).toEqual(["31423456789012", "31423456789000"]);
    expect(stored[0]).toMatchObject({ fch_vig_desde: "2026-10-16", fch_vig_hasta: "2026-10-31", fch_tope_inf: "2026-11-08" });
    expect(synced.map((x) => x[1])).toEqual([1, 3, 6, 8]);
    expect(sinMov).toEqual([["c0", true]]);
    expect(checked).toContain("CAEA al día");
  });
});
