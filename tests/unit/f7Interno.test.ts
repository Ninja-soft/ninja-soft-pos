import { describe, expect, it } from "vitest";
import {
  DEFAULT_IMPERSONATION_MINUTES,
  buildImpersonationUrl,
  durationLabel,
  formatRemaining,
  impersonationErrorMessage,
  impersonationExpiresAt,
  parseImpersonationFragment,
  parseImpersonationMinutes,
  remainingSeconds,
} from "@/supabase/functions/_shared/impersonation";
import {
  canAssignRole,
  canStaffDo,
  isInvitePending,
  memberActions,
  memberErrorMessage,
  memberState,
  parseInviteMemberInput,
  type MemberRow,
} from "@/supabase/functions/_shared/tenantMembers";
import {
  EMPTY_SEGMENT,
  fromRpcSegment,
  groupByBatch,
  isEmptySegment,
  matchesSegment,
  segmentError,
  segmentSummary,
  segmentTenants,
  toRpcSegment,
  toggleValue,
  type SegmentTenant,
} from "@/lib/internal/segments";
import { atRiskTenants, tenantHealthScore } from "@/lib/internal/tenantHealth";
import { groupModules, parseTenant360 } from "@/lib/internal/tenant360";
import { describeAuditAction } from "@/lib/internal/auditTimeline";

const NONCE = "a".repeat(64);
const TENANT = "11111111-1111-4111-8111-111111111111";

// ── Acceso como el negocio (ADR-084) ─────────────────────────────────────────
describe("impersonation: duración", () => {
  it("default 30 sin valor; enteros entre 5 y 240", () => {
    expect(parseImpersonationMinutes(undefined)).toBe(DEFAULT_IMPERSONATION_MINUTES);
    expect(parseImpersonationMinutes(null)).toBe(30);
    expect(parseImpersonationMinutes(60)).toBe(60);
    expect(parseImpersonationMinutes("120")).toBe(120);
    expect(parseImpersonationMinutes(5)).toBe(5);
    expect(parseImpersonationMinutes(240)).toBe(240);
  });
  it("rechaza fuera de rango o no entero (no recorta en silencio)", () => {
    expect(parseImpersonationMinutes(4)).toBeNull();
    expect(parseImpersonationMinutes(241)).toBeNull();
    expect(parseImpersonationMinutes(30.5)).toBeNull();
    expect(parseImpersonationMinutes("abc")).toBeNull();
    expect(parseImpersonationMinutes({})).toBeNull();
  });
  it("vencimiento y etiquetas", () => {
    const now = new Date("2026-10-13T12:00:00Z");
    expect(impersonationExpiresAt(now, 30).toISOString()).toBe("2026-10-13T12:30:00.000Z");
    expect(durationLabel(15)).toBe("15 minutos");
    expect(durationLabel(60)).toBe("1 hora");
    expect(durationLabel(120)).toBe("2 horas");
  });
});

describe("impersonation: link y cuenta regresiva", () => {
  it("el link lleva token y nonce en el fragmento y se parsea de vuelta", () => {
    const url = buildImpersonationUrl("https://pos.soft.ninja/", "abc123def456ghi789", NONCE);
    expect(url.startsWith("https://pos.soft.ninja/auth/impersonate#")).toBe(true);
    expect(url).not.toContain("?");
    const hash = url.slice(url.indexOf("#"));
    expect(parseImpersonationFragment(hash)).toEqual({ tokenHash: "abc123def456ghi789", nonce: NONCE });
  });
  it("fragmentos inválidos", () => {
    expect(parseImpersonationFragment("")).toBeNull();
    expect(parseImpersonationFragment("#th=abc&n=" + NONCE)).toBeNull(); // token corto
    expect(parseImpersonationFragment("#th=abc123def456ghi789&n=zz")).toBeNull();
    expect(parseImpersonationFragment("#th=abc123def456ghi789&n=" + "A".repeat(64))).toBeNull();
  });
  it("tiempo restante nunca negativo y formato", () => {
    const now = new Date("2026-10-13T12:00:00Z");
    expect(remainingSeconds("2026-10-13T12:01:05Z", now)).toBe(65);
    expect(remainingSeconds("2026-10-13T11:00:00Z", now)).toBe(0);
    expect(remainingSeconds("no-date", now)).toBe(0);
    expect(formatRemaining(65)).toBe("1:05");
    expect(formatRemaining(3600 + 5 * 60)).toBe("1 h 05 min");
    expect(formatRemaining(-3)).toBe("0:00");
  });
  it("mensajes de error", () => {
    expect(impersonationErrorMessage("link_used")).toMatch(/ya se usó/);
    expect(impersonationErrorMessage("link_expired")).toMatch(/venció/);
    expect(impersonationErrorMessage("cualquier")).toMatch(/No se pudo/);
  });
});

