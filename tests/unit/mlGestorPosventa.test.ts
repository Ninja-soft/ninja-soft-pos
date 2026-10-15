// @vitest-environment node
// =============================================================================
// Gestor de Mercado Libre, parte B (H141 · ADR-132): reputación (niveles,
// umbrales, margen y avisos, criterios de ANDESMAR), mapeo de reclamos
// (tipo, vencimiento, "te toca", resultado, acciones disponibles), horas
// hábiles de Argentina, embudos y el worker de reclamos con un fetch falso.
// Nunca se llama a Mercado Libre.
// =============================================================================
import { describe, expect, it } from "vitest";
import {
  arDate,
  barFill,
  cleanThresholds,
  crossings,
  levelIndex,
  levelLabel,
  margin,
  marginText,
  metricLevel,
  periodLabel,
  snapshotFromReputation,
} from "@/supabase/functions/_shared/mercadolibre/reputation";
import {
  affectsFlag,
  attachmentProblem,
  canDo,
  claimDueDate,
  claimKind,
  claimPayload,
  claimResult,
  isMyTurn,
  isUncertain,
  normalizeMessages,
  plainText,
  sellerActions,
  type MlClaim,
} from "@/supabase/functions/_shared/mercadolibre/claims";
import {
  autoClaimKey,
  autoSalesKey,
  businessHoursLeft,
  caseGroup,
  dueLabel,
  effectiveStage,
  reasonLabel,
  urgency,
  type StageRow,
} from "@/lib/mercadolibre/postsale";
import { isHandledTopic, parseNotification, resourceId } from "@/supabase/functions/_shared/mercadolibre/notifications";
import { reconcileClaims, refreshClaim, takeReputation } from "@/supabase/functions/_shared/mercadolibre/gestorWorker";
import { MlApiError, type MlClient } from "@/supabase/functions/_shared/mercadolibre/client";

// Respuesta real de /users/me de una cuenta chica (15/10/2026, sin datos personales).
const REP_SMALL = {
  level_id: null,
  power_seller_status: null,
  transactions: { canceled: 0, completed: 0, period: "historic", ratings: { negative: 0, neutral: 0, positive: 1 }, total: 0 },
  metrics: {
    sales: { period: "365 days", completed: 0 },
    claims: { period: "365 days", rate: 0, value: 0 },
    delayed_handling_time: { period: "365 days", rate: 0, value: 0 },
    cancellations: { period: "365 days", rate: 0, value: 0 },
  },
};

