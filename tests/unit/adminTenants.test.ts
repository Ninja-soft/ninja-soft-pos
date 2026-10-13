import { describe, expect, it } from "vitest";
import {
  TENANT_INDUSTRIES,
  isValidReason,
  parseCreateTenantInput,
  slugifyTenantName,
} from "@/supabase/functions/_shared/tenantAdmin";
import { VERTICALS } from "@/lib/verticals/config";
import {
  lifecycleActions,
  lifecycleErrorMessage,
  lifecycleState,
} from "@/lib/internal/tenantLifecycle";
import {
  auditChanges,
  describeAuditAction,
  filterAuditEntries,
  groupAuditByDay,
  type AuditLike,
} from "@/lib/internal/auditTimeline";

const base = {
  name: "  Almacén  Don José ",
  industry: "kiosco",
  owner_email: " Jose@Mail.COM ",
  owner_name: "José",
  plan_key: "pro",
  trial_days: 14,
  reason: "  venta por teléfono ",
};

describe("alta manual de negocio · validación", () => {
  it("normaliza nombre, email, slug y motivo", () => {
    const r = parseCreateTenantInput(base);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({
      name: "Almacén Don José",
      slug: "almacen-don-jose",
      ownerEmail: "jose@mail.com",
      ownerName: "José",
      planKey: "pro",
      trialDays: 14,
      reason: "venta por teléfono",
    });
  });

  it("rechaza datos inválidos con un código por campo", () => {
    expect(parseCreateTenantInput({ ...base, name: "a" })).toEqual({ ok: false, error: "invalid_name" });
    expect(parseCreateTenantInput({ ...base, industry: "farmacia" })).toEqual({ ok: false, error: "invalid_industry" });
    expect(parseCreateTenantInput({ ...base, owner_email: "sin-arroba" })).toEqual({ ok: false, error: "invalid_email" });
    expect(parseCreateTenantInput({ ...base, plan_key: "" })).toEqual({ ok: false, error: "invalid_plan" });
    expect(parseCreateTenantInput({ ...base, plan_key: "Pro Plan" })).toEqual({ ok: false, error: "invalid_plan" });
    expect(parseCreateTenantInput({ ...base, trial_days: 91 })).toEqual({ ok: false, error: "invalid_trial_days" });
    expect(parseCreateTenantInput({ ...base, trial_days: 1.5 })).toEqual({ ok: false, error: "invalid_trial_days" });
    expect(parseCreateTenantInput({ ...base, trial_days: "14" })).toEqual({ ok: false, error: "invalid_trial_days" });
    expect(parseCreateTenantInput({ ...base, reason: "x".repeat(501) })).toEqual({ ok: false, error: "reason_too_long" });
    expect(parseCreateTenantInput(null)).toEqual({ ok: false, error: "invalid_name" });
  });

  it("trial 0 es válido (alta activa) y el motivo es opcional", () => {
    const r = parseCreateTenantInput({ ...base, trial_days: 0, reason: "", owner_name: "" });
    expect(r.ok && r.value.trialDays).toBe(0);
    expect(r.ok && r.value.reason).toBeNull();
    expect(r.ok && r.value.ownerName).toBeNull();
  });

  it("slug: sin acentos ni símbolos, máximo 40 y con fallback", () => {
    expect(slugifyTenantName("Café & Té ñandú")).toBe("cafe-te-nandu");
    expect(slugifyTenantName("!!!")).toBe("negocio");
    const long = slugifyTenantName("a".repeat(39) + " bbbb");
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long.endsWith("-")).toBe(false);
    expect(slugifyTenantName("x").match(/^[a-z0-9]+(-[a-z0-9]+)*$/)).not.toBeNull();
  });

  it("los rubros coinciden con los verticales del front", () => {
    expect([...TENANT_INDUSTRIES]).toEqual([...VERTICALS]);
  });

  it("motivo válido: 5 a 500 caracteres sin contar espacios de borde", () => {
    expect(isValidReason("   abcd ")).toBe(false);
    expect(isValidReason("abcde")).toBe(true);
    expect(isValidReason(null)).toBe(false);
    expect(isValidReason("x".repeat(501))).toBe(false);
  });
});

