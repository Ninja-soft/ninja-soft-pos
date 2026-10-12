import { describe, it, expect } from "vitest";
import {
  addDays,
  allowedStoreIds,
  assignmentStatus,
  branchErrorMessage,
  hasFullScope,
  locationLabel,
  normalizeOpeningHours,
  registerShort,
  resolveBranchContext,
  resolveRegister,
  summarizeOpeningHours,
  todayAR,
  type BranchRegister,
  type ScopeInput,
} from "@/modules/branches/logic";

const store = (id: string, extra: Partial<{ is_default: boolean; deleted_at: string | null; created_at: string }> = {}) => ({
  id,
  is_default: false,
  deleted_at: null,
  created_at: `2026-01-0${id.length}`,
  ...extra,
});

const centro = store("centro", { is_default: true, created_at: "2026-01-01" });
const norte = store("norte", { created_at: "2026-02-01" });
const sur = store("sur", { created_at: "2026-03-01" });
const vieja = store("vieja", { created_at: "2025-12-01", deleted_at: "2026-05-01" });

const asg = (store_id: string, kind: "home" | "cover" | "extra", valid_from: string, valid_until: string | null = null, deleted_at: string | null = null) => ({
  store_id,
  kind,
  valid_from,
  valid_until,
  deleted_at,
});

describe("assignmentStatus (vigencia perezosa)", () => {
  const today = "2026-10-13";
  it("programada, vigente, finalizada y cancelada", () => {
    expect(assignmentStatus(asg("x", "home", "2026-10-20"), today)).toBe("scheduled");
    expect(assignmentStatus(asg("x", "home", "2026-10-13"), today)).toBe("active");
    expect(assignmentStatus(asg("x", "cover", "2026-10-01", "2026-10-13"), today)).toBe("active");
    expect(assignmentStatus(asg("x", "cover", "2026-10-01", "2026-10-12"), today)).toBe("ended");
    expect(assignmentStatus(asg("x", "home", "2026-10-01", null, "2026-10-05T00:00:00Z"), today)).toBe("cancelled");
  });
});

describe("allowedStoreIds (espejo de staff_allowed_store_ids)", () => {
  const base: Omit<ScopeInput, "role" | "assignments"> = {
    stores: [centro, norte, sur, vieja],
    today: "2026-10-13",
  };

  it("el dueño ve todas, incluidas las archivadas", () => {
    expect(allowedStoreIds({ ...base, role: "owner", assignments: [asg("norte", "home", "2026-01-01")] })).toEqual([
      "vieja",
      "centro",
      "norte",
      "sur",
    ]);
  });

  it("negocio con una sola sucursal viva: todos ven todo", () => {
    const stores = [centro, vieja];
    expect(allowedStoreIds({ role: "cashier", stores, assignments: [], today: base.today })).toEqual(["vieja", "centro"]);
  });

  it("sin asignaciones: encargado ve todas, cajero sólo la principal", () => {
    expect(allowedStoreIds({ ...base, role: "manager", assignments: [] })).toHaveLength(4);
    expect(allowedStoreIds({ ...base, role: "cashier", assignments: [] })).toEqual(["centro"]);
    expect(allowedStoreIds({ ...base, role: "viewer", assignments: [] })).toEqual(["centro"]);
  });

  it("base + acceso adicional vigentes", () => {
    const assignments = [asg("norte", "home", "2026-01-01"), asg("sur", "extra", "2026-10-01", "2026-12-31")];
    expect(allowedStoreIds({ ...base, role: "cashier", assignments })).toEqual(["norte", "sur"]);
  });

  it("la cobertura temporal es exclusiva mientras dura", () => {
    const assignments = [asg("norte", "home", "2026-01-01"), asg("sur", "cover", "2026-10-10", "2026-10-15")];
    expect(allowedStoreIds({ ...base, role: "cashier", assignments })).toEqual(["sur"]);
    expect(allowedStoreIds({ ...base, role: "cashier", assignments, today: "2026-10-16" })).toEqual(["norte"]);
  });

  it("traslado programado: hasta la fecha sigue en la base vieja", () => {
    const assignments = [asg("centro", "home", "2026-01-01", "2026-10-19"), asg("norte", "home", "2026-10-20")];
    expect(allowedStoreIds({ ...base, role: "cashier", assignments })).toEqual(["centro"]);
    expect(allowedStoreIds({ ...base, role: "cashier", assignments, today: "2026-10-20" })).toEqual(["norte"]);
  });

  it("un encargado con asignación queda limitado (encargado de sucursal)", () => {
    const assignments = [asg("norte", "home", "2026-01-01")];
    expect(allowedStoreIds({ ...base, role: "manager", assignments })).toEqual(["norte"]);
    expect(hasFullScope({ ...base, role: "manager", assignments })).toBe(false);
    expect(hasFullScope({ ...base, role: "manager", assignments: [] })).toBe(true);
  });

  it("ignora asignaciones canceladas o de sucursales archivadas", () => {
    const assignments = [
      asg("vieja", "home", "2026-01-01"),
      asg("sur", "extra", "2026-01-01", null, "2026-02-01T00:00:00Z"),
    ];
    expect(allowedStoreIds({ ...base, role: "cashier", assignments })).toEqual(["centro"]);
  });
});