describe("reputación", () => {
  it("foto desde seller_reputation (cuenta chica real)", () => {
    const s = snapshotFromReputation(REP_SMALL);
    expect(s).toMatchObject({ level_id: null, sales_completed: 0, sales_period: "365 days", ratings: { positive: 1, neutral: 0, negative: 0 } });
    expect(s.claims).toEqual({ rate: 0, value: 0, period: "365 days", real_value: null, real_rate: null });
    expect(levelLabel(s.level_id)).toBe("Sin nivel todavía");
  });
  it("excluidos y niveles", () => {
    const s = snapshotFromReputation({
      level_id: "4_light_green",
      power_seller_status: "gold",
      metrics: { sales: { completed: 500, period: "60 days" }, claims: { rate: 0.012, value: 6, excluded: { real_value: 9, real_rate: 0.018 } } },
    });
    expect(s.claims.real_value).toBe(9);
    expect(levelIndex(s.level_id)).toBe(3);
    expect(periodLabel("60 days")).toBe("60 días");
    expect(periodLabel("historic")).toBe("histórico");
    expect(periodLabel("1 months")).toBe("1 mes");
  });
  it("nivel de la métrica: ámbar desde el 80 % del umbral", () => {
    expect(metricLevel(0.0079, 1)).toBe("ok");
    expect(metricLevel(0.008, 1)).toBe("ambar");
    expect(metricLevel(0.01, 1)).toBe("rojo");
    expect(metricLevel(0.003, 0.5)).toBe("ok");
    expect(metricLevel(0.075, 8)).toBe("ambar");
    expect(barFill(0.005, 1)).toBe(50);
    expect(barFill(0.05, 1)).toBe(100);
  });
  it("margen como ANDESMAR: permitidos, margen y ventas que faltan", () => {
    expect(margin(500, 3, 1)).toEqual({ allowed: 5, margin: 2, salesNeeded: null });
    expect(margin(500, 5, 1)).toEqual({ allowed: 5, margin: 0, salesNeeded: null });
    expect(margin(500, 7, 1)).toEqual({ allowed: 5, margin: -2, salesNeeded: 200 });
    expect(margin(100, 1, 0.5)).toEqual({ allowed: 0, margin: -1, salesNeeded: 100 });
    expect(margin(0, 0, 1)).toEqual({ allowed: 0, margin: 0, salesNeeded: null });
    // 1 % de 300 = 3 exacto (sin error de coma flotante).
    expect(margin(300, 0, 1).allowed).toBe(3);
    expect(marginText("claims", margin(500, 3, 1), 1)).toBe("Te quedan 2 reclamos de margen antes de pasar el 1 % (tope: 5).");
    expect(marginText("cancellations", margin(500, 2, 0.5), 0.5)).toBe("Estás justo en el límite del 0,5 %: una cancelación más te saca del verde.");
    expect(marginText("delayed", margin(100, 9, 8), 8)).toMatch(/Te pasaste del 8 %\. Te faltan 13 ventas sin despachos con demora/);
  });
  it("avisos sólo cuando una métrica empeora de nivel", () => {
    const base = snapshotFromReputation({ metrics: { sales: { completed: 100 }, claims: { rate: 0.005 }, cancellations: { rate: 0.001 }, delayed_handling_time: { rate: 0.09 } } });
    const worse = snapshotFromReputation({ metrics: { sales: { completed: 100 }, claims: { rate: 0.009 }, cancellations: { rate: 0.006 }, delayed_handling_time: { rate: 0.01 } } });
    const th = cleanThresholds(null);
    expect(crossings(null, worse, th)).toEqual([]);
    expect(crossings(base, worse, th)).toEqual([
      { key: "claims", from: "ok", to: "ambar" },
      { key: "cancellations", from: "ok", to: "rojo" },
    ]);
  });
  it("umbrales fuera de rango vuelven al default", () => {
    expect(cleanThresholds({ claims: 0, cancellations: 30, delayed: 12 })).toEqual({ claims: 1, cancellations: 0.5, delayed: 12 });
  });
  it("fecha de la foto en Argentina", () => {
    expect(arDate(Date.parse("2026-10-16T02:30:00Z"))).toBe("2026-10-15");
    expect(arDate(Date.parse("2026-10-16T03:00:00Z"))).toBe("2026-10-16");
  });
});

const seller = (actions: Array<{ action: string; mandatory?: boolean; due_date?: string }>) => [
  { role: "complainant", type: "buyer", available_actions: [{ action: "x" }] },
  { role: "respondent", type: "seller", available_actions: actions },
];

