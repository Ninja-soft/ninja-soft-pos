// ADR-165 · F22 · H148 (L5): expedición robusta. Lógica pura del escaneo,
// del resultado por producto (espejo de _exp_apply_outcome), de la pestaña
// Con problemas y de la cola offline; y lo que la migración garantiza.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPEDITION_SETTINGS,
  checkProgress,
  expeditionErrorMessage,
  expeditionSettings,
  itemChecked,
  itemOpenQty,
  lineMissing,
  matchLocal,
  normalizeCode,
  outcomeLines,
  outcomePayload,
  outcomePlan,
  outcomeProblem,
  outcomeSummary,
  outcomeTotals,
  scanFeedback,
  setLine,
  stageMode,
  type OutcomeLine,
} from "@/lib/logistics/expedition";
import { dispatchHasProblem, dispatchProblems, expeditionCounts, expeditionList, EXPEDITION_TABS, type DispatchLike } from "@/lib/orders/logic";
import { applyPending, type QueuedAction } from "@/lib/logistics/offline";
import { isPermanentEventError } from "@/lib/logistics/logic";

describe("Configuración de Expedición", () => {
  it("normaliza y cae a los defaults (escaneo opcional al armar y cargar, no al entregar)", () => {
    expect(expeditionSettings(null)).toEqual(DEFAULT_EXPEDITION_SETTINGS);
    const s = expeditionSettings({ scan_on_pick: "obligatorio", scan_on_load: "x", scan_on_deliver: "opcional", allow_partial: false, damaged_destination: "deposito", undelivered_action: "revisar" });
    expect(s).toMatchObject({ scan_on_pick: "obligatorio", scan_on_load: "opcional", scan_on_deliver: "opcional", allow_partial: false, damaged_destination: "deposito", undelivered_action: "revisar" });
    expect(stageMode(s, "armado")).toBe("obligatorio");
    expect(stageMode(s, "carga")).toBe("opcional");
    expect(stageMode(s, "entrega")).toBe("opcional");
  });
});

describe("Escaneo", () => {
  const items = [
    { id: "a", name: "Mesa", qty: 2, codes: ["7790001", "MESA"] },
    { id: "b", name: "Silla", qty: 1, codes: ["7790002"] },
    { id: "c", name: "Silla", qty: 1, codes: ["7790002"] },
  ];

  it("normaliza lo que manda el lector (espacios, Enter, minúsculas)", () => {
    expect(normalizeCode(" mesa\r\n")).toBe("MESA");
  });

  it("suma al primer renglón incompleto y avisa excedente y ajeno", () => {
    expect(matchLocal(items, "mesa", {})).toEqual({ kind: "ok", itemId: "a" });
    expect(matchLocal(items, "7790001", { a: 2 })).toEqual({ kind: "excedente", itemId: "a" });
    expect(matchLocal(items, "7790002", { b: 1 })).toEqual({ kind: "ok", itemId: "c" });
    expect(matchLocal(items, "7790009", {})).toEqual({ kind: "ajeno", itemId: null });
    expect(matchLocal(items, "   ", {})).toEqual({ kind: "ajeno", itemId: null });
  });

  it("un renglón está controlado completo o con motivo; el avance cuenta renglones", () => {
    expect(itemChecked(2, { scanned: 1 })).toBe(false);
    expect(itemChecked(2, { scanned: 2 })).toBe(true);
    expect(itemChecked(2, { scanned: 0, reason: "faltante" })).toBe(true);
    expect(itemChecked(0, undefined)).toBe(true);
    expect(checkProgress(items, { a: { scanned: 2 }, b: { scanned: 1 } })).toEqual({ done: 2, total: 3, complete: false });
    expect(checkProgress(items, { a: { scanned: 2 }, b: { scanned: 1 }, c: { scanned: 0, reason: "danado" } }).complete).toBe(true);
  });

  it("el aviso del cruce dice de qué entrega es", () => {
    expect(scanFeedback({ result: "cruce", other_dispatch_number: 12 })).toMatchObject({ tone: "danger", title: "No es de esta entrega" });
    expect(scanFeedback({ result: "cruce", other_dispatch_number: 12 }).description).toContain("N° 12");
    expect(scanFeedback({ result: "ok", product_name: "Mesa", scanned: 1, expected: 2 }).title).toBe("Mesa (1 de 2)");
    expect(scanFeedback({ result: "excedente", product_name: "Mesa" }).tone).toBe("warning");
    expect(scanFeedback({ result: "desconocido" }).title).toBe("Código desconocido");
  });
});

