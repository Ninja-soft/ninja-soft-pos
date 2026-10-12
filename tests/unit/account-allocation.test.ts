import { describe, it, expect } from "vitest";
import { allocatePayment, defaultOrder, type OpenItem } from "@/lib/account/allocation";

// Casos espejo de account_collect() en SQL (imputación por defecto).
const items: OpenItem[] = [
  { id: "c2", kind: "charge", due_date: "2026-11-20", created_at: "2026-10-21T10:00:00Z", open: 200 },
  { id: "i1", kind: "interest", due_date: "2026-10-16", created_at: "2026-10-16T03:00:00Z", open: 30 },
  { id: "c1", kind: "charge", due_date: "2026-10-10", created_at: "2026-09-10T10:00:00Z", open: 100 },
  { id: "i0", kind: "interest", due_date: "2026-09-16", created_at: "2026-09-16T03:00:00Z", open: 10 },
];

describe("defaultOrder", () => {
  it("interés más viejo primero, luego cargos por vencimiento", () => {
    expect(defaultOrder(items).map((i) => i.id)).toEqual(["i0", "i1", "c1", "c2"]);
  });
});

describe("allocatePayment", () => {
  it("imputa FIFO por defecto", () => {
    const r = allocatePayment(items, 150);
    expect(r.allocations).toEqual([
      { id: "i0", amount: 10 },
      { id: "i1", amount: 30 },
      { id: "c1", amount: 100 },
      { id: "c2", amount: 10 },
    ]);
    expect(r.unapplied).toBe(0);
  });

  it("el excedente queda como saldo a favor (anticipo)", () => {
    const r = allocatePayment(items, 400);
    expect(r.allocations.reduce((a, x) => a + x.amount, 0)).toBe(340);
    expect(r.unapplied).toBe(60);
  });

  it("respeta la imputación elegida y reparte el resto por defecto", () => {
    const r = allocatePayment(items, 250, [{ id: "c2", amount: 200 }]);
    expect(r.allocations).toEqual([
      { id: "c2", amount: 200 },
      { id: "i0", amount: 10 },
      { id: "i1", amount: 30 },
      { id: "c1", amount: 10 },
    ]);
  });

  it("rechaza imputaciones inválidas", () => {
    expect(() => allocatePayment(items, 100, [{ id: "zz", amount: 10 }])).toThrow("allocation_unknown_item");
    expect(() => allocatePayment(items, 100, [{ id: "c1", amount: 150 }])).toThrow("allocation_exceeds_open");
    expect(() => allocatePayment(items, 50, [{ id: "c2", amount: 60 }])).toThrow("allocation_exceeds_payment");
    expect(() => allocatePayment(items, 0)).toThrow("invalid_amount");
  });

  it("trabaja en centavos (sin errores de coma flotante)", () => {
    const r = allocatePayment(
      [
        { id: "a", kind: "charge", due_date: "2026-01-01", created_at: "2026-01-01", open: 0.1 },
        { id: "b", kind: "charge", due_date: "2026-01-02", created_at: "2026-01-02", open: 0.2 },
      ],
      0.3,
    );
    expect(r.allocations).toEqual([
      { id: "a", amount: 0.1 },
      { id: "b", amount: 0.2 },
    ]);
    expect(r.unapplied).toBe(0);
  });
});