describe("reclamos", () => {
  const claim: MlClaim = {
    id: 5_123_456_789,
    resource_id: 2_000_000_123,
    resource: "order",
    status: "opened",
    type: "mediations",
    stage: "claim",
    reason_id: "PDD9939",
    players: seller([
      { action: "send_message_to_complainant", mandatory: false, due_date: "2026-10-18T12:00:00.000-03:00" },
      { action: "allow_return", mandatory: true, due_date: "2026-10-17T18:00:00.000-03:00" },
      { action: "open_dispute", mandatory: false },
    ]),
    date_created: "2026-10-15T09:00:00.000-03:00",
    last_updated: "2026-10-15T10:00:00.000-03:00",
  };
  it("tipo del caso", () => {
    expect(claimKind({ type: "cancel_purchase", stage: "claim" })).toBe("cancelacion");
    expect(claimKind({ type: "returns", stage: "claim" })).toBe("devolucion");
    expect(claimKind({ type: "mediations", stage: "claim" }, true)).toBe("devolucion");
    expect(claimKind({ type: "mediations", stage: "dispute" })).toBe("mediacion");
    expect(claimKind({ type: "mediations", stage: "claim" })).toBe("reclamo");
  });
  it("acciones del vendedor: obligatorias primero y vencimiento más temprano", () => {
    expect(sellerActions(claim).map((a) => a.action)).toEqual(["allow_return", "send_message_to_complainant", "open_dispute"]);
    expect(claimDueDate(claim)).toBe("2026-10-17T21:00:00.000Z");
    expect(claimDueDate(claim, { due_date: "2026-10-16T12:00:00.000-03:00" })).toBe("2026-10-16T15:00:00.000Z");
  });
  it("te toca: por action_responsible o por acción obligatoria; nunca si está cerrado", () => {
    expect(isMyTurn(claim)).toBe(true);
    expect(isMyTurn(claim, { action_responsible: "complainant" })).toBe(false);
    expect(isMyTurn({ ...claim, players: seller([{ action: "send_message_to_complainant" }]) })).toBe(false);
    expect(isMyTurn({ ...claim, status: "closed" })).toBe(false);
  });
  it("resultado del caso", () => {
    expect(claimResult({ status: "opened", resolution: { reason: "partial_refunded" } })).toBeNull();
    expect(claimResult({ status: "closed", resolution: { reason: "partial_refunded" } })).toBe("reintegro");
    expect(claimResult({ status: "closed", resolution: { benefited: ["respondent"] } })).toBe("a_favor");
    expect(claimResult({ status: "closed", resolution: { benefited: ["complainant"], applied_coverage: true } })).toBe("cubierto");
    expect(claimResult({ status: "closed", resolution: { benefited: ["complainant"] } })).toBe("en_contra");
  });
  it("afecta la reputación y payload sin pisar lo que no se pudo leer", () => {
    expect(affectsFlag({ affects_reputation: "affected" })).toBe(true);
    expect(affectsFlag({ affects_reputation: "not_affected" })).toBe(false);
    expect(affectsFlag(null)).toBeNull();
    const p = claimPayload(claim, { title: "Producto distinto", action_responsible: "respondent" }, null, undefined);
    expect(p).toMatchObject({ claim_id: "5123456789", resource_id: "2000000123", kind: "reclamo", status: "opened", due_at: "2026-10-17T21:00:00.000Z", detail_title: "Producto distinto" });
    expect(p.affects_reputation).toBeUndefined();
    expect(p.return_status).toBeUndefined();
    const withReturn = claimPayload(claim, null, { id: 99, status: "shipped" }, true);
    expect(withReturn).toMatchObject({ kind: "devolucion", return_id: "99", return_status: "shipped", affects_reputation: true });
  });
  it("una escritura sólo si ML la ofrece ahora", () => {
    expect(canDo(claim, "allow_return")).toBe(true);
    expect(canDo(claim, "open_dispute")).toBe(true);
    expect(canDo(claim, "partial_refund")).toBe(false);
    expect(canDo(claim, "message_mediator")).toBe(false);
    expect(canDo({ ...claim, status: "closed" }, "allow_return")).toBe(false);
  });
  it("incierto ante 0, 408, 429 y 5xx", () => {
    expect([0, 408, 429, 500, 503].every(isUncertain)).toBe(true);
    expect([400, 403, 404, 409].some(isUncertain)).toBe(false);
  });
  it("adjuntos: 3, jpg/png/pdf, 5 MB cada uno y 8 MB en total", () => {
    const mb = 1024 * 1024;
    expect(attachmentProblem([{ type: "image/png", size: mb }])).toBeNull();
    expect(attachmentProblem(Array(4).fill({ type: "image/png", size: 1 }))).toBe("Hasta 3 adjuntos.");
    expect(attachmentProblem([{ type: "image/gif", size: 1 }])).toBe("Sólo JPG, PNG o PDF.");
    expect(attachmentProblem([{ type: "application/pdf", size: 6 * mb }])).toBe("Cada adjunto hasta 5 MB.");
    expect(attachmentProblem([{ type: "image/jpeg", size: 4 * mb }, { type: "image/jpeg", size: 4.5 * mb }])).toBe("Entre todos, hasta 8 MB.");
  });
  it("mensajes del mediador en HTML a texto, ordenados", () => {
    expect(plainText("<p>Hola&nbsp;<b>vendedor</b></p><p>Mandá foto &amp; video</p>")).toBe("Hola vendedor\nMandá foto & video");
    const msgs = normalizeMessages([
      { sender_role: "mediator", message: "<p>Revisamos</p>", date_created: "2026-10-15T12:00:00Z" },
      { sender_role: "complainant", message: "No llegó", date_created: "2026-10-15T10:00:00Z", attachments: [{ original_filename: "foto.jpg" }] },
    ]);
    expect(msgs.map((m) => [m.from, m.text, m.attachments])).toEqual([
      ["complainant", "No llegó", ["foto.jpg"]],
      ["mediator", "Revisamos", []],
    ]);
  });
  it("motivos y grupos", () => {
    expect(reasonLabel("PNR9501")).toBe("No recibió el producto");
    expect(reasonLabel("PDD9939")).toBe("Producto distinto o con fallas");
    expect(reasonLabel("CS123")).toBe("Compra cancelada");
    expect(caseGroup("mediacion")).toBe("mediations");
    expect(caseGroup("cancelacion")).toBe("others");
  });
  it("tópicos de reclamos: patrón, procesados e id del reclamo", () => {
    for (const topic of ["claims", "claims_actions", "post_purchase"]) {
      const r = parseNotification({ _id: "abcd-1234-efgh", topic, resource: "/post-purchase/v1/claims/5123456789/actions", user_id: 1, application_id: 9 }, "9");
      expect(r.ok).toBe(true);
      expect(isHandledTopic(topic)).toBe(true);
    }
    expect(resourceId("/post-purchase/v1/claims/5123456789/actions")).toBe("5123456789");
    expect(resourceId("/orders/2000000123")).toBe("2000000123");
    expect(isHandledTopic("messages")).toBe(false);
  });
});