// ── Miembros desde internal ──────────────────────────────────────────────────
function member(p: Partial<MemberRow> = {}): MemberRow {
  return {
    user_id: "u1",
    email: "a@b.com",
    full_name: null,
    display_name: null,
    role: "cashier",
    status: "active",
    invited_at: null,
    joined_at: null,
    created_at: "2026-10-01T00:00:00Z",
    last_sign_in_at: "2026-10-10T00:00:00Z",
    email_confirmed_at: "2026-10-01T00:00:00Z",
    is_staff: false,
    ...p,
  };
}

describe("miembros: invitación", () => {
  it("valida email, rol, motivo y negocio", () => {
    const ok = parseInviteMemberInput({
      tenant_id: TENANT,
      email: " Nuevo@Mail.com ",
      role: "manager",
      reason: "pedido del dueño",
      display_name: "  Caja 2 ",
    });
    expect(ok).toEqual({
      ok: true,
      value: { tenantId: TENANT, email: "nuevo@mail.com", role: "manager", displayName: "Caja 2", reason: "pedido del dueño" },
    });
    expect(parseInviteMemberInput({ tenant_id: "x", email: "a@b.com", role: "cashier", reason: "motivo" })).toEqual({
      ok: false,
      error: "missing_tenant_id",
    });
    expect(parseInviteMemberInput({ tenant_id: TENANT, email: "mal", role: "cashier", reason: "motivo" })).toMatchObject({
      error: "invalid_email",
    });
    expect(parseInviteMemberInput({ tenant_id: TENANT, email: "a@b.com", role: "admin", reason: "motivo" })).toMatchObject({
      error: "invalid_role",
    });
    expect(parseInviteMemberInput({ tenant_id: TENANT, email: "a@b.com", role: "viewer", reason: "corto" })).toMatchObject({
      ok: true,
    });
    expect(parseInviteMemberInput({ tenant_id: TENANT, email: "a@b.com", role: "viewer", reason: "abc" })).toMatchObject({
      error: "reason_required",
    });
  });
});

describe("miembros: permisos por nivel (matriz H11)", () => {
  it("soporte sólo resetea el acceso", () => {
    expect(canStaffDo("support", "reset_access")).toBe(true);
    for (const a of ["invite", "resend_invite", "set_role", "suspend", "reactivate"] as const) {
      expect(canStaffDo("support", a)).toBe(false);
      expect(canStaffDo("admin", a)).toBe(true);
    }
  });
  it("dar o quitar el rol de dueño es de super_admin", () => {
    expect(canAssignRole("admin", "cashier", "manager")).toBe(true);
    expect(canAssignRole("admin", "cashier", "owner")).toBe(false);
    expect(canAssignRole("admin", "owner", "manager")).toBe(false);
    expect(canAssignRole("super_admin", "owner", "manager")).toBe(true);
    expect(canAssignRole("super_admin", "cashier", "cashier")).toBe(false);
    expect(canAssignRole("support", "cashier", "viewer")).toBe(false);
  });
});

