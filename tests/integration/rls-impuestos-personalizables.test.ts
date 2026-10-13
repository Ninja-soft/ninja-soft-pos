// @vitest-environment node
// =============================================================================
// ADR-105: impuestos 100 % personalizables por negocio (migraciones
// 20261110100000 y 20261110100100). Valor efectivo = versión del negocio con
// vigencia > plantilla de NinjaSoft, en el cálculo del servidor (sale_tax_preview,
// create_sale, retenciones, padrones); aislamiento entre negocios; gating por
// rol y plan; historial y volver a la plantilla.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
// El cajero vende en SU turno, abierto por él. Inserts multi-fila con todas las
// claves en cada fila. audit_logs es inmutable (ADR-083): el cleanup no la toca.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `imp101-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";
const CUIT_C = "30712345671";

type User = { id: string; client: SupabaseClient };
const ctx = {} as {
  admin: SupabaseClient;
  tenant: string;
  tenantB: string;
  tenantN: string;
  owner: User;
  cashier: User;
  ownerB: User;
  ownerN: User;
  userIds: string[];
  store: string;
  shift: string;
  product: string;
  customer: string;
  supplier: string;
  today: string;
  nextYear: string;
};

type RpcRes = { data: unknown; error: { message: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcRes>;

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

async function must<T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T> {
  const r = await p;
  if (r.error) throw new Error(r.error.message);
  return r.data as T;
}

const save = (c: SupabaseClient, p: Record<string, unknown>) => rpc(c, "tax_custom_save", { p });
const items = () => [{ product_id: ctx.product, quantity: 1, unit_price: 1210, discount: 0 }];
const preview = async (c: SupabaseClient, customer: string | null = null) => {
  const r = await rpc(c, "sale_tax_preview", { p_items: items(), p_total: 1210, p_customer: customer });
  if (r.error) throw new Error(r.error.message);
  return r.data as { iva_total: number; perceptions: { rate: number; source: string }[]; warnings: string[] };
};

describe.skipIf(!enabled)("ADR-105 · impuestos personalizables por negocio", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];
    ctx.today = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
    ctx.nextYear = new Date(Date.now() + 365 * 86400_000).toISOString().slice(0, 10);

    const t = await must(
      admin
        .from("tenants")
        .insert([
          { name: `Imp A ${STAMP}`, slug: `ia-${STAMP}`, status: "active" },
          { name: `Imp B ${STAMP}`, slug: `ib-${STAMP}`, status: "active" },
          { name: `Imp N ${STAMP}`, slug: `in-${STAMP}`, status: "active" },
        ])
        .select("id, slug"),
    );
    const rows = t as { id: string; slug: string }[];
    ctx.tenant = rows.find((x) => x.slug === `ia-${STAMP}`)!.id;
    ctx.tenantB = rows.find((x) => x.slug === `ib-${STAMP}`)!.id;
    ctx.tenantN = rows.find((x) => x.slug === `in-${STAMP}`)!.id;

    // Inserción multi-fila por PostgREST: todas las claves en cada fila.
    await must(
      admin.from("subscription_addons").insert([
        { tenant_id: ctx.tenant, addon_key: "percepciones_retenciones", status: "active", source: "granted" },
        { tenant_id: ctx.tenant, addon_key: "impuestos_iva", status: "active", source: "granted" },
        { tenant_id: ctx.tenant, addon_key: "compras", status: "active", source: "granted" },
        { tenant_id: ctx.tenantB, addon_key: "percepciones_retenciones", status: "active", source: "granted" },
        { tenant_id: ctx.tenantB, addon_key: "impuestos_iva", status: "active", source: "granted" },
        { tenant_id: ctx.tenantN, addon_key: "compras", status: "active", source: "granted" },
      ]),
    );

    ctx.owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenant, "owner");
    ctx.cashier = await makeUser(admin, `caj-${STAMP}@test.local`, ctx.tenant, "cashier");
    ctx.ownerB = await makeUser(admin, `ownerb-${STAMP}@test.local`, ctx.tenantB, "owner");
    ctx.ownerN = await makeUser(admin, `ownern-${STAMP}@test.local`, ctx.tenantN, "owner");
    ctx.userIds.push(ctx.owner.id, ctx.cashier.id, ctx.ownerB.id, ctx.ownerN.id);

    for (const o of [ctx.owner, ctx.ownerB]) {
      const r = await rpc(o.client, "tax_settings_save", { p: { iva_condition: "responsable_inscripto", cuit: "30-50000000-3" } });
      if (r.error) throw new Error(r.error.message);
    }

    const st = await must(ctx.owner.client.from("stores").insert({ name: "Centro" } as never).select("id").single());
    ctx.store = (st as unknown as { id: string }).id;
    const prods = await must(
      admin
        .from("products")
        .insert([
          { tenant_id: ctx.tenant, name: `Remera ${STAMP}`, price: 1210, cost: 500, stock: 50, track_stock: false },
          { tenant_id: ctx.tenantB, name: `Remera B ${STAMP}`, price: 1210, cost: 500, stock: 50, track_stock: false },
        ])
        .select("id, tenant_id"),
    );
    ctx.product = (prods as { id: string; tenant_id: string }[]).find((p) => p.tenant_id === ctx.tenant)!.id;
    const cust = await must(
      admin
        .from("customers")
        .insert({ tenant_id: ctx.tenant, name: "Cliente RI", document_type: "cuit", document_number: CUIT_C, iva_condition: "responsable_inscripto" })
        .select("id")
        .single(),
    );
    ctx.customer = (cust as unknown as { id: string }).id;
    const sup = await must(
      admin
        .from("suppliers")
        .insert({ tenant_id: ctx.tenant, name: "Proveedor", cuit: "20123456786", iva_condition: "responsable_inscripto" })
        .select("id")
        .single(),
    );
    ctx.supplier = (sup as unknown as { id: string }).id;

    const reg = await must(ctx.owner.client.from("cash_registers").insert({ store_id: ctx.store, name: "Caja 1" } as never).select("id").single());
    // El cajero abre SU turno.
    const sh = await rpc(ctx.cashier.client, "open_cash_shift", { p_register_id: (reg as unknown as { id: string }).id, p_opening_amount: 0 });
    if (sh.error) throw new Error(sh.error.message);
    ctx.shift = sh.data as string;
  }, 180_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin || !ctx.tenant) return;
    for (const tenant of [ctx.tenant, ctx.tenantB, ctx.tenantN]) {
      await admin.from("subscription_addons").delete().eq("tenant_id", tenant);
      // audit_logs es inmutable (ADR-083): si el negocio no se puede borrar por
      // sus auditorías, queda (datos de prueba con sello único).
      await admin.from("tenants").delete().eq("id", tenant);
    }
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("IVA: la versión con vigencia manda sobre la plantilla y create_sale la usa (cajero en su turno)", async () => {
    expect(Number((await preview(ctx.owner.client)).iva_total)).toBe(210);
    const fut = await save(ctx.owner.client, { catalog: "iva_rate", item_key: "21", valid_from: ctx.nextYear, data: { rate: 19 } });
    expect(fut.error).toBeNull();
    expect(Number((await preview(ctx.owner.client)).iva_total)).toBe(210);
    const now = await save(ctx.owner.client, { catalog: "iva_rate", item_key: "21", valid_from: ctx.today, data: { rate: 10.5 } });
    expect(now.error).toBeNull();
    expect(Number((await preview(ctx.owner.client)).iva_total)).toBe(114.98);

    const sale = await rpc(ctx.cashier.client, "create_sale", {
      p_items: items(),
      p_payments: [{ method: "cash", amount: 1210 }],
      p_cash_shift_id: ctx.shift,
    });
    expect(sale.error).toBeNull();
    const { data: rows } = await ctx.admin
      .from("sales")
      .select("iva_total, cash_shift_id")
      .eq("tenant_id", ctx.tenant)
      .order("created_at", { ascending: false })
      .limit(1);
    expect(Number(rows![0]!.iva_total)).toBe(114.98);
    expect(rows![0]!.cash_shift_id).toBe(ctx.shift);
  });

  it("otro negocio no ve ni altera los valores de A y su cálculo no cambia", async () => {
    const { data: mine } = await ctx.owner.client.from("tax_custom_values").select("id").eq("tenant_id", ctx.tenant);
    expect((mine ?? []).length).toBeGreaterThan(0);
    const id = (mine as { id: string }[])[0]!.id;

    const { data: seen } = await ctx.ownerB.client.from("tax_custom_values").select("id").eq("tenant_id", ctx.tenant);
    expect(seen ?? []).toHaveLength(0);
    expect((await rpc(ctx.ownerB.client, "tax_custom_delete", { p_id: id })).error?.message).toMatch(/tax_custom_not_found/);
    expect((await save(ctx.ownerB.client, { id, data: { rate: 1 } })).error?.message).toMatch(/tax_custom_not_found/);
    const prev = await rpc(ctx.ownerB.client, "sale_tax_preview", {
      p_items: [{ product_id: null, quantity: 1, unit_price: 1210 }],
      p_total: 1210,
      p_customer: null,
    });
    expect(Number((prev.data as { iva_total: number }).iva_total)).toBe(210);
  });

  it("sin escritura directa; el cajero no personaliza; sin la feature no se puede", async () => {
    const ins = await ctx.owner.client
      .from("tax_custom_values")
      .insert({ tenant_id: ctx.tenant, catalog: "iva_rate", item_key: "27", data: {} } as never);
    expect(ins.error).not.toBeNull();
    expect((await save(ctx.cashier.client, { catalog: "iva_rate", item_key: "27", data: { rate: 20 } })).error?.message).toMatch(
      /forbidden/,
    );
    const { data: cashierSees } = await ctx.cashier.client.from("tax_custom_values").select("id");
    expect(cashierSees ?? []).toHaveLength(0);
    expect(
      (await save(ctx.ownerN.client, { catalog: "ret_concept", item_key: "ganancias:078", data: { rate_registered: 1 } })).error
        ?.message,
    ).toMatch(/feature_not_in_plan/);
  });

  it("percepción: cambio de valores con vigencia y alícuota manual por CUIT", async () => {
    const reg = await must(
      ctx.owner.client
        .from("tax_regimes")
        .insert({
          tenant_id: ctx.tenant,
          tax: "iibb",
          role: "perception",
          jurisdiction: "902",
          name: "Perc ARBA",
          padron_source: "arba",
          default_rate: 3,
          base_kind: "net",
          applies_to: ["responsable_inscripto"],
        } as never)
        .select("id")
        .single(),
    );
    const regId = (reg as unknown as { id: string }).id;
    expect(Number((await preview(ctx.owner.client, ctx.customer)).perceptions[0]!.rate)).toBe(3);
    expect((await save(ctx.owner.client, { catalog: "regime_values", item_key: regId, valid_from: ctx.today, data: { default_rate: 5 } })).error).toBeNull();
    expect(Number((await preview(ctx.owner.client, ctx.customer)).perceptions[0]!.rate)).toBe(5);
    const man = await rpc(ctx.owner.client, "tax_padron_manual_set", {
      p: { jurisdiction: "902", cuit: CUIT_C, perception_rate: 2, valid_from: ctx.today, valid_to: ctx.nextYear },
    });
    expect(man.error).toBeNull();
    const p = await preview(ctx.owner.client, ctx.customer);
    expect(Number(p.perceptions[0]!.rate)).toBe(2);
    expect(p.perceptions[0]!.source).toBe("padron");
    // régimen fuera de vigencia: no percibe
    await must(ctx.owner.client.from("tax_regimes").update({ valid_to: "2020-01-01", valid_from: "2019-01-01" } as never).eq("id", regId));
    expect((await preview(ctx.owner.client, ctx.customer)).perceptions).toHaveLength(0);
  });

  it("retenciones: concepto con vigencia, escala y concepto propio; volver a la plantilla e historial", async () => {
    await must(
      ctx.owner.client.from("tax_regimes").insert({ tenant_id: ctx.tenant, tax: "ganancias", role: "retention", name: "Gan", padron_source: "none" } as never),
    );
    const prev = async (concept: string, amount: number) => {
      const r = await rpc(ctx.owner.client, "tax_retention_preview", {
        p: { supplier_id: ctx.supplier, amount, date: ctx.today, options: { ganancias_concept: concept } },
      });
      if (r.error) throw new Error(r.error.message);
      return (r.data as { lines: { tax: string; amount: number; reason: string }[] }).lines.find((l) => l.tax === "ganancias")!;
    };
    expect((await prev("078", 11000)).reason).toBe("below_non_taxable");
    expect(
      (await save(ctx.owner.client, {
        catalog: "ret_concept",
        item_key: "ganancias:078",
        valid_from: ctx.today,
        data: { min_non_taxable: 1000, rate_registered: 3, min_withholding: 0 },
      })).error,
    ).toBeNull();
    expect(Number((await prev("078", 11000)).amount)).toBe(300);

    expect(
      (await save(ctx.owner.client, {
        catalog: "ret_concept",
        item_key: "ganancias:propio1",
        is_custom: true,
        data: { name: "Comisiones", rate_registered: 1, rate_unregistered: 1, min_withholding: 0 },
      })).error,
    ).toBeNull();
    expect(Number((await prev("propio1", 1000)).amount)).toBe(10);

    const reset = await rpc(ctx.owner.client, "tax_custom_reset", { p_catalog: "ret_concept", p_item_key: "ganancias:078" });
    expect(reset.data).toBe(1);
    expect((await prev("078", 11000)).reason).toBe("below_non_taxable");
    const hist = await rpc(ctx.owner.client, "tax_custom_history", { p_catalog: "ret_concept", p_item_key: "ganancias:078" });
    expect((hist.data as unknown[]).length).toBeGreaterThanOrEqual(2);
    const histB = await rpc(ctx.ownerB.client, "tax_custom_history", { p_catalog: "ret_concept", p_item_key: "ganancias:078" });
    expect(histB.data).toEqual([]);
  });

  it("perfiles de padrón: inserción multi-fila con todas las claves y aislamiento", async () => {
    const cfg = { file_type: "delimited", separator: ";", columns: { cuit: { index: 1 }, rate: { index: 2 } } };
    const ins = await ctx.owner.client
      .from("tax_padron_profiles")
      .insert([
        { tenant_id: ctx.tenant, name: "Mendoza", jurisdiction: "913", kind: "perception", config: cfg },
        { tenant_id: ctx.tenant, name: "Salta", jurisdiction: "917", kind: "retention", config: cfg },
      ] as never)
      .select("id");
    expect(ins.error).toBeNull();
    const id = (ins.data as { id: string }[])[0]!.id;
    const bad = await ctx.ownerB.client.from("tax_padron_profiles").insert({ tenant_id: ctx.tenant, name: "x", jurisdiction: "913", config: cfg } as never);
    expect(bad.error).not.toBeNull();
    const { data: bSees } = await ctx.ownerB.client.from("tax_padron_profiles").select("id").eq("id", id);
    expect(bSees ?? []).toHaveLength(0);
    const start = await rpc(ctx.ownerB.client, "tax_padron_import_start", { p: { jurisdiction: "913", format: "profile", profile_id: id } });
    expect(start.error?.message).toMatch(/padron_profile_not_found/);
    const mine = await rpc(ctx.owner.client, "tax_padron_import_start", { p: { jurisdiction: "913", format: "profile", profile_id: id, kind: "perception" } });
    expect(mine.error).toBeNull();
    const caj = await ctx.cashier.client.from("tax_padron_profiles").insert({ tenant_id: ctx.tenant, name: "c", jurisdiction: "913", config: cfg } as never);
    expect(caj.error).not.toBeNull();
  });

  it("cada cambio queda en audit_logs", async () => {
    const { count } = await ctx.admin
      .from("audit_logs")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", ctx.tenant)
      .eq("entity_type", "tax_custom_values");
    expect(count ?? 0).toBeGreaterThanOrEqual(5);
  });
});
