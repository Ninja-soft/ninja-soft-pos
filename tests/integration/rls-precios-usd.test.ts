// @vitest-environment node
// =============================================================================
// ADR-140: costos en dólares, costo final y actualización masiva por dólar.
//
//   · Cotización: la del día en Argentina (o la anterior) entre la oficial de la
//     plataforma (platform_fx_rates, ADR-135) y la del negocio (fx_rates).
//   · Trigger de costos: USD × cotización, costo final con componentes, gating
//     de precios_usd y costo_final.
//   · Asistente v2: vista previa, lote por dólar, historial con lote y motivo,
//     deshacer (precio y costo), cajero sin acceso, otro negocio aislado.
//   · Reglas automáticas: RLS de lectura por negocio, escritura sólo por RPC.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `usd-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

/** Fecha calendario en Argentina (UTC-3, sin horario de verano). */
function arDate(offsetDays = 0): string {
  return new Date(Date.now() - 3 * 3600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

type User = { id: string; client: SupabaseClient };
const ctx = {} as {
  admin: SupabaseClient;
  tenant: string;
  tenantB: string;
  owner: User;
  cashier: User;
  ownerB: User;
  userIds: string[];
  product: string;
  list: string;
  fxIds: string[];
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
  return { id, client };
}

type RpcRes = { data: unknown; error: { message: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcRes>;

async function must(p: PromiseLike<{ error: unknown }>, what: string) {
  const { error } = await p;
  if (error) throw new Error(`${what}: ${(error as { message?: string }).message ?? String(error)}`);
}

describe.skipIf(!enabled)("ADR-140 costos en dólares y actualización por dólar", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];
    ctx.fxIds = [];
    const { data: t, error } = await admin
      .from("tenants")
      .insert([
        { name: `USD ${STAMP}`, slug: `usd-${STAMP}`, status: "active" },
        { name: `USD B ${STAMP}`, slug: `usdb-${STAMP}`, status: "active" },
      ])
      .select("id, slug");
    if (error || !t) throw error ?? new Error("tenant");
    const rows = t as { id: string; slug: string }[];
    ctx.tenant = rows.find((x) => x.slug === `usd-${STAMP}`)!.id;
    ctx.tenantB = rows.find((x) => x.slug === `usdb-${STAMP}`)!.id;
    await must(
      admin.from("subscription_addons").insert(
        ["listas_precios", "listas_precios_pro", "precios_usd"].map((key) => ({ tenant_id: ctx.tenant, addon_key: key, status: "active", source: "granted" })),
      ),
      "addons",
    );
    ctx.owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenant, "owner");
    ctx.cashier = await makeUser(admin, `caj-${STAMP}@test.local`, ctx.tenant, "cashier");
    ctx.ownerB = await makeUser(admin, `ownerb-${STAMP}@test.local`, ctx.tenantB, "owner");
    ctx.userIds.push(ctx.owner.id, ctx.cashier.id, ctx.ownerB.id);

    // Oficial venta de la plataforma: ayer (AR) 1000 por la API.
    const { data: fx, error: fxErr } = await admin
      .from("platform_fx_rates")
      .upsert({ rate_date: arDate(-1), casa: "oficial", venta: 1000, source: "manual", note: STAMP } as never, {
        onConflict: "rate_date,casa,source",
      })
      .select("id");
    if (fxErr) throw fxErr;
    ctx.fxIds.push(...((fx ?? []) as { id: string }[]).map((x) => x.id));

    const { data: l, error: lErr } = await ctx.owner.client
      .from("price_lists")
      .insert({ name: "Mayorista", channel: "mayorista", adjustment_pct: -10 } as never)
      .select("id")
      .single();
    if (lErr || !l) throw lErr ?? new Error("price_list");
    ctx.list = (l as { id: string }).id;
  });

  afterAll(async () => {
    if (!ctx.admin) return;
    if (ctx.fxIds.length) await ctx.admin.from("platform_fx_rates").delete().in("id", ctx.fxIds);
    for (const id of ctx.userIds) await ctx.admin.auth.admin.deleteUser(id);
    await ctx.admin.from("tenants").delete().in("id", [ctx.tenant, ctx.tenantB]);
  });

  it("price_fx_quote: la oficial de la plataforma del día anterior (fecha AR)", async () => {
    const { data, error } = await rpc(ctx.owner.client, "price_fx_quote", { p_date: arDate(), p_source: "oficial" });
    expect(error).toBeNull();
    const q = data as { rate: number; rate_date: string; origin: string };
    expect(Number(q.rate)).toBeGreaterThan(0);
    expect(q.rate_date <= arDate()).toBe(true);
  });

  it("la cotización del negocio más nueva (o del mismo día) gana a la de la plataforma", async () => {
    // fx_rates se escribe con listas_precios_pro; acá la carga el service role.
    await must(
      ctx.admin.from("fx_rates").insert({ tenant_id: ctx.tenant, currency: "USD", source: "oficial", rate_date: arDate(), rate: 1111 } as never),
      "fx negocio",
    );
    const { data } = await rpc(ctx.owner.client, "price_fx_quote", { p_date: arDate(), p_source: "oficial" });
    const q = data as { rate: number; origin: string };
    expect(q.origin).toBe("negocio");
    expect(Number(q.rate)).toBe(1111);
  });

  it("alta en dólares: costo en pesos y costo final con componentes", async () => {
    const { data, error } = await ctx.owner.client
      .from("products")
      .insert({
        name: `Router ${STAMP}`,
        price: 15000,
        cost_currency: "USD",
        cost_usd: 10,
        cost_fx_rate: 1000,
        cost_extras: [{ label: "Flete", type: "pct", value: 10 }],
        markup_mode: "markup",
        markup_pct: 40,
      } as never)
      .select("id, cost, final_cost, cost_fx_rate")
      .single();
    expect(error).toBeNull();
    const p = data as { id: string; cost: number; final_cost: number };
    ctx.product = p.id;
    expect(Number(p.cost)).toBe(10000);
    expect(Number(p.final_cost)).toBe(11000);
  });

  it("otro negocio sin precios_usd no puede cargar costos en dólares", async () => {
    const { error } = await ctx.ownerB.client
      .from("products")
      .insert({ name: "X", price: 1, cost_currency: "USD", cost_usd: 1, cost_fx_rate: 1000 } as never);
    expect(error?.message ?? "").toMatch(/precios_usd/);
  });

  it("asistente por dólar: vista previa, aplicar, historial y deshacer", async () => {
    const req = {
      mode: "fx",
      reprice: "keep_markup",
      targets: { base: true, list_ids: [] },
      scope: { product_ids: [ctx.product] },
      fx: { source: "manual", rate: 1200 },
      reason: `Dólar ${STAMP}`,
    };
    const pv = await rpc(ctx.owner.client, "price_bulk_v2_preview", { p: req });
    expect(pv.error).toBeNull();
    const rows = (pv.data as { rows: { new_price: number; new_cost: number }[] }).rows;
    expect(Number(rows[0]!.new_cost)).toBe(12000);
    expect(Number(rows[0]!.new_price)).toBe(18000);

    const cashier = await rpc(ctx.cashier.client, "price_bulk_v2_preview", { p: req });
    expect(cashier.error?.message ?? "").toMatch(/forbidden/);

    const cr = await rpc(ctx.owner.client, "price_bulk_v2_create", { p: req });
    expect(cr.error).toBeNull();
    const batch = (cr.data as { id: string; status: string }).id;
    const { data: prod } = await ctx.owner.client.from("products").select("price, cost").eq("id", ctx.product).single();
    expect(Number((prod as { price: number }).price)).toBe(18000);
    expect(Number((prod as { cost: number }).cost)).toBe(12000);

    const { data: hist } = await ctx.owner.client
      .from("product_price_history")
      .select("batch_id, reason")
      .eq("product_id", ctx.product)
      .eq("batch_id", batch);
    expect((hist ?? []).length).toBe(1);
    expect((hist as { reason: string }[])[0]!.reason).toBe(`Dólar ${STAMP}`);

    // Otro negocio no ve el lote ni sus líneas.
    const { data: other } = await ctx.ownerB.client.from("price_bulk_batches").select("id").eq("id", batch);
    expect(other ?? []).toHaveLength(0);
    const otherLines = await rpc(ctx.ownerB.client, "price_bulk_lines_get", { p_batch: batch });
    expect(otherLines.data ?? []).toEqual([]);

    const rv = await rpc(ctx.owner.client, "price_bulk_revert", { p_batch: batch });
    expect(rv.error).toBeNull();
    expect((rv.data as { costs: number }).costs).toBe(1);
    const { data: back } = await ctx.owner.client.from("products").select("price, cost").eq("id", ctx.product).single();
    expect(Number((back as { price: number }).price)).toBe(15000);
    expect(Number((back as { cost: number }).cost)).toBe(10000);
  });

  it("reglas automáticas: sólo por RPC, lectura por negocio, el tick es del service role", async () => {
    const direct = await ctx.owner.client
      .from("price_fx_rules")
      .insert({ tenant_id: ctx.tenant, name: "x", threshold_pct: 5 } as never);
    expect(direct.error).not.toBeNull();
    const saved = await rpc(ctx.owner.client, "price_fx_rule_save", {
      p: { name: "Regla", threshold_pct: 5, request: { reprice: "keep_markup", targets: { base: true, list_ids: [] }, scope: {} } },
    });
    expect(saved.error).toBeNull();
    const { data: mine } = await ctx.owner.client.from("price_fx_rules").select("id");
    expect((mine ?? []).length).toBe(1);
    const { data: theirs } = await ctx.ownerB.client.from("price_fx_rules").select("id");
    expect(theirs ?? []).toHaveLength(0);
    const tick = await rpc(ctx.owner.client, "price_fx_auto_tick");
    expect(tick.error).not.toBeNull();
    const cashierSave = await rpc(ctx.cashier.client, "price_fx_rule_save", { p: { name: "y", threshold_pct: 5, request: {} } });
    expect(cashierSave.error?.message ?? "").toMatch(/forbidden/);
  });
});
