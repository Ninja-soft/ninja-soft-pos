// @vitest-environment node
// =============================================================================
// Mercado Libre Full (ADR-142): cobertura y alertas, conciliación de la
// recepción, armado de etiquetas (Code 128, por unidad y por bulto, rollo y
// A4), normalización de la API de fulfillment y la sincronización con un
// fetch falso que sólo admite GET. Nunca se llama a Mercado Libre.
// =============================================================================
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CODE128_PATTERNS,
  CODE128_QUIET,
  code128Segments,
  code128Svg,
  code128Values,
  code128Width,
  isCode128B,
} from "@/lib/barcode/code128";
import {
  COVERAGE_LABELS,
  FULL_CHECKLIST,
  coverage,
  fullErrorMessage,
  isValidInventoryId,
  isValidMlInboundId,
  receptionFromMl,
  reconcileReception,
  soldInWindow,
} from "@/lib/mercadolibre/full";
import {
  FULL_LABEL_FORMATS,
  boxLabels,
  buildLabelsHtml,
  expandUnitLabels,
  labelFormat,
  labelsPerSheet,
  paginate,
  shortTitle,
} from "@/lib/mercadolibre/fullLabels";
import { createMlClient } from "@/supabase/functions/_shared/mercadolibre/client";
import {
  bucketOf,
  checkInboundReception,
  fullCostCharges,
  fullInventoryRefs,
  normalizeFullStock,
  normalizeOperation,
  opsDateRanges,
  receptionFromOps,
  syncFullAccount,
} from "@/supabase/functions/_shared/mercadolibre/full";
import { FEATURE_INFO } from "@/lib/saas/featureInfo";

// -----------------------------------------------------------------------------
describe("Code 128 (etiqueta de Full)", () => {
  it("la tabla es la estándar: 107 símbolos distintos, 11 módulos y barras pares", () => {
    expect(CODE128_PATTERNS).toHaveLength(107);
    expect(new Set(CODE128_PATTERNS).size).toBe(107);
    CODE128_PATTERNS.slice(0, 106).forEach((p) => {
      const w = [...p].map(Number);
      expect(w.reduce((a, b) => a + b, 0)).toBe(11);
      expect((w[0]! + w[2]! + w[4]!) % 2).toBe(0);
    });
    expect([...CODE128_PATTERNS[106]!].map(Number).reduce((a, b) => a + b, 0)).toBe(13);
  });

  it("checksum módulo 103 con start B", () => {
    // Ejemplo clásico: "PJJ123C" -> 104 + 48·1 + 42·2 + 42·3 + 17·4 + 18·5 + 19·6 + 35·7 = 879 -> 879 % 103 = 55.
    const v = code128Values("PJJ123C");
    expect(v[0]).toBe(104);
    expect(v.at(-2)).toBe(55);
    expect(v.at(-1)).toBe(106);
    expect(code128Values("LCQI05831")).toHaveLength(9 + 3);
  });

  it("ancho = 11 por símbolo y 13 del stop; empieza y termina en barra", () => {
    const s = code128Segments("LCQI05831");
    expect(code128Width("LCQI05831")).toBe(11 * (9 + 2) + 13); // datos + start + checksum, y el stop de 13
    expect(s[0]!.on).toBe(true);
    expect(s.at(-1)!.on).toBe(true);
  });

  it("rechaza lo que no es ASCII imprimible", () => {
    expect(isCode128B("ÑANDÚ")).toBe(false);
    expect(isCode128B("")).toBe(false);
    expect(() => code128Values("a\nb")).toThrow("code128_invalid");
  });

  it("SVG en mm con zona de silencio y el texto escapado", () => {
    const svg = code128Svg("AB<1>", { width: 46, height: 10 });
    expect(svg).toContain('width="46mm"');
    expect(svg).toContain(`viewBox="0 0 ${code128Width("AB<1>") + CODE128_QUIET * 2} 100"`);
    expect(svg).toContain("AB&lt;1&gt;");
  });
});

