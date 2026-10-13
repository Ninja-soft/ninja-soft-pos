// @vitest-environment node
// =============================================================================
// F8 · ADR-099 (migración 20261109800100): comisiones estimadas por medio de
// pago (payment_fee_rules + payment_fees_report), la venta que cierra su
// espera de transferencia (trigger sobre payments) y el barrido de esperas.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
//
// Escenario: negocio A con la feature (dueño y cajero), negocio B sin ella.
// El cajero cobra en SU turno, abierto por él. audit_logs es inmutable
// (ADR-083): el cleanup no la toca.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `pst-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type Ctx = {
  admin: SupabaseClient;
  tenant: string;
  tenantB: string;
  owner: SupabaseClient;
  cashier: SupabaseClient;
  ownerB: SupabaseClient;
  userIds: string[];
  store: string;
  product: string;
  register: string;
  shiftCashier: string;
  account: string;
  from: string;
  to: string;
};
const ctx = {} as Ctx;

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
  const { error: tuErr } = await admin
    .from("tenant_users")
    .insert({ tenant_id: tenantId, user_id: id, role, status: "active" });
  if (tuErr) throw tuErr;
  const client = createClient(URL_!, ANON!, { auth: { persistSession: false } });
  const { error: sErr } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr) throw sErr;
  return { id, client };
}

const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<{ data: unknown; error: { message: string } | null }>;

const ruleRow = (p: Record<string, unknown>) => ({
  method: "credit",
  provider_key: null,
  installments: null,
  fee_pct: 0,
  fixed_fee: 0,
  vat_on_fee: false,
  note: null,
  ...p,
});

