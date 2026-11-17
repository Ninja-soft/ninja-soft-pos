// SEC-27: toda Edge que usa el tenant del JWT valida la membresía.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  TENANT_AUTH_DENIAL,
  authOutcome,
  claimTenantId,
  isBanned,
  membershipOutcome,
  type MembershipDb,
} from "@/supabase/functions/_shared/tenantMember";

const ROOT = path.resolve(__dirname, "..", "..");
const FUNCTIONS = path.join(ROOT, "supabase", "functions");

// Edges migradas a requireTenantMember (SEC-27). No pueden volver al chequeo inline.
const MIGRATED = [
  "dlocalgo",
  "getnet",
  "gocuotas",
  "mobbex_create_qr",
  "mp_create_qr",
  "mp_cupon",
  "mp_point",
  "talo",
  "tiendita_copy_image",
  "ualabis",
  "viumi",
];

// Leen current_tenant_id pero validan de otra forma (verificado a mano).
const ALLOWLIST: Record<string, { reason: string; mustMatch: RegExp }> = {
  arca_padron: {
    reason: "RPC arca_padron_guard: tenant_users activo + feature padron_arca (20261128100100).",
    mustMatch: /rpc\("arca_padron_guard"/,
  },
  geo: {
    reason: "RPC geo_guard: tenant_users activo + feature direcciones_geo (20261226100000).",
    mustMatch: /rpc\("geo_guard"/,
  },
  routing: {
    reason: "RPC routing_guard: tenant_users activo + feature + capacidad logistics.route.manage (20270102100000).",
    mustMatch: /rpc\("routing_guard"/,
  },
  internal_create_tenant: {
    reason: "Sólo staff (is_internal): no usa el claim para autorizar, lo ESCRIBE en el dueño nuevo.",
    mustMatch: /if \(!meta\.is_internal\) return json\(\{ error: "forbidden" \}, 403\)/,
  },
};

const GUARD_RPC = /^[a-z0-9_]*(_edge_guard[a-z0-9_]*|_access_check|_mp_refund_claim|is_tenant_manager)$/;

// Análisis con el AST de TypeScript: strings, templates y comentarios no
// cuentan (un "/*" dentro de un string no esconde código, y un
// "requireTenantMember(" en un comentario no vale como guard).
type EdgeScan = {
  readsClaim: boolean;
  callsHelper: boolean;
  importsHelper: boolean;
  guardRpc: boolean;
  queriesTenantUsers: boolean;
  /** Posición de la primera llamada a requireTenantMember (-1 si no hay). */
  helperAt: number;
  /** Posición del primer admin.from / admin.storage / admin.rpc (-1 si no hay). */
  firstAdminUseAt: number;
};

const calleeName = (e: ts.Expression): string | null =>
  ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : null;
const firstStringArg = (c: ts.CallExpression): string | null => {
  const a = c.arguments[0];
  return a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) ? a.text : null;
};

function scanEdge(src: string, fileName = "index.ts"): EdgeScan {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: EdgeScan = {
    readsClaim: false,
    callsHelper: false,
    importsHelper: false,
    guardRpc: false,
    queriesTenantUsers: false,
    helperAt: -1,
    firstAdminUseAt: -1,
  };
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === "current_tenant_id") out.readsClaim = true;
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteral(node.argumentExpression) &&
      node.argumentExpression.text === "current_tenant_id"
    ) {
      out.readsClaim = true;
    }
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "../_shared/tenantAuth.ts" &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings) &&
      node.importClause.namedBindings.elements.some((el) => el.name.text === "requireTenantMember")
    ) {
      out.importsHelper = true;
    }
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      const arg = firstStringArg(node);
      if (ts.isIdentifier(node.expression) && name === "requireTenantMember") {
        out.callsHelper = true;
        if (out.helperAt < 0) out.helperAt = node.getStart(sf);
      }
      if (name === "rpc" && arg && GUARD_RPC.test(arg)) out.guardRpc = true;
      if (ts.isPropertyAccessExpression(node.expression) && name === "from" && arg === "tenant_users") {
        out.queriesTenantUsers = true;
      }
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "admin" &&
      ["from", "storage", "rpc"].includes(node.name.text)
    ) {
      const at = node.getStart(sf);
      if (out.firstAdminUseAt < 0 || at < out.firstAdminUseAt) out.firstAdminUseAt = at;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const guarded = (s: EdgeScan) => s.callsHelper || s.guardRpc || s.queriesTenantUsers;

const edges = fs
  .readdirSync(FUNCTIONS, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
  .map((d) => d.name)
  .filter((d) => fs.existsSync(path.join(FUNCTIONS, d, "index.ts")));
const raw = (fn: string) => fs.readFileSync(path.join(FUNCTIONS, fn, "index.ts"), "utf8");
const scan = (fn: string) => scanEdge(raw(fn), `${fn}/index.ts`);

describe("SEC-27 · escáner de Edges", () => {
  it('un "/*" dentro de un string no esconde código, y strings/comentarios no cuentan como guard', () => {
    const src = [
      'const open = "/*";',
      "const tenantId = (user.app_metadata as { current_tenant_id?: string }).current_tenant_id;",
      'const close = "*/";',
      "const fake = 'requireTenantMember(req)'; // requireTenantMember(req)",
      '/* await admin.from("tenant_users").select("role") */',
      'const tpl = `admin.from("tenant_users") ${tenantId}`;',
      'await admin.rpc("tenant_has_feature_for", { p_tenant: tenantId });',
    ].join("\n");
    const s = scanEdge(src);
    expect(s.readsClaim).toBe(true);
    expect(s.callsHelper).toBe(false);
    expect(s.queriesTenantUsers).toBe(false);
    expect(s.guardRpc).toBe(false);
    expect(guarded(s)).toBe(false);
  });

  it("reconoce las llamadas reales", () => {
    const meta = "const t = user.app_metadata.current_tenant_id;\n";
    expect(scanEdge(meta + "const m = await requireTenantMember(req, { respond: json });").callsHelper).toBe(true);
    expect(scanEdge(meta + 'await admin.from("tenant_users").select("role");').queriesTenantUsers).toBe(true);
    expect(scanEdge(meta + 'await admin.rpc("ml_edge_guard_billing", {});').guardRpc).toBe(true);
    expect(scanEdge(meta + 'await admin.rpc("shipping_access_check", {});').guardRpc).toBe(true);
    expect(scanEdge('const x = rpc("current_tenant_id");').readsClaim).toBe(false);
    expect(scanEdge('const x = meta["current_tenant_id"];').readsClaim).toBe(true);
  });
});

describe("SEC-27 · membresía en las Edge Functions (estático)", () => {
  it("toda Edge que lee current_tenant_id valida la membresía", () => {
    const missing = edges.filter((fn) => {
      const s = scan(fn);
      return s.readsClaim && !guarded(s) && !ALLOWLIST[fn];
    });
    expect(missing).toEqual([]);
  });

  it("la allowlist está al día (cada excepción sigue leyendo el claim y conserva su guard)", () => {
    for (const [fn, { mustMatch }] of Object.entries(ALLOWLIST)) {
      expect(edges, fn).toContain(fn);
      const s = scan(fn);
      expect(s.readsClaim, fn).toBe(true);
      expect(guarded(s), `${fn}: ya tiene guard reconocido, sacala de la allowlist`).toBe(false);
      expect(raw(fn), fn).toMatch(mustMatch);
    }
  });

  it("las Edges migradas usan el helper y no repiten la consulta inline", () => {
    for (const fn of MIGRATED) {
      const s = scan(fn);
      expect(s.importsHelper, fn).toBe(true);
      expect(s.callsHelper, fn).toBe(true);
      expect(raw(fn), fn).toMatch(/if \(member instanceof Response\) return member;/);
      expect(s.queriesTenantUsers, fn).toBe(false);
      expect(s.readsClaim, fn).toBe(false);
    }
  });

  it("tiendita_copy_image ya no copia con service_role sin chequear membresía", () => {
    const s = scan("tiendita_copy_image");
    expect(s.helperAt).toBeGreaterThan(-1);
    expect(s.firstAdminUseAt).toBeGreaterThan(s.helperAt);
  });
});

// ── lógica pura del helper ───────────────────────────────────────────────────

type Rows = {
  member?: { role: string } | null;
  memberError?: unknown;
  userRow?: { suspended_at: string | null } | null;
  userError?: unknown;
  throws?: boolean;
};

function fakeDb(rows: Rows) {
  const calls: { table: string; filters: [string, unknown][] }[] = [];
  const db: MembershipDb = {
    from(table: string) {
      const filters: [string, unknown][] = [];
      calls.push({ table, filters });
      const q = {
        eq(column: string, value: unknown) {
          filters.push([column, value]);
          return q;
        },
        maybeSingle() {
          if (rows.throws) return Promise.reject(new Error("network"));
          if (table === "tenant_users") {
            return Promise.resolve({ data: rows.member ?? null, error: rows.memberError ?? null });
          }
          return Promise.resolve({ data: rows.userRow ?? null, error: rows.userError ?? null });
        },
      };
      return { select: () => q };
    },
  };
  return { db, calls };
}

const USER = { id: "u-1", app_metadata: { current_tenant_id: "t-1" } };

describe("SEC-27 · tenantMember (lógica pura)", () => {
  it("claimTenantId", () => {
    expect(claimTenantId({ current_tenant_id: "t-1" })).toBe("t-1");
    expect(claimTenantId({ current_tenant_id: " " })).toBeNull();
    expect(claimTenantId({})).toBeNull();
    expect(claimTenantId(null)).toBeNull();
  });

  it("authOutcome: 401 sin usuario o con error, 400 sin claim", () => {
    expect(authOutcome({ data: { user: null }, error: null })).toEqual({ ok: false, failure: "unauthorized" });
    expect(authOutcome({ data: { user: USER }, error: { message: "jwt expired" } })).toEqual({
      ok: false,
      failure: "unauthorized",
    });
    expect(authOutcome({ data: null, error: null })).toEqual({ ok: false, failure: "unauthorized" });
    expect(authOutcome({ data: { user: { id: "u", app_metadata: {} } }, error: null })).toEqual({
      ok: false,
      failure: "no_tenant",
    });
    expect(authOutcome({ data: { user: USER }, error: null })).toEqual({ ok: true, user: USER, tenantId: "t-1" });
  });

  it("respuestas por defecto idénticas a las Edges inline", () => {
    expect(TENANT_AUTH_DENIAL).toEqual({
      unauthorized: { status: 401, body: { error: "unauthorized" } },
      no_tenant: { status: 400, body: { error: "no_tenant" } },
      forbidden: { status: 403, body: { error: "forbidden" } },
    });
  });

  it("miembro activo pasa con su rol; consulta la misma fila que el chequeo inline", async () => {
    const { db, calls } = fakeDb({ member: { role: "cashier" }, userRow: { suspended_at: null } });
    expect(await membershipOutcome(db, USER, "t-1")).toEqual({ ok: true, role: "cashier" });
    const tu = calls.find((c) => c.table === "tenant_users");
    expect(tu?.filters).toEqual([
      ["tenant_id", "t-1"],
      ["user_id", "u-1"],
      ["status", "active"],
    ]);
    expect(calls.find((c) => c.table === "users")?.filters).toEqual([["id", "u-1"]]);
  });

  it("403 si no es miembro activo, está suspendido, el rol no alcanza o falla la lectura", async () => {
    const out = (rows: Rows, roles?: string[]) => membershipOutcome(fakeDb(rows).db, USER, "t-1", { roles });
    expect(await out({ member: null })).toEqual({ ok: false, failure: "forbidden", reason: "not_member" });
    expect(await out({ member: { role: "owner" }, userRow: { suspended_at: "2026-11-01T00:00:00Z" } })).toEqual({
      ok: false,
      failure: "forbidden",
      reason: "user_suspended",
    });
    expect(await out({ member: { role: "cashier" } }, ["owner", "manager"])).toEqual({
      ok: false,
      failure: "forbidden",
      reason: "role_not_allowed",
    });
    expect(await out({ member: { role: "manager" } }, ["owner", "manager"])).toMatchObject({ ok: true, role: "manager" });
    expect(await out({ memberError: { message: "boom" } })).toMatchObject({ ok: false, reason: "lookup_failed" });
    expect(await out({ member: { role: "owner" }, userError: { message: "boom" } })).toMatchObject({
      ok: false,
      reason: "lookup_failed",
    });
    expect(await out({ throws: true })).toMatchObject({ ok: false, reason: "lookup_failed" });
    // Sin fila en users (no debería pasar): no cuenta como suspendido.
    expect(await out({ member: { role: "viewer" }, userRow: null })).toMatchObject({ ok: true, role: "viewer" });
  });

  it("ban de Auth vigente (banned_until futuro): 403 sin consultar la base", async () => {
    const now = new Date("2026-11-17T12:00:00Z");
    const banned = { ...USER, banned_until: "2026-12-01T00:00:00Z" };
    expect(isBanned(banned, now)).toBe(true);
    expect(isBanned({ ...USER, banned_until: "2026-11-01T00:00:00Z" }, now)).toBe(false);
    expect(isBanned({ ...USER, banned_until: null }, now)).toBe(false);
    expect(isBanned({ ...USER, banned_until: "" }, now)).toBe(false);
    expect(isBanned({ ...USER, banned_until: "no-es-fecha" }, now)).toBe(false);
    expect(isBanned(USER, now)).toBe(false);
    const fake = fakeDb({ member: { role: "owner" } });
    expect(await membershipOutcome(fake.db, banned, "t-1", { now })).toEqual({
      ok: false,
      failure: "forbidden",
      reason: "banned",
    });
    expect(fake.calls).toEqual([]);
    // Ban vencido: sigue el chequeo normal.
    expect(
      await membershipOutcome(fakeDb({ member: { role: "owner" } }).db, { ...USER, banned_until: "2026-01-01T00:00:00Z" }, "t-1", {
        now,
      }),
    ).toEqual({ ok: true, role: "owner" });
  });

  it("staff interno sin fila en tenant_users: 403 (no hay bypass)", async () => {
    const staff = { id: "s-1", app_metadata: { current_tenant_id: "t-1", is_internal: true } };
    expect(await membershipOutcome(fakeDb({ member: null }).db, staff, "t-1")).toMatchObject({
      ok: false,
      reason: "not_member",
    });
  });
});