describe("Resultado por producto", () => {
  // Una entrega de 5: 2 mesas, 2 sillas (1 se rompe) y 1 lámpara (rechazada).
  const base = outcomeLines([
    { id: "m", name: "Mesa", qty: 2 },
    { id: "s", name: "Silla", qty: 2 },
    { id: "l", name: "Lámpara", qty: 1 },
  ]);
  const lines: OutcomeLine[] = [
    base[0]!,
    setLine(setLine(base[1]!, "delivered", 1), "damaged", 1),
    setLine(setLine(base[2]!, "delivered", 0), "rejected", 1),
  ];

  it("arranca con todo entregado y no deja pasarse de lo que lleva", () => {
    expect(base.map((l) => l.delivered)).toEqual([2, 2, 1]);
    const over = setLine(base[0]!, "damaged", 5);
    expect(over.damaged).toBe(0);
    const ok = setLine(setLine(base[0]!, "delivered", 1), "damaged", 5);
    expect(ok.damaged).toBe(1);
    expect(lineMissing(setLine(base[0]!, "delivered", 0))).toBe(2);
  });

  it("5 ítems con 1 roto y 1 rechazado: 3 entregados, merma de 1, hija con la reposición y 1 para resolver", () => {
    expect(outcomeTotals(lines)).toMatchObject({ qty: 5, delivered: 3, damaged: 1, rejected: 1, missing: 0, complete: false, anyDelivered: true });
    expect(outcomeSummary(lines)).toBe("3 entregados, 1 roto, 1 rechazado");
    const plan = outcomePlan(lines, DEFAULT_EXPEDITION_SETTINGS);
    expect(plan.damage).toEqual([{ itemId: "s", qty: 1, destination: "merma" }]);
    expect(plan.child).toEqual([{ itemId: "s", qty: 1 }]);
    expect(plan.open).toEqual([{ itemId: "l", qty: 1 }]);
    expect(plan.closes).toBe(true);
    // Dejando para revisar, la reposición también queda en Con problemas.
    const rev = outcomePlan(lines, { ...DEFAULT_EXPEDITION_SETTINGS, undelivered_action: "revisar", damaged_destination: "deposito" });
    expect(rev.child).toEqual([]);
    expect(rev.open).toEqual([{ itemId: "s", qty: 1 }, { itemId: "l", qty: 1 }]);
    expect(rev.damage[0]!.destination).toBe("deposito");
  });

  it("si no se entrega nada, la entrega vuelve entera y sólo queda la merma", () => {
    const none = base.map((l) => setLine(l, "delivered", 0));
    none[1] = setLine(none[1]!, "damaged", 1);
    const plan = outcomePlan(none, DEFAULT_EXPEDITION_SETTINGS);
    expect(plan).toEqual({ damage: [{ itemId: "s", qty: 1, destination: "merma" }], child: [], open: [], closes: false });
  });

  it("pide motivo y foto de lo roto, respeta la entrega parcial apagada y exige entregar algo en el mostrador", () => {
    const s = DEFAULT_EXPEDITION_SETTINGS;
    expect(outcomeProblem(lines, { settings: s, photos: 0, reason: null, note: "" })).toMatch(/qué le pasó/);
    expect(outcomeProblem(lines, { settings: s, photos: 0, reason: "roto", note: "" })).toMatch(/foto/);
    expect(outcomeProblem(lines, { settings: { ...s, damage_requires_photo: false }, photos: 0, reason: "roto", note: "" })).toBeNull();
    expect(outcomeProblem(lines, { settings: s, photos: 1, reason: "otro", note: "" })).toMatch(/Contá/);
    expect(outcomeProblem(lines, { settings: { ...s, allow_partial: false }, photos: 1, reason: "roto", note: "" })).toMatch(/parcial/);
    const none = base.map((l) => setLine(l, "delivered", 0));
    expect(outcomeProblem(none, { settings: s, photos: 0, reason: null, note: "", mustDeliver: true })).toMatch(/Tiene que entregarse algo/);
    expect(outcomePayload(lines)[1]).toEqual({ item_id: "s", delivered: 1, damaged: 1, rejected: 0 });
  });

  it("lo pendiente de resolver descuenta lo reprogramado y lo resuelto", () => {
    expect(itemOpenQty({ qty_damaged: 1, qty_rejected: 1, qty_missing: 1, qty_rescheduled: 1, qty_settled: 0 })).toBe(2);
    expect(itemOpenQty({ qty_damaged: 1, qty_rescheduled: 1 })).toBe(0);
    expect(itemOpenQty({})).toBe(0);
  });
});

