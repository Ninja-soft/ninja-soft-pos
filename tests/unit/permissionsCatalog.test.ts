import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  CAPABILITY_BY_KEY,
  compareRoles,
  dependents,
  MODULES,
  moduleIsPartial,
  moduleLevel,
  normalizeCapabilities,
  requiresAll,
  resolveCapabilities,
  searchCapabilities,
  setModuleLevel,
  SYSTEM_ROLE_BY_KEY,
  SYSTEM_ROLES,
  systemRoleForBase,
  toggleCapability,
  type BaseRole,
} from "@/lib/permissions/capabilities";
import { buildSeedSql } from "@/lib/permissions/seedSql";
import { can, deniedReasonByCapability, type RoleAction } from "@/lib/permissions/roles";
import { roleErrorMessage } from "@/lib/permissions/errors";

const MIGRATION = join(process.cwd(), "supabase/migrations/20261204100100_permisos_capacidades.sql");
const caps = (k: string) => [...SYSTEM_ROLE_BY_KEY.get(k)!.capabilities];

describe("catálogo de capacidades (ADR-138)", () => {
  it("el seed de la migración es el que genera el código", () => {
    const sql = readFileSync(MIGRATION, "utf8").replace(/\r\n/g, "\n");
    const block = sql.split("-- @@SEED-INICIO@@\n")[1]?.split("-- @@SEED-FIN@@")[0];
    expect(block).toBe(buildSeedSql());
  });

  it("claves únicas, con formato, módulos conocidos y dependencias existentes sin ciclos", () => {
    const keys = CAPABILITIES.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    const mods = new Set(MODULES.map((m) => m.key));
    for (const c of CAPABILITIES) {
      expect(c.key).toMatch(/^[a-z_]+(\.[a-z_]+)+$/);
      expect(mods.has(c.module)).toBe(true);
      for (const d of c.dependsOn) expect(CAPABILITY_BY_KEY.has(d)).toBe(true);
      expect(requiresAll(c.key)).not.toContain(c.key);
      expect(c.description).not.toMatch(/—/);
      expect(c.label).not.toMatch(/—/);
    }
  });

  it("incluye las capacidades de stock que usa Inventario con el mismo nombre", () => {
    for (const k of ["stock.adjust", "stock.adjust.approve", "stock.count"]) expect(CAPABILITY_BY_KEY.has(k)).toBe(true);
    expect(requiresAll("stock.adjust.approve")).toEqual(["stock.adjust", "stock.view"]);
  });

  it("dependencias transitivas y dependientes", () => {
    expect(requiresAll("prices.manage")).toEqual(["products.edit", "products.price", "products.view"]);
    expect(dependents("sales.void")).toEqual(["sales.void.past_days"]);
    expect(dependents("products.view")).toEqual(expect.arrayContaining(["sales.create", "products.edit", "purchases.manage"]));
  });
});

