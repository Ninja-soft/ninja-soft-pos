// @vitest-environment node
// =============================================================================
// F18 · H100 (ADR-058): listas de precios PRO.
//
//   · Paridad: la matriz de tests/fixtures/priceMatrix.ts sembrada tal cual y
//     resuelta por resolve_unit_price (SQL) tiene que dar el mismo `expected`
//     que resolveUnitPrice (TS, tests/unit/price-resolver-parity.test.ts),
//     con PRO y después de bajar de plan.
//   · RLS y gating: lectura sólo del negocio, escritura PRO con la feature,
//     cajero sin escritura, aprobación del dueño, deshacer, etiquetas.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  ASSIGNMENTS,
  BREAKS,
  CASES,
  CUSTOMERS,
  FX,
  GROUPS,
  ITEMS,
  LISTS,
  MATRIX_NOW,
  PRODUCTS,
  SCHEDULES,
  TERMS,
} from "../fixtures/priceMatrix";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `lpp-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type User = { id: string; email: string; client: SupabaseClient };
const ctx = {} as {
  admin: SupabaseClient;
  tenant: string;
  tenantB: string;
  owner: User;
  manager: User;
  cashier: User;
  ownerB: User;
  store: string;
  userIds: string[];
};

async function signIn(email: string, headers?: Record<string, string>) {
  const client = createClient(URL_!, ANON!, {
    auth: { persistSession: false },
    ...(headers ? { global: { headers } } : {}),
  });
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw error;
  return client;
}

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
  return { id, email, client: await signIn(email) };
}

type RpcRes = { data: unknown; error: { message: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcRes>;

async function must(p: PromiseLike<{ error: unknown }>, what: string) {
  const { error } = await p;
  if (error) throw new Error(`${what}: ${(error as { message?: string }).message ?? String(error)}`);
}

describe.skipIf(!enabled)("F18 · H100 listas de precios PRO", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];

    const { data: t, error: tErr } = await admin
      .from("tenants")
      .insert([
        { name: `LPP ${STAMP}`, slug: `lpp-${STAMP}`, status: "active" },
        { name: `LPP B ${STAMP}`, slug: `lppb-${STAMP}`, status: "active" },
      ])
      .select("id, slug");
    if (tErr || !t) throw tErr ?? new Error("tenant");
    const rows = t as { id: string; slug: string }[];
    ctx.tenant = rows.find((x) => x.slug === `lpp-${STAMP}`)!.id;
    ctx.tenantB = rows.find((x) => x.slug === `lppb-${STAMP}`)!.id;

    await must(
      admin.from("subscription_addons").insert(
        ["listas_precios", "listas_precios_pro", "variantes", "grupos_clientes", "multi_caja"].map((key) => ({
          tenant_id: ctx.tenant,
          addon_key: key,
          status: "active",
          source: "granted",
        })),
      ),
      "addons",
    );

    ctx.owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenant, "owner");
    ctx.manager = await makeUser(admin, `man-${STAMP}@test.local`, ctx.tenant, "manager");
    ctx.cashier = await makeUser(admin, `caj-${STAMP}@test.local`, ctx.tenant, "cashier");
    ctx.ownerB = await makeUser(admin, `ownerb-${STAMP}@test.local`, ctx.tenantB, "owner");
    ctx.userIds.push(ctx.owner.id, ctx.manager.id, ctx.cashier.id, ctx.ownerB.id);

    const { data: store, error: sErr } = await ctx.owner.client
      .from("stores")
      .insert({ name: "Centro" } as never)
      .select("id")
      .single();
    if (sErr || !store) throw sErr ?? new Error("store");
    ctx.store = (store as { id: string }).id;

    // Sembrado de la matriz (los ids son fijos: un negocio por corrida).
    const T = ctx.tenant;
    await must(
      admin.from("products").insert(
        PRODUCTS.map((p) => ({
          id: p.id,
          tenant_id: T,
          name: p.name,
          price: p.price,
          cost: p.costs.cost,
          last_cost: p.costs.last_cost,
          avg_cost: p.costs.avg_cost,
          replacement_cost: p.costs.replacement_cost,
          min_price: p.costs.min_price,
          has_variants: Boolean(p.variants),
        })) as never,
      ),
      "products",
    );
    await must(
      admin.from("product_variants").insert(
        PRODUCTS.flatMap((p) =>
          (p.variants ?? []).map((v) => ({
            id: v.id,
            tenant_id: T,
            product_id: p.id,
            option1: v.option1,
            price_override: v.price_override,
          })),
        ) as never,
      ),
      "variants",
    );
    await must(
      admin.from("price_lists").insert(
        LISTS.map((l) => ({
          id: l.id,
          tenant_id: T,
          name: l.name,
          channel: l.channel,
          adjustment_pct: l.adjustment_pct,
          adjustment_amount: l.adjustment_amount,
          kind: l.base_list_id ? "fixed" : l.kind,
          cost_basis: l.cost_basis,
          markup_mode: l.markup_mode,
          markup_value: l.markup_value,
          currency: l.currency,
          fx_source: l.fx_source,
          rounding: l.rounding,
          min_margin_pct: l.min_margin_pct,
          valid_from: l.valid_from,
          valid_to: l.valid_to,
          is_active: l.is_active !== false,
          pos_selectable: Boolean(l.pos_selectable),
          created_at: l.created_at,
        })) as never,
      ),
      "lists",
    );
    for (const l of LISTS.filter((x) => x.base_list_id)) {
      await must(
        admin.from("price_lists").update({ base_list_id: l.base_list_id, kind: l.kind } as never).eq("id", l.id),
        "derived",
      );
    }
    await must(
      admin.from("price_list_items").insert(ITEMS.map((i) => ({ ...i, tenant_id: T })) as never),
      "items",
    );
    await must(
      admin.from("price_list_breaks").insert(BREAKS.map((b) => ({ ...b, tenant_id: T })) as never),
      "breaks",
    );
    await must(
      admin.from("payment_terms").insert(
        TERMS.map((x) => ({
          id: x.id,
          tenant_id: T,
          name: x.name,
          days: x.days,
          surcharge_pct: x.surcharge_pct,
          is_active: x.is_active,
          sort: x.sort,
        })) as never,
      ),
      "terms",
    );
    await must(admin.from("fx_rates").insert(FX.map((r) => ({ ...r, tenant_id: T })) as never), "fx");
    await must(
      admin.from("price_schedules").insert(SCHEDULES.map((s) => ({ ...s, tenant_id: T })) as never),
      "schedules",
    );
    await must(admin.from("customer_groups").insert(GROUPS.map((g) => ({ ...g, tenant_id: T })) as never), "groups");
    await must(
      admin.from("customers").insert(CUSTOMERS.map((c) => ({ ...c, tenant_id: T })) as never),
      "customers",
    );
    await must(
      admin.from("price_list_assignments").insert(ASSIGNMENTS.map((a) => ({ ...a, tenant_id: T })) as never),
      "assignments",
    );
  }, 180_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin || !ctx.tenant) return;
    for (const tenant of [ctx.tenant, ctx.tenantB]) {
      await admin.from("subscription_addons").delete().eq("tenant_id", tenant);
      await admin.from("audit_logs").delete().eq("tenant_id", tenant);
      await admin.from("tenants").delete().eq("id", tenant);
    }
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  async function runMatrix(pro: boolean) {
    const bad: string[] = [];
    for (const c of CASES.filter((x) => x.pro === pro)) {
      const r = await rpc(ctx.owner.client, "resolve_unit_price", {
        p_tenant: ctx.tenant,
        p_product: c.product,
        p_variant: c.variant ?? null,
        p_qty: c.qty ?? 1,
        p_customer: c.customer ?? null,
        p_store: null,
        p_list_id: c.list ?? null,
        p_at: c.at ?? MATRIX_NOW,
        p_term: c.term ?? null,
        p_pos_list: c.posList ?? null,
      });
      if (r.error) bad.push(`${c.name}: ${r.error.message}`);
      else if (Number(r.data) !== c.expected) bad.push(`${c.name}: ${String(r.data)} != ${c.expected}`);
    }
    return bad;
  }

  it("paridad SQL ↔ TS con PRO", async () => {
    expect(await runMatrix(true)).toEqual([]);
  });

  it("RLS: el otro negocio no ve listas PRO, plazos, escalas ni cotizaciones", async () => {
    for (const table of ["price_list_breaks", "payment_terms", "fx_rates", "price_schedules", "price_list_assignments"]) {
      const { data } = await ctx.ownerB.client.from(table as never).select("id").eq("tenant_id", ctx.tenant);
      expect(data ?? []).toEqual([]);
    }
    const snap = await rpc(ctx.ownerB.client, "resolve_unit_price", { p_tenant: ctx.tenant, p_product: PRODUCTS[0]!.id });
    expect(snap.error?.message).toMatch(/forbidden/);
  });

  it("el cajero lee pero no escribe plazos ni escalas; la foto del POS trae todo", async () => {
    const { error: e1 } = await ctx.cashier.client
      .from("payment_terms")
      .insert({ tenant_id: ctx.tenant, name: "Cajero", days: 15, surcharge_pct: 1 } as never);
    expect(e1).not.toBeNull();
    const snap = await rpc(ctx.cashier.client, "price_context_snapshot", { p_store: null, p_customer: CUSTOMERS[0].id });
    expect(snap.error).toBeNull();
    const s = snap.data as { pro: boolean; terms: unknown[]; customerTermId: string };
    expect(s.pro).toBe(true);
    expect(s.terms.length).toBe(2);
    expect(s.customerTermId).toBe(CUSTOMERS[0].payment_term_id);
  });

  it("masivo del encargado con aprobación del dueño, etiquetas y deshacer", async () => {
    const save = await rpc(ctx.owner.client, "price_settings_save", { p: { mode: "pro", require_approval: true } });
    expect(save.error).toBeNull();
    const byManager = await rpc(ctx.manager.client, "price_settings_save", { p: { require_approval: false } });
    expect(byManager.error?.message).toMatch(/forbidden/);

    const scope = { product_ids: [PRODUCTS[2]!.id] };
    const prev = await rpc(ctx.manager.client, "price_bulk_preview", { p: { mode: "pct", value: 10, scope } });
    expect(prev.error).toBeNull();
    expect((prev.data as { count: number }).count).toBe(1);

    const created = await rpc(ctx.manager.client, "price_bulk_create", { p: { mode: "pct", value: 10, scope } });
    expect(created.error).toBeNull();
    const batch = created.data as { id: string; status: string };
    expect(batch.status).toBe("pending_approval");
    const cashierTry = await rpc(ctx.cashier.client, "price_bulk_create", { p: { mode: "pct", value: 10, scope } });
    expect(cashierTry.error?.message).toMatch(/forbidden/);

    const ok = await rpc(ctx.owner.client, "price_bulk_decide", { p_batch: batch.id, p_approve: true, p_note: "ok" });
    expect(ok.error).toBeNull();
    const { data: p3 } = await ctx.admin.from("products").select("price").eq("id", PRODUCTS[2]!.id).single();
    expect(Number((p3 as { price: number }).price)).toBe(109.99);

    const { data: q } = await ctx.cashier.client
      .from("price_label_queue" as never)
      .select("id, store_id, new_price")
      .eq("product_id", PRODUCTS[2]!.id)
      .is("printed_at", null);
    const queue = (q ?? []) as { id: string; store_id: string; new_price: number }[];
    expect(queue.some((r) => r.store_id === ctx.store && Number(r.new_price) === 109.99)).toBe(true);
    const printed = await rpc(ctx.owner.client, "price_labels_mark_printed", { p_ids: queue.map((r) => r.id) });
    expect(Number(printed.data)).toBeGreaterThan(0);

    const undo = await rpc(ctx.manager.client, "price_bulk_revert", { p_batch: batch.id });
    expect(undo.error).toBeNull();
    expect((undo.data as { reverted: number }).reverted).toBe(1);
    const { data: back } = await ctx.admin.from("products").select("price").eq("id", PRODUCTS[2]!.id).single();
    expect(Number((back as { price: number }).price)).toBe(99.99);
  });

  it("bajar de plan: lo PRO deja de aplicarse (paridad sin PRO) y no se puede crear", async () => {
    await must(
      ctx.admin
        .from("subscription_addons")
        .update({ status: "cancelled" } as never)
        .eq("tenant_id", ctx.tenant)
        .eq("addon_key", "listas_precios_pro"),
      "downgrade",
    );
    expect(await runMatrix(false)).toEqual([]);

    const { error } = await ctx.owner.client.from("price_list_breaks").insert({
      tenant_id: ctx.tenant,
      price_list_id: LISTS[1]!.id,
      min_qty: 3,
      kind: "pct",
      value: -5,
    } as never);
    expect(error).not.toBeNull();
    const { error: lErr } = await ctx.owner.client
      .from("price_lists")
      .insert({ tenant_id: ctx.tenant, name: "Costo", kind: "cost", cost_basis: "cost", markup_mode: "markup", markup_value: 40 } as never);
    expect(lErr?.message).toMatch(/listas_precios_pro/);
    // Desactivar una lista PRO existente sigue andando.
    const { error: offErr } = await ctx.owner.client
      .from("price_lists")
      .update({ is_active: false } as never)
      .eq("id", LISTS[3]!.id);
    expect(offErr).toBeNull();
  });
});