describe("horas hábiles y vencimientos (hora de Argentina)", () => {
  // Jueves 15/10/2026 10:00 en Argentina.
  const thu = Date.parse("2026-10-15T10:00:00-03:00");
  it("cuenta sólo lunes a viernes", () => {
    expect(businessHoursLeft("2026-10-15T13:00:00-03:00", thu)).toBe(3);
    // Del jueves 10 al lunes 10: jueves 14 h + viernes 24 h + lunes 10 h = 48 h hábiles.
    expect(businessHoursLeft("2026-10-19T10:00:00-03:00", thu)).toBe(48);
    expect(businessHoursLeft("2026-10-15T09:00:00-03:00", thu)!).toBeLessThan(0);
    expect(businessHoursLeft(null, thu)).toBeNull();
  });
  it("semáforo: vencido, rojo < 4 h, ámbar < 24 h", () => {
    expect(urgency("2026-10-15T09:00:00-03:00", thu)).toBe("vencido");
    expect(urgency("2026-10-15T12:00:00-03:00", thu)).toBe("rojo");
    expect(urgency("2026-10-16T08:00:00-03:00", thu)).toBe("ambar");
    expect(urgency("2026-10-20T10:00:00-03:00", thu)).toBe("ok");
    expect(urgency("2026-10-16T08:00:00-03:00", thu, 12)).toBe("ok");
    expect(urgency(null, thu)).toBe("sin_plazo");
  });
  it("etiqueta en hora de Argentina", () => {
    expect(dueLabel("2026-10-16T21:00:00Z")).toBe("Resolvé hasta el vie 16/10 18:00");
    expect(dueLabel(null)).toBe("Sin vencimiento");
  });
});

