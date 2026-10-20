// F24 · H161 (ADR-174): costo en la venta y reportes de gestión.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deadBucket, deltaPct, marginPct, monthLabel, rangeToInstants, stockReasonLabel, ymd } from "@/lib/reports/gestion";

const SQL = readFileSync(join(process.cwd(), "supabase/migrations/20270112100000_h161_costo_gestion.sql"), "utf8");

describe("Costo en la venta (migración)", () => {
  it("guarda el costo al vender y lo usan el CMV, la devolución y el comparativo", () => {
    expect(SQL).toMatch(/create trigger sale_item_unit_cost\s+before insert on public\.sale_items/);
    expect(SQL).toMatch(/coalesce\(si\.unit_cost, pr\.cost, 0\)\), 0\), 2\) into v_cost\s+from sale_items si/);
    expect(SQL).toMatch(/coalesce\(si\.unit_cost, pr\.cost, 0\)\), 0\), 2\) into v_cost\s+from sale_return_items ri/);
    expect(SQL).toMatch(/sum\(si\.quantity \* coalesce\(si\.unit_cost, pr\.cost\)\)/);
    // El histórico se marca como aproximado.
    expect(SQL).toMatch(/set unit_cost = p\.cost, cost_source = 'backfill'/);
  });

  it("los reportes controlan permiso y plan en el servidor", () => {
    expect(SQL).toMatch(/report_collections[\s\S]*?_report_guard\('reports\.view'\)/);
    expect(SQL).toMatch(/report_stock_movements[\s\S]*?_report_guard\('stock\.view'\)/);
    expect(SQL).toMatch(/report_dead_stock[\s\S]*?_report_guard\('reports\.view', 'metricas_avanzadas'\)/);
    expect(SQL).toMatch(/report_profitability[\s\S]*?_report_guard\('reports\.costs', 'metricas_avanzadas'\)/);
    expect(SQL.match(/report_store_filter\(p_store_id\)/g)?.length).toBeGreaterThanOrEqual(4);
  });
});

describe("Helpers de Gestión", () => {
  it("variación y margen", () => {
    expect(deltaPct(120, 100)).toBe(20);
    expect(deltaPct(80, 100)).toBe(-20);
    expect(deltaPct(10, 0)).toBeNull();
    expect(deltaPct(10, null)).toBeNull();
    expect(marginPct(30, 100)).toBe(30);
    expect(marginPct(30, 0)).toBeNull();
  });

  it("etiquetas", () => {
    expect(monthLabel("2026-10")).toBe("octubre 2026");
    expect(stockReasonLabel("sale_void")).toBe("Anulación de venta");
    expect(stockReasonLabel("otra_cosa")).toBe("otra cosa");
    expect(deadBucket(null)).toBe("nunca");
    expect(deadBucket(400)).toBe("365+");
    expect(deadBucket(100)).toBe("90+");
    expect(deadBucket(10)).toBe("menos");
  });

  it("rango a instantes y fecha local", () => {
    const r = rangeToInstants(new Date(2026, 9, 1, 15), new Date(2026, 9, 20, 9))!;
    expect(new Date(r.from).getDate()).toBe(1);
    expect(new Date(r.to).getDate()).toBe(21);
    expect(rangeToInstants(undefined, undefined)).toBeNull();
    expect(ymd(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});
