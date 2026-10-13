// @vitest-environment node
// =============================================================================
// Impuestos como sujeto (ADR-095, migraciones 20261109300000 a 20261109300200):
// paridad SQL ↔ TS (liquidación de IIBB y clasificación de impuestos de
// procesadores), retenciones sufridas (alta, importación idempotente,
// liquidaciones de procesadores), liquidación de IIBB con ventas por
// actividad, confirmación y bloqueo del mes, gating por plan y rol y RLS por
// negocio.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos. audit_logs
// es inmutable: no se borra (se va con el negocio).
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { IIBB_CASES } from "../fixtures/iibbMatrix";
import { SUFFERED_CASES } from "../fixtures/sufferedMatrix";
import { computeIibb } from "@/lib/tax/iibb";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `iibb-test-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

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

// Mes cerrado de referencia: dos meses atrás.
const d = new Date();
d.setDate(1);
d.setMonth(d.getMonth() - 2);
const MONTH = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const PERIOD = `${MONTH}-01`;
const at = (day: number) => `${MONTH}-${String(day).padStart(2, "0")}T15:00:00-03:00`;

describe.skipIf(!enabled)("Impuestos como sujeto · retenciones sufridas e IIBB", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];
    const t = (await must(
      admin
        .from("tenants")
        .insert([
          { name: `IIBB A ${STAMP}`, slug: `ia-${STAMP}`, status: "active" },
          { name: `IIBB B ${STAMP}`, slug: `ib-${STAMP}`, status: "active" },
          { name: `IIBB N ${STAMP}`, slug: `in-${STAMP}`, status: "active" },
        ])
        .select("id, slug"),
    )) as { id: string; slug: string }[];
    ctx.tenant = t.find((x) => x.slug === `ia-${STAMP}`)!.id;
    ctx.tenantB = t.find((x) => x.slug === `ib-${STAMP}`)!.id;
    ctx.tenantN = t.find((x) => x.slug === `in-${STAMP}`)!.id;

    // Multi-fila con todas las claves en cada fila.
    await must(
      admin.from("subscription_addons").insert([
        { tenant_id: ctx.tenant, addon_key: "percepciones_retenciones", status: "active", source: "granted" },
        { tenant_id: ctx.tenant, addon_key: "impuestos_iva", status: "active", source: "granted" },
        { tenant_id: ctx.tenantB, addon_key: "percepciones_retenciones", status: "active", source: "granted" },
        { tenant_id: ctx.tenantN, addon_key: "impuestos_iva", status: "active", source: "granted" },
      ]),
    );
    ctx.owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenant, "owner");
    ctx.cashier = await makeUser(admin, `caj-${STAMP}@test.local`, ctx.tenant, "cashier");
    ctx.ownerB = await makeUser(admin, `ownerb-${STAMP}@test.local`, ctx.tenantB, "owner");
    ctx.ownerN = await makeUser(admin, `ownern-${STAMP}@test.local`, ctx.tenantN, "owner");
    ctx.userIds.push(ctx.owner.id, ctx.cashier.id, ctx.ownerB.id, ctx.ownerN.id);

    const r = await rpc(ctx.owner.client, "tax_settings_save", {
      p: { iva_condition: "responsable_inscripto", cuit: "30-50000000-3", iibb_jurisdiction: "902" },
    });
    if (r.error) throw new Error(r.error.message);
    const st = (await must(
      admin.from("stores").insert({ tenant_id: ctx.tenant, name: "Centro", province: "Buenos Aires" }).select("id").single(),
    )) as { id: string };
    ctx.store = st.id;
  }, 180_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin || !ctx.tenant) return;
    for (const tenant of [ctx.tenant, ctx.tenantB, ctx.tenantN]) {
      await admin.from("subscription_addons").delete().eq("tenant_id", tenant);
      await admin.from("tenants").delete().eq("id", tenant);
    }
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("paridad SQL ↔ TypeScript de la liquidación (_iibb_math)", async () => {
    for (const c of IIBB_CASES) {
      const sql = (await must(ctx.admin.rpc("_iibb_math" as never, { p: c.input } as never))) as Record<string, unknown> & {
        activities: { tax: number; base: number }[];
      };
      const ts = computeIibb(c.input);
      expect(sql.activities.map((a) => Number(a.tax))).toEqual(ts.activities.map((a) => a.tax));
      expect(sql.activities.map((a) => Number(a.base))).toEqual(ts.activities.map((a) => a.base));
      for (const k of ["determined", "deductions_total", "used", "to_pay", "credit_next"] as const) {
        expect(Number(sql[k])).toBe(ts[k]);
      }
    }
  });

  it("paridad SQL ↔ TypeScript de la clasificación", async () => {
    for (const c of SUFFERED_CASES) {
      const sql = await must(
        ctx.admin.rpc("_tax_suffered_classify" as never, {
          p_text: c.text,
          p_default_jur: c.defaultJurisdiction,
          p_default_regime: c.defaultRegime,
        } as never),
      );
      expect(sql).toEqual(c.expect);
    }
  });

  it("registra, importa sin duplicar y bloquea a quien no corresponde", async () => {
    const id = await must(
      ctx.owner.client.rpc("tax_suffered_register" as never, {
        p: { tax: "iibb", kind: "retencion", regime: "sircreb", jurisdiction: "902", operation_date: `${MONTH}-10`, amount: 30 },
      } as never),
    );
    expect(id).toBeTruthy();
    const rows = [
      { tax: "ganancias", kind: "retencion", regime: "general", jurisdiction: null, operation_date: `${MONTH}-03`, amount: 100, agent_cuit: "30500010912", certificate: "C-1" },
      { tax: "ganancias", kind: "retencion", regime: "general", jurisdiction: null, operation_date: `${MONTH}-03`, amount: 100, agent_cuit: "30500010912", certificate: "C-1" },
      { tax: "iibb", kind: "percepcion", regime: "general", jurisdiction: "902", operation_date: `${MONTH}-04`, amount: 12.5, agent_cuit: null, certificate: null },
    ];
    const imp = (await must(ctx.owner.client.rpc("tax_suffered_import" as never, { p_rows: rows, p_source: "planilla" } as never))) as {
      inserted: number;
      duplicates: number;
    };
    expect(imp).toMatchObject({ inserted: 2, duplicates: 1 });

    const caj = await rpc(ctx.cashier.client, "tax_suffered_list", { p_period: PERIOD });
    expect(caj.error?.message).toMatch(/forbidden/);
    const sinPlan = await rpc(ctx.ownerN.client, "tax_suffered_list", { p_period: PERIOD });
    expect(sinPlan.error?.message).toMatch(/feature_not_in_plan/);
    const directo = await ctx.owner.client.from("tax_suffered_entries").insert({ tenant_id: ctx.tenant } as never);
    expect(directo.error).toBeTruthy();

    const { data: propios } = await ctx.owner.client.from("tax_suffered_entries").select("id");
    expect((propios ?? []).length).toBe(3);
    const { data: ajenos } = await ctx.ownerB.client.from("tax_suffered_entries").select("id");
    expect(ajenos ?? []).toHaveLength(0);
    const { data: delCajero } = await ctx.cashier.client.from("tax_suffered_entries").select("id");
    expect(delCajero ?? []).toHaveLength(0);
  });

  it("toma los impuestos de una liquidación de Mercado Pago (sin el IVA de la comisión)", async () => {
    await must(
      ctx.admin.from("settlement_lines").insert([
        {
          tenant_id: ctx.tenant, provider_key: "mercadopago", line_key: `L1-${STAMP}`, kind: "payment",
          operation_at: at(11), gross: 1000, fee: 50, taxes: 40, net: 910,
          fee_detail: [
            { label: "Comisión de Mercado Pago", amount: 50, kind: "fee" },
            { label: "Retención de Ingresos Brutos", amount: 25, kind: "tax" },
            { label: "IVA sobre la comisión", amount: 10.5, kind: "tax" },
            { label: "Retención IIBB SIRTAC", amount: 4.5, kind: "tax", code: "sirtac_cordoba" },
          ],
        },
        {
          tenant_id: ctx.tenant, provider_key: "mercadopago", line_key: `L2-${STAMP}`, kind: "payment",
          operation_at: at(12), gross: 500, fee: 25, taxes: 0, net: 475,
          fee_detail: [{ label: "Comisión de Mercado Pago", amount: 25, kind: "fee" }],
        },
      ]),
    );
    const list = (await must(ctx.owner.client.rpc("tax_suffered_list" as never, { p_period: PERIOD } as never))) as {
      origin: string; regime: string; jurisdiction: string; amount: number;
    }[];
    const mp = list.filter((r) => r.origin === "procesador");
    expect(mp).toHaveLength(2);
    expect(mp.find((r) => r.regime === "sirtac")?.jurisdiction).toBe("904");
    const again = (await must(
      ctx.owner.client.rpc("tax_suffered_sync_settlements" as never, { p_from: PERIOD, p_to: `${MONTH}-28` } as never),
    )) as { inserted: number };
    expect(again.inserted).toBe(0);
  });

  it("liquida IIBB por actividad, confirma y bloquea el mes", async () => {
    const cat = (await must(
      ctx.admin.from("categories").insert({ tenant_id: ctx.tenant, name: "Servicios" }).select("id").single(),
    )) as { id: string };
    // Actividades como dueño (multi-fila, todas las claves).
    await must(
      ctx.owner.client.from("iibb_activities").insert([
        { tenant_id: ctx.tenant, jurisdiction: "902", code: "477000", name: "Comercio", rate: 3.5, min_tax: 0, is_default: true, category_ids: [] },
        { tenant_id: ctx.tenant, jurisdiction: "902", code: "960000", name: "Servicios", rate: 4, min_tax: 0, is_default: false, category_ids: [cat.id] },
      ] as never),
    );
    const caj = await ctx.cashier.client.from("iibb_activities").insert({ tenant_id: ctx.tenant, jurisdiction: "901", name: "x", rate: 1 } as never);
    expect(caj.error).toBeTruthy();

    const prods = (await must(
      ctx.admin
        .from("products")
        .insert([
          { tenant_id: ctx.tenant, name: `Remera ${STAMP}`, price: 1210, category_id: null },
          { tenant_id: ctx.tenant, name: `Arreglo ${STAMP}`, price: 605, category_id: cat.id },
        ])
        .select("id, category_id"),
    )) as { id: string; category_id: string | null }[];
    const sale = (await must(
      ctx.admin
        .from("sales")
        .insert({ tenant_id: ctx.tenant, store_id: ctx.store, total: 1815, subtotal: 1815, status: "completed", created_at: at(10), number: 1 })
        .select("id")
        .single(),
    )) as { id: string };
    await must(
      ctx.admin.from("sale_items").insert([
        { tenant_id: ctx.tenant, sale_id: sale.id, product_id: prods.find((p) => !p.category_id)!.id, product_name: "Remera", quantity: 1, unit_price: 1210, subtotal: 1210, net_amount: 1000, iva_rate: 21 },
        { tenant_id: ctx.tenant, sale_id: sale.id, product_id: prods.find((p) => p.category_id)!.id, product_name: "Arreglo", quantity: 1, unit_price: 605, subtotal: 605, net_amount: 500, iva_rate: 21 },
      ]),
    );

    const pv = (await must(
      ctx.owner.client.rpc("iibb_liquidation_preview" as never, { p_jurisdiction: "902", p_period: PERIOD, p_opening_credit: null } as never),
    )) as { determined: number; to_pay: number; credit_next: number; deductions: Record<string, number>; activities: { tax: number }[] };
    // 1000 × 3,5 % + 500 × 4 % = 35 + 20.
    expect(Number(pv.determined)).toBe(55);
    expect(Number(pv.deductions.sircreb)).toBe(30);
    expect(Number(pv.deductions.retencion)).toBe(25);

    const mal = await rpc(ctx.owner.client, "iibb_liquidation_confirm", {
      p_jurisdiction: "902", p_period: PERIOD, p_expected_to_pay: 999, p_expected_credit: 0, p_opening_credit: null,
    });
    expect(mal.error?.message).toMatch(/iibb_changed/);
    const ok = await rpc(ctx.owner.client, "iibb_liquidation_confirm", {
      p_jurisdiction: "902", p_period: PERIOD, p_expected_to_pay: pv.to_pay, p_expected_credit: pv.credit_next, p_opening_credit: null,
    });
    expect(ok.error).toBeNull();
    const lock = await rpc(ctx.owner.client, "tax_suffered_register", {
      p: { tax: "iibb", kind: "retencion", jurisdiction: "902", operation_date: `${MONTH}-15`, amount: 5 },
    });
    expect(lock.error?.message).toMatch(/iibb_period_liquidated/);

    const { data: ajenas } = await ctx.ownerB.client.from("iibb_liquidations").select("id");
    expect(ajenas ?? []).toHaveLength(0);
    const sinPlan = await rpc(ctx.ownerN.client, "iibb_liquidation_preview", { p_jurisdiction: "902", p_period: PERIOD });
    expect(sinPlan.error?.message).toMatch(/feature_not_in_plan/);

    const audit = await ctx.admin
      .from("audit_logs")
      .select("action")
      .eq("tenant_id", ctx.tenant)
      .in("action", ["iibb_liquidation_confirmed", "tax_suffered_registered", "tax_suffered_imported"]);
    expect((audit.data ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("sin fugas por internal_scope", async () => {
    const leaks = await ctx.admin.rpc("rls_internal_scope_leaks" as never);
    if (!leaks.error) expect(leaks.data ?? []).toHaveLength(0);
  });
});