describe("embudos", () => {
  const stages: StageRow[] = [
    { id: "s-new", name: "Nueva", sort: 0, auto_key: "new", is_final: false },
    { id: "s-prep", name: "A preparar", sort: 1, auto_key: "to_prepare", is_final: false },
    { id: "s-mine", name: "Llamar", sort: 2, auto_key: null, is_final: false },
    { id: "s-claim", name: "Con reclamo", sort: 3, auto_key: "claim", is_final: false },
    { id: "s-done", name: "Resuelta", sort: 4, auto_key: "resolved", is_final: true },
  ];
  it("etapa automática de una venta y de un reclamo", () => {
    expect(autoSalesKey({ orderStatus: "paid" })).toBe("new");
    expect(autoSalesKey({ orderStatus: "paid", shipmentStatus: "ready_to_ship" })).toBe("to_prepare");
    expect(autoSalesKey({ orderStatus: "paid", shipmentStatus: "shipped" })).toBe("shipped");
    expect(autoSalesKey({ orderStatus: "paid", shipmentStatus: "delivered" })).toBe("delivered");
    expect(autoSalesKey({ orderStatus: "paid", shipmentStatus: "delivered", claimStatus: "opened" })).toBe("claim");
    expect(autoSalesKey({ orderStatus: "cancelled" })).toBe("resolved");
    expect(autoClaimKey({ status: "opened", action_responsible: "respondent" })).toBe("new");
    expect(autoClaimKey({ status: "opened", action_responsible: "complainant" })).toBe("waiting");
    expect(autoClaimKey({ status: "closed" })).toBe("resolved");
  });
  it("la etapa elegida a mano gana, salvo que el caso se cierre después", () => {
    expect(effectiveStage(stages, "to_prepare", null, null)).toBe("s-prep");
    expect(effectiveStage(stages, "shipped", null, null)).toBe("s-new"); // sin etapa para ese automático: la primera
    expect(effectiveStage(stages, "to_prepare", { stage_id: "s-mine", moved_at: "2026-10-15T10:00:00Z" }, null)).toBe("s-mine");
    expect(effectiveStage(stages, "resolved", { stage_id: "s-mine", moved_at: "2026-10-15T10:00:00Z" }, "2026-10-15T09:00:00Z")).toBe("s-mine");
    expect(effectiveStage(stages, "resolved", { stage_id: "s-mine", moved_at: "2026-10-15T10:00:00Z" }, "2026-10-15T11:00:00Z")).toBe("s-done");
    expect(effectiveStage(stages, "claim", { stage_id: "borrada", moved_at: null }, null)).toBe("s-claim");
    expect(effectiveStage([], "new", null, null)).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Worker de reclamos y reputación con un cliente falso.
// -----------------------------------------------------------------------------
function fakeClient(routes: Record<string, unknown | ((q?: Record<string, unknown>) => unknown)>): MlClient & { calls: string[] } {
  const calls: string[] = [];
  const get = async (path: string, query?: Record<string, unknown>) => {
    calls.push(path + (query ? `?${new URLSearchParams(query as Record<string, string>).toString()}` : ""));
    const key = Object.keys(routes).find((k) => path === k || path.startsWith(k + "?"));
    if (!key) throw new MlApiError("not_found", "no", 404, false);
    const v = routes[key];
    if (v instanceof MlApiError) throw v;
    return typeof v === "function" ? (v as (q?: Record<string, unknown>) => unknown)(query) : v;
  };
  return {
    calls,
    get: get as MlClient["get"],
    post: (async () => ({})) as MlClient["post"],
    put: (async () => ({})) as MlClient["put"],
    request: (async () => ({ status: 200, data: {}, headers: new Headers() })) as MlClient["request"],
  };
}

describe("worker del gestor", () => {
  const base: MlClaim = {
    id: 777,
    resource_id: 2000000999,
    status: "opened",
    type: "returns",
    stage: "claim",
    players: seller([{ action: "allow_return", mandatory: true, due_date: "2026-10-17T18:00:00.000-03:00" }]),
    last_updated: "2026-10-15T10:00:00.000-03:00",
  };
  it("refreshClaim: un /returns que falla no borra el retorno conocido", async () => {
    const rpcCalls: Array<[string, Record<string, unknown>]> = [];
    const client = fakeClient({
      "/post-purchase/v1/claims/777": base,
      "/post-purchase/v1/claims/777/detail": { title: "Quiere devolver", action_responsible: "respondent" },
      "/post-purchase/v2/claims/777/returns": new MlApiError("server_error", "x", 500, true),
      "/post-purchase/v1/claims/777/affects-reputation": { affects_reputation: "affected" },
    });
    const r = await refreshClaim({ rpc: async (fn, a) => (rpcCalls.push([fn, a]), { ok: true }), client: () => client }, "acc", "777");
    expect(r.status).toBe("done");
    const p = rpcCalls[0]![1].p as Record<string, unknown>;
    expect(rpcCalls[0]![0]).toBe("ml_claim_upsert");
    expect("return_status" in p).toBe(false);
    expect(p.affects_reputation).toBe(true);
    expect(p.kind).toBe("devolucion");
  });
  it("refreshClaim: 403 en el GET usa la fila de la búsqueda; sin la feature se ignora", async () => {
    const client = fakeClient({ "/post-purchase/v1/claims/777": new MlApiError("forbidden", "x", 403, false) });
    const r = await refreshClaim({ rpc: async () => ({ ok: false, error: "feature_off" }), client: () => client }, "acc", "777", base);
    expect(r).toEqual({ status: "ignored", note: "feature_off" });
  });
  it("reconcileClaims relee sólo lo que cambió y pide ordenado", async () => {
    const unchanged = { ...base, id: 1, last_updated: "2026-10-15T09:00:00.000-03:00" };
    const changed = { ...base, id: 2, last_updated: "2026-10-15T11:00:00.000-03:00" };
    const client = fakeClient({
      "/post-purchase/v1/claims/search": (q?: Record<string, unknown>) => (q?.status === "opened" ? { data: [unchanged, changed] } : { data: [] }),
      "/post-purchase/v1/claims/2": changed,
    });
    const upserts: string[] = [];
    const r = await reconcileClaims(
      {
        rpc: async (fn, a) => {
          if (fn === "ml_claims_stamp") return [
            { claim_id: 1, ml_last_updated: "2026-10-15T12:00:00.000Z", status: "opened" },
            { claim_id: 2, ml_last_updated: "2026-10-15T12:00:00.000Z", status: "opened" },
          ];
          if (fn === "ml_claim_upsert") upserts.push(String((a.p as { claim_id: string }).claim_id));
          return { ok: true };
        },
        client: () => client,
        now: () => Date.parse("2026-10-15T15:00:00Z"),
      },
      "acc",
    );
    expect(r).toEqual({ seen: 2, refreshed: 1 });
    expect(upserts).toEqual(["2"]);
    expect(client.calls.some((c) => c.includes("sort=date_created%3Adesc") && c.includes("status=opened"))).toBe(true);
  });
  it("takeReputation guarda la foto con los avisos contra la anterior", async () => {
    const client = fakeClient({
      "/users/42": { seller_reputation: { level_id: "5_green", metrics: { sales: { completed: 200 }, claims: { rate: 0.009, value: 2 } } } },
    });
    const calls: Array<[string, Record<string, unknown>]> = [];
    const prev = snapshotFromReputation({ level_id: "5_green", metrics: { sales: { completed: 200 }, claims: { rate: 0.002, value: 0 } } });
    const r = await takeReputation(
      { rpc: async (fn, a) => (calls.push([fn, a]), fn === "ml_reputation_last" ? prev : { ok: true }), client: () => client },
      "acc",
      42,
      null,
    );
    expect(r.alerts).toBe(1);
    const save = calls.find((c) => c[0] === "ml_reputation_snapshot_save")!;
    expect((save[1].p_alerts as Array<{ key: string; to: string }>)[0]).toMatchObject({ key: "claims", to: "ámbar" });
  });
});