describe("miembros: estado y acciones visibles", () => {
  it("invitación pendiente = nunca confirmó ni ingresó", () => {
    expect(isInvitePending(member({ email_confirmed_at: null, last_sign_in_at: null }))).toBe(true);
    expect(isInvitePending(member({ status: "invited" }))).toBe(true);
    expect(isInvitePending(member())).toBe(false);
    expect(memberState(member({ email_confirmed_at: null, last_sign_in_at: null }))).toBe("pending");
    expect(memberState(member({ status: "suspended" }))).toBe("suspended");
    expect(memberState(member({ status: "inactive" }))).toBe("inactive");
  });
  it("activo: rol, suspender y resetear; nunca sobre uno mismo", () => {
    expect(memberActions("admin", member(), "otro", 1)).toEqual(["set_role", "suspend", "reset_access"]);
    expect(memberActions("admin", member(), "u1", 1)).toEqual([]);
  });
  it("pendiente: reenviar, rol y suspender (sin reset)", () => {
    const m = member({ email_confirmed_at: null, last_sign_in_at: null });
    expect(memberActions("admin", m, null, 1)).toEqual(["resend_invite", "set_role", "suspend"]);
  });
  it("suspendido: reactivar; dado de baja por el negocio: nada", () => {
    expect(memberActions("admin", member({ status: "suspended" }), null, 1)).toEqual([
      "set_role",
      "reactivate",
      "reset_access",
    ]);
    expect(memberActions("super_admin", member({ status: "inactive" }), null, 1)).toEqual([]);
  });
  it("único dueño activo: no se suspende ni se le cambia el rol", () => {
    const owner = member({ role: "owner" });
    expect(memberActions("super_admin", owner, null, 1)).toEqual(["reset_access"]);
    expect(memberActions("super_admin", owner, null, 2)).toEqual(["set_role", "suspend", "reset_access"]);
    // un admin no toca el rol de un dueño aunque haya otro
    expect(memberActions("admin", owner, null, 2)).toEqual(["suspend", "reset_access"]);
  });
  it("soporte ve sólo resetear", () => {
    expect(memberActions("support", member(), null, 1)).toEqual(["reset_access"]);
  });
  it("mensajes de error del servidor", () => {
    expect(memberErrorMessage("last_owner")).toMatch(/dueño activo/);
    expect(memberErrorMessage('new row violates "forbidden_super_admin_only"')).toMatch(/super admin/);
    expect(memberErrorMessage(undefined)).toMatch(/No se pudo/);
  });
});

// ── Segmentos ────────────────────────────────────────────────────────────────
function tenant(p: Partial<SegmentTenant> = {}): SegmentTenant {
  return {
    id: "t1",
    name: "Kiosco",
    status: "active",
    subStatus: "active",
    planFamily: "pro",
    industry: "kiosco",
    created_at: "2026-09-15T10:00:00Z",
    deletedAt: null,
    ...p,
  };
}