describe.skipIf(!enabled)("F8 · pagos sin terceros (ADR-099)", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];
    ctx.from = new Date(Date.now() - 3_600_000).toISOString();
    ctx.to = new Date(Date.now() + 3_600_000).toISOString();

    const tenants = await admin
      .from("tenants")
      .insert([
        { name: `PST ${STAMP}`, slug: `pst-${STAMP}`, status: "active" },
        { name: `PSTB ${STAMP}`, slug: `pstb-${STAMP}`, status: "active" },
      ])
      .select("id, slug");
    if (tenants.error || !tenants.data) throw tenants.error ?? new Error("tenants");
    ctx.tenant = tenants.data.find((t) => t.slug === `pst-${STAMP}`)!.id;
    ctx.tenantB = tenants.data.find((t) => t.slug === `pstb-${STAMP}`)!.id;

    // Todas las claves en cada fila.
    const { error: addonErr } = await admin.from("subscription_addons").insert([
      ...["comisiones_estimadas", "transferencia", "transferencia_auto_mp"].map((key) => ({
        tenant_id: ctx.tenant,
        addon_key: key,
        status: "active",
        source: "granted",
      })),
      { tenant_id: ctx.tenantB, addon_key: "transferencia", status: "active", source: "granted" },
    ]);
    if (addonErr) throw addonErr;

    const owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenant, "owner");
    const cashier = await makeUser(admin, `cajero-${STAMP}@test.local`, ctx.tenant, "cashier");
    const ownerB = await makeUser(admin, `ownerb-${STAMP}@test.local`, ctx.tenantB, "owner");
    ctx.owner = owner.client;
    ctx.cashier = cashier.client;
    ctx.ownerB = ownerB.client;
    ctx.userIds.push(owner.id, cashier.id, ownerB.id);

    const st = await owner.client.from("stores").insert({ name: "Centro" } as never).select("id").single();
    if (st.error || !st.data) throw st.error ?? new Error("store");
    ctx.store = (st.data as unknown as { id: string }).id;

    const prod = await admin
      .from("products")
      .insert([{ tenant_id: ctx.tenant, name: `Remera ${STAMP}`, sku: `REM-${STAMP}`, price: 100, cost: 50, stock: 100 }])
      .select("id")
      .single();
    if (prod.error || !prod.data) throw prod.error ?? new Error("product");
    ctx.product = (prod.data as unknown as { id: string }).id;

    const reg = await owner.client
      .from("cash_registers")
      .insert({ store_id: ctx.store, name: "Caja 1" } as never)
      .select("id")
      .single();
    if (reg.error || !reg.data) throw reg.error ?? new Error("caja");
    ctx.register = (reg.data as unknown as { id: string }).id;

    // El cajero abre SU turno.
    const sh = await rpc(cashier.client, "open_cash_shift", { p_register_id: ctx.register, p_opening_amount: 0 });
    if (sh.error) throw new Error(sh.error.message);
    ctx.shiftCashier = sh.data as string;

    const acc = (await admin
      .from("transfer_accounts" as never)
      .insert({
        tenant_id: ctx.tenant,
        bank_slug: "mercado-pago",
        bank_name: "Mercado Pago",
        holder_name: "Titular Test",
        alias: `pst.${STAMP}`,
      } as never)
      .select("id")
      .single()) as unknown as { data: { id: string } | null; error: Error | null };
    if (acc.error || !acc.data) throw acc.error ?? new Error("account");
    ctx.account = acc.data.id;
  }, 150_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin || !ctx.tenant) return;
    for (const t of [ctx.tenant, ctx.tenantB]) {
      await admin.from("transfer_watches" as never).delete().eq("tenant_id", t);
      await admin.from("transfer_accounts" as never).delete().eq("tenant_id", t);
      await admin.from("payment_fee_rules" as never).delete().eq("tenant_id", t);
      await admin.from("subscription_addons").delete().eq("tenant_id", t);
      // audit_logs es inmutable (ADR-083): si el negocio no se puede borrar
      // por sus auditorías, queda (datos de prueba con sello único).
      await admin.from("tenants").delete().eq("id", t);
    }
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  // ── Reglas de comisión ──────────────────────────────────────────────────
  it("el dueño carga varias comisiones de una vez", async () => {
    const { error } = await ctx.owner.from("payment_fee_rules" as never).insert([
      ruleRow({ method: "credit", fee_pct: 3, vat_on_fee: true }),
      ruleRow({ method: "credit", installments: 3, fee_pct: 6, vat_on_fee: true }),
      ruleRow({ method: "transfer", fixed_fee: 5 }),
    ] as never);
    expect(error).toBeNull();
    const { data } = await ctx.admin
      .from("payment_fee_rules" as never)
      .select("tenant_id, created_by")
      .eq("tenant_id", ctx.tenant);
    expect((data as unknown as unknown[]).length).toBe(3);
  });

  it("una regla repetida (mismo medio, procesador y cuotas) se rechaza", async () => {
    const { error } = await ctx.owner
      .from("payment_fee_rules" as never)
      .insert([ruleRow({ method: "credit", installments: 3, fee_pct: 7 })] as never);
    expect(error).not.toBeNull();
  });

  it("el cajero no carga comisiones", async () => {
    const { error } = await ctx.cashier
      .from("payment_fee_rules" as never)
      .insert([ruleRow({ method: "debit", fee_pct: 1 })] as never);
    expect(error).not.toBeNull();
  });

  it("sin el plan, el servidor rechaza la regla", async () => {
    const { error } = await ctx.ownerB
      .from("payment_fee_rules" as never)
      .insert([ruleRow({ method: "debit", fee_pct: 1 })] as never);
    expect(error?.message).toContain("feature_not_in_plan");
  });

  it("otro negocio no ve las reglas", async () => {
    const { data } = await ctx.ownerB.from("payment_fee_rules" as never).select("id");
    expect((data as unknown as unknown[]).length).toBe(0);
  });

  it("no se borra físico: baja lógica", async () => {
    const { data: rows } = await ctx.owner
      .from("payment_fee_rules" as never)
      .select("id, method")
      .eq("method", "transfer");
    const id = (rows as unknown as { id: string }[])[0]!.id;
    await ctx.owner.from("payment_fee_rules" as never).delete().eq("id", id);
    const still = await ctx.admin.from("payment_fee_rules" as never).select("id").eq("id", id);
    expect((still.data as unknown as unknown[]).length).toBe(1);
    const { error } = await ctx.owner
      .from("payment_fee_rules" as never)
      .update({ deleted_at: new Date().toISOString() } as never)
      .eq("id", id);
    expect(error).toBeNull();
  });

  // ── Venta en el turno del cajero y reporte ──────────────────────────────
  it("la transferencia emparejada se cierra sola con la venta", async () => {
    const mpId = `MP${Date.now()}`;
    const w = await ctx.admin
      .from("transfer_watches" as never)
      .insert({
        tenant_id: ctx.tenant,
        account_id: ctx.account,
        amount: 200,
        status: "matched",
        mp_payment_id: mpId,
        matched_amount: 200,
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      } as never)
      .select("id")
      .single();
    expect(w.error).toBeNull();
    const watchId = (w.data as unknown as { id: string }).id;

    const s = await rpc(ctx.cashier, "create_sale", {
      p_items: [{ product_id: ctx.product, quantity: 4, unit_price: 100, discount: 0 }],
      p_payments: [{ method: "transfer", amount: 200, reference: mpId }, { method: "cash", amount: 200 }],
      p_cash_shift_id: ctx.shiftCashier,
    });
    expect(s.error).toBeNull();

    const { data } = await ctx.admin
      .from("transfer_watches" as never)
      .select("status, sale_id")
      .eq("id", watchId)
      .single();
    const row = data as unknown as { status: string; sale_id: string | null };
    expect(row.status).toBe("closed");
    expect(row.sale_id).not.toBeNull();
  });

  it("el cajero cobra con crédito en 3 cuotas y el reporte estima la comisión", async () => {
    const s = await rpc(ctx.cashier, "create_sale", {
      p_items: [{ product_id: ctx.product, quantity: 10, unit_price: 100, discount: 0 }],
      p_payments: [{ method: "credit", amount: 1000, card_voucher: { cuotas: "3", marca: "visa" } }],
      p_cash_shift_id: ctx.shiftCashier,
    });
    expect(s.error).toBeNull();

    const r = await rpc(ctx.owner, "payment_fees_report", { p_from: ctx.from, p_to: ctx.to });
    expect(r.error).toBeNull();
    const out = r.data as {
      rows: { method: string; installments: number | null; gross: number; fee: number; vat: number; net: number; rule_id: string | null }[];
    };
    const credit = out.rows.find((x) => x.method === "credit" && x.installments === 3)!;
    expect(Number(credit.gross)).toBe(1000);
    expect(Number(credit.fee)).toBe(60);
    expect(Number(credit.vat)).toBe(12.6);
    expect(Number(credit.net)).toBe(927.4);
    const cash = out.rows.find((x) => x.method === "cash")!;
    expect(Number(cash.fee)).toBe(0);
    expect(cash.rule_id).toBeNull();
    // La regla de transferencia se dio de baja: ya no aplica.
    const transfer = out.rows.find((x) => x.method === "transfer")!;
    expect(Number(transfer.fee)).toBe(0);
  });

  it("el cajero y el negocio sin plan no ven el reporte", async () => {
    const c = await rpc(ctx.cashier, "payment_fees_report", { p_from: ctx.from, p_to: ctx.to });
    expect(c.error?.message).toContain("forbidden");
    const b = await rpc(ctx.ownerB, "payment_fees_report", { p_from: ctx.from, p_to: ctx.to });
    expect(b.error?.message).toContain("feature_not_in_plan");
  });

  // ── Barrido ─────────────────────────────────────────────────────────────
  it("el barrido vence las esperas vencidas y libera las emparejadas sin venta", async () => {
    const past = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const ins = await ctx.admin
      .from("transfer_watches" as never)
      .insert([
        { tenant_id: ctx.tenant, account_id: ctx.account, amount: 10, status: "waiting", mp_payment_id: null, matched_amount: null, expires_at: past },
        { tenant_id: ctx.tenant, account_id: ctx.account, amount: 20, status: "matched", mp_payment_id: `FREE${Date.now()}`, matched_amount: 20, expires_at: past },
      ] as never)
      .select("id, status");
    expect(ins.error).toBeNull();
    const ids = (ins.data as unknown as { id: string }[]).map((x) => x.id);

    const sw = await rpc(ctx.admin, "transfer_watches_sweep");
    expect(sw.error).toBeNull();

    const { data } = await ctx.admin
      .from("transfer_watches" as never)
      .select("id, status, mp_payment_id")
      .in("id", ids);
    for (const row of data as unknown as { status: string; mp_payment_id: string | null }[]) {
      expect(row.status).toBe("expired");
      expect(row.mp_payment_id).toBeNull();
    }
  });

  it("nadie autenticado corre el barrido", async () => {
    const r = await rpc(ctx.owner, "transfer_watches_sweep");
    expect(r.error).not.toBeNull();
  });
});