describe("ciclo de vida del negocio", () => {
  it("estado: la baja lógica manda sobre el status", () => {
    expect(lifecycleState({ status: "active", deletedAt: "2026-10-01T00:00:00Z" })).toBe("deleted");
    expect(lifecycleState({ status: "suspended" })).toBe("suspended");
    expect(lifecycleState({ status: "cancelled" })).toBe("cancelled");
    expect(lifecycleState({ status: "past_due" })).toBe("operating");
    expect(lifecycleState({ status: "trial" })).toBe("operating");
  });

  it("acciones según estado y nivel (espejo de la RPC)", () => {
    expect(lifecycleActions("operating", "admin")).toEqual(["suspend"]);
    expect(lifecycleActions("operating", "super_admin")).toEqual(["suspend", "delete"]);
    expect(lifecycleActions("suspended", "admin")).toEqual(["reactivate"]);
    expect(lifecycleActions("suspended", "super_admin")).toEqual(["reactivate", "delete"]);
    expect(lifecycleActions("deleted", "super_admin")).toEqual(["reactivate"]);
    expect(lifecycleActions("operating", "support")).toEqual([]);
    // Interno legacy sin nivel: como admin.
    expect(lifecycleActions("operating", null)).toEqual(["suspend"]);
  });

  it("mensajes de error legibles (la clave más específica gana)", () => {
    expect(lifecycleErrorMessage("forbidden_super_admin_only")).toMatch(/super admin/);
    expect(lifecycleErrorMessage("forbidden")).toMatch(/nivel de staff/);
    expect(lifecycleErrorMessage("P0001: reason_required")).toMatch(/5 caracteres/);
    expect(lifecycleErrorMessage("use_tenant_lifecycle")).toMatch(/Ciclo de vida/i);
    expect(lifecycleErrorMessage("otro error")).toBe("otro error");
    expect(lifecycleErrorMessage(undefined)).toMatch(/No se pudo/);
  });
});

function entry(p: Partial<AuditLike> & { action: string; entity_type: string }): AuditLike {
  return {
    id: Math.random().toString(36).slice(2),
    before_data: null,
    after_data: null,
    reason: null,
    created_at: "2026-10-13T15:00:00Z",
    ...p,
  };
}

describe("timeline de auditoría", () => {
  it("etiquetas y categorías conocidas", () => {
    expect(describeAuditAction("tenants", "tenant_suspended")).toEqual({ label: "Negocio suspendido", category: "lifecycle" });
    expect(describeAuditAction("subscriptions", "plan_changed").category).toBe("plan");
    expect(describeAuditAction("impersonation", "impersonation_link_generated").category).toBe("access");
    expect(describeAuditAction("tenant_feature_flags", "flag_changed").category).toBe("config");
  });

  it("reglas para acciones sin texto propio", () => {
    expect(describeAuditAction("products", "UPDATE")).toEqual({ label: "Cambio en productos", category: "operation" });
    expect(describeAuditAction("subscriptions", "INSERT")).toEqual({ label: "Alta en suscripción", category: "plan" });
    expect(describeAuditAction("tenant_users", "member_updated").category).toBe("access");
    expect(describeAuditAction("x", "payment_secret_set")).toEqual({ label: "Payment secret set", category: "config" });
    expect(describeAuditAction("tenants", "tenant_whatever").category).toBe("lifecycle");
  });

  it("cambios de primer nivel, sin claves técnicas", () => {
    const ch = auditChanges(
      { status: "active", deleted_at: null, updated_at: "a" },
      { status: "suspended", deleted_at: null, updated_at: "b", note: true },
    );
    expect(ch).toEqual([
      { key: "status", before: "active", after: "suspended" },
      { key: "note", before: "", after: "sí" },
    ]);
    expect(auditChanges(null, [1, 2])).toEqual([]);
    expect(auditChanges({ a: { x: 1 } }, { a: { x: 2 } })).toEqual([{ key: "a", before: '{"x":1}', after: '{"x":2}' }]);
  });

  it("filtra por categoría y por texto (motivo, autor, etiqueta)", () => {
    const list = [
      entry({ entity_type: "tenants", action: "tenant_suspended", reason: "Deuda de dos meses" }),
      entry({ entity_type: "subscriptions", action: "plan_changed", actorName: "Lucía" }),
      entry({ entity_type: "products", action: "INSERT" }),
    ];
    expect(filterAuditEntries(list, { category: "lifecycle", query: "" })).toHaveLength(1);
    expect(filterAuditEntries(list, { category: "all", query: "deuda" })).toHaveLength(1);
    expect(filterAuditEntries(list, { category: "all", query: "lucía" })[0]!.action).toBe("plan_changed");
    expect(filterAuditEntries(list, { category: "plan", query: "deuda" })).toHaveLength(0);
    expect(filterAuditEntries(list, { category: "all", query: "  " })).toHaveLength(3);
  });

  it("agrupa por día respetando el orden", () => {
    const a = entry({ entity_type: "t", action: "a", created_at: new Date(2026, 9, 13, 18).toISOString() });
    const b = entry({ entity_type: "t", action: "b", created_at: new Date(2026, 9, 13, 9).toISOString() });
    const c = entry({ entity_type: "t", action: "c", created_at: new Date(2026, 9, 12, 20).toISOString() });
    const g = groupAuditByDay([a, b, c]);
    expect(g.map((x) => x.day)).toEqual(["2026-10-13", "2026-10-12"]);
    expect(g[0]!.items.map((x) => x.action)).toEqual(["a", "b"]);
  });
});
