// @vitest-environment node
// =============================================================================
// ADR-062: integración NubCeo (configuración, credenciales, cola de envíos y
// asientos contables).
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos. No llama a
// NubCeo: sólo base, RLS, RPC y triggers.
//
// Escenario: negocio A con la feature por add-on (dueña, encargado y cajera)
// y negocio B sin la feature (otro dueño) para el aislamiento.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `nb-test-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";
const SECRET = `secreto-${STAMP}`;

type User = { id: string; email: string; client: SupabaseClient };
const ctx = {} as {
  admin: SupabaseClient;
  tenant: string;
  tenantB: string;
  store: string;
  storeB: string;
  owner: User;
  manager: User;
  cashier: User;
  ownerB: User;
  userIds: string[];
  saleNumber: number;
};

async function makeUser(admin: SupabaseClient, email: string, tenantId: string, role: string): Promise<User> {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    app_metadata: { current_tenant_id: tenantId },
  });
  if (error) throw error;
  const id = data.user!.id;
  await admin.from("users").upsert({ id, email, full_name: email.split("@")[0] });
  const { error: tuErr } = await admin.from("tenant_users").insert({ tenant_id: tenantId, user_id: id, role, status: "active" });
  if (tuErr) throw tuErr;
  const client = createClient(URL_!, ANON!, { auth: { persistSession: false } });
  const { error: sErr } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr) throw sErr;
  return { id, email, client };
}