describe("resolveBranchContext", () => {
  const allowed = [
    { id: "centro", is_default: true, is_active: true },
    { id: "norte", is_default: false, is_active: true },
    { id: "pausada", is_default: false, is_active: false },
  ];

  it("una sola sucursal: sin selector y siempre esa", () => {
    expect(resolveBranchContext({ allowed: [allowed[0]!], saved: "all", savedPos: null })).toEqual({
      filterStoreId: "centro",
      posStoreId: "centro",
      isMulti: false,
    });
  });

  it("todas: el filtro queda en null y el POS en la principal", () => {
    expect(resolveBranchContext({ allowed, saved: "all", savedPos: null })).toEqual({
      filterStoreId: null,
      posStoreId: "centro",
      isMulti: true,
    });
  });

  it("respeta lo guardado si sigue permitido; si no, cae a la principal", () => {
    expect(resolveBranchContext({ allowed, saved: "norte", savedPos: null }).posStoreId).toBe("norte");
    expect(resolveBranchContext({ allowed, saved: "norte", savedPos: "centro" }).posStoreId).toBe("centro");
    expect(resolveBranchContext({ allowed, saved: "borrada", savedPos: "borrada" })).toEqual({
      filterStoreId: null,
      posStoreId: "centro",
      isMulti: true,
    });
  });

  it("el POS no queda en una sucursal pausada", () => {
    expect(resolveBranchContext({ allowed, saved: "pausada", savedPos: "pausada" })).toEqual({
      filterStoreId: "pausada",
      posStoreId: "centro",
      isMulti: true,
    });
  });

  it("sin sucursales permitidas", () => {
    expect(resolveBranchContext({ allowed: [], saved: null, savedPos: null }).posStoreId).toBeNull();
  });
});

describe("resolveRegister (caja del dispositivo)", () => {
  const reg = (id: string, sort: number, extra: Partial<BranchRegister> = {}): BranchRegister => ({
    id,
    store_id: "centro",
    name: `Caja ${sort}`,
    code: null,
    kind: "fixed",
    is_active: true,
    deleted_at: null,
    sort,
    device_notes: null,
    printer_notes: null,
    afip_pos_number: null,
    created_at: "2026-01-01",
    ...extra,
  });
  const regs = [reg("c2", 2), reg("c1", 1), reg("c3", 3, { is_active: false }), reg("c4", 4, { deleted_at: "x" })];
  const shift = (cash_register_id: string, opened_by: string, opened_at = "2026-10-13T10:00:00Z") => ({
    id: `s-${cash_register_id}`,
    cash_register_id,
    opened_by,
    opened_at,
  });

  it("usa la recordada si sigue operable", () => {
    expect(resolveRegister(regs, "c2", [], "u1")?.id).toBe("c2");
    expect(resolveRegister(regs, "c3", [], "u1")?.id).toBe("c1");
  });

  it("si no hay recordada, la del turno abierto del usuario", () => {
    expect(resolveRegister(regs, null, [shift("c2", "u1")], "u1")?.id).toBe("c2");
  });

  it("si no, la primera libre", () => {
    expect(resolveRegister(regs, null, [shift("c1", "otro")], "u1")?.id).toBe("c2");
    expect(resolveRegister(regs, null, [shift("c1", "a"), shift("c2", "b")], "u1")?.id).toBe("c1");
  });

  it("sin cajas operables", () => {
    expect(resolveRegister([reg("x", 1, { is_active: false })], null, [], "u1")).toBeNull();
  });
});

describe("etiquetas", () => {
  it("registerShort y locationLabel", () => {
    expect(registerShort({ name: "Caja 1", code: null })).toBe("C1");
    expect(registerShort({ name: "Caja rápida", code: null })).toBe("CR");
    expect(registerShort({ name: "Caja 2", code: "N2" })).toBe("N2");
    expect(locationLabel({ name: "Sucursal Centro", short_name: "Centro" }, { name: "Caja 1", code: null })).toBe(
      "Centro · Caja 1",
    );
    expect(locationLabel({ name: "Centro", short_name: null }, { name: "Caja 1", code: null }, true)).toBe("Centro · C1");
    expect(locationLabel(null, null)).toBe("");
  });
});

describe("horario", () => {
  it("valida formato, orden y superposición", () => {
    expect(normalizeOpeningHours({ mon: [{ from: "09:00", to: "13:00" }, { from: "16:00", to: "20:00" }] })).toEqual({
      mon: [
        { from: "09:00", to: "13:00" },
        { from: "16:00", to: "20:00" },
      ],
    });
    expect(normalizeOpeningHours({ mon: [{ from: "13:00", to: "09:00" }] })).toBeNull();
    expect(normalizeOpeningHours({ mon: [{ from: "9", to: "13:00" }] })).toBeNull();
    expect(
      normalizeOpeningHours({ mon: [{ from: "09:00", to: "14:00" }, { from: "13:00", to: "20:00" }] }),
    ).toBeNull();
    expect(normalizeOpeningHours({ tue: [{ from: "", to: "" }] })).toEqual({});
  });

  it("resume días consecutivos con el mismo horario", () => {
    const r = { from: "09:00", to: "18:00" };
    expect(
      summarizeOpeningHours({ mon: [r], tue: [r], wed: [r], thu: [r], fri: [r], sat: [{ from: "09:00", to: "13:00" }] }),
    ).toBe("Lu a Vi 09:00-18:00 · Sá 09:00-13:00");
    expect(summarizeOpeningHours({})).toBe("Sin horario cargado");
  });
});

describe("fechas y errores", () => {
  it("todayAR usa la zona de Argentina", () => {
    // 02:00 UTC del 14 = 23:00 del 13 en Buenos Aires.
    expect(todayAR(new Date("2026-10-14T02:00:00Z"))).toBe("2026-10-13");
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("traduce los errores del servidor", () => {
    expect(branchErrorMessage({ message: "feature_not_in_plan: multi_sucursal" })).toMatch(/más de una sucursal/);
    expect(branchErrorMessage(new Error("plan_limit: max_stores"))).toMatch(/máximo de sucursales/);
    expect(branchErrorMessage({ message: "otra cosa" }, "x")).toBe("x");
  });
});
