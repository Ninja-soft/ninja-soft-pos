import { describe, it, expect } from "vitest";
import { auditActionLabel, auditDiff, auditEntityLabel, auditTone, auditValue } from "@/lib/security/auditLabels";
import { hourWindow, summarizeOwnerStats, type OwnerStats } from "@/modules/dashboard/ownerStats";

describe("visor de auditoría", () => {
  it("traduce acciones y entidades, con respaldo legible", () => {
    expect(auditActionLabel("cash_shift_force_closed")).toBe("Cierre forzado de caja");
    expect(auditActionLabel("algo_nuevo_raro")).toBe("Algo nuevo raro");
    expect(auditEntityLabel("cash_shifts")).toBe("Turno de caja");
    expect(auditEntityLabel("otra_tabla")).toBe("otra tabla");
  });
  it("tono por sensibilidad", () => {
    expect(auditTone("supervisor_pin_failed")).toBe("danger");
    expect(auditTone("supervisor_authorized")).toBe("warning");
    expect(auditTone("member_invited")).toBe("info");
    expect(auditTone("update")).toBe("neutral");
  });
  it("diff campo a campo sin timestamps", () => {
    const d = auditDiff({ price: 100, name: "A", updated_at: "x" }, { price: 120, name: "A", updated_at: "y", stock: 3 });
    expect(d.map((r) => r.key)).toEqual(["name", "price", "stock"]);
    expect(d.find((r) => r.key === "price")!.changed).toBe(true);
    expect(d.find((r) => r.key === "name")!.changed).toBe(false);
    expect(auditValue(null)).toBe("vacío");
    expect(auditValue(true)).toBe("sí");
    expect(auditValue({ a: 1 })).toBe('{"a":1}');
  });
});

describe("panel del dueño", () => {
  const stats: OwnerStats = {
    today: "2026-10-12",
    by_store: [
      { store_id: "a", name: "Centro", short_name: null, color: null, today_total: 1500, today_count: 3, yesterday_total: 1000, yesterday_count: 2 },
      { store_id: "b", name: "Norte", short_name: null, color: null, today_total: 500, today_count: 1, yesterday_total: 1000, yesterday_count: 4 },
    ],
    by_hour: Array.from({ length: 24 }, (_, h) => ({ hour: h, today: h === 6 ? 100 : 0, yesterday: h === 23 ? 50 : 0 })),
    open_shifts: 2,
    staff: { active: 3, suspended: 0, on_leave: 1, terminated: 0 },
  };
  it("totales y variación contra ayer", () => {
    const s = summarizeOwnerStats(stats);
    expect(s.today).toBe(2000);
    expect(s.yesterday).toBe(2000);
    expect(s.delta).toBe(0);
    expect(s.tickets).toBe(4);
    expect(s.avgTicket).toBe(500);
    expect(summarizeOwnerStats(undefined).delta).toBeNull();
  });
  it("ventana de horas: 8 a 21 ampliada a las horas con ventas", () => {
    const w = hourWindow(stats.by_hour);
    expect(w[0]!.hour).toBe(6);
    expect(w[w.length - 1]!.hour).toBe(23);
    const quiet = hourWindow(Array.from({ length: 24 }, (_, h) => ({ hour: h, today: 0, yesterday: 0 })));
    expect(quiet.map((r) => r.hour)).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
  });
});