// -----------------------------------------------------------------------------
describe("Cobertura y alertas de quiebre", () => {
  const base = { leadDays: 7, targetDays: 30 };

  it("sin ventas no hay cobertura ni sugerencia", () => {
    expect(coverage({ ...base, available: 10, inTransit: 0, sold: 0 })).toMatchObject({ level: "no_sales", daysCover: null, suggestQty: 0 });
  });

  it("sin disponible y con ventas: quiebre", () => {
    const c = coverage({ ...base, available: 0, inTransit: 0, sold: 30 });
    expect(c.level).toBe("out");
    expect(c.suggestQty).toBe(37); // 1/día × (30 + 7)
  });

  it("menos días que la llegada de un envío: crítico", () => {
    const c = coverage({ ...base, available: 5, inTransit: 0, sold: 30 });
    expect(c).toMatchObject({ dailyAvg: 1, daysCover: 5, level: "critical", suggestQty: 32 });
  });

  it("debajo de la mitad del objetivo: bajo; lo que está en camino resta de lo sugerido", () => {
    const c = coverage({ ...base, available: 12, inTransit: 10, sold: 30 });
    expect(c.level).toBe("low");
    expect(c.daysCoverWithTransit).toBe(22);
    expect(c.suggestQty).toBe(15);
  });

  it("cubierto: no sugiere de más", () => {
    const c = coverage({ ...base, available: 60, inTransit: 0, sold: 30 });
    expect(c).toMatchObject({ level: "ok", daysCover: 60, suggestQty: 0 });
  });

  it("ventana configurable y entradas sucias", () => {
    const c = coverage({ ...base, available: -3, inTransit: Number.NaN, sold: 14, windowDays: 7 });
    expect(c.level).toBe("out");
    expect(c.dailyAvg).toBe(2);
  });

  it("ventas: las operaciones de Full mandan; si no, las órdenes", () => {
    expect(soldInWindow({ sold_30d_ops: 4, sold_30d_orders: 9 })).toEqual({ sold: 4, source: "ops" });
    expect(soldInWindow({ sold_30d_ops: null, sold_30d_orders: "3" })).toEqual({ sold: 3, source: "orders" });
    expect(soldInWindow({ sold_30d_ops: null, sold_30d_orders: null })).toEqual({ sold: 0, source: "none" });
  });

  it("todas las alertas tienen texto", () => {
    for (const k of ["out", "critical", "low", "ok", "no_sales"] as const) expect(COVERAGE_LABELS[k].label).toBeTruthy();
  });
});

// -----------------------------------------------------------------------------
describe("Conciliación de la recepción (mismo criterio que la RPC)", () => {
  it("todo recibido: se cierra como recibido", () => {
    const r = reconcileReception([{ id: "a", title: "Remera", sent: 10, received: 10, damaged: 0 }]);
    expect(r).toMatchObject({ closeStatus: "received", canClose: true, canSave: true });
    expect(r.totals.missing).toBe(0);
  });

  it("faltante exige qué pasó y motivo", () => {
    const r = reconcileReception([{ id: "a", title: "Remera", sent: 10, received: 8, damaged: 1 }]);
    expect(r.lines[0]).toMatchObject({ missing: 1, issues: ["missing_action", "missing_reason"] });
    expect(r.canClose).toBe(false);
    expect(r.canSave).toBe(true);
    const ok = reconcileReception([
      { id: "a", title: "Remera", sent: 10, received: 8, damaged: 1, missingAction: "returned", missingReason: "Quedó en el depósito" },
      { id: "b", title: "Gorra", sent: 3, received: 2, damaged: 0, missingAction: "lost", missingReason: "Bulto roto" },
    ]);
    expect(ok).toMatchObject({ canClose: true, closeStatus: "closed_with_diff" });
    expect(ok.totals).toEqual({ sent: 13, received: 10, damaged: 1, missing: 2, returned: 1, lost: 1 });
  });

  it("dañado sin faltante también es diferencia", () => {
    const r = reconcileReception([{ id: "a", title: "Taza", sent: 4, received: 3, damaged: 1 }]);
    expect(r).toMatchObject({ closeStatus: "closed_with_diff", canClose: true });
  });

  it("recibido + dañado > enviado o negativos: no se guarda", () => {
    expect(reconcileReception([{ id: "a", title: "x", sent: 2, received: 2, damaged: 1 }])).toMatchObject({ canSave: false, canClose: false });
    expect(reconcileReception([{ id: "a", title: "x", sent: 2, received: -1, damaged: 0 }]).lines[0]!.issues).toContain("negative");
  });

  it("la sugerencia de ML nunca supera lo enviado", () => {
    expect(receptionFromMl([{ id: "a", sent: 5, ml_received: 9, ml_damaged: 2 }])).toEqual([{ id: "a", received: 3, damaged: 2 }]);
    expect(receptionFromMl([{ id: "b", sent: 5, ml_received: null, ml_damaged: null }])).toEqual([{ id: "b", received: 0, damaged: 0 }]);
  });
});