describe("segmentos", () => {
  it("vacío no matchea a nadie y pide criterio", () => {
    expect(isEmptySegment(EMPTY_SEGMENT)).toBe(true);
    expect(segmentError(EMPTY_SEGMENT)).toMatch(/al menos un criterio/);
    expect(segmentTenants([tenant()], EMPTY_SEGMENT)).toEqual([]);
  });
  it("plan por familia, estado de la suscripción, rubro y fechas inclusive", () => {
    const s = { ...EMPTY_SEGMENT, plans: ["pro"], statuses: ["active"] };
    expect(matchesSegment(tenant(), s)).toBe(true);
    expect(matchesSegment(tenant({ planFamily: "start" }), s)).toBe(false);
    expect(matchesSegment(tenant({ subStatus: "past_due" }), s)).toBe(false);
    expect(matchesSegment(tenant({ subStatus: null, status: "active" }), s)).toBe(true);
    expect(matchesSegment(tenant({ industry: null }), { ...EMPTY_SEGMENT, industries: ["otro"] })).toBe(true);
    const d = { ...EMPTY_SEGMENT, createdFrom: "2026-09-15", createdTo: "2026-09-15" };
    expect(matchesSegment(tenant(), d)).toBe(true);
    expect(matchesSegment(tenant({ created_at: "2026-09-16T00:00:00Z" }), d)).toBe(false);
  });
  it("los dados de baja nunca entran", () => {
    expect(matchesSegment(tenant({ deletedAt: "2026-10-01T00:00:00Z" }), { ...EMPTY_SEGMENT, plans: ["pro"] })).toBe(false);
  });
  it("fechas invertidas o mal formadas", () => {
    expect(segmentError({ ...EMPTY_SEGMENT, createdFrom: "2026-10-02", createdTo: "2026-10-01" })).toMatch(/posterior/);
    expect(segmentError({ ...EMPTY_SEGMENT, createdFrom: "02/10/2026" })).toMatch(/inválida/);
  });
  it("payload de la RPC sólo con los criterios usados y vuelta", () => {
    const s = { ...EMPTY_SEGMENT, plans: ["start"], createdFrom: "2026-01-01" };
    const rpc = toRpcSegment(s);
    expect(rpc).toEqual({ plans: ["start"], created_from: "2026-01-01" });
    expect(fromRpcSegment(rpc)).toEqual(s);
    expect(fromRpcSegment(null)).toEqual(EMPTY_SEGMENT);
  });
  it("resumen legible y toggle", () => {
    expect(segmentSummary({ ...EMPTY_SEGMENT, plans: ["pro", "business"], industries: ["kiosco"] }, { kiosco: "Kiosco" })).toBe(
      "Plan Pro o Business · Rubro Kiosco",
    );
    expect(toggleValue(["a"], "a")).toEqual([]);
    expect(toggleValue(["a"], "b")).toEqual(["a", "b"]);
  });
  it("historial: agrupa por lote", () => {
    const rows = [
      { id: "1", segmentBatchId: "b" },
      { id: "2", segmentBatchId: null },
      { id: "3", segmentBatchId: "b" },
    ];
    const g = groupByBatch(rows);
    expect(g).toHaveLength(2);
    expect(g[0]).toMatchObject({ count: 2, ids: ["1", "3"] });
    expect(g[1]).toMatchObject({ count: 1, ids: ["2"] });
  });
});

// ── Salud por negocio ────────────────────────────────────────────────────────
const NOW = new Date("2026-10-13T12:00:00Z");
const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

describe("salud por negocio", () => {
  it("negocio sano", () => {
    const h = tenantHealthScore(
      { status: "active", createdAt: days(60), lastLoginAt: days(0), lastSaleAt: days(0), sales7dCount: 40, activeUsers: 3 },
      NOW,
    );
    expect(h).toEqual({ score: 100, level: "ok", reasons: [] });
  });
  it("suspendido o cancelado: 0 y en riesgo", () => {
    expect(tenantHealthScore({ status: "suspended", createdAt: null, lastLoginAt: null, lastSaleAt: null, sales7dCount: 0, activeUsers: 0 }, NOW)).toEqual({
      score: 0,
      level: "risk",
      reasons: ["Suspendido"],
    });
  });
  it("suma penalidades con motivos", () => {
    const h = tenantHealthScore(
      {
        status: "past_due",
        createdAt: days(90),
        lastLoginAt: days(20),
        lastSaleAt: days(30),
        sales7dCount: 0,
        activeUsers: 2,
        webhookErrors7d: 3,
      },
      NOW,
    );
    expect(h.score).toBe(100 - 30 - 25 - 25 - 10);
    expect(h.level).toBe("risk");
    expect(h.reasons).toContain("Pago pendiente");
    expect(h.reasons).toContain("Sin ventas hace 30 días");
    expect(h.reasons).toContain("3 errores de cobro en 7 días");
  });
  it("negocio recién creado no se castiga por no vender aún", () => {
    const h = tenantHealthScore(
      { status: "trial", createdAt: days(1), lastLoginAt: days(0), lastSaleAt: null, sales7dCount: 0, activeUsers: 1 },
      NOW,
    );
    expect(h.level).toBe("ok");
  });
  it("trial por vencer sin uso", () => {
    const h = tenantHealthScore(
      {
        status: "trial",
        createdAt: days(12),
        trialEndsAt: new Date(NOW.getTime() + 2 * 86_400_000).toISOString(),
        lastLoginAt: days(1),
        lastSaleAt: null,
        sales7dCount: 0,
        activeUsers: 1,
      },
      NOW,
    );
    expect(h.reasons).toContain("Trial vence en 2 días sin uso");
    expect(h.level).toBe("attention");
  });
  it("lista de riesgo: peores primero, sin sanos ni suspendidos", () => {
    const mk = (id: string, score: number, level: "ok" | "attention" | "risk") => ({
      tenant: { id, created_at: "2026-01-0" + id + "T00:00:00Z" },
      health: { score, level, reasons: [] },
    });
    const out = atRiskTenants([mk("1", 100, "ok"), mk("2", 50, "attention"), mk("3", 10, "risk"), mk("4", 0, "risk")]);
    expect(out.map((r) => r.tenant.id)).toEqual(["3", "2"]);
  });
});

