import { describe, expect, it } from "vitest";
import {
  argentinaClock,
  branchAlerts,
  isWithinOpeningHours,
  worstSeverity,
  type BranchOverview,
} from "@/lib/branches/monitorAlerts";

// Miércoles 2026-10-14 15:00 en Argentina (UTC-3) = 18:00 UTC.
const NOW = new Date("2026-10-14T18:00:00Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();

function row(p: Partial<BranchOverview> = {}): BranchOverview {
  return {
    store_id: "s1",
    name: "Centro",
    short_name: null,
    color: null,
    is_default: true,
    is_active: true,
    opening_hours: { wed: [{ from: "09:00", to: "20:00" }] },
    registers_total: 2,
    registers_open: 1,
    open_shifts: [{ shift_id: "x", register_name: "Caja 1", opened_at: ago(60), opened_by_name: "Ana" }],
    sales_today_total: 1000,
    sales_today_count: 3,
    last_sale_at: ago(5),
    staff_on_shift: 1,
    staff_assigned: 2,
    low_stock_count: 0,
    pending_waiting: 0,
    pending_waiting_amount: 0,
    pending_paid_unsold: 0,
    terminals: [],
    last_z: null,
    close_tolerance: 0,
    ...p,
  };
}

describe("argentinaClock / isWithinOpeningHours", () => {
  it("usa la hora de Argentina", () => {
    expect(argentinaClock(NOW)).toEqual({ day: "wed", hhmm: "15:00" });
  });
  it("en horario, fuera de horario y sin horario", () => {
    expect(isWithinOpeningHours({ wed: [{ from: "09:00", to: "20:00" }] }, NOW)).toBe(true);
    expect(isWithinOpeningHours({ wed: [{ from: "09:00", to: "13:00" }] }, NOW)).toBe(false);
    expect(isWithinOpeningHours({ thu: [{ from: "09:00", to: "20:00" }] }, NOW)).toBe(false);
    expect(isWithinOpeningHours({}, NOW)).toBeNull();
    expect(isWithinOpeningHours(null, NOW)).toBeNull();
  });
  it("el límite de cierre es exclusivo", () => {
    expect(isWithinOpeningHours({ wed: [{ from: "09:00", to: "15:00" }] }, NOW)).toBe(false);
  });
});

describe("branchAlerts", () => {
  it("sucursal sana: sin alertas", () => {
    expect(branchAlerts(row(), NOW)).toEqual([]);
    expect(worstSeverity([])).toBeNull();
  });

  it("caja abierta hace más de N horas", () => {
    const a = branchAlerts(row({ open_shifts: [{ shift_id: "x", register_name: "Caja 1", opened_at: ago(13 * 60), opened_by_name: "Ana" }] }), NOW);
    expect(a.map((x) => x.kind)).toEqual(["long_shift"]);
    expect(branchAlerts(row({ open_shifts: [{ shift_id: "x", register_name: "Caja 1", opened_at: ago(13 * 60), opened_by_name: "Ana" }] }), NOW, { longShiftHours: 24 })).toEqual([]);
  });

  it("en horario sin cajas abiertas es grave; fuera de horario no", () => {
    const closed = row({ registers_open: 0, open_shifts: [] });
    expect(branchAlerts(closed, NOW)[0]?.kind).toBe("closed_in_hours");
    expect(worstSeverity(branchAlerts(closed, NOW))).toBe("danger");
    expect(branchAlerts({ ...closed, opening_hours: { wed: [{ from: "09:00", to: "13:00" }] } }, NOW)).toEqual([]);
    expect(branchAlerts({ ...closed, opening_hours: {} }, NOW)).toEqual([]);
  });

  it("cobros pagados sin venta y faltantes, ordenadas por severidad", () => {
    const a = branchAlerts(row({ pending_paid_unsold: 2, low_stock_count: 4 }), NOW);
    expect(a.map((x) => x.kind)).toEqual(["paid_unsold", "low_stock"]);
    expect(a[0]!.message).toContain("2 cobros pagados");
  });

  it("terminal sin señal sólo en horario", () => {
    const t = [{ id: "t", label: "Point 1", provider_key: "mercadopago_point", kind: "point", last_seen_at: ago(90), register_id: null }];
    expect(branchAlerts(row({ terminals: t }), NOW).map((x) => x.kind)).toEqual(["terminal_stale"]);
    expect(branchAlerts(row({ terminals: [{ ...t[0]!, last_seen_at: null }] }), NOW).map((x) => x.kind)).toEqual(["terminal_stale"]);
    expect(branchAlerts(row({ terminals: [{ ...t[0]!, last_seen_at: ago(10) }] }), NOW)).toEqual([]);
    expect(branchAlerts(row({ terminals: t, opening_hours: {} }), NOW)).toEqual([]);
  });

  it("diferencia del último Z contra la tolerancia", () => {
    const z = { closed_at: ago(600), difference: -150, z_number: 7 };
    expect(branchAlerts(row({ last_z: z }), NOW).map((x) => x.kind)).toEqual(["z_difference"]);
    expect(branchAlerts(row({ last_z: z, close_tolerance: 200 }), NOW)).toEqual([]);
  });

  it("sin ventas en horario sólo si se pide", () => {
    const quiet = row({ last_sale_at: ago(120) });
    expect(branchAlerts(quiet, NOW)).toEqual([]);
    expect(branchAlerts(quiet, NOW, { noSaleMinutes: 60 }).map((x) => x.kind)).toEqual(["no_sales_in_hours"]);
  });
});

describe("H99: señal de las cajas y último cobro de las terminales (ADR-080)", () => {
  const reg = (p: Record<string, unknown> = {}) => ({
    id: "r1",
    name: "Caja 2",
    last_ping_at: ago(1) as string | null,
    app_version: null,
    info: null,
    user_name: "Ana",
    shift_open: true,
    ...p,
  });

  it("caja abierta sin señal hace más del umbral avisa", () => {
    const r = row({ registers: [reg({ last_ping_at: ago(12) })] });
    const kinds = branchAlerts(r, NOW).map((x) => x.kind);
    expect(kinds).toContain("register_silent");
    expect(branchAlerts(r, NOW).find((x) => x.kind === "register_silent")?.message).toMatch(/Caja 2/);
    expect(branchAlerts(r, NOW, { registerStaleMinutes: 30 }).map((x) => x.kind)).not.toContain("register_silent");
  });

  it("no avisa con señal reciente, caja cerrada o caja que nunca mandó señal", () => {
    for (const p of [{ last_ping_at: ago(2) }, { shift_open: false, last_ping_at: ago(60) }, { last_ping_at: null }]) {
      expect(branchAlerts(row({ registers: [reg(p)] }), NOW).map((x) => x.kind)).not.toContain("register_silent");
    }
  });

  it("base vieja sin registers no rompe", () => {
    const r = row();
    delete (r as { registers?: unknown }).registers;
    expect(branchAlerts(r, NOW)).toEqual([]);
  });

  it("último cobro rechazado en la última hora avisa", () => {
    const t = (status: string, min: number) => ({
      id: "t1",
      label: "Point Centro",
      provider_key: "mercadopago",
      kind: "point",
      last_seen_at: ago(1),
      register_id: null,
      last_charge: { at: ago(min), status, amount: 100 },
    });
    expect(branchAlerts(row({ terminals: [t("rejected", 10)] }), NOW).map((x) => x.kind)).toContain("terminal_rejected");
    expect(branchAlerts(row({ terminals: [t("rejected", 90)] }), NOW).map((x) => x.kind)).not.toContain(
      "terminal_rejected",
    );
    expect(branchAlerts(row({ terminals: [t("approved", 5)] }), NOW).map((x) => x.kind)).not.toContain(
      "terminal_rejected",
    );
  });
});