// -----------------------------------------------------------------------------
describe("Etiquetas de Full", () => {
  it("una etiqueta por unidad; sin código de inventario no se imprime", () => {
    const r = expandUnitLabels([
      { inventory_id: "lcqi05831", title: "Remera", variation_label: "Rojo / M", sku: "REM", qty: 3 },
      { inventory_id: null, title: "Gorra", qty: 2 },
      { inventory_id: "ABCD12345", title: "Taza", qty: 0 },
    ]);
    expect(r.labels).toHaveLength(3);
    expect(r.labels[0]).toEqual({ inventoryId: "LCQI05831", title: "Remera", variation: "Rojo / M", sku: "REM" });
    expect(r.skipped).toEqual(["Gorra"]);
    expect(r.truncated).toBe(false);
  });

  it("tope de 5.000 por impresión", () => {
    const r = expandUnitLabels([{ inventory_id: "ABCD12345", title: "x", qty: 6000 }]);
    expect(r.labels).toHaveLength(5000);
    expect(r.truncated).toBe(true);
  });

  it("bultos numerados i de N", () => {
    const b = boxLabels({ mlInboundId: "77001", account: "TIENDA", origin: "Central", number: 4, date: "15/10/2026" }, 3);
    expect(b.map((x) => `${x.index}/${x.total}`)).toEqual(["1/3", "2/3", "3/3"]);
  });

  it("formatos: rollo una por hoja, A4 con grilla que entra en la hoja", () => {
    expect(labelsPerSheet(FULL_LABEL_FORMATS.thermal_50x25)).toBe(1);
    expect(labelsPerSheet(FULL_LABEL_FORMATS.a4_44)).toBe(44);
    expect(labelsPerSheet(FULL_LABEL_FORMATS.a4_65)).toBe(65);
    for (const f of Object.values(FULL_LABEL_FORMATS)) {
      if (f.kind !== "a4") continue;
      const right = (f.marginLeft ?? 0) + f.cols! * f.width + (f.cols! - 1) * (f.gapX ?? 0);
      const bottom = (f.marginTop ?? 0) + f.rows! * f.height + (f.rows! - 1) * (f.gapY ?? 0);
      expect(right).toBeLessThanOrEqual(210);
      expect(bottom).toBeLessThanOrEqual(297);
    }
    expect(labelFormat("cualquiera").key).toBe("thermal_50x25");
    expect(paginate([1, 2, 3, 4, 5], FULL_LABEL_FORMATS.a4_44)).toHaveLength(1);
    expect(paginate(Array.from({ length: 45 }, (_, i) => i), FULL_LABEL_FORMATS.a4_44)).toHaveLength(2);
  });

  it("HTML de rollo 50 x 25 mm: página del tamaño de la etiqueta, código y texto", () => {
    const { labels } = expandUnitLabels([{ inventory_id: "LCQI05831", title: "Remera <básica>", qty: 2 }]);
    const html = buildLabelsHtml({ kind: "units", labels }, FULL_LABEL_FORMATS.thermal_50x25);
    expect(html).toContain("@page{size:50mm 25mm;margin:0}");
    expect(html.match(/class="sheet"/g)).toHaveLength(2);
    expect(html).toContain("LCQI05831");
    expect(html).toContain("Remera &lt;básica&gt;");
    expect(html).not.toContain("<básica>");
  });

  it("HTML A4: grilla posicionada en mm", () => {
    const { labels } = expandUnitLabels([{ inventory_id: "LCQI05831", title: "Remera", qty: 5 }]);
    const html = buildLabelsHtml({ kind: "units", labels }, FULL_LABEL_FORMATS.a4_44);
    expect(html).toContain("@page{size:210mm 297mm;margin:0}");
    expect(html.match(/class="cell"/g)).toHaveLength(5);
    expect(html).toContain("left:56.5mm;top:8.8mm"); // segunda columna
  });

  it("bultos con el número del envío de ML", () => {
    const html = buildLabelsHtml(
      { kind: "boxes", labels: boxLabels({ mlInboundId: "77001", account: "TIENDA", origin: "Central", number: 4, date: "15/10/2026" }, 2) },
      FULL_LABEL_FORMATS.thermal_100x50,
    );
    expect(html).toContain("Bulto 2 de 2");
    expect(html).toContain("ML 77001");
  });

  it("título largo se acorta según el tamaño", () => {
    const t = shortTitle("x".repeat(200), FULL_LABEL_FORMATS.thermal_50x25);
    expect(t.length).toBeLessThanOrEqual(75);
    expect(t.endsWith("…")).toBe(true);
  });
});