// ── Ficha 360 ────────────────────────────────────────────────────────────────
describe("ficha 360", () => {
  it("normaliza y tolera faltantes", () => {
    const f = parseTenant360({
      members: { total: 3, active: "2", owners: 1, last_login_at: "2026-10-10T00:00:00Z" },
      stores: 2,
      sales: { d30_count: 10, d30_total: "1500.50" },
      modules: [
        { key: "pos", label: "POS", grupo: "base", is_basic: true, enabled: true },
        { key: "variantes", label: "Variantes", grupo: "catalogo", enabled: false },
      ],
      errors: [
        { source: "email", label: "x", at: "2026-10-01T00:00:00Z" },
        { source: "webhook", label: "mp", detail: "401", at: "2026-10-05T00:00:00Z" },
        { source: "raro", label: "?", at: "2026-09-01T00:00:00Z" },
      ],
      activity: [{ action: "tenant_suspended", entity_type: "tenants", created_at: "2026-10-02T00:00:00Z" }],
      webhook_errors_7d: 2,
    });
    expect(f.members.active).toBe(2);
    expect(f.members.lastLoginAt).toBe("2026-10-10T00:00:00Z");
    expect(f.registers).toBe(0);
    expect(f.sales.d30Total).toBe(1500.5);
    expect(f.modules.find((m) => m.key === "variantes")?.isBasic).toBe(false);
    expect(f.errors.map((e) => e.source)).toEqual(["webhook", "email", "email"]);
    expect(f.activity[0]?.actorEmail).toBeNull();
    expect(f.webhookErrors7d).toBe(2);
    expect(parseTenant360(null).modules).toEqual([]);
  });
  it("módulos agrupados, activos primero", () => {
    const g = groupModules([
      { key: "b", label: "B", grupo: "x", isBasic: false, enabled: false },
      { key: "a", label: "A", grupo: "x", isBasic: false, enabled: true },
      { key: "c", label: "C", grupo: "y", isBasic: true, enabled: true },
    ]);
    expect(g.map((x) => x.grupo)).toEqual(["x", "y"]);
    expect(g[0]?.items.map((i) => i.key)).toEqual(["a", "b"]);
  });
});

describe("auditoría: acciones nuevas con etiqueta y categoría de accesos", () => {
  it.each([
    "impersonation_started",
    "impersonation_ended",
    "member_invited_internal",
    "member_invite_resent",
    "member_role_changed_internal",
    "member_suspended_internal",
    "member_reactivated_internal",
    "member_access_reset_internal",
  ])("%s", (action) => {
    const d = describeAuditAction("tenant_users", action);
    expect(d.category).toBe("access");
    expect(d.label).not.toMatch(/_/);
  });
});
