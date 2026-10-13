import { describe, expect, it } from "vitest";
import {
  DEFAULT_FILTERS,
  MAX_PRESETS,
  activeFilterCount,
  detectRange,
  moveInOrder,
  removePreset,
  resolveOrder,
  resolveRange,
  sanitizeFilters,
  sanitizePresets,
  setDefaultPreset,
  toLocalDay,
  upsertPreset,
  type ReportPresetState,
} from "@/lib/reports/savedFilters";

const NOW = new Date(2026, 9, 13, 22, 30); // 13/10/2026 22:30 local (después de las 21 h)
const UUID = "11111111-2222-4333-8444-555555555555";

describe("resolveRange", () => {
  it("rangos relativos en días locales", () => {
    const r = (range: Parameters<typeof resolveRange>[0]["range"]) =>
      resolveRange({ range, from: null, to: null }, NOW);
    expect(toLocalDay(r("today").from)).toBe("2026-10-13");
    expect(toLocalDay(r("yesterday").to)).toBe("2026-10-12");
    expect(toLocalDay(r("7d").from)).toBe("2026-10-07");
    expect(toLocalDay(r("30d").from)).toBe("2026-09-14");
    expect(toLocalDay(r("month").from)).toBe("2026-10-01");
    const pm = r("prev_month");
    expect([toLocalDay(pm.from), toLocalDay(pm.to)]).toEqual([
      "2026-09-01",
      "2026-09-30",
    ]);
  });

  it("rango fijo, invertido y sin fechas", () => {
    const c = resolveRange(
      { range: "custom", from: "2026-05-10", to: "2026-05-01" },
      NOW,
    );
    expect([toLocalDay(c.from), toLocalDay(c.to)]).toEqual([
      "2026-05-01",
      "2026-05-10",
    ]);
    const none = resolveRange({ range: "custom", from: null, to: null }, NOW);
    expect(toLocalDay(none.from)).toBe("2026-10-07");
  });

  it("detectRange reconoce presets y si no guarda fechas fijas", () => {
    const r = resolveRange({ range: "30d", from: null, to: null }, NOW);
    expect(detectRange(r.from, r.to, NOW)).toEqual({
      range: "30d",
      from: null,
      to: null,
    });
    expect(
      detectRange(new Date(2026, 0, 2), new Date(2026, 0, 5), NOW),
    ).toEqual({
      range: "custom",
      from: "2026-01-02",
      to: "2026-01-05",
    });
  });
});

describe("sanitize", () => {
  it("descarta valores inválidos", () => {
    expect(
      sanitizeFilters({
        range: "x",
        storeId: "no-uuid",
        method: "Cash!",
        categoryId: 3,
      }),
    ).toEqual(DEFAULT_FILTERS);
    expect(sanitizeFilters({ range: "custom", from: "bad" }).range).toBe("7d");
    expect(
      sanitizeFilters({
        range: "custom",
        from: "2026-01-05",
        to: "2026-01-01",
      }),
    ).toMatchObject({
      from: "2026-01-05",
      to: "2026-01-05",
    });
    expect(
      sanitizeFilters({
        range: "month",
        storeId: UUID,
        method: "cash",
        categoryId: UUID,
      }),
    ).toEqual({
      range: "month",
      from: null,
      to: null,
      storeId: UUID,
      method: "cash",
      categoryId: UUID,
    });
  });

  it("presets: sin duplicados, tope y default válido", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      id: `p${i}`,
      name: `F ${i}`,
      filters: {},
    }));
    const s = sanitizePresets({
      presets: [...many, { id: "p0", name: "dup" }],
      defaultId: "p3",
    });
    expect(s.presets).toHaveLength(MAX_PRESETS);
    expect(s.defaultId).toBe("p3");
    expect(
      sanitizePresets({ presets: [{ id: "a", name: "  " }], defaultId: "a" }),
    ).toEqual({ presets: [], defaultId: null });
    expect(sanitizePresets(null)).toEqual({ presets: [], defaultId: null });
  });
});

describe("presets", () => {
  const base: ReportPresetState = { presets: [], defaultId: null };
  it("agrega, actualiza por nombre, marca default y elimina", () => {
    const a = upsertPreset(
      base,
      "Efectivo del mes",
      { ...DEFAULT_FILTERS, method: "cash" },
      "a",
    );
    if ("error" in a) throw new Error("no");
    const b = upsertPreset(
      a.state,
      "efectivo DEL mes",
      { ...DEFAULT_FILTERS, method: "debit" },
      "b",
    );
    if ("error" in b) throw new Error("no");
    expect(b.id).toBe("a");
    expect(b.state.presets).toHaveLength(1);
    expect(b.state.presets[0]!.filters.method).toBe("debit");
    const d = setDefaultPreset(b.state, "a");
    expect(d.defaultId).toBe("a");
    expect(setDefaultPreset(d, "zzz")).toBe(d);
    expect(removePreset(d, "a")).toEqual({ presets: [], defaultId: null });
  });

  it("valida nombre y tope", () => {
    expect(upsertPreset(base, "   ", DEFAULT_FILTERS)).toEqual({
      error: "empty_name",
    });
    const full: ReportPresetState = {
      presets: Array.from({ length: MAX_PRESETS }, (_, i) => ({
        id: `p${i}`,
        name: `F${i}`,
        filters: DEFAULT_FILTERS,
      })),
      defaultId: null,
    };
    expect(upsertPreset(full, "Nuevo", DEFAULT_FILTERS)).toEqual({
      error: "too_many",
    });
    expect("error" in upsertPreset(full, "f3", DEFAULT_FILTERS)).toBe(false);
  });

  it("cuenta filtros activos", () => {
    expect(activeFilterCount(DEFAULT_FILTERS)).toBe(0);
    expect(
      activeFilterCount({
        ...DEFAULT_FILTERS,
        method: "cash",
        categoryId: UUID,
        storeId: UUID,
      }),
    ).toBe(3);
  });
});

describe("orden de reportes", () => {
  const CATALOG = ["a", "b", "c", "d"] as const;
  it("resolveOrder respeta lo guardado y suma lo nuevo al final", () => {
    expect(resolveOrder(["c", "x", "a", "c"], CATALOG)).toEqual([
      "c",
      "a",
      "b",
      "d",
    ]);
    expect(resolveOrder("basura", CATALOG)).toEqual(["a", "b", "c", "d"]);
  });
  it("moveInOrder mueve dentro del grupo y no se sale de los bordes", () => {
    const order = ["a", "b", "c", "d"] as ("a" | "b" | "c" | "d")[];
    expect(moveInOrder(order, "b", -1)).toEqual(["b", "a", "c", "d"]);
    expect(moveInOrder(order, "a", -1)).toBe(order);
    expect(moveInOrder(order, "d", 1)).toBe(order);
    // Grupo {b, d}: bajar b lo cambia con d, saltando c.
    expect(moveInOrder(order, "b", 1, ["b", "d"])).toEqual([
      "a",
      "d",
      "c",
      "b",
    ]);
  });
});