// -----------------------------------------------------------------------------
describe("API de fulfillment (normalización)", () => {
  it("motivos de no disponible con los dos nombres de la doc", () => {
    expect(bucketOf("damage")).toBe("damaged");
    expect(bucketOf("damaged")).toBe("damaged");
    expect(bucketOf("noFiscalCoverage")).toBe("no_fiscal_coverage");
    expect(bucketOf("no_fiscal_coverage")).toBe("no_fiscal_coverage");
    expect(bucketOf("not_supported")).toBe("not_supported");
    expect(bucketOf("internal_process")).toBe("internal_process");
    expect(bucketOf("algo_nuevo")).toBe("other");
  });

  it("stock de un inventario (ejemplo de la doc)", () => {
    const row = normalizeFullStock(
      {
        inventory_id: "LCQI05831",
        total: 20,
        available_quantity: 5,
        not_available_quantity: 15,
        not_available_detail: [
          { status: "damage", quantity: 2, conditions: [{ condition: "arrived_damaged", quantity: 2 }] },
          { status: "lost", quantity: 1 },
          { status: "noFiscalCoverage", quantity: 5 },
          { status: "withdrawal", quantity: 5 },
          { status: "internal_process", quantity: 1 },
          { status: "transfer", quantity: 1 },
        ],
        external_references: [{ type: "item", id: "MLA1557246024", variation_id: 4742223403 }],
      },
      { ml_item_id: null, ml_variation_id: null, title: "Remera", variation_label: null, item_status: "active" },
    );
    expect(row).toMatchObject({ inventory_id: "LCQI05831", total: 20, available_quantity: 5, not_available_quantity: 15, ml_item_id: "MLA1557246024", ml_variation_id: "4742223403" });
    expect(row.buckets).toMatchObject({ damaged: 2, lost: 1, no_fiscal_coverage: 5, withdrawal: 5, internal_process: 1, transfer: 1, other: 0 });
    expect(row.conditions).toEqual([{ status: "damaged", condition: "arrived_damaged", quantity: 2 }]);
  });

  it("no disponible sin detalle va a otro motivo", () => {
    const row = normalizeFullStock({ inventory_id: "ABCD12345", available_quantity: 1, not_available_quantity: 3 }, { ml_item_id: "MLA1", ml_variation_id: null, title: "", variation_label: null, item_status: null });
    expect(row.buckets.other).toBe(3);
    expect(row.total).toBe(4);
  });

  it("inventory_id por variación (o el de la publicación)", () => {
    const refs = fullInventoryRefs({
      id: "MLA1",
      title: "Remera",
      status: "active",
      inventory_id: "ITEM00001",
      variations: [
        { id: 11, inventory_id: "VARA00001", attribute_combinations: [{ id: "COLOR", name: "Color", value_name: "Rojo" }] },
        { id: 12, inventory_id: "VARA00001" },
        { id: 13, inventory_id: null },
      ] as never,
    });
    expect(refs).toEqual([{ inventory_id: "VARA00001", ml_item_id: "MLA1", ml_variation_id: "11", title: "Remera", variation_label: "Rojo", item_status: "active" }]);
    expect(fullInventoryRefs({ id: "MLA2", title: "Taza", status: "active", inventory_id: "taza00001", variations: [] })[0]!.inventory_id).toBe("TAZA00001");
  });

  it("operaciones y recepción por inbound_id", () => {
    const ops = [
      { id: 1, inventory_id: "DEHW09303", date_created: "2026-10-01T10:00:00Z", type: "INBOUND_RECEPTION", detail: { available_quantity: 8, not_available_detail: [{ status: "damaged", quantity: 1 }] }, external_references: [{ type: "inbound_id", value: "0001" }] },
      { id: 2, inventory_id: "DEHW09303", date_created: "2026-10-02T10:00:00Z", type: "INBOUND_RECEPTION", detail: { available_quantity: 1 }, external_references: [{ type: "inbound_id", value: "0001" }] },
      { id: 3, inventory_id: "DEHW09303", date_created: "2026-10-02T10:00:00Z", type: "INBOUND_RECEPTION", detail: { available_quantity: 50 }, external_references: [{ type: "inbound_id", value: "0002" }] },
      { id: 4, inventory_id: "DEHW09303", date_created: "2026-10-03T10:00:00Z", type: "SALE_CONFIRMATION", detail: { available_quantity: -1 }, external_references: [{ type: "shipment_id", value: "28312961122" }] },
    ];
    expect(receptionFromOps(ops, "0001")).toEqual([{ inventory_id: "DEHW09303", received: 9, damaged: 1 }]);
    expect(normalizeOperation(ops[3]!)).toMatchObject({ operation_id: "4", type: "sale_confirmation", delta_available: -1, shipment_ref: "28312961122", inbound_ref: null });
    expect(normalizeOperation({ id: 9 } as never)).toBeNull();
  });

  it("costos: sólo los cargos de Full del resumen", () => {
    const c = fullCostCharges({
      bill_includes: {
        charges: [
          { label: "Cargo por venta", amount: 100, type: "CV" },
          { label: "Cargo por almacenamiento en Full", amount: 50.5, type: "CFS" },
          { label: "Tarifa de stock antiguo", amount: 3, type: "X" },
          { label: "Cargo por retiro de stock", amount: 7, type: "CRS" },
        ],
      },
    });
    expect(c.map((x) => x.amount)).toEqual([50.5, 3, 7]);
    expect(fullCostCharges(null)).toEqual([]);
  });

  it("rangos de 60 días como máximo", () => {
    const r = opsDateRanges(90, new Date("2026-10-15T12:00:00Z"));
    expect(r).toEqual([
      { from: "2026-08-17", to: "2026-10-15" },
      { from: "2026-07-18", to: "2026-08-16" },
    ]);
  });
});

