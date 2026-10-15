// @vitest-environment node
// =============================================================================
// Inventario: ajustes de stock con aprobación y capacidades (ADR-137 sobre
// el modelo único de permisos de ADR-138; migraciones 20261203100000,
// 20261204100000..100200 y 20261204100300). RLS, capacidad, plan,
// maker-checker, importación y auditoría.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea datos.
//
// Escenario: negocio A con aprobacion_ajustes e importacion_excel (add-ons),
// dueño, encargado, cajero (después auditor) y solo lectura; negocio B sin
// la feature opcional.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { argentinaDay } from "@/lib/permissions/roles";
import { fmtDateTimeAR } from "@/lib/stock/inventorySheet";
import { SYSTEM_ROLE_BY_KEY } from "@/lib/permissions/capabilities";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `adj-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type User = { id: string; client: SupabaseClient };
const ctx = {} as {
  admin: SupabaseClient;
  tenant: string;
  tenantB: string;
  owner: User;
  manager: User;
  cashier: User;
  viewer: User;
  ownerB: User;
  userIds: string[];
  store: string;
  product: string;
  sku: string;
};

type RpcRes<T = unknown> = { data: T; error: { message: string } | null };
const rpc = <T = unknown>(c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcRes<T>>;

async function makeUser(admin: SupabaseClient, email: string, tenantId: string, role: string): Promise<User> {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    app_metadata: { current_tenant_id: tenantId },
  });
  if (error) throw error;
  const id = data.user!.id;
  ctx.userIds.push(id);
  await admin.from("users").upsert({ id, email, full_name: email.split("@")[0] });
  const { error: tuErr } = await admin.from("tenant_users").insert({ tenant_id: tenantId, user_id: id, role, status: "active" });
  if (tuErr) throw tuErr;
  const client = createClient(URL_!, ANON!, { auth: { persistSession: false } });
  const { error: sErr } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr) throw sErr;
  return { id, client };
}

async function stockOf(): Promise<number> {
  const { data } = await ctx.admin.from("products").select("stock").eq("id", ctx.product).single();
  return Number((data as { stock: number }).stock);
}

async function auditActions(entityId: string): Promise<string[]> {
  const { data } = await ctx.admin.from("audit_logs").select("action").eq("entity_id", entityId);
  return ((data ?? []) as { action: string }[]).map((r) => r.action);
}

type Req = { id: string | null; status: string; delta: number };
const request = (u: User, p: Record<string, unknown>) =>
  rpc<Req>(u.client, "stock_adjustment_request", {
    p: { store_id: ctx.store, product_id: ctx.product, ...p },
  });

describe.skipIf(!enabled)("Inventario · ajustes con aprobación y capacidades (ADR-137)", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];
    const { data: t, error } = await admin
      .from("tenants")
      .insert([
        { name: `Adj A ${STAMP}`, slug: `aa-${STAMP}`, status: "active" },
        { name: `Adj B ${STAMP}`, slug: `ab-${STAMP}`, status: "active" },
      ])
      .select("id, slug");
    if (error || !t) throw error ?? new Error("tenants");
    const rows = t as { id: string; slug: string }[];
    ctx.tenant = rows.find((x) => x.slug === `aa-${STAMP}`)!.id;
    ctx.tenantB = rows.find((x) => x.slug === `ab-${STAMP}`)!.id;

    const { error: aErr } = await admin.from("subscription_addons").insert(
      ["aprobacion_ajustes", "importacion_excel"].map((key) => ({
        tenant_id: ctx.tenant,
        addon_key: key,
        status: "active",
        source: "granted",
      })),
    );
    if (aErr) throw aErr;

    ctx.owner = await makeUser(admin, `own-${STAMP}@test.local`, ctx.tenant, "owner");
    ctx.manager = await makeUser(admin, `mgr-${STAMP}@test.local`, ctx.tenant, "manager");
    ctx.cashier = await makeUser(admin, `caj-${STAMP}@test.local`, ctx.tenant, "cashier");
    ctx.viewer = await makeUser(admin, `ver-${STAMP}@test.local`, ctx.tenant, "viewer");
    ctx.ownerB = await makeUser(admin, `ownb-${STAMP}@test.local`, ctx.tenantB, "owner");

    const { data: store, error: sErr } = await ctx.owner.client.from("stores").insert({ name: "Centro" } as never).select("id").single();
    if (sErr || !store) throw sErr ?? new Error("store");
    ctx.store = (store as { id: string }).id;
    ctx.sku = `SKU-${STAMP}`;
    const { data: prod, error: pErr } = await ctx.owner.client
      .from("products")
      .insert({ tenant_id: ctx.tenant, name: `Coca ${STAMP}`, sku: ctx.sku, price: 200, cost: 100, track_stock: true } as never)
      .select("id")
      .single();
    if (pErr || !prod) throw pErr ?? new Error("product");
    ctx.product = (prod as { id: string }).id;
  }, 180_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin || !ctx.tenant) return;
    for (const t of [ctx.tenant, ctx.tenantB]) {
      await admin.from("subscription_addons").delete().eq("tenant_id", t);
      // audit_logs es inmutable (ADR-083): si el negocio no se puede borrar
      // por sus auditorías, queda (datos de prueba con sello único).
      await admin.from("tenants").delete().eq("id", t);
    }
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 120_000);

  it("capacidades efectivas por rol = espejo TS (catálogo único)", async () => {
    for (const [u, role] of [
      [ctx.manager, "manager"],
      [ctx.cashier, "cashier"],
      [ctx.viewer, "viewer"],
    ] as const) {
      const { data, error } = await rpc<{ capabilities: string[] }>(u.client, "my_capabilities");
      expect(error, role).toBeNull();
      expect([...(data?.capabilities ?? [])].sort(), role).toEqual([...SYSTEM_ROLE_BY_KEY.get(role)!.capabilities].sort());
    }
  });

  it("el encargado ajusta en el momento; el cajero y solo lectura no", async () => {
    const r = await request(ctx.manager, { mode: "add", qty: 30, reason: "ingreso" });
    expect(r.error).toBeNull();
    expect(r.data.status).toBe("applied");
    expect(await stockOf()).toBe(30);
    expect(await auditActions(r.data.id!)).toContain("stock_adjustment_applied");

    const c = await request(ctx.cashier, { mode: "add", qty: 1, reason: "ingreso" });
    expect(c.error?.message).toMatch(/forbidden_capability/);
    const v = await request(ctx.viewer, { mode: "add", qty: 1, reason: "ingreso" });
    expect(v.error?.message).toMatch(/forbidden_read_only/);
  });

  it("nadie escribe las tablas nuevas por REST", async () => {
    const a = await ctx.owner.client
      .from("stock_adjustments" as never)
      .insert({ tenant_id: ctx.tenant, store_id: ctx.store, product_id: ctx.product, mode: "add", qty: 1, reason: "ingreso", system_qty: 0, delta: 1 } as never);
    expect(a.error).not.toBeNull();
    const p = await ctx.owner.client
      .from("stock_adjustment_policy" as never)
      .insert({ tenant_id: ctx.tenant, approval_enabled: false } as never);
    expect(p.error).not.toBeNull();
    const m = await ctx.owner.client
      .from("permission_user_overrides" as never)
      .insert({ tenant_id: ctx.tenant, user_id: ctx.cashier.id, capability: "stock.adjust", effect: "grant" } as never);
    expect(m.error).not.toBeNull();
  });

  it("otro negocio no ve los ajustes ni la política", async () => {
    const { data } = await ctx.ownerB.client.from("stock_adjustments" as never).select("id").eq("tenant_id", ctx.tenant);
    expect(data ?? []).toHaveLength(0);
    const l = await rpc<unknown[]>(ctx.ownerB.client, "stock_adjustments_list", { p_store_id: ctx.store });
    expect(l.error?.message ?? "").toMatch(/store_forbidden|forbidden/);
    const s = await rpc(ctx.ownerB.client, "inventory_stock_sheet", { p_store_id: ctx.store });
    expect(s.error?.message ?? "").toMatch(/store_not_found|forbidden/);
  });

  it("negocio sin la feature no prende la aprobación", async () => {
    const r = await rpc(ctx.ownerB.client, "stock_adjustment_policy_save", { p: { approval_enabled: true } });
    expect(r.error?.message).toMatch(/feature_not_in_plan: aprobacion_ajustes/);
  });

  it("umbral: pendiente, auditor aprueba, nadie aprueba lo propio, rechazo con motivo", async () => {
    expect((await rpc(ctx.manager.client, "stock_adjustment_policy_save", { p: { approval_enabled: true } })).error?.message).toMatch(/forbidden/);
    const save = await rpc(ctx.owner.client, "stock_adjustment_policy_save", {
      p: { approval_enabled: true, approver: "auditor", threshold_units: 10 },
    });
    expect(save.error).toBeNull();

    const small = await request(ctx.manager, { mode: "remove", qty: 2, reason: "rotura" });
    expect(small.data.status).toBe("applied");
    const big = await request(ctx.manager, { mode: "remove", qty: 12, reason: "robo", notes: "faltante" });
    expect(big.data.status).toBe("pending");
    expect(await stockOf()).toBe(28);

    // Encargado sin el permiso no aprueba; solo lectura no puede ser auditor.
    expect((await rpc(ctx.manager.client, "stock_adjustment_decide", { p_id: big.data.id, p_approve: true })).error?.message).toMatch(/forbidden_approver/);
    // El auditor es un permiso puntual del modelo único (permission_override_set).
    expect(
      (await rpc(ctx.owner.client, "permission_override_set", { p_user: ctx.viewer.id, p_capability: "stock.adjust.approve", p_effect: "grant" })).error?.message,
    ).toMatch(/capability_needs_higher_base/);
    expect(
      (await rpc(ctx.manager.client, "permission_override_set", { p_user: ctx.cashier.id, p_capability: "stock.adjust.approve", p_effect: "grant" })).error?.message,
    ).toMatch(/forbidden/);
    const grant = await rpc(ctx.owner.client, "permission_override_set", {
      p_user: ctx.cashier.id, p_capability: "stock.adjust.approve", p_effect: "grant", p_reason: "auditor",
    });
    expect(grant.error).toBeNull();
    expect(await auditActions(ctx.cashier.id)).toContain("permission_override_set");

    const rej = await rpc(ctx.cashier.client, "stock_adjustment_decide", { p_id: big.data.id, p_approve: false });
    expect(rej.error?.message).toMatch(/decision_notes_required/);
    const ok = await rpc<{ status: string }>(ctx.cashier.client, "stock_adjustment_decide", { p_id: big.data.id, p_approve: true });
    expect(ok.error).toBeNull();
    expect(await stockOf()).toBe(16);
    expect(await auditActions(big.data.id!)).toEqual(expect.arrayContaining(["stock_adjustment_requested", "stock_adjustment_approved"]));

    // El dueño otorga stock.adjust al cajero-auditor: lo que pide no lo aprueba él.
    await rpc(ctx.owner.client, "permission_override_set", { p_user: ctx.cashier.id, p_capability: "stock.adjust", p_effect: "grant" });
    const own = await request(ctx.cashier, { mode: "remove", qty: 11, reason: "vencimiento" });
    expect(own.data.status).toBe("pending");
    const self = await rpc(ctx.cashier.client, "stock_adjustment_decide", { p_id: own.data.id, p_approve: true });
    expect(self.error?.message).toMatch(/self_approval_forbidden/);
    const no = await rpc(ctx.owner.client, "stock_adjustment_decide", { p_id: own.data.id, p_approve: false, p_notes: "Contalo de nuevo" });
    expect(no.error).toBeNull();
    expect(await stockOf()).toBe(16);

    // El dueño nunca espera.
    const mine = await request(ctx.owner, { mode: "add", qty: 50, reason: "ingreso" });
    expect(mine.data.status).toBe("applied");
  });

  it("historial con quién pidió y quién aprobó, en hora de Argentina", async () => {
    const { data, error } = await rpc<
      { status: string; requested_by: string; decided_by: string | null; requested_at: string; value: number | null }[]
    >(ctx.manager.client, "stock_adjustments_list", { p_store_id: ctx.store });
    expect(error).toBeNull();
    const approved = data.find((r) => r.status === "applied" && r.decided_by === ctx.cashier.id);
    expect(approved?.requested_by).toBe(ctx.manager.id);
    // La fecha que se muestra es el día de Argentina en que se pidió.
    const shown = fmtDateTimeAR(approved!.requested_at).slice(0, 10).split("/").reverse().join("-");
    expect(shown).toBe(argentinaDay(approved!.requested_at));
    // El cajero ve el historial pero no los valores.
    const c = await rpc<{ value: number | null }[]>(ctx.cashier.client, "stock_adjustments_list", { p_store_id: ctx.store });
    expect(c.data.every((r) => r.value === null)).toBe(true);
  });

  it("importación: dry-run no escribe y aplica con una auditoría por lote", async () => {
    const before = await stockOf();
    const rows = [
      { _row: 2, sku: ctx.sku, op: "set", qty: before + 1, reason: "conteo" },
      { _row: 3, sku: "NO-EXISTE", op: "add", qty: 1, reason: "ingreso" },
      { _row: 4, sku: ctx.sku, op: "set", qty: null, reason: "conteo" },
    ];
    const dry = await rpc<{ applied: boolean; updated: number; errors: number; skipped: number }>(
      ctx.manager.client, "import_stock_adjustments", { p_rows: rows, p_apply: false, p_file_name: "conteo.xlsx" },
    );
    expect(dry.error).toBeNull();
    expect(dry.data).toMatchObject({ applied: false, updated: 1, errors: 1, skipped: 1 });
    expect(await stockOf()).toBe(before);
    const cashier = await rpc(ctx.cashier.client, "import_stock_adjustments", { p_rows: rows, p_apply: true });
    expect(cashier.error?.message).toMatch(/forbidden/);
    const app = await rpc<{ applied: boolean; updated: number }>(
      ctx.manager.client, "import_stock_adjustments", { p_rows: rows, p_apply: true, p_file_name: "conteo.xlsx" },
    );
    expect(app.data).toMatchObject({ applied: true, updated: 1 });
    expect(await stockOf()).toBe(before + 1);
  });

  it("planilla, movimientos y valuación con permisos", async () => {
    const sheet = await rpc<{ cost: number | null; store_qty: number }[]>(ctx.cashier.client, "inventory_stock_sheet", { p_store_id: ctx.store });
    expect(sheet.error).toBeNull();
    expect(sheet.data.every((r) => r.cost === null)).toBe(true);
    const val = await rpc(ctx.cashier.client, "inventory_valuation", { p_store_id: ctx.store });
    expect(val.error?.message).toMatch(/forbidden/);
    const val2 = await rpc<{ cost_value: number }>(ctx.viewer.client, "inventory_valuation", { p_store_id: ctx.store });
    expect(Number(val2.data.cost_value)).toBeGreaterThan(0);
    const mov = await rpc<{ reason: string; loss_reason: string | null }[]>(ctx.owner.client, "inventory_movements", { p_store_id: ctx.store });
    expect(mov.data.some((m) => m.reason === "loss" && m.loss_reason === "roto")).toBe(true);
  });

  it("guardarraíles RLS en 0", async () => {
    for (const fn of ["rls_internal_scope_leaks", "rls_bare_current_tenant_policies", "rls_policies_without_initplan"]) {
      const { data, error } = await ctx.admin.rpc(fn);
      expect(error, fn).toBeNull();
      expect(data ?? [], fn).toHaveLength(0);
    }
  });
});
