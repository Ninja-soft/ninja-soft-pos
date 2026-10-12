// @vitest-environment node
// =============================================================================
// ADR-055: cuentas para cobrar por transferencia, logo propio en Storage y
// snapshot de la cuenta en payments.metadata.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
//
// Escenario: negocio M (transferencia_multicuenta + multi_sucursal por addon)
// con Centro y Norte, dueño y cajero; negocio S sin la feature.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `tr-test-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

// CBU / CVU válidos (dígitos verificadores del BCRA).
const CBU_GALICIA = "0070999000000045678901";
const CBU_NACION = "0110599520000012345678";
const CVU_MP = "0000003110000123456781";
const PNG_1PX = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

type Ctx = {
  admin: SupabaseClient;
  tenantM: string;
  tenantS: string;
  owner: SupabaseClient;
  ownerS: SupabaseClient;
  cashier: SupabaseClient;
  userIds: string[];
  product: string;
  centro: string;
  norte: string;
  cajaNorte: string;
  accGalicia: string;
  accMp: string;
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
  const { error: tuErr } = await admin.from("tenant_users").insert({ tenant_id: tenantId, user_id: id, role, status: "active" });
  if (tuErr) throw tuErr;
  const client = createClient(URL_!, ANON!, { auth: { persistSession: false } });
  const { error: sErr } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr) throw sErr;
  return { id, client };
}

const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown>) =>
  c.rpc(fn as never, args as never) as unknown as Promise<{ data: unknown; error: { message: string } | null }>;

const account = (p: Record<string, unknown>) => ({
  bank_slug: "galicia",
  bank_name: "Banco Galicia",
  holder_name: "Kiosco Ninja SRL",
  cuit: "30712345671",
  cbu: CBU_GALICIA,
  alias: null,
  account_type: "cuenta_corriente",
  currency: "ARS",
  ...p,
});