describe("Con problemas", () => {
  const d = (x: Partial<DispatchLike>): DispatchLike => ({
    status: "pendiente",
    delivery_type: "envio",
    store_id: "A",
    fulfillment_store_id: "A",
    arrived_at: null,
    ...x,
  });

  it("la pestaña está antes de Entregados", () => {
    expect(EXPEDITION_TABS.map((t) => t.value)).toEqual(["pendientes", "armando", "listos", "en_camino", "problemas", "entregados"]);
  });

  it("junta lo parcial sin resolver (aunque esté entregado), lo no entregado, lo que espera stock y los cruces", () => {
    expect(dispatchProblems(d({ status: "entregado", issue_open: true }))).toEqual(["resultado"]);
    expect(dispatchProblems(d({ status: "listo", delivery_attempts: 1 }))).toEqual(["no_entregado"]);
    expect(dispatchProblems(d({ awaiting_transfer_id: "t1" }))).toEqual(["esperando_stock"]);
    expect(dispatchProblems(d({ status: "armando", scan_alerts: 2 }))).toEqual(["cruces"]);
    expect(dispatchHasProblem(d({ status: "entregado", scan_alerts: 3 }))).toBe(false);
    expect(dispatchHasProblem(d({ status: "cancelado", issue_open: true }))).toBe(false);
  });

  it("cuenta y lista; una entregada con problema no suma en las pestañas de estado", () => {
    const all = [d({}), d({ status: "entregado", issue_open: true }), d({ awaiting_transfer_id: "t" }), d({ status: "listo" })];
    const c = expeditionCounts(all, "A", "todos");
    expect(c).toMatchObject({ pendientes: 2, listos: 1, problemas: 2, entregados: 0 });
    expect(expeditionList(all, { tab: "problemas", storeId: "A", mode: "todos", showImmediate: false })).toHaveLength(2);
  });
});

describe("Cola offline de la app", () => {
  const detail = { route: { id: "r", status: "en_curso" as const }, stops: [{ id: "s1", status: "en_camino" as const }, { id: "s2", status: "en_camino" as const }] };
  const ev = (id: string, stopId: string, payload: Record<string, unknown>): QueuedAction => ({
    id,
    kind: "event",
    routeId: "r",
    stopId,
    eventType: "parcial",
    payload,
    media: [],
    createdAt: `2026-10-16T10:0${id}:00Z`,
    attempts: 0,
    lastError: null,
    failed: false,
  });

  it("una entrega por producto pendiente se ve parcial o no entregada", () => {
    const out = applyPending(detail, [ev("1", "s1", { any_delivered: true, complete: false }), ev("2", "s2", { any_delivered: false })]);
    expect(out.stops.map((s) => s.status)).toEqual(["parcial", "no_entregada"]);
  });

  it("los rechazos de datos de L5 no se reintentan solos", () => {
    for (const m of ["deliver_scan_incomplete", "partial_not_allowed", "damage_photo_required", "dispatch_not_in_stop", "invalid_item_qty", "item_not_in_dispatch"]) {
      expect(isPermanentEventError(new Error(m)), m).toBe(true);
    }
    expect(isPermanentEventError(new Error("Failed to fetch"))).toBe(false);
  });
});