type RpcOut = { data: unknown; error: { message: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcOut>;
const obj = (r: RpcOut) => r.data as Record<string, unknown>;

async function newTenant(admin: SupabaseClient, name: string) {
  const { data, error } = await admin
    .from("tenants")
    .insert({ name, slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${STAMP}`, status: "active" })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("tenant");
  return data.id as string;
}

async function newStore(admin: SupabaseClient, tenantId: string, name: string) {
  const { data, error } = await admin.from("stores").insert({ tenant_id: tenantId, name }).select("id").single();
  if (error || !data) throw error ?? new Error("store");
  return data.id as string;
}

async function newSale(tenantId: string, storeId: string, total: number) {
  ctx.saleNumber += 1;
  const { data, error } = await ctx.admin
    .from("sales")
    .insert({ tenant_id: tenantId, store_id: storeId, number: ctx.saleNumber, status: "completed", subtotal: total, total })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("sale");
  await ctx.admin.from("payments").insert({ tenant_id: tenantId, sale_id: data.id, method: "cash", amount: total });
  return data.id as string;
}

describe.skipIf(!enabled)("ADR-062 · integración NubCeo", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];
    ctx.saleNumber = 900_000 + Math.floor(Math.random() * 1000);
    ctx.tenant = await newTenant(admin, `Nubceo A ${STAMP}`);
    ctx.tenantB = await newTenant(admin, `Nubceo B ${STAMP}`);
    const { error: addonErr } = await admin
      .from("subscription_addons")
      .insert({ tenant_id: ctx.tenant, addon_key: "integracion_nubceo", status: "active", source: "granted" });
    if (addonErr) throw addonErr;
    ctx.store = await newStore(admin, ctx.tenant, "Centro");
    ctx.storeB = await newStore(admin, ctx.tenantB, "Otra");
    ctx.owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenant, "owner");
    ctx.manager = await makeUser(admin, `enc-${STAMP}@test.local`, ctx.tenant, "manager");
    ctx.cashier = await makeUser(admin, `caj-${STAMP}@test.local`, ctx.tenant, "cashier");
    ctx.ownerB = await makeUser(admin, `ownerb-${STAMP}@test.local`, ctx.tenantB, "owner");
    ctx.userIds.push(ctx.owner.id, ctx.manager.id, ctx.cashier.id, ctx.ownerB.id);
  }, 120_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin) return;
    for (const t of [ctx.tenant, ctx.tenantB].filter(Boolean)) {
      await admin.from("nubceo_ledger_headers").delete().eq("tenant_id", t);
      await admin.from("nubceo_runs").delete().eq("tenant_id", t);
      await admin.from("nubceo_sync").delete().eq("tenant_id", t);
      await admin.from("nubceo_credentials").delete().eq("tenant_id", t);
      await admin.from("nubceo_settings").delete().eq("tenant_id", t);
      await admin.from("payments").delete().eq("tenant_id", t);
      await admin.from("sales").delete().eq("tenant_id", t);
      await admin.from("stores").delete().eq("tenant_id", t);
      await admin.from("subscription_addons").delete().eq("tenant_id", t);
      await admin.from("audit_logs").delete().eq("tenant_id", t);
      await admin.from("tenants").delete().eq("id", t);
    }
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 120_000);

  it("la dueña configura: credenciales y envío en simulación", async () => {
    const creds = await rpc(ctx.owner.client, "nubceo_credentials_set", {
      p_environment: "prod",
      p_api_key: `key-${STAMP}`,
      p_api_secret: SECRET,
      p_nubceo_tenant: "1616",
      p_tax_code: "30-68543701-1",
      p_api_url: null,
    });
    expect(creds.error).toBeNull();
    const saved = await rpc(ctx.manager.client, "nubceo_settings_save", {
      p: {
        enabled: true,
        simulate: true,
        environment: "prod",
        every_minutes: 15,
        mapping: { saleIdPrefix: "T-", branchCodes: { [ctx.store]: "SUC-01" } },
      },
    });
    expect(saved.error).toBeNull();
    expect((obj(saved).settings as Record<string, unknown>).start_at).toBeTruthy();
  });

  it("nadie lee las credenciales por PostgREST y la RPC nunca devuelve el secreto", async () => {
    for (const u of [ctx.owner, ctx.manager, ctx.cashier, ctx.ownerB]) {
      const { data, error } = await u.client.from("nubceo_credentials").select("*");
      expect(error !== null || (data ?? []).length === 0, `${u.email} leyó nubceo_credentials`).toBe(true);
    }
    const got = await rpc(ctx.owner.client, "nubceo_settings_get");
    expect(got.error).toBeNull();
    const text = JSON.stringify(got.data);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(`key-${STAMP}`);
    expect(((obj(got).credentials as Record<string, Record<string, unknown>>).prod ?? {}).api_key_hint).toBe(STAMP.slice(-4));
  });

  it("una venta completada se encola sola; sólo dueño y encargado de A la ven", async () => {
    const sale = await newSale(ctx.tenant, ctx.store, 1500);
    const { data: own } = await ctx.owner.client.from("nubceo_sync").select("sale_id, venta_id, status").eq("sale_id", sale);
    expect(own).toEqual([{ sale_id: sale, venta_id: `T-${ctx.saleNumber}`, status: "pending" }]);
    const { data: mgr } = await ctx.manager.client.from("nubceo_sync").select("id").eq("sale_id", sale);
    expect(mgr).toHaveLength(1);
    const { data: caj } = await ctx.cashier.client.from("nubceo_sync").select("id").eq("tenant_id", ctx.tenant);
    expect(caj ?? []).toHaveLength(0);
    const { data: other } = await ctx.ownerB.client.from("nubceo_sync").select("id").eq("tenant_id", ctx.tenant);
    expect(other ?? []).toHaveLength(0);
    const { data: settingsB } = await ctx.ownerB.client.from("nubceo_settings").select("tenant_id");
    expect((settingsB ?? []).some((r: { tenant_id: string }) => r.tenant_id === ctx.tenant)).toBe(false);
  });

  it("sin escritura directa: la cola, la configuración y los asientos sólo cambian por RPC", async () => {
    const upd = await ctx.owner.client.from("nubceo_sync").update({ status: "synced" }).eq("tenant_id", ctx.tenant).select("id");
    expect(upd.error !== null || (upd.data ?? []).length === 0).toBe(true);
    const ins = await ctx.owner.client
      .from("nubceo_ledger_headers")
      .insert({ tenant_id: ctx.tenant, source: "csv", nubceo_id: "x", entry_date: "2026-10-01" });
    expect(ins.error).not.toBeNull();
    const set = await ctx.owner.client.from("nubceo_settings").update({ simulate: false }).eq("tenant_id", ctx.tenant).select("tenant_id");
    expect(set.error !== null || (set.data ?? []).length === 0).toBe(true);
  });

  it("la cajera y otro negocio no configuran; sin la feature no se escribe", async () => {
    expect((await rpc(ctx.cashier.client, "nubceo_settings_get")).error?.message).toMatch(/forbidden/);
    expect((await rpc(ctx.cashier.client, "nubceo_settings_save", { p: { enabled: false } })).error?.message).toMatch(/forbidden/);
    expect(
      (
        await rpc(ctx.cashier.client, "nubceo_credentials_set", {
          p_environment: "prod",
          p_api_key: "x",
          p_api_secret: "y",
          p_nubceo_tenant: "1",
          p_tax_code: null,
          p_api_url: null,
        })
      ).error?.message,
    ).toMatch(/forbidden/);
    const b = await rpc(ctx.ownerB.client, "nubceo_settings_save", { p: { enabled: true } });
    expect(b.error?.message).toMatch(/feature_not_in_plan/);
    expect(obj(await rpc(ctx.ownerB.client, "nubceo_settings_get")).feature).toBe(false);
  });

  it("las funciones del sincronizador no se exponen al cliente", async () => {
    for (const [fn, args] of [
      ["nubceo_claim", { p_tenant: ctx.tenant, p_limit: 10 }],
      ["nubceo_snapshots", { p_tenant: ctx.tenant, p_ids: [] }],
      ["nubceo_apply_results", { p_tenant: ctx.tenant, p_results: [] }],
      ["nubceo_due_tenants", { p_limit: 5 }],
      ["nubceo_ledger_upsert", { p_tenant: ctx.tenant, p_headers: [], p_source: "api" }],
      ["nubceo_edge_guard", { p_tenant: ctx.tenant, p_user: ctx.owner.id }],
    ] as const) {
      expect((await rpc(ctx.owner.client, fn, args)).error, fn).not.toBeNull();
    }
    expect((await rpc(ctx.admin, "nubceo_edge_guard", { p_tenant: ctx.tenant, p_user: ctx.owner.id })).data).toBeNull();
    expect((await rpc(ctx.admin, "nubceo_edge_guard", { p_tenant: ctx.tenant, p_user: ctx.cashier.id })).data).toBe("forbidden");
    expect((await rpc(ctx.admin, "nubceo_edge_guard", { p_tenant: ctx.tenantB, p_user: ctx.ownerB.id })).data).toBe(
      "feature_not_in_plan",
    );
  });

  it("cola: toma con lease, resultados, anulación y reintento", async () => {
    const sale = await newSale(ctx.tenant, ctx.store, 2000);
    const claimed = (await rpc(ctx.admin, "nubceo_claim", { p_tenant: ctx.tenant, p_limit: 50 })).data as { id: string; sale_id: string; status: string }[];
    const row = claimed.find((r) => r.sale_id === sale)!;
    expect(row.status).toBe("sending");
    const snaps = (await rpc(ctx.admin, "nubceo_snapshots", { p_tenant: ctx.tenant, p_ids: [row.id] })).data as {
      payments: { method: string }[];
    }[];
    expect(snaps[0]!.payments.map((p) => p.method)).toEqual(["cash"]);
    await rpc(ctx.admin, "nubceo_apply_results", {
      p_tenant: ctx.tenant,
      p_results: [{ id: row.id, status: "synced", sent: true, payload: { id: "x" }, payload_hash: "h", environment: "prod" }],
    });
    await ctx.admin.from("sales").update({ status: "voided" }).eq("id", sale);
    const { data: after } = await ctx.owner.client.from("nubceo_sync").select("status").eq("id", row.id).single();
    expect(after?.status).toBe("delete_pending");

    const sale2 = await newSale(ctx.tenant, ctx.store, 300);
    await ctx.admin.from("sales").update({ status: "voided" }).eq("id", sale2);
    const { data: ex } = await ctx.owner.client.from("nubceo_sync").select("id, status, excluded_by").eq("sale_id", sale2).single();
    expect(ex).toMatchObject({ status: "excluded", excluded_by: "void" });
    expect((await rpc(ctx.owner.client, "nubceo_retry", { p_ids: [ex!.id] })).data).toBe(0);
  });

  it("asientos por CSV: sólo los ve el negocio que los importó", async () => {
    const r = await rpc(ctx.owner.client, "nubceo_ledger_import", {
      p_headers: [
        {
          nubceo_id: `csv:1:2026-10-01:${STAMP}`,
          number: "1",
          date: "2026-10-01",
          entries: [
            { account_code: "1.1", account_name: "Banco", amount: 100 },
            { account_code: "4.1", account_name: "Ventas", amount: -100 },
          ],
        },
      ],
    });
    expect(r.error).toBeNull();
    expect(obj(r)).toMatchObject({ headers: 1, entries: 2 });
    const { data: mine } = await ctx.manager.client
      .from("nubceo_ledger_headers")
      .select("total_debit, total_credit, nubceo_ledger_entries(amount)")
      .eq("tenant_id", ctx.tenant);
    expect(mine).toHaveLength(1);
    expect(Number(mine![0]!.total_debit)).toBe(100);
    const { data: cajera } = await ctx.cashier.client.from("nubceo_ledger_entries").select("id");
    expect(cajera ?? []).toHaveLength(0);
    const { data: otro } = await ctx.ownerB.client.from("nubceo_ledger_headers").select("id").eq("tenant_id", ctx.tenant);
    expect(otro ?? []).toHaveLength(0);
  });

  it("ninguna policy nueva filtra con is_internal() (ADR-052)", async () => {
    const { data, error } = await ctx.admin.rpc("rls_internal_scope_leaks" as never);
    expect(error).toBeNull();
    expect(data ?? []).toEqual([]);
  });
});