// -----------------------------------------------------------------------------
describe("Sincronización (fetch falso: sólo GET)", () => {
  function fakeMl(routes: Array<[RegExp, unknown]>) {
    const calls: Array<{ method: string; url: string }> = [];
    const fetch = async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url });
      if (method !== "GET") throw new Error(`solo GET: ${method} ${url}`);
      const path = new URL(url).pathname + new URL(url).search;
      const hit = routes.find(([re]) => re.test(path));
      if (!hit) return new Response(JSON.stringify({ message: "not_found" }), { status: 404 });
      return new Response(JSON.stringify(hit[1]), { status: 200, headers: { "content-type": "application/json" } });
    };
    return { calls, client: createMlClient({ fetch, getToken: async () => "T" }) };
  }

  it("publicaciones en Full -> stock por inventario -> operaciones", async () => {
    const ml = fakeMl([
      [/\/users\/1001\/items\/search/, { results: ["MLA1", "MLA2"], scroll_id: null }],
      [/^\/items\?ids=/, [
        { code: 200, body: { id: "MLA1", title: "Remera", status: "active", inventory_id: "LCQI05831", variations: [] } },
        { code: 200, body: { id: "MLA2", title: "Gorra", status: "active", inventory_id: "ABCD12345", variations: [] } },
      ]],
      [/\/inventories\/LCQI05831\/stock\/fulfillment\?include_attributes=conditions/, { inventory_id: "LCQI05831", total: 3, available_quantity: 3, not_available_quantity: 0 }],
      [/\/stock\/fulfillment\/operations\/search/, { results: [{ id: 7, inventory_id: "LCQI05831", date_created: "2026-10-10T00:00:00Z", type: "SALE_CONFIRMATION", detail: { available_quantity: -1 } }] }],
    ]);
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const rpc = async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return fn === "ml_full_ops_save" ? 1 : { ok: true };
    };
    const r = await syncFullAccount({ rpc, client: ml.client, now: () => Date.parse("2026-10-15T12:00:00Z") }, { id: "acc", ml_user_id: 1001 }, ["MLA1"]);
    expect(r).toMatchObject({ items: 2, inventories: 2, errors: 1, partial: false });
    expect(ml.calls.every((c) => c.method === "GET")).toBe(true);
    const ups = calls.filter((c) => c.fn === "ml_full_inventory_upsert");
    // Con un error de lectura no se da de baja nada (complete sólo sin errores).
    expect(ups).toHaveLength(1);
    const rows = (ups[0]!.args.p as { rows: Array<{ inventory_id: string; error: string | null; available_quantity: number }> }).rows;
    expect(rows.find((x) => x.inventory_id === "LCQI05831")!.available_quantity).toBe(3);
    expect(rows.find((x) => x.inventory_id === "ABCD12345")!.error).toBeTruthy();
    expect(calls.some((c) => c.fn === "ml_full_ops_save")).toBe(true);
    expect(ml.calls.some((c) => c.url.includes("logistic_type=fulfillment"))).toBe(true);
  });

  it("sin errores, la lista completa da de baja lo que ya no está en Full", async () => {
    const ml = fakeMl([
      [/\/users\/1001\/items\/search/, { results: ["MLA1"] }],
      [/^\/items\?ids=/, [{ code: 200, body: { id: "MLA1", title: "Remera", status: "active", inventory_id: "LCQI05831" } }]],
      [/\/inventories\/LCQI05831\/stock\/fulfillment/, { inventory_id: "LCQI05831", available_quantity: 1 }],
      [/\/stock\/fulfillment\/operations\/search/, { results: [] }],
    ]);
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    await syncFullAccount({ rpc: async (fn, args) => void calls.push({ fn, args }), client: ml.client }, { id: "acc", ml_user_id: 1001 }, []);
    const last = calls.filter((c) => c.fn === "ml_full_inventory_upsert").at(-1)!;
    expect(last.args.p).toEqual({ rows: [], complete: true, keep_ids: ["LCQI05831"] });
  });

  it("cortado por tiempo: parcial y sin bajas", async () => {
    const ml = fakeMl([
      [/\/users\/1001\/items\/search/, { results: ["MLA1"] }],
      [/^\/items\?ids=/, [{ code: 200, body: { id: "MLA1", title: "Remera", status: "active", inventory_id: "LCQI05831" } }]],
    ]);
    let t = 0;
    const calls: string[] = [];
    const r = await syncFullAccount(
      { rpc: async (fn) => void calls.push(fn), client: ml.client, now: () => (t += 1000), deadline: 2500 },
      { id: "acc", ml_user_id: 1001 },
      [],
    );
    expect(r.partial).toBe(true);
    expect(calls).not.toContain("ml_full_ops_save");
  });

  it("recepción de un envío abierto", async () => {
    const ml = fakeMl([
      [/\/stock\/fulfillment\/operations\/search.*type=INBOUND_RECEPTION/, {
        results: [{ id: 1, inventory_id: "LCQI05831", date_created: "2026-10-12T00:00:00Z", type: "INBOUND_RECEPTION", detail: { available_quantity: 8 }, external_references: [{ type: "inbound_id", value: "77001" }] }],
      }],
    ]);
    const saved: unknown[] = [];
    const lines = await checkInboundReception(
      { rpc: async (_fn, args) => void saved.push(args), client: ml.client, now: () => Date.parse("2026-10-15T12:00:00Z") },
      { id: "acc", ml_user_id: 1001 },
      { id: "ib", ml_inbound_id: "77001", dispatched_at: "2026-10-10T12:00:00Z", inventory_ids: ["LCQI05831"] },
    );
    expect(lines).toEqual([{ inventory_id: "LCQI05831", received: 8, damaged: 0 }]);
    expect(saved[0]).toMatchObject({ p_inbound: "ib" });
  });
});

