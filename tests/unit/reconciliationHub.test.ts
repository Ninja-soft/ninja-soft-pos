import { describe, it, expect } from "vitest";
import type { SettlementLineRow } from "@/lib/reports/processorReconciliation";
import type { PaymentDisputeRow } from "@/lib/reports/paymentDisputes";
import { groupCardRows, summarizeCardRows, type CardRecRow } from "@/lib/reports/cardReconciliation";
import {
  buildConciliacionSheets,
  buildInbox,
  bulkPlan,
  conciliacionFileName,
  filterLinesByStore,
  hubKpis,
  inboxGroups,
  moneyByDay,
  providerCards,
  releaseCalendar,
  statusSegments,
} from "@/lib/reports/reconciliationHub";
import { buildWorkbook } from "@/lib/utils/xlsxWorkbook";

const NOW = new Date(2026, 9, 12, 10, 0); // lunes 12/10/2026 10:00 local

let seq = 0;
function line(p: Partial<SettlementLineRow> = {}): SettlementLineRow {
  seq++;
  return {
    id: `l${seq}`,
    provider_key: "mercadopago",
    scope_store_id: null,
    external_id: `ext${seq}`,
    order_id: null,
    external_reference: null,
    kind: "payment",
    status: "approved",
    operation_at: new Date(2026, 9, 10, 12).toISOString(),
    release_date: null,
    released: true,
    gross: 1000,
    fee: 50,
    taxes: 10,
    net: 940,
    refunded: 0,
    payment_method: null,
    payment_type: null,
    card_brand: "Visa",
    last4: "1234",
    installments: 1,
    lote: null,
    cupon: null,
    autorizacion: null,
    comercio: null,
    terminal: null,
    description: null,
    payer: null,
    fee_detail: [],
    payment_id: "p",
    intent_id: null,
    sale_id: `s${seq}`,
    match_status: "matched",
    match_method: "provider_id",
    diff_amount: 0,
    review_note: null,
    reviewed_at: null,
    ...p,
  };
}

function dispute(p: Partial<PaymentDisputeRow> = {}): PaymentDisputeRow {
  return {
    id: "d1",
    provider_key: "mercadopago",
    kind: "chargeback",
    provider_payment_id: "ext-x",
    provider_case_id: "case1",
    payment_id: null,
    sale_id: null,
    settlement_line_id: null,
    amount: 700,
    currency: "ARS",
    status: "open",
    provider_status: null,
    provider_status_detail: null,
    reason: null,
    refund_source: null,
    origin: "provider",
    documentation_status: "pending",
    documentation_deadline: new Date(2026, 9, 13, 12).toISOString(),
    coverage_applied: null,
    coverage_eligible: null,
    occurred_at: new Date(2026, 9, 8).toISOString(),
    first_seen_at: new Date(2026, 9, 8).toISOString(),
    resolved_at: null,
    acknowledged_at: null,
    ...p,
  };
}

function card(p: Partial<CardRecRow> = {}): CardRecRow {
  seq++;
  return {
    id: `c${seq}`,
    createdAt: "2026-10-10T15:00:00.000Z",
    day: "2026-10-10",
    ticket: 10,
    kind: "credit",
    brandKey: "visa",
    brandLabel: "Visa",
    installments: 1,
    lote: "12",
    cupon: "1",
    autorizacion: "A1",
    ultimos4: "1111",
    comercio: "999",
    adquirente: "payway",
    amount: 100,
    reference: null,
    reconciledAt: null,
    shiftOpenedBy: null,
    ...p,
  };
}

const pending = (p: Partial<SettlementLineRow> = {}) =>
  line({ released: false, release_date: new Date(2026, 9, 14, 9).toISOString(), ...p });

describe("filterLinesByStore", () => {
  const a = line({ scope_store_id: "A", sale_id: null });
  const b = line({ scope_store_id: null, sale_id: "sB" });
  const c = line({ scope_store_id: null, sale_id: null });
  const store = (id: string | null) => (id === "sB" ? "B" : null);
  it("sin sucursal devuelve todo", () => {
    expect(filterLinesByStore([a, b, c], null, store)).toHaveLength(3);
  });
  it("con sucursal toma la credencial o la venta de esa sucursal", () => {
    expect(filterLinesByStore([a, b, c], "A", store)).toEqual([a]);
    expect(filterLinesByStore([a, b, c], "B", store)).toEqual([b]);
  });
});