describe("Mensajes", () => {
  it("traduce los rechazos del servidor", () => {
    expect(expeditionErrorMessage(new Error("pick_scan_incomplete"))).toMatch(/escanear lo armado/);
    expect(expeditionErrorMessage(new Error("load_scan_incomplete"))).toMatch(/carga/);
    expect(expeditionErrorMessage(new Error("stock_already_requested"))).toMatch(/traslado/);
    expect(expeditionErrorMessage(new Error("forbidden"), "Pedir stock es de un dueño o encargado.")).toBe("Pedir stock es de un dueño o encargado.");
    expect(expeditionErrorMessage({ message: "forbidden_capability", details: "capability:logistics.prepare" })).toMatch(/Armar y despachar entregas/);
  });
});

describe("Migración 20270103100000_logistica_l5_expedicion", () => {
  const sql = readFileSync(join(process.cwd(), "supabase", "migrations", "20270103100000_logistica_l5_expedicion.sql"), "utf8");
  const code = sql.replace(/--.*$/gm, "");

  it("tablas nuevas con tenant, RLS con initplan, alcance por sucursal y sin is_internal() suelto", () => {
    for (const t of ["dispatch_item_checks", "dispatch_scan_log", "dispatch_damages"]) {
      expect(sql).toContain(`alter table ${t} enable row level security;`);
      expect(sql).toContain(`create policy ${t}_branch_scope on ${t}`);
    }
    expect(code).not.toMatch(/or is_internal\(\)/i);
    expect(sql).toContain("tenant_id = (select current_tenant_id()) or (select internal_scope())");
    expect(sql).toContain("store_id = any ((select user_allowed_store_ids())::uuid[])");
    expect(sql).toContain("revoke all on dispatch_item_checks, dispatch_scan_log, dispatch_damages from anon, authenticated;");
  });

  it("el stock se mueve con las funciones existentes y no recrea la venta ni las transiciones", () => {
    expect(code).toContain("perform transfer_move_stock(p_d.tenant_id, v_store, p_item.product_id, p_item.variant_id, -p_qty, 'loss'");
    expect(code).toContain("perform warehouse_apply(p_d.tenant_id, v_wh");
    expect(code).toContain("v_tid := transfer_save(null, v_origin, v_d.store_id");
    expect(code).toContain("v_status := transfer_submit(v_tid);");
    expect(code).not.toMatch(/create or replace function (public\.)?(create_sale|pos_sale_create_fulfilled|remito_issue|_dispatch_can|dispatch_advance|dispatch_deliver|delivery_event_record|route_start|route_detail|_logistics_settings)\(/);
  });

  it("gating server-side: expedición, reparto propio y traslados; capacidad de armar", () => {
    expect(code).toContain("_dispatch_lock(");
    expect(code).toContain("_route_lock(");
    expect(code).toContain("'logistics.prepare'");
    expect(code).toContain("tenant_has_feature_for(v_tenant, 'pedidos_despacho')");
  });

  it("compuertas del escaneo obligatorio por trigger y auditoría", () => {
    expect(code).toContain("raise exception 'pick_scan_incomplete'");
    expect(code).toContain("raise exception 'load_scan_incomplete'");
    expect(code).toContain("raise exception 'deliver_scan_incomplete'");
    for (const a of ["dispatch_item_damaged", "dispatch_rescheduled", "dispatch_scan_mismatch", "dispatch_partial_delivered", "dispatch_issue_resolved", "dispatch_stock_requested", "dispatch_stock_arrived", "route_stop_items_recorded", "expedition_settings_saved"]) {
      expect(sql).toContain(`'${a}'`);
    }
  });

  it("lecturas y eventos idempotentes por el id que genera la pantalla", () => {
    expect(sql).toMatch(/create table if not exists dispatch_scan_log \(\s*id\s+uuid primary key,/);
    expect(code).toContain("'duplicate', true");
  });

  it("textos sin raya", () => {
    expect(sql).not.toContain("—");
  });
});
