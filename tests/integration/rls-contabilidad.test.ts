// @vitest-environment node
// =============================================================================
// Contabilidad (ADR-066, migraciones 20261029100000 a 20261029100300): RLS de
// las tablas acc_*, gating de la feature, alta con plantilla, asiento
// automático de una venta, asientos manuales y reversión, libros, cierre y
// reapertura, e internal_scope.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
//
// Escenario: negocio A con la feature (add-on otorgado), dueño y cajero, una
// sucursal; negocio B sin la feature con su dueño.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `acc-test-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type Ctx = {
  admin: SupabaseClient;
  tenantA: string;
  tenantB: string;
  owner: SupabaseClient;
  cashier: SupabaseClient;
  ownerB: SupabaseClient;
  userIds: string[];
  store: string;
  sale: string;
  lastMonth: string;
};
const ctx = {} as Ctx;

type RpcResult = { data: unknown; error: { message: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown>) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcResult>;

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

function firstOfPrevMonth(): string {
  const d = new Date();
  const p = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
  return p.toISOString().slice(0, 10);
}

describe.skipIf(!enabled)("contabilidad · RLS, gating y asientos", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];
    ctx.lastMonth = firstOfPrevMonth();
    const { data: tenants, error } = await admin
      .from("tenants")
      .insert([
        { name: `Acc A ${STAMP}`, slug: `aa-${STAMP}`, status: "active" },
        { name: `Acc B ${STAMP}`, slug: `ab-${STAMP}`, status: "active" },
      ])
      .select("id");
    if (error || !tenants) throw error ?? new Error("tenants");
    ctx.tenantA = tenants[0]!.id;
    ctx.tenantB = tenants[1]!.id;

    const { error: addonErr } = await admin
      .from("subscription_addons")
      .insert([{ tenant_id: ctx.tenantA, addon_key: "contabilidad", status: "active", source: "granted" }]);
    if (addonErr) throw addonErr;

    const owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenantA, "owner");
    const cashier = await makeUser(admin, `cajero-${STAMP}@test.local`, ctx.tenantA, "cashier");
    const ownerB = await makeUser(admin, `owner-b-${STAMP}@test.local`, ctx.tenantB, "owner");
    Object.assign(ctx, { owner: owner.client, cashier: cashier.client, ownerB: ownerB.client });
    ctx.userIds.push(owner.id, cashier.id, ownerB.id);

    const { data: existing } = await admin.from("stores").select("id").eq("tenant_id", ctx.tenantA).is("deleted_at", null).limit(1).maybeSingle();
    if (existing?.id) ctx.store = existing.id as string;
    else {
      const { data: st, error: stErr } = await admin.from("stores").insert({ tenant_id: ctx.tenantA, name: `Local ${STAMP}` }).select("id").single();
      if (stErr || !st) throw stErr ?? new Error("store");
      ctx.store = st.id as string;
    }
  }, 120_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin) return;
    for (const t of [ctx.tenantA, ctx.tenantB].filter(Boolean)) {
      await admin.from("subscription_addons").delete().eq("tenant_id", t);
      await admin.from("audit_logs").delete().eq("tenant_id", t);
      await admin.from("tenant_users").delete().eq("tenant_id", t);
      await admin.from("tenants").delete().eq("id", t);
    }
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  });

  it("gating: B sin la feature y el cajero no activan", async () => {
    const b = await rpc(ctx.ownerB, "acc_setup", { p: {} });
    expect(b.error?.message).toMatch(/feature_not_in_plan: contabilidad/);
    const c = await rpc(ctx.cashier, "acc_setup", { p: {} });
    expect(c.error?.message).toMatch(/forbidden/);
  });

  it("el dueño activa con la plantilla y los centros de costo", async () => {
    const r = await rpc(ctx.owner, "acc_setup", { p: { start_date: ctx.lastMonth } });
    expect(r.error).toBeNull();
    const { data: accounts } = await ctx.owner.from("acc_accounts").select("id, system_key").eq("tenant_id", ctx.tenantA);
    expect((accounts ?? []).length).toBeGreaterThan(70);
    const { data: cc } = await ctx.owner.from("acc_cost_centers").select("store_id").eq("tenant_id", ctx.tenantA);
    expect((cc ?? []).some((c) => c.store_id === ctx.store)).toBe(true);
  });

  it("una venta genera su asiento balanceado al commit", async () => {
    const created = `${ctx.lastMonth}T15:00:00-03:00`;
    const { data: sale, error } = await ctx.admin
      .from("sales")
      .insert({ tenant_id: ctx.tenantA, store_id: ctx.store, number: 994001, subtotal: 1210, total: 1210, status: "completed", created_at: created })
      .select("id")
      .single();
    if (error || !sale) throw error ?? new Error("sale");
    ctx.sale = sale.id as string;
    // Los cobros en otra request: el trigger diferido corre al commit de cada una
    // y la venta se completa al reintentar con acc_generate.
    const { error: pErr } = await ctx.admin.from("payments").insert({ tenant_id: ctx.tenantA, sale_id: ctx.sale, method: "cash", amount: 1210 } as never);
    if (pErr) throw pErr;
    const gen = await rpc(ctx.owner, "acc_generate", { p_from: ctx.lastMonth, p_to: ctx.lastMonth.slice(0, 8) + "28", p_regenerate: true });
    expect(gen.error).toBeNull();
    const { data: lines } = await ctx.owner
      .from("acc_journal_lines")
      .select("debit, credit, account_code")
      .eq("tenant_id", ctx.tenantA)
      .eq("source_id", ctx.sale);
    const rows = (lines ?? []) as Array<{ debit: number; credit: number }>;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const d = rows.reduce((t, r) => t + Number(r.debit), 0);
    const c = rows.reduce((t, r) => t + Number(r.credit), 0);
    expect(d).toBe(1210);
    expect(c).toBe(1210);
  });

  it("RLS: el cajero y el otro negocio no leen; nadie escribe directo", async () => {
    const cashier = await ctx.cashier.from("acc_entries").select("id").eq("tenant_id", ctx.tenantA);
    expect(cashier.data ?? []).toHaveLength(0);
    const cashierView = await ctx.cashier.from("acc_journal_lines").select("id").eq("tenant_id", ctx.tenantA);
    expect(cashierView.data ?? []).toHaveLength(0);
    const other = await ctx.ownerB.from("acc_accounts").select("id").eq("tenant_id", ctx.tenantA);
    expect(other.data ?? []).toHaveLength(0);
    const ins = await ctx.owner
      .from("acc_entries")
      .insert({ tenant_id: ctx.tenantA, number: 99999, entry_date: ctx.lastMonth, kind: "manual", description: "x" } as never);
    expect(ins.error).not.toBeNull();
    const upd = await ctx.owner.from("acc_accounts").update({ name: "hack" } as never).eq("tenant_id", ctx.tenantA).select("id");
    expect(upd.data ?? []).toHaveLength(0);
  });

  it("asiento manual: rechaza el desbalanceado, guarda y revierte", async () => {
    const { data: accs } = await ctx.owner.from("acc_accounts").select("id, system_key").eq("tenant_id", ctx.tenantA).in("system_key", ["caja", "capital"]);
    const caja = accs!.find((a) => a.system_key === "caja")!.id;
    const capital = accs!.find((a) => a.system_key === "capital")!.id;
    const bad = await rpc(ctx.owner, "acc_entry_manual_save", {
      p: { date: ctx.lastMonth, description: "x", lines: [{ account_id: caja, debit: 10 }, { account_id: capital, credit: 9 }] },
    });
    expect(bad.error?.message).toMatch(/acc_entry_unbalanced/);
    const ok = await rpc(ctx.owner, "acc_entry_manual_save", {
      p: { date: ctx.lastMonth, description: "Aporte", kind: "opening", lines: [{ account_id: caja, debit: 1000 }, { account_id: capital, credit: 1000 }] },
    });
    expect(ok.error).toBeNull();
    const rev = await rpc(ctx.owner, "acc_entry_reverse", { p_id: ok.data, p_reason: "Error de carga", p_date: ctx.lastMonth });
    expect(rev.error).toBeNull();
    const again = await rpc(ctx.owner, "acc_entry_reverse", { p_id: ok.data, p_reason: "Otra", p_date: ctx.lastMonth });
    expect(again.error?.message).toMatch(/acc_entry_already_reversed/);
  });

  it("libros: sumas y saldos cuadra y el cajero no los pide", async () => {
    const r = await rpc(ctx.owner, "acc_trial_balance", { p_from: ctx.lastMonth, p_to: ctx.lastMonth.slice(0, 8) + "28" });
    expect(r.error).toBeNull();
    const rows = (r.data ?? []) as Array<{ debit: number; credit: number }>;
    const d = rows.reduce((t, x) => t + Number(x.debit), 0);
    const c = rows.reduce((t, x) => t + Number(x.credit), 0);
    expect(Math.abs(d - c)).toBeLessThan(0.001);
    expect(d).toBeGreaterThan(0);
    const cashier = await rpc(ctx.cashier, "acc_trial_balance", { p_from: ctx.lastMonth, p_to: ctx.lastMonth });
    expect(cashier.error?.message).toMatch(/forbidden/);
    const vat = await rpc(ctx.owner, "acc_vat_sales", { p_from: ctx.lastMonth, p_to: ctx.lastMonth.slice(0, 8) + "28" });
    expect(vat.error).toBeNull();
  });

  it("cierre: numera, bloquea el mes y sólo el dueño reabre", async () => {
    const close = await rpc(ctx.owner, "acc_period_close", { p_period: ctx.lastMonth });
    expect(close.error).toBeNull();
    const { data: nums } = await ctx.owner
      .from("acc_entries")
      .select("official_number")
      .eq("tenant_id", ctx.tenantA)
      .eq("period", ctx.lastMonth)
      .is("deleted_at", null);
    expect((nums ?? []).every((n) => Number(n.official_number) > 0)).toBe(true);
    const { data: accs } = await ctx.owner.from("acc_accounts").select("id, system_key").eq("tenant_id", ctx.tenantA).in("system_key", ["caja", "capital"]);
    const late = await rpc(ctx.owner, "acc_entry_manual_save", {
      p: {
        date: ctx.lastMonth,
        description: "tarde",
        lines: [
          { account_id: accs!.find((a) => a.system_key === "caja")!.id, debit: 1 },
          { account_id: accs!.find((a) => a.system_key === "capital")!.id, credit: 1 },
        ],
      },
    });
    expect(late.error?.message).toMatch(/acc_period_closed/);
    const cashier = await rpc(ctx.cashier, "acc_period_reopen", { p_period: ctx.lastMonth, p_reason: "motivo largo" });
    expect(cashier.error?.message).toMatch(/forbidden/);
    const reopen = await rpc(ctx.owner, "acc_period_reopen", { p_period: ctx.lastMonth, p_reason: "Ajuste del estudio" });
    expect(reopen.error).toBeNull();
  });

  it("B sin la feature no genera ni lee libros", async () => {
    const g = await rpc(ctx.ownerB, "acc_generate", { p_from: ctx.lastMonth, p_to: ctx.lastMonth });
    expect(g.error?.message).toMatch(/feature_not_in_plan: contabilidad/);
  });

  it("sin políticas PERMISSIVE con is_internal() (ADR-052)", async () => {
    const { data, error } = await rpc(ctx.admin, "rls_internal_scope_leaks", {});
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });
});