describe("tarjetas por procesador y resumen", () => {
  const lines = [
    line({ provider_key: "mercadopago" }),
    line({ provider_key: "mercadopago", match_status: "missing_in_pos", sale_id: null }),
    pending({ provider_key: "payway", gross: 2000, fee: 100, taxes: 0, net: 1900 }),
  ];
  const unmatched = [{ payment_id: "x", sale_id: "sx", intent_id: null, provider_key: "payway", amount: 300, created_at: NOW.toISOString(), provider: "payway" }];
  const cards = providerCards(lines, unmatched, new Map(), NOW);

  it("arma una tarjeta por procesador del catálogo, con o sin datos", () => {
    expect(cards.map((c) => c.key)).toContain("transfer");
    expect(cards.find((c) => c.key === "nave")?.hasData).toBe(false);
    const mp = cards.find((c) => c.key === "mercadopago")!;
    expect(mp.hasData).toBe(true);
    expect(mp.summary.count).toBe(2);
    expect(mp.toReview).toBe(1);
    expect(mp.pct).toBe(50);
  });

  it("los segmentos de estado no incluyen los vacíos", () => {
    const pw = cards.find((c) => c.key === "payway")!;
    expect(pw.segments.map((s) => s.key)).toEqual(["matched", "pos_only"]);
    expect(statusSegments({ counts: { matched: 0, amount_diff: 0, missing_in_pos: 0, ignored: 0, pos_only: 0 }, amounts: { matched: 0, amount_diff: 0, missing_in_pos: 0, ignored: 0, pos_only: 0 } })).toEqual([]);
  });

  it("suma el resumen del período y la próxima acreditación", () => {
    const k = hubKpis(cards);
    expect(k.sold).toBe(4000);
    expect(k.charged).toBe(220);
    expect(k.released).toBe(1880);
    expect(k.pending).toBe(1900);
    expect(k.nextRelease).toBe(new Date(2026, 9, 14, 9).toISOString());
    expect(k.providers).toBe(2);
    expect(k.toReview).toBe(2);
  });

  it("usa las disputas abiertas de otros períodos como plata en riesgo", () => {
    const k = hubKpis(cards, [dispute(), dispute({ id: "d2", kind: "refund", amount: 99 })]);
    expect(k.atRisk).toBe(700);
    expect(k.riskCount).toBe(1);
  });
});

describe("gráficos y calendario", () => {
  const lines = [
    line({ operation_at: new Date(2026, 9, 9, 10).toISOString() }),
    pending({ operation_at: new Date(2026, 9, 10, 10).toISOString(), provider_key: "payway", net: 500, fee: 30, taxes: 0, gross: 530 }),
    pending({ release_date: new Date(2026, 10, 30).toISOString(), net: 200 }),
    pending({ release_date: null, net: 100 }),
  ];

  it("moneyByDay separa acreditado, por acreditar y comisiones por día de operación", () => {
    const s = moneyByDay(lines, new Map(), NOW);
    expect(s.labels).toEqual(["09/10", "10/10"]);
    expect(s.released).toEqual([940, 0]);
    expect(s.pending[1]).toBe(800);
    expect(s.charged[0]).toBe(60);
  });

  it("releaseCalendar arranca hoy, ubica cada acreditación y separa lo de después y lo sin fecha", () => {
    const cal = releaseCalendar(lines, new Map(), NOW, 14);
    expect(cal.days).toHaveLength(14);
    expect(cal.days[0]).toMatchObject({ day: "2026-10-12", isToday: true });
    const wed = cal.days.find((d) => d.day === "2026-10-14")!;
    expect(wed.amount).toBe(500);
    expect(wed.providers).toEqual([{ key: "payway", amount: 500 }]);
    expect(cal.later).toBe(200);
    expect(cal.laterCount).toBe(1);
    expect(cal.undated).toBe(100);
  });
});

