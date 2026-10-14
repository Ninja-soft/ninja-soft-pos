// @vitest-environment node
// =============================================================================
// ADR-122: presupuestos, tipos de servicio e imágenes con IA.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos. No llama a
// Gemini (la Edge no se invoca acá).
//
//   · quotes / quote_items: lectura por negocio, sin escritura directa; el
//     cajero emite por quote_save; solo lectura no; sin `presupuestos` en el
//     plan, la base lo rechaza.
//   · Numeración concurrente-segura (dos altas en paralelo, números distintos).
//   · Link público: anon ve y responde con el token, nunca la tabla.
//   · Conversión: create_sale normal + quote_link_sale.
//   · service_types: semilla, RLS y el tipo llega a sale_items.
//   · ai_image_settings sin el complemento: rechazado; ai_image_generations
//     sin escritura del cliente.
// audit_logs es inmutable (ADR-083): el cleanup no la toca.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `qte-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type Ctx = {
  admin: SupabaseClient;
  anon: SupabaseClient;
  tenantA: string;
  tenantB: string;
  ownerA: SupabaseClient;
  cashierA: SupabaseClient;
  viewerA: SupabaseClient;
  ownerB: SupabaseClient;
  userIds: string[];
  shift: string;
  service: string;
  quoteId: string;
  token: string;
  createdFlag?: string;
};
const ctx = {} as Ctx;