describe.skipIf(!enabled)("ADR-055 · cuentas de transferencia", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];

    const { data: tenants, error: tErr } = await admin
      .from("tenants")
      .insert([
        { name: `Multi ${STAMP}`, slug: `m-${STAMP}`, status: "active" },
        { name: `Single ${STAMP}`, slug: `s-${STAMP}`, status: "active" },
      ])
      .select("id");
    if (tErr || !tenants) throw tErr ?? new Error("tenants");
    ctx.tenantM = tenants[0]!.id;
    ctx.tenantS = tenants[1]!.id;

    const { error: addonErr } = await admin.from("subscription_addons").insert(
      ["transferencia_multicuenta", "multi_sucursal", "multi_caja"].map((key) => ({
        tenant_id: ctx.tenantM,
        addon_key: key,
        status: "active",
        source: "granted",
      })),
    );
    if (addonErr) throw addonErr;

    const owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenantM, "owner");
    const cashier = await makeUser(admin, `cajero-${STAMP}@test.local`, ctx.tenantM, "cashier");
    const ownerS = await makeUser(admin, `owner-s-${STAMP}@test.local`, ctx.tenantS, "owner");
    ctx.owner = owner.client;
    ctx.cashier = cashier.client;
    ctx.ownerS = ownerS.client;
    ctx.userIds.push(owner.id, cashier.id, ownerS.id);

    const { data: prod, error: pErr } = await admin
      .from("products")
      .insert({ tenant_id: ctx.tenantM, name: `Producto ${STAMP}`, price: 100 })
      .select("id")
      .single();
    if (pErr || !prod) throw pErr ?? new Error("product");
    ctx.product = prod.id;

    const stores = await owner.client.from("stores").insert([{ name: "Centro" }, { name: "Norte" }] as never).select("id, name");
    if (stores.error || !stores.data) throw stores.error ?? new Error("stores");
    const list = stores.data as unknown as { id: string; name: string }[];
    ctx.centro = list.find((s) => s.name === "Centro")!.id;
    ctx.norte = list.find((s) => s.name === "Norte")!.id;
    const reg = await owner.client
      .from("cash_registers")
      .insert({ store_id: ctx.norte, name: "Caja 1" } as never)
      .select("id")
      .single();
    if (reg.error || !reg.data) throw reg.error ?? new Error("caja");
    ctx.cajaNorte = (reg.data as unknown as { id: string }).id;
  }, 120_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin) return;
    for (const t of [ctx.tenantM, ctx.tenantS].filter(Boolean)) {
      const { data: objs } = await admin.storage.from("transfer-logos").list(t);
      if (objs?.length) await admin.storage.from("transfer-logos").remove(objs.map((o) => `${t}/${o.name}`));
      await admin.from("config_overrides").delete().eq("tenant_id", t);
      await admin.from("transfer_accounts").delete().eq("tenant_id", t);
      await admin.from("subscription_addons").delete().eq("tenant_id", t);
      await admin.from("audit_logs").delete().eq("tenant_id", t);
      await admin.from("tenants").delete().eq("id", t);
    }
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("el dueño carga cuentas; la primera queda por defecto y el cambio de defecto es único", async () => {
    const a = await ctx.owner.from("transfer_accounts").insert(account({}) as never).select("id, is_default").single();
    expect(a.error).toBeNull();
    const first = a.data as unknown as { id: string; is_default: boolean };
    expect(first.is_default).toBe(true);
    ctx.accGalicia = first.id;

    const b = await ctx.owner
      .from("transfer_accounts")
      .insert(
        account({ bank_slug: "mercado-pago", bank_name: "Mercado Pago", cbu: CVU_MP, alias: "kiosco.ninja.mp", account_type: "cuenta_virtual", is_default: true }) as never,
      )
      .select("id, is_default")
      .single();
    expect(b.error).toBeNull();
    ctx.accMp = (b.data as unknown as { id: string }).id;

    const { data: rows } = await ctx.admin
      .from("transfer_accounts")
      .select("id, is_default")
      .eq("tenant_id", ctx.tenantM)
      .is("deleted_at", null);
    const defaults = (rows ?? []).filter((r: { is_default: boolean }) => r.is_default);
    expect(defaults.map((r: { id: string }) => r.id)).toEqual([ctx.accMp]);

    const { data: logs } = await ctx.admin
      .from("audit_logs")
      .select("action")
      .eq("tenant_id", ctx.tenantM)
      .eq("entity_type", "transfer_accounts");
    expect((logs ?? []).length).toBeGreaterThan(0);
  });

  it("valida CBU / CVU, CUIT, alias y el logo de otro negocio", async () => {
    const badCbu = await ctx.owner.from("transfer_accounts").insert(account({ cbu: "0070999000000045678900" }) as never);
    expect(badCbu.error).not.toBeNull();
    const badCuit = await ctx.owner.from("transfer_accounts").insert(account({ cbu: CBU_NACION, cuit: "20123456787" }) as never);
    expect(badCuit.error).not.toBeNull();
    const noData = await ctx.owner.from("transfer_accounts").insert(account({ cbu: null, alias: null }) as never);
    expect(noData.error).not.toBeNull();
    const foreignLogo = await ctx.owner
      .from("transfer_accounts")
      .insert(account({ cbu: CBU_NACION, bank_slug: null, bank_name: "Otra", custom_logo_path: `${ctx.tenantS}/x.png`, custom_logo_url: "https://x" }) as never);
    expect(foreignLogo.error?.message).toMatch(/invalid_logo_path/);
  });

  it("aislamiento: otro negocio no ve las cuentas; el cajero las lee pero no las edita", async () => {
    const foreign = await ctx.ownerS.from("transfer_accounts").select("id").eq("tenant_id", ctx.tenantM);
    expect(foreign.data ?? []).toHaveLength(0);

    const read = await ctx.cashier.from("transfer_accounts").select("id").eq("tenant_id", ctx.tenantM);
    expect((read.data ?? []).length).toBe(2);

    const ins = await ctx.cashier.from("transfer_accounts").insert(account({ cbu: CBU_NACION }) as never);
    expect(ins.error).not.toBeNull();
    const upd = await ctx.cashier.from("transfer_accounts").update({ holder_name: "Otro" } as never).eq("id", ctx.accGalicia).select("id");
    expect(upd.data ?? []).toHaveLength(0);

    // Sin DELETE: baja lógica.
    const del = await ctx.owner.from("transfer_accounts").delete().eq("id", ctx.accGalicia).select("id");
    expect(del.data ?? []).toHaveLength(0);
  });

  it("plan: sin transferencia_multicuenta sólo una cuenta activa y sin elegir por sucursal", async () => {
    const one = await ctx.ownerS.from("transfer_accounts").insert(account({}) as never);
    expect(one.error).toBeNull();
    const two = await ctx.ownerS.from("transfer_accounts").insert(account({ cbu: CBU_NACION }) as never);
    expect(two.error?.message).toMatch(/transferencia_multicuenta/);
    // Pausada sí se puede guardar.
    const paused = await ctx.ownerS.from("transfer_accounts").insert(account({ cbu: CBU_NACION, is_active: false }) as never);
    expect(paused.error).toBeNull();
  });

  it("Storage: logo sólo en la carpeta del propio negocio y con rol de encargado", async () => {
    const own = await ctx.owner.storage
      .from("transfer-logos")
      .upload(`${ctx.tenantM}/${STAMP}.png`, PNG_1PX, { contentType: "image/png" });
    expect(own.error).toBeNull();
    const foreign = await ctx.owner.storage
      .from("transfer-logos")
      .upload(`${ctx.tenantS}/${STAMP}.png`, PNG_1PX, { contentType: "image/png" });
    expect(foreign.error).not.toBeNull();
    const cashier = await ctx.cashier.storage
      .from("transfer-logos")
      .upload(`${ctx.tenantM}/${STAMP}-c.png`, PNG_1PX, { contentType: "image/png" });
    expect(cashier.error).not.toBeNull();
    const svg = await ctx.owner.storage
      .from("transfer-logos")
      .upload(`${ctx.tenantM}/${STAMP}.svg`, new TextEncoder().encode("<svg/>"), { contentType: "image/svg+xml" });
    expect(svg.error).not.toBeNull();
  });

  it("por sucursal: Norte oculta Mercado Pago; los campos sólo valen en 'transfer'", async () => {
    const set = await rpc(ctx.owner, "config_override_set", {
      p_scope: "store",
      p_scope_id: ctx.norte,
      p_domain: "payment_method",
      p_domain_key: "transfer",
      p_patch: { transfer_accounts: { [ctx.accMp]: false }, transfer_require_reference: true },
    });
    expect(set.error).toBeNull();

    const eff = await rpc(ctx.owner, "transfer_effective", { p_store_id: ctx.norte });
    expect(eff.error).toBeNull();
    const v = eff.data as { account_ids: string[]; default_account_id: string; require_reference: boolean };
    expect(v.account_ids).toEqual([ctx.accGalicia]);
    expect(v.default_account_id).toBe(ctx.accGalicia);
    expect(v.require_reference).toBe(true);

    const centro = await rpc(ctx.owner, "transfer_effective", { p_store_id: ctx.centro });
    expect((centro.data as { default_account_id: string }).default_account_id).toBe(ctx.accMp);

    const wrongKey = await rpc(ctx.owner, "config_override_set", {
      p_scope: "store",
      p_scope_id: ctx.norte,
      p_domain: "payment_method",
      p_domain_key: "cash",
      p_patch: { transfer_show_screen: false },
    });
    expect(wrongKey.error?.message).toMatch(/field_not_allowed/);

    const badMap = await rpc(ctx.owner, "config_override_set", {
      p_scope: "store",
      p_scope_id: ctx.norte,
      p_domain: "payment_method",
      p_domain_key: "transfer",
      p_patch: { transfer_accounts: { "no-uuid": true } },
    });
    expect(badMap.error).not.toBeNull();
  });

  it("cobro: la cuenta y su snapshot quedan en payments.metadata; n° obligatorio en Norte", async () => {
    const open = await rpc(ctx.owner, "open_cash_shift", { p_register_id: ctx.cajaNorte, p_opening_amount: 0 });
    expect(open.error).toBeNull();
    const shift = open.data as string;
    const item = [{ product_id: ctx.product, quantity: 1, unit_price: 100, discount: 0 }];

    const noRef = await rpc(ctx.owner, "create_sale", {
      p_items: item,
      p_payments: [{ method: "transfer", amount: 100, card_voucher: { transfer_pos: true } }],
      p_cash_shift_id: shift,
    });
    expect(noRef.error?.message).toMatch(/transfer_reference_required/);

    const hidden = await rpc(ctx.owner, "create_sale", {
      p_items: item,
      p_payments: [{ method: "transfer", amount: 100, reference: "op-9", card_voucher: { transfer_pos: true, transfer_account_id: ctx.accMp } }],
      p_cash_shift_id: shift,
    });
    expect(hidden.error?.message).toMatch(/transfer_account_not_available/);

    const ok = await rpc(ctx.owner, "create_sale", {
      p_items: item,
      p_payments: [{ method: "transfer", amount: 100, reference: "op-10", card_voucher: { transfer_pos: true, transfer_account_id: ctx.accGalicia } }],
      p_cash_shift_id: shift,
    });
    expect(ok.error).toBeNull();
    const saleId = (ok.data as { sale_id: string }).sale_id;
    const { data: pay } = await ctx.admin.from("payments").select("metadata, card_voucher").eq("sale_id", saleId).single();
    const meta = (pay as { metadata: { transfer: Record<string, unknown> }; card_voucher: Record<string, unknown> }).metadata.transfer;
    expect(meta.account_id).toBe(ctx.accGalicia);
    expect(meta.cbu).toBe(CBU_GALICIA);
    expect(meta.operation).toBe("op-10");
    expect(meta.chosen).toBe(true);
    expect((pay as { card_voucher: Record<string, unknown> }).card_voucher).toEqual({});

    // Sin la marca del POS (p. ej. diferencia de un cambio): sin n° y con la
    // cuenta por defecto de la sucursal.
    const plain = await rpc(ctx.owner, "create_sale", {
      p_items: item,
      p_payments: [{ method: "transfer", amount: 100 }],
      p_cash_shift_id: shift,
    });
    expect(plain.error).toBeNull();
    const { data: pay2 } = await ctx.admin
      .from("payments")
      .select("metadata")
      .eq("sale_id", (plain.data as { sale_id: string }).sale_id)
      .single();
    expect((pay2 as { metadata: { transfer: { account_id: string; chosen: boolean } } }).metadata.transfer).toMatchObject({
      account_id: ctx.accGalicia,
      chosen: false,
    });
  });

  it("base del negocio por RPC con auditoría; el cajero no puede", async () => {
    const ok = await rpc(ctx.owner, "transfer_settings_save", { p_show_screen: false, p_require_reference: false });
    expect(ok.error).toBeNull();
    const { data: row } = await ctx.admin
      .from("tenant_payment_methods")
      .select("config")
      .eq("tenant_id", ctx.tenantM)
      .eq("provider_key", "transfer")
      .single();
    expect((row as { config: Record<string, unknown> }).config.transfer_show_screen).toBe(false);
    const denied = await rpc(ctx.cashier, "transfer_settings_save", { p_show_screen: true, p_require_reference: true });
    expect(denied.error?.message).toMatch(/forbidden/);
  });
});