describe("roles de sistema = permisos por rol de hoy (ADR-071)", () => {
  const ACTIONS: RoleAction[] = [
    "catalog:write", "catalog:taxonomy", "catalog:import", "stock:adjust",
    "customers:create", "customers:update", "customers:delete", "sales:return", "sales:void", "operate",
  ];
  const NOW = Date.UTC(2026, 9, 13, 18, 0, 0);
  const DATES = [null, "2026-10-13T12:00:00Z", "2026-10-10T12:00:00Z", "2026-10-14T02:30:00Z"];

  it.each(["owner", "manager", "cashier", "viewer"] as const)("%s: mismo resultado por capacidad que por rol", (role) => {
    const eff = [...resolveCapabilities({ base: role, roleCapabilities: caps(role) }).effective];
    for (const a of ACTIONS) {
      for (const d of DATES) {
        const ctx = { saleDate: d, now: NOW };
        expect(deniedReasonByCapability(role, eff, a, ctx) === null, `${role} ${a} ${d}`).toBe(can(role, a, ctx));
      }
    }
  });

  it("el dueño tiene todo; el encargado todo menos configuración y lo del dueño", () => {
    expect(resolveCapabilities({ base: "owner", roleCapabilities: [] }).effective.size).toBe(CAPABILITIES.length);
    const m = resolveCapabilities({ base: "manager", roleCapabilities: caps("manager") }).effective;
    expect(m.has("config.edit")).toBe(false);
    expect(m.has("team.roles")).toBe(false);
    expect(m.has("team.manage")).toBe(true);
    expect(m.has("sales.void.past_days")).toBe(true);
  });

  it("cajero: vende, cobra, anula del día y devuelve; no toca catálogo ni stock", () => {
    const c = resolveCapabilities({ base: "cashier", roleCapabilities: caps("cashier") }).effective;
    for (const k of ["sales.create", "sales.void", "sales.return", "cash.open", "cash.movements", "customers.create"]) expect(c.has(k)).toBe(true);
    for (const k of ["sales.void.past_days", "products.edit", "stock.adjust", "customers.delete", "reports.costs"]) expect(c.has(k)).toBe(false);
  });

  it("roles de sistema: nivel coherente y todas sus capacidades efectivas", () => {
    for (const r of SYSTEM_ROLES) {
      const eff = resolveCapabilities({ base: r.base, roleCapabilities: r.capabilities }).effective;
      expect([...eff].sort(), r.key).toEqual([...r.capabilities].sort());
    }
    expect(SYSTEM_ROLE_BY_KEY.get("seller")!.base).toBe("cashier");
    expect(SYSTEM_ROLE_BY_KEY.get("auditor")!.base).toBe("viewer");
    expect(caps("seller")).not.toContain("sales.create");
    expect(caps("auditor")).toEqual(expect.arrayContaining(["reports.costs", "audit.view"]));
  });
});

describe("capacidades efectivas", () => {
  const cashierPlus = [...caps("cashier"), "sales.void.past_days", "products.edit", "products.price", "config.edit"];

  it("rol personalizado: concede lo que pide su nivel, no lo que pide uno mayor", () => {
    const r = resolveCapabilities({ base: "cashier", roleCapabilities: cashierPlus, customRole: true });
    expect(r.effective.has("sales.void.past_days")).toBe(true);
    expect(r.effective.has("products.price")).toBe(true);
    expect(r.effective.has("config.edit")).toBe(false);
    expect(r.detail.get("config.edit")!.blocked).toBe("base_too_low");
  });

  it("sin la feature, el rol personalizado cae a su rol de sistema y los permisos puntuales no cuentan", () => {
    const r = resolveCapabilities({
      base: "cashier",
      roleCapabilities: cashierPlus,
      customRole: true,
      featureOn: false,
      overrides: [{ capability: "customers.delete", effect: "grant" }],
    });
    expect(r.usedSystemFallback).toBe(true);
    expect([...r.effective].sort()).toEqual([...caps("cashier")].sort());
    expect(r.detail.get("customers.delete")!.blocked).toBe("feature_off");
  });

  it("permisos puntuales: quitar arrastra lo que depende; conceder sin dependencias no alcanza", () => {
    const r = resolveCapabilities({
      base: "manager",
      roleCapabilities: caps("manager"),
      overrides: [
        { capability: "sales.void", effect: "revoke" },
      ],
    });
    expect(r.effective.has("sales.void")).toBe(false);
    expect(r.effective.has("sales.void.past_days")).toBe(false);
    expect(r.detail.get("sales.void")!.blocked).toBe("revoked");
    expect(r.detail.get("sales.void.past_days")!.blocked).toBe("missing_dependency");
    expect(r.detail.get("sales.void.past_days")!.missing).toEqual(["sales.void"]);

    const v = resolveCapabilities({
      base: "viewer",
      roleCapabilities: ["reports.view"],
      overrides: [{ capability: "reports.costs", effect: "grant" }, { capability: "audit.view", effect: "grant" }],
    });
    expect(v.effective.has("reports.costs")).toBe(true);
    expect(v.detail.get("reports.costs")!.source).toBe("override");
    const w = resolveCapabilities({ base: "viewer", roleCapabilities: [], overrides: [{ capability: "reports.costs", effect: "grant" }] });
    expect(w.effective.has("reports.costs")).toBe(false);
    expect(w.detail.get("reports.costs")!.missing).toEqual(["reports.view"]);
  });

  it("por sucursal: el rol de la sucursal manda (se resuelve igual con su nivel)", () => {
    const negocio = resolveCapabilities({ base: "manager", roleCapabilities: caps("manager") }).effective;
    const norte = resolveCapabilities({ base: "cashier", roleCapabilities: caps("cashier") }).effective;
    expect(negocio.has("sales.void.past_days")).toBe(true);
    expect(norte.has("sales.void.past_days")).toBe(false);
  });
});