// -----------------------------------------------------------------------------
describe("Textos, errores y plan", () => {
  it("validaciones de códigos", () => {
    expect(isValidMlInboundId("77001")).toBe(true);
    expect(isValidMlInboundId("77 001")).toBe(false);
    expect(isValidInventoryId("LCQI05831")).toBe(true);
    expect(isValidInventoryId("lcqi05831")).toBe(false);
  });

  it("errores del servidor en castellano", () => {
    expect(fullErrorMessage(new Error("not_full_enabled: Taza"))).toContain("«Taza» no está habilitado para Full");
    expect(fullErrorMessage(new Error("feature_not_in_plan: mercadolibre_full"))).toBe("Tu plan no incluye Mercado Libre Full.");
    expect(fullErrorMessage(new Error("insufficient_stock"))).toContain("No alcanza el stock propio");
  });

  it("checklist completo y copy sin guiones largos", () => {
    expect(FULL_CHECKLIST.map((s) => s.key)).toEqual(["enable", "plan", "draft", "ml", "labels", "dispatch", "receive", "sell"]);
    const all = JSON.stringify(FULL_CHECKLIST) + JSON.stringify(FEATURE_INFO.mercadolibre_full);
    expect(all).not.toMatch(/—/);
  });

  it("feature OPTIONAL con copy, plan y dependencia; gating en el servidor", () => {
    expect(FEATURE_INFO.mercadolibre_full).toMatchObject({ minPlan: "Business", requires: ["mercadolibre"] });
    const dir = join(process.cwd(), "supabase", "migrations");
    const feat = readFileSync(join(dir, "20261209100000_features_mercadolibre_full.sql"), "utf8");
    expect(feat).toMatch(/'mercadolibre_full'[\s\S]*'integraciones', false/);
    const sql = readFileSync(join(dir, "20261209100100_mercadolibre_full.sql"), "utf8").replace(/--.*$/gm, "");
    expect(sql).toContain("tenant_has_feature_for(v_tenant, 'mercadolibre_full')");
    expect(sql).not.toMatch(/or\s+is_internal\(\)/i);
    // Policies siempre con initplan.
    expect(sql).not.toMatch(/using \(tenant_id = current_tenant_id\(\)/);
  });
});