describe("bandeja de pendientes", () => {
  const lines = [
    line({ match_status: "missing_in_pos", sale_id: null }),
    line({ match_status: "amount_diff", diff_amount: 50 }),
    line({ match_status: "matched" }),
  ];
  const groups = groupCardRows([
    card({ day: "2026-10-10" }),
    card({ day: "2026-10-10", reconciledAt: "2026-10-11T00:00:00Z" }),
    card({ day: "2026-10-12", lote: "13" }),
  ]);
  const items = buildInbox({
    lines,
    unmatched: [{ payment_id: "p9", sale_id: "s9", intent_id: null, provider_key: "payway", amount: 300, created_at: NOW.toISOString(), provider: "payway" }],
    disputes: [dispute(), dispute({ id: "d3", kind: "refund", status: "refunded", resolved_at: NOW.toISOString(), acknowledged_at: NOW.toISOString() })],
    cardGroups: groups,
    canReconcileCards: true,
    canResolveLines: true,
    now: NOW,
  });

  it("junta cada tipo en orden (disputas primero) y salta lo resuelto y visto", () => {
    expect(items.map((i) => i.kind)).toEqual(["dispute", "missing_in_pos", "pos_only", "amount_diff", "card_batch"]);
  });

  it("el contracargo con plazo de 2 días o menos queda urgente", () => {
    expect(items[0]!.urgent).toBe(true);
    expect(items[0]!.canReview).toBe(true);
  });

  it("los lotes de hoy no entran; los viejos sólo con sus cobros pendientes", () => {
    const b = items.find((i) => i.kind === "card_batch")!;
    expect(b.paymentIds).toHaveLength(1);
    expect(b.amount).toBe(100);
    expect(b.canReconcile).toBe(true);
  });

  it("sin permiso para resolver, las líneas no se pueden marcar en lote", () => {
    const ro = buildInbox({ lines, unmatched: [], disputes: [], cardGroups: [], canReconcileCards: false, canResolveLines: false, now: NOW });
    expect(ro.every((i) => !i.canReview && !i.canReconcile)).toBe(true);
  });

  it("bulkPlan separa qué se concilia y qué se marca revisado", () => {
    const all = new Set(items.map((i) => i.id));
    const plan = bulkPlan(items, all);
    expect(plan.reconcile).toHaveLength(1);
    expect(plan.paymentIds).toHaveLength(1);
    expect(plan.reviewLines).toHaveLength(2);
    expect(plan.ackDisputes).toHaveLength(1);
    expect(plan.chosen).toHaveLength(5);
  });

  it("inboxGroups suma por tipo", () => {
    const g = inboxGroups(items);
    expect(g.map((x) => x.kind)).toEqual(["dispute", "missing_in_pos", "pos_only", "amount_diff", "card_batch"]);
    expect(g.find((x) => x.kind === "pos_only")!.amount).toBe(300);
  });
});

describe("Excel de la conciliación", () => {
  it("nombre de archivo con negocio, período y sucursal", () => {
    expect(conciliacionFileName({ negocio: "Kiosco Ñandú", from: "2026-10-01", to: "2026-10-12", branch: "Centro" })).toBe(
      "conciliacion_kiosco-nandu_2026-10-01_al_2026-10-12_centro.xlsx",
    );
    expect(conciliacionFileName({ negocio: null, from: "2026-10-12", to: "2026-10-12" })).toBe("conciliacion_2026-10-12.xlsx");
  });

  it("arma todas las hojas y el workbook se construye", () => {
    const lines = [line(), pending({ provider_key: "payway", match_status: "missing_in_pos", sale_id: null })];
    const cards = providerCards(lines, [], new Map(), NOW);
    const rows = [card({ day: "2026-10-10" }), card({ day: "2026-10-10", reconciledAt: "x" })];
    const inbox = buildInbox({ lines, unmatched: [], disputes: [dispute()], cardGroups: groupCardRows(rows), canReconcileCards: true, canResolveLines: true, now: NOW });
    const sheets = buildConciliacionSheets({
      negocio: "Mi negocio",
      periodLabel: "01/10/2026 al 12/10/2026",
      scopeLabel: null,
      processors: { cards, kpis: hubKpis(cards), lines, index: new Map(), calendar: releaseCalendar(lines, new Map(), NOW), ticket: () => "" },
      cards: { groups: groupCardRows(rows), summary: summarizeCardRows(rows) },
      inbox,
      disputes: [dispute()],
      ticket: () => "",
      now: NOW,
    });
    expect(sheets.map((s) => s.name)).toEqual([
      "Resumen",
      "Por procesador",
      "Detalle de cobros",
      "Por lote",
      "Cupones",
      "Pendientes",
      "Disputas",
    ]);
    const resumen = sheets[0]!;
    expect(resumen.subtitle).toBe("Mi negocio · 01/10/2026 al 12/10/2026");
    expect(resumen.sections!.map((s) => s.title)).toContain("Resumen del período");
    const lote = sheets.find((s) => s.name === "Por lote")!;
    expect(lote.rows[0]).toMatchObject({ estado: "Parcial", conciliado: 100, pendiente: 100 });
    const detalle = sheets.find((s) => s.name === "Detalle de cobros")!;
    expect(detalle.columns.find((c) => c.key === "estado")?.status?.["Cobro sin venta"]).toBeTruthy();

    const wb = buildWorkbook(sheets);
    expect(wb.worksheets.map((w) => w.name)).toEqual(sheets.map((s) => s.name));
    const ws = wb.getWorksheet("Por procesador")!;
    expect(ws.getCell(3, 1).value).toBe("Procesador");
  });

  it("sin procesadores sólo van las hojas de tarjetas", () => {
    const rows = [card()];
    const sheets = buildConciliacionSheets({
      negocio: null,
      periodLabel: "x",
      scopeLabel: null,
      processors: null,
      cards: { groups: groupCardRows(rows), summary: summarizeCardRows(rows) },
      inbox: [],
      disputes: [],
      ticket: () => "",
    });
    expect(sheets.map((s) => s.name)).toEqual(["Resumen", "Por lote", "Cupones"]);
  });
});