describe("edición", () => {
  it("prender trae sus dependencias y apagar se lleva lo que depende", () => {
    const on = toggleCapability(["sales.view"], "sales.void.past_days", true, "cashier");
    expect(on.next).toEqual(expect.arrayContaining(["sales.view", "sales.void", "sales.void.past_days"]));
    expect(on.addedDeps).toEqual(["sales.void"]);
    const off = toggleCapability(on.next, "sales.view", false, "cashier");
    expect(off.next).toEqual([]);
    expect(off.removedDependents).toEqual(expect.arrayContaining(["sales.void", "sales.void.past_days"]));
  });

  it("normalizar descarta claves desconocidas y lo que no permite el nivel", () => {
    expect(normalizeCapabilities(["nada", "config.edit", "customers.delete"], "cashier")).toEqual([
      "customers.view",
      "customers.edit",
      "customers.delete",
    ]);
  });

  it("modo simple: niveles por módulo", () => {
    const base: BaseRole = "cashier";
    let list = setModuleLevel([], "ventas", "operate", base);
    expect(moduleLevel(list, "ventas", base)).toBe("operate");
    expect(list).toEqual(expect.arrayContaining(["sales.create", "products.view"]));
    list = setModuleLevel(list, "ventas", "admin", base);
    expect(moduleLevel(list, "ventas", base)).toBe("admin");
    list = setModuleLevel(list, "productos", "none", base);
    expect(list).not.toContain("products.view");
    expect(list).not.toContain("sales.create");
    expect(moduleLevel(list, "ventas", base)).toBe("view");
    expect(moduleIsPartial(list, "ventas", base)).toBe(true);
    expect(moduleLevel(caps("manager"), "stock", "manager")).toBe("admin");
    expect(setModuleLevel([], "stock", "admin", "manager")).not.toContain("stock.adjust.approve");
  });

  it("plantillas: el modo simple reproduce Cajero y Encargado", () => {
    expect(moduleLevel(caps("cashier"), "caja", "cashier")).toBe("operate");
    expect(moduleLevel(caps("cashier"), "productos", "cashier")).toBe("view");
    expect(moduleLevel(caps("manager"), "ventas", "manager")).toBe("admin");
    expect(systemRoleForBase("viewer").key).toBe("viewer");
  });

  it("comparar roles", () => {
    const d = compareRoles(caps("cashier"), caps("seller"));
    expect(d.onlyA).toEqual(expect.arrayContaining(["sales.create", "cash.open"]));
    expect(d.onlyB).toEqual([]);
    expect(d.rows).toHaveLength(CAPABILITIES.length);
  });

  it("búsqueda sin acentos por etiqueta, clave o módulo", () => {
    expect(searchCapabilities("anular").map((c) => c.key)).toEqual(["sales.void", "sales.void.past_days"]);
    expect(searchCapabilities("auditoria").map((c) => c.key)).toContain("audit.view");
    expect(searchCapabilities("finanzas")).toHaveLength(3);
  });
});

describe("mensajes", () => {
  it("rechazo con la capacidad que falta", () => {
    expect(roleErrorMessage({ message: "forbidden_role", details: "capability:products.price" })).toBe(
      'Tu rol no tiene el permiso "Cambiar precios y costos". Pedíselo al dueño.',
    );
    expect(roleErrorMessage({ message: "forbidden_capability", details: "capability:sales.return" })).toContain("Devoluciones");
    expect(roleErrorMessage({ message: "forbidden_role" })).toBe("Esta acción requiere un encargado o el dueño del negocio.");
  });
});