type RpcRes = { data: unknown; error: { message: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcRes>;

async function makeUser(admin: SupabaseClient, email: string, tenantId: string, role: string) {
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

// La feature por negocio con un flag explícito (no depende del plan que el
// alta le asigne al negocio de prueba): A la tiene, B no.
async function setFeature(admin: SupabaseClient, tenantId: string, key: string, enabled: boolean): Promise<string | null> {
  let created: string | null = null;
  let { data: flag } = await admin.from("feature_flags").select("id").eq("key", key).maybeSingle();
  if (!flag) {
    const ins = await admin.from("feature_flags").insert({ key, default_enabled: false } as never).select("id").single();
    if (ins.error) throw ins.error;
    flag = ins.data as { id: string };
    created = flag.id as string;
  }
  const { error } = await admin
    .from("tenant_feature_flags")
    .insert({ tenant_id: tenantId, feature_flag_id: (flag as { id: string }).id, enabled } as never);
  if (error) throw error;
  return created;
}

describe.skipIf(!enabled)("ADR-122 · presupuestos", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.anon = createClient(URL_!, ANON!, { auth: { persistSession: false } });
    ctx.userIds = [];
    const { data: tenants, error } = await admin
      .from("tenants")
      .insert([
        { name: `QTE A ${STAMP}`, slug: `qtea-${STAMP}`, status: "active", industry: "servicios" },
        { name: `QTE B ${STAMP}`, slug: `qteb-${STAMP}`, status: "active" },
      ])
      .select("id");
    if (error || !tenants) throw error ?? new Error("tenants");
    ctx.tenantA = tenants[0]!.id;
    ctx.tenantB = tenants[1]!.id;
    const created = await setFeature(admin, ctx.tenantA, "presupuestos", true);
    if (created) ctx.createdFlag = created;
    await setFeature(admin, ctx.tenantB, "presupuestos", false);

    const ownerA = await makeUser(admin, `qte-owner-a-${STAMP}@test.local`, ctx.tenantA, "owner");
    const cashierA = await makeUser(admin, `qte-cashier-a-${STAMP}@test.local`, ctx.tenantA, "cashier");
    const viewerA = await makeUser(admin, `qte-viewer-a-${STAMP}@test.local`, ctx.tenantA, "viewer");
    const ownerB = await makeUser(admin, `qte-owner-b-${STAMP}@test.local`, ctx.tenantB, "owner");
    ctx.ownerA = ownerA.client;
    ctx.cashierA = cashierA.client;
    ctx.viewerA = viewerA.client;
    ctx.ownerB = ownerB.client;
    ctx.userIds.push(ownerA.id, cashierA.id, viewerA.id, ownerB.id);

    const st = await ownerA.client.from("stores").insert({ name: "Laboratorio" } as never).select("id").single();
    const reg = await ownerA.client
      .from("cash_registers")
      .insert({ store_id: (st.data as unknown as { id: string }).id, name: "Caja 1" } as never)
      .select("id")
      .single();
    const sh = await rpc(cashierA.client, "open_cash_shift", {
      p_register_id: (reg.data as unknown as { id: string }).id,
      p_opening_amount: 0,
    });
    if (sh.error) throw new Error(sh.error.message);
    ctx.shift = sh.data as string;
  }, 150_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin) return;
    for (const t of [ctx.tenantA, ctx.tenantB].filter(Boolean)) {
      await admin.from("tenant_feature_flags").delete().eq("tenant_id", t);
      await admin.from("tenants").delete().eq("id", t);
    }
    if (ctx.createdFlag) await admin.from("feature_flags").delete().eq("id", ctx.createdFlag);
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("tipos de servicio: semilla, RLS y escritura sólo del dueño", async () => {
    const seed = await rpc(ctx.ownerA, "ensure_service_types");
    expect(seed.error).toBeNull();
    expect(seed.data).toBe(7);
    const listA = await ctx.ownerA.from("service_types" as never).select("id, name");
    expect((listA.data as unknown[]).length).toBe(7);
    const listB = await ctx.ownerB.from("service_types" as never).select("id");
    expect((listB.data as unknown[]).length).toBe(0);
    const byCashier = await ctx.cashierA.from("service_types" as never).insert({ tenant_id: ctx.tenantA, name: "Cajero" } as never);
    expect(byCashier.error).not.toBeNull();

    const informe = (listA.data as unknown as { id: string; name: string }[]).find((t) => t.name === "Informe")!;
    const p = await ctx.ownerA
      .from("products")
      .insert({ name: `Informe técnico ${STAMP}`, price: 20000, is_service: true, unit: "informe", service_type_id: informe.id } as never)
      .select("id")
      .single();
    expect(p.error).toBeNull();
    ctx.service = (p.data as unknown as { id: string }).id;
  });

  it("el cajero emite, la base recalcula y numera; solo lectura y otro negocio no", async () => {
    const items = [
      { product_id: ctx.service, quantity: 2, line_note: "Planta Rosario" },
      { name: "Viático", quantity: 1, unit_price: 5000 },
    ];
    const [r1, r2] = await Promise.all([
      rpc(ctx.cashierA, "quote_save", { p_quote: { validity_days: 10, discount_total: 1000, customer_name: "Cliente SA" }, p_items: items }),
      rpc(ctx.cashierA, "quote_save", { p_quote: {}, p_items: [{ name: "Otro", quantity: 1, unit_price: 1 }] }),
    ]);
    expect(r1.error).toBeNull();
    expect(r2.error).toBeNull();
    const a = r1.data as { id: string; number: number; total: number };
    const b = r2.data as { number: number };
    expect(new Set([a.number, b.number]).size).toBe(2);
    expect(Number(a.total)).toBe(20000 * 2 + 5000 - 1000);
    ctx.quoteId = a.id;

    const qi = await ctx.ownerA.from("quote_items" as never).select("service_type_name, unit_label, line_note").eq("quote_id", a.id).order("sort");
    expect((qi.data as unknown as Record<string, unknown>[])[0]).toMatchObject({ service_type_name: "Informe", unit_label: "informe", line_note: "Planta Rosario" });

    const direct = await ctx.ownerA.from("quotes" as never).update({ total: 1 } as never).eq("id", a.id).select("id");
    expect((direct.data as unknown[] | null)?.length ?? 0).toBe(0);
    const viewer = await rpc(ctx.viewerA, "quote_save", { p_quote: {}, p_items: [{ name: "x", quantity: 1, unit_price: 1 }] });
    expect(viewer.error?.message).toMatch(/forbidden_read_only/);
    const planB = await rpc(ctx.ownerB, "quote_save", { p_quote: {}, p_items: [{ name: "x", quantity: 1, unit_price: 1 }] });
    expect(planB.error?.message).toMatch(/feature_not_in_plan/);
    const seenB = await ctx.ownerB.from("quotes" as never).select("id");
    expect((seenB.data as unknown[]).length).toBe(0);
  });

  it("link público: anon ve y acepta con el token, nunca la tabla", async () => {
    const sh = await rpc(ctx.ownerA, "quote_share", { p_id: ctx.quoteId });
    expect(sh.error).toBeNull();
    ctx.token = (sh.data as { token: string }).token;
    const pub = await rpc(ctx.anon, "quote_public_get", { p_token: ctx.token });
    expect(pub.error).toBeNull();
    expect((pub.data as { status: string; items: unknown[] }).status).toBe("sent");
    expect(JSON.stringify(pub.data)).not.toContain(ctx.tenantA);
    const table = await ctx.anon.from("quotes" as never).select("id");
    expect((table.data as unknown[] | null)?.length ?? 0).toBe(0);
    const acc = await rpc(ctx.anon, "quote_public_respond", { p_token: ctx.token, p_accept: true, p_name: "María Pérez" });
    expect(acc.error).toBeNull();
    const again = await rpc(ctx.anon, "quote_public_respond", { p_token: ctx.token, p_accept: false, p_name: "x" });
    expect(again.error?.message).toMatch(/quote_already_answered/);
  });

  it("conversión: la venta normal + quote_link_sale; el tipo llega al renglón vendido", async () => {
    const sale = await rpc(ctx.cashierA, "create_sale", {
      p_items: [{ product_id: ctx.service, quantity: 2, unit_price: 20000, discount: 0 }],
      p_payments: [{ method: "cash", amount: 40000 }],
      p_cash_shift_id: ctx.shift,
    });
    expect(sale.error).toBeNull();
    const saleId = (sale.data as { sale_id: string }).sale_id;
    const items = await ctx.admin.from("sale_items").select("service_type_name").eq("sale_id", saleId);
    expect((items.data as unknown as { service_type_name: string }[])[0]!.service_type_name).toBe("Informe");
    const lk = await rpc(ctx.cashierA, "quote_link_sale", { p_id: ctx.quoteId, p_sale_id: saleId });
    expect(lk.error).toBeNull();
    const q = await ctx.ownerA.from("quotes" as never).select("status, converted_sale_id").eq("id", ctx.quoteId).single();
    expect(q.data).toEqual({ status: "converted", converted_sale_id: saleId });
    const edit = await rpc(ctx.ownerA, "quote_save", { p_quote: { id: ctx.quoteId }, p_items: [{ name: "x", quantity: 1, unit_price: 1 }] });
    expect(edit.error?.message).toMatch(/quote_locked/);
  });

  it("imágenes con IA: sin el complemento no se configura y el cliente no escribe generaciones", async () => {
    const s = await ctx.ownerA.from("ai_image_settings" as never).insert({ tenant_id: ctx.tenantA, auto_cover: true } as never);
    expect(s.error?.message).toMatch(/addon_required/);
    const g = await ctx.ownerA.from("ai_image_generations" as never).insert({ tenant_id: ctx.tenantA, style: "photo", prompt: "x" } as never);
    expect(g.error).not.toBeNull();
    const reserve = await rpc(ctx.ownerA, "_ai_image_reserve", {
      p_tenant: ctx.tenantA,
      p_user: null,
      p_product: ctx.service,
      p_style: "photo",
      p_prompt: "x",
      p_model: "m",
    });
    expect(reserve.error).not.toBeNull();
    const usage = await rpc(ctx.ownerA, "ai_image_usage_today");
    expect(usage.data).toMatchObject({ used: 0, allowed: false });
  });
});
