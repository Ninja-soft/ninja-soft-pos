// @vitest-environment node
// =============================================================================
// Ficha del cliente 360 (H31b · ADR-067, migración 20261030100200):
// customer_360_summary y customer_360_timeline (gating, negocio, alcance de
// sucursal, datos sólo de encargados, paginación por cursor) y notas internas
// (RLS de customer_notes, RPC de alta y baja).
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
//
// Escenario: negocio A con Centro y Norte (multi_sucursal y clientes_360 por
// addon), dueño y un cajero con base en Norte; un cliente con una venta de
// $100 en Centro y otra de $40 en Norte, y un reclamo de MP en la de Norte.
// Negocio B con clientes_360 y su dueño.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `c360-test-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type User = { id: string; client: SupabaseClient };
type Ctx = {
  admin: SupabaseClient;
  tenantA: string;
  tenantB: string;
  owner: User;
  cashier: User;
  ownerB: User;
  centro: string;
  norte: string;
  customer: string;
  saleCentro: string;
  saleNorte: string;
  ownerNote: string;
  userIds: string[];
};
const ctx = {} as Ctx;

type RpcResult = { data: unknown; error: { message: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcResult>;

type Summary = {
  kpis: { purchases: number; total: number; open_disputes: number };
  by_store: { store_id: string; total: number }[];
  payment_methods: { method: string; total: number }[];
  top_products: { name: string; total: number }[];
  monthly: { month: string; total: number }[];
  is_manager: boolean;
};
type Timeline = { items: { kind: string; id: string; sale_id: string | null; at: string }[]; next_cursor: { at: string; id: string } | null };

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

describe.skipIf(!enabled)("cliente 360 · RLS y RPC", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];
    const { data: tenants, error } = await admin
      .from("tenants")
      .insert([
        { name: `C360 A ${STAMP}`, slug: `c360a-${STAMP}`, status: "active" },
        { name: `C360 B ${STAMP}`, slug: `c360b-${STAMP}`, status: "active" },
      ])
      .select("id");
    if (error || !tenants) throw error ?? new Error("tenants");
    ctx.tenantA = tenants[0]!.id;
    ctx.tenantB = tenants[1]!.id;

    const { error: addErr } = await admin.from("subscription_addons").insert([
      { tenant_id: ctx.tenantA, addon_key: "multi_sucursal", status: "active", source: "granted" },
      { tenant_id: ctx.tenantA, addon_key: "clientes_360", status: "active", source: "granted" },
      { tenant_id: ctx.tenantB, addon_key: "clientes_360", status: "active", source: "granted" },
    ]);
    if (addErr) throw addErr;

    ctx.owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenantA, "owner");
    ctx.cashier = await makeUser(admin, `caj-${STAMP}@test.local`, ctx.tenantA, "cashier");
    ctx.ownerB = await makeUser(admin, `owner-b-${STAMP}@test.local`, ctx.tenantB, "owner");
    ctx.userIds.push(ctx.owner.id, ctx.cashier.id, ctx.ownerB.id);

    const { data: c, error: e1 } = await ctx.owner.client.from("stores").insert({ name: "Centro" } as never).select("id").single();
    if (e1 || !c) throw e1 ?? new Error("centro");
    ctx.centro = (c as unknown as { id: string }).id;
    const { data: n, error: e2 } = await ctx.owner.client.from("stores").insert({ name: "Norte" } as never).select("id").single();
    if (e2 || !n) throw e2 ?? new Error("norte");
    ctx.norte = (n as unknown as { id: string }).id;

    const sched = await rpc(ctx.owner.client, "staff_branch_schedule", {
      p_store_id: ctx.norte,
      p_kind: "home",
      p_user_id: ctx.cashier.id,
      p_reason: "Base Norte",
    });
    if (sched.error) throw new Error(sched.error.message);

    const { data: cu, error: cuErr } = await admin
      .from("customers")
      .insert({ tenant_id: ctx.tenantA, name: `Cliente ${STAMP}` })
      .select("id")
      .single();
    if (cuErr || !cu) throw cuErr ?? new Error("customer");
    ctx.customer = cu.id as string;

    const { data: sales, error: sErr } = await admin
      .from("sales")
      .insert([
        { tenant_id: ctx.tenantA, store_id: ctx.centro, customer_id: ctx.customer, number: 996001, subtotal: 100, total: 100, status: "completed" },
        { tenant_id: ctx.tenantA, store_id: ctx.norte, customer_id: ctx.customer, number: 996002, subtotal: 40, total: 40, status: "completed" },
      ])
      .select("id, number");
    if (sErr || !sales) throw sErr ?? new Error("sales");
    ctx.saleCentro = sales.find((s) => Number(s.number) === 996001)!.id;
    ctx.saleNorte = sales.find((s) => Number(s.number) === 996002)!.id;

    const { error: iErr } = await admin.from("sale_items").insert([
      { tenant_id: ctx.tenantA, sale_id: ctx.saleCentro, product_name: "Yerba", quantity: 2, unit_price: 50, subtotal: 100 },
      { tenant_id: ctx.tenantA, sale_id: ctx.saleNorte, product_name: "Galletitas", quantity: 1, unit_price: 40, subtotal: 40 },
    ]);
    if (iErr) throw iErr;
    const { error: pErr } = await admin.from("payments").insert([
      { tenant_id: ctx.tenantA, sale_id: ctx.saleCentro, method: "cash", amount: 100 },
      { tenant_id: ctx.tenantA, sale_id: ctx.saleNorte, method: "qr", amount: 40, reference: "7770001" },
    ] as never);
    if (pErr) throw pErr;

    const { error: dErr } = await admin.from("payment_disputes" as never).insert({
      tenant_id: ctx.tenantA,
      provider_key: "mercadopago",
      kind: "claim",
      dispute_key: `mp_claim:${STAMP}`,
      provider_payment_id: "7770001",
      sale_id: ctx.saleNorte,
      amount: 40,
      status: "open",
    } as never);
    if (dErr) throw dErr;
  }, 120_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin) return;
    for (const t of [ctx.tenantA, ctx.tenantB].filter(Boolean)) {
      await admin.from("customer_notes" as never).delete().eq("tenant_id", t);
      await admin.from("payment_disputes" as never).delete().eq("tenant_id", t);
      await admin.from("payments").delete().eq("tenant_id", t);
      await admin.from("sale_items").delete().eq("tenant_id", t);
      await admin.from("sales").delete().eq("tenant_id", t);
      await admin.from("staff_branch_assignments").delete().eq("tenant_id", t);
      await admin.from("audit_logs").delete().eq("tenant_id", t);
      await admin.from("subscription_addons").delete().eq("tenant_id", t);
      await admin.from("tenant_users").delete().eq("tenant_id", t);
      await admin.from("tenants").delete().eq("id", t);
    }
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("el dueño ve todo el cliente y puede filtrar por sucursal", async () => {
    const r = await rpc(ctx.owner.client, "customer_360_summary", { p_customer: ctx.customer });
    expect(r.error).toBeNull();
    const s = r.data as Summary;
    expect(s.kpis.purchases).toBe(2);
    expect(Number(s.kpis.total)).toBe(140);
    expect(s.kpis.open_disputes).toBe(1);
    expect(s.is_manager).toBe(true);
    expect(s.by_store).toHaveLength(2);
    expect(s.payment_methods.map((m) => m.method).sort()).toEqual(["cash", "qr"]);
    expect(s.top_products[0]).toMatchObject({ name: "Yerba" });
    expect(s.monthly).toHaveLength(12);

    const norte = await rpc(ctx.owner.client, "customer_360_summary", { p_customer: ctx.customer, p_store: ctx.norte });
    expect(Number((norte.data as Summary).kpis.total)).toBe(40);
  });

  it("el cajero sólo ve su sucursal y no ve disputas", async () => {
    const r = await rpc(ctx.cashier.client, "customer_360_summary", { p_customer: ctx.customer });
    expect(r.error).toBeNull();
    const s = r.data as Summary;
    expect(Number(s.kpis.total)).toBe(40);
    expect(s.kpis.open_disputes).toBe(0);
    expect(s.is_manager).toBe(false);

    const t = await rpc(ctx.cashier.client, "customer_360_timeline", { p_customer: ctx.customer });
    expect(t.error).toBeNull();
    const items = (t.data as Timeline).items;
    expect(items.some((i) => i.sale_id === ctx.saleCentro)).toBe(false);
    expect(items.some((i) => i.sale_id === ctx.saleNorte && i.kind === "sale")).toBe(true);
    expect(items.some((i) => i.kind === "dispute")).toBe(false);

    const other = await rpc(ctx.cashier.client, "customer_360_summary", { p_customer: ctx.customer, p_store: ctx.centro });
    expect(other.error?.message).toMatch(/forbidden/);

    const owner = await rpc(ctx.owner.client, "customer_360_timeline", { p_customer: ctx.customer, p_kinds: ["dispute"] });
    expect((owner.data as Timeline).items.map((i) => i.kind)).toEqual(["dispute"]);
  });

  it("otro negocio no ve el cliente", async () => {
    const r = await rpc(ctx.ownerB.client, "customer_360_summary", { p_customer: ctx.customer });
    expect(r.error?.message).toMatch(/customer_not_found/);
    const t = await rpc(ctx.ownerB.client, "customer_360_timeline", { p_customer: ctx.customer });
    expect(t.error?.message).toMatch(/customer_not_found/);
    const n = await rpc(ctx.ownerB.client, "customer_note_add", { p_customer: ctx.customer, p_body: "x" });
    expect(n.error?.message).toMatch(/customer_not_found/);
  });

  it("notas: alta por RPC, sin escritura directa, baja de la autora o un encargado", async () => {
    const direct = await ctx.owner.client
      .from("customer_notes" as never)
      .insert({ customer_id: ctx.customer, body: "directa" } as never);
    expect(direct.error).not.toBeNull();

    const a = await rpc(ctx.owner.client, "customer_note_add", { p_customer: ctx.customer, p_body: "Prefiere WhatsApp", p_pinned: true });
    expect(a.error).toBeNull();
    ctx.ownerNote = (a.data as { id: string }).id;

    const empty = await rpc(ctx.cashier.client, "customer_note_add", { p_customer: ctx.customer, p_body: "   " });
    expect(empty.error?.message).toMatch(/note_empty/);

    const c = await rpc(ctx.cashier.client, "customer_note_add", { p_customer: ctx.customer, p_body: "Pidió factura A" });
    expect(c.error).toBeNull();
    const cashierNote = (c.data as { id: string }).id;

    // El cajero no borra la nota del dueño; el dueño sí borra la del cajero.
    const no = await rpc(ctx.cashier.client, "customer_note_delete", { p_id: ctx.ownerNote });
    expect(no.error?.message).toMatch(/forbidden/);
    const yes = await rpc(ctx.owner.client, "customer_note_delete", { p_id: cashierNote });
    expect(yes.error).toBeNull();

    const other = await ctx.ownerB.client.from("customer_notes" as never).select("id").eq("id", ctx.ownerNote);
    expect(other.data ?? []).toHaveLength(0);

    const notes = await rpc(ctx.owner.client, "customer_360_timeline", { p_customer: ctx.customer, p_kinds: ["note"] });
    expect((notes.data as Timeline).items.map((i) => i.id)).toEqual([ctx.ownerNote]);

    const s = await rpc(ctx.owner.client, "customer_360_summary", { p_customer: ctx.customer });
    expect((s.data as { pinned_notes: { id: string }[] }).pinned_notes.map((x) => x.id)).toEqual([ctx.ownerNote]);

    const { data: audit } = await ctx.admin
      .from("audit_logs")
      .select("action")
      .eq("tenant_id", ctx.tenantA)
      .in("action", ["customer_note_added", "customer_note_deleted"]);
    expect((audit ?? []).length).toBe(3);
  });

  it("paginación por cursor sin repetir", async () => {
    const first = await rpc(ctx.owner.client, "customer_360_timeline", { p_customer: ctx.customer, p_limit: 1 });
    expect(first.error).toBeNull();
    const p1 = first.data as Timeline;
    expect(p1.items).toHaveLength(1);
    expect(p1.next_cursor).not.toBeNull();
    const second = await rpc(ctx.owner.client, "customer_360_timeline", {
      p_customer: ctx.customer,
      p_limit: 1,
      p_before_at: p1.next_cursor!.at,
      p_before_id: p1.next_cursor!.id,
    });
    const p2 = second.data as Timeline;
    expect(p2.items).toHaveLength(1);
    expect(p2.items[0]!.id).not.toBe(p1.items[0]!.id);
    expect(p2.items[0]!.at <= p1.items[0]!.at).toBe(true);
  });

  it("sin la feature no hay ficha 360 (gating real)", async () => {
    await ctx.admin.from("subscription_addons").delete().eq("tenant_id", ctx.tenantA).eq("addon_key", "clientes_360");
    try {
      const r = await rpc(ctx.owner.client, "customer_360_summary", { p_customer: ctx.customer });
      expect(r.error?.message).toMatch(/feature_not_in_plan: clientes_360/);
      const t = await rpc(ctx.owner.client, "customer_360_timeline", { p_customer: ctx.customer });
      expect(t.error?.message).toMatch(/feature_not_in_plan/);
      const n = await rpc(ctx.owner.client, "customer_note_add", { p_customer: ctx.customer, p_body: "x" });
      expect(n.error?.message).toMatch(/feature_not_in_plan/);
    } finally {
      await ctx.admin
        .from("subscription_addons")
        .insert({ tenant_id: ctx.tenantA, addon_key: "clientes_360", status: "active", source: "granted" });
    }
  });
});
