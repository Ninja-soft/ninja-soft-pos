// @vitest-environment node
// =============================================================================
// Impuestos (ADR-068, migraciones 20261028100000 a 20261028100300): paridad
// del motor (sale_tax_preview contra tests/fixtures/taxMatrix.ts), datos
// fiscales, regímenes, padrones, percepciones en create_sale, RLS de
// sale_tax_lines y gating por plan.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
//
// Escenario: negocio A con percepciones, internos y variantes por add-on,
// dueño y cajero; negocio B sin las features opcionales.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { TAX_CASES, TAX_PRODUCTS, matrixPreviewItems } from "../fixtures/taxMatrix";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `imp-test-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";
const CUIT_RI = "30712345671";
const CUIT_MONO = "20444444445";

type User = { id: string; client: SupabaseClient };
type Ctx = {
  admin: SupabaseClient;
  tenant: string;
  tenantB: string;
  owner: User;
  cashier: User;
  ownerB: User;
  userIds: string[];
  customerRi: string;
  customerMono: string;
  saleId: string;
};
const ctx = {} as Ctx;

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

const today = () => new Date().toISOString().slice(0, 10);
const shift = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

describe.skipIf(!enabled)("impuestos · motor, padrones, percepciones y RLS", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];
    const { data: t, error } = await admin
      .from("tenants")
      .insert([
        { name: `Imp A ${STAMP}`, slug: `ia-${STAMP}`, status: "active" },
        { name: `Imp B ${STAMP}`, slug: `ib-${STAMP}`, status: "active" },
      ])
      .select("id, slug");
    if (error || !t) throw error ?? new Error("tenants");
    const rows = t as { id: string; slug: string }[];
    ctx.tenant = rows.find((x) => x.slug === `ia-${STAMP}`)!.id;
    ctx.tenantB = rows.find((x) => x.slug === `ib-${STAMP}`)!.id;

    const { error: aErr } = await admin.from("subscription_addons").insert(
      ["percepciones_retenciones", "impuestos_internos", "variantes", "descuentos"].map((key) => ({
        tenant_id: ctx.tenant,
        addon_key: key,
        status: "active",
        source: "granted",
      })),
    );
    if (aErr) throw aErr;

    ctx.owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenant, "owner");
    ctx.cashier = await makeUser(admin, `caj-${STAMP}@test.local`, ctx.tenant, "cashier");
    ctx.ownerB = await makeUser(admin, `ownerb-${STAMP}@test.local`, ctx.tenantB, "owner");
    ctx.userIds.push(ctx.owner.id, ctx.cashier.id, ctx.ownerB.id);

    // Productos de la matriz con sus datos fiscales.
    for (const p of TAX_PRODUCTS) {
      const it = p.internal;
      const { error: pErr } = await ctx.owner.client.from("products").insert({
        id: p.id,
        tenant_id: ctx.tenant,
        name: `${p.name} ${STAMP}`,
        price: p.price,
        cost: p.cost ?? null,
        tax_rate_code: p.rate_code,
        internal_tax_mode: it?.mode ?? "none",
        internal_tax_base: it?.base ?? "price",
        internal_tax_rate: it?.rate ?? null,
        internal_tax_amount: it?.amount ?? null,
        internal_tax_included: it?.included ?? true,
        has_variants: Boolean(p.variants),
      } as never);
      if (pErr) throw pErr;
      for (const v of p.variants ?? []) {
        const { error: vErr } = await ctx.owner.client
          .from("product_variants")
          .insert({ id: v.id, tenant_id: ctx.tenant, product_id: p.id, option1: v.key, tax_rate_code: v.rate_code } as never);
        if (vErr) throw vErr;
      }
    }

    const { data: store, error: sErr } = await ctx.owner.client.from("stores").insert({ name: "Centro" } as never).select("id").single();
    if (sErr || !store) throw sErr ?? new Error("store");
    const { data: reg, error: rErr } = await ctx.owner.client
      .from("cash_registers")
      .insert({ store_id: (store as { id: string }).id, name: "Caja 1" } as never)
      .select("id")
      .single();
    if (rErr || !reg) throw rErr ?? new Error("register");
    const sh = await rpc(ctx.cashier.client, "open_cash_shift", { p_register_id: (reg as { id: string }).id, p_opening_amount: 0 });
    if (sh.error) throw new Error(sh.error.message);

    const { data: cust, error: cErr } = await ctx.owner.client
      .from("customers")
      .insert([
        { tenant_id: ctx.tenant, name: `RI ${STAMP}`, document_type: "cuit", document_number: "30-71234567-1", iva_condition: "responsable_inscripto" },
        { tenant_id: ctx.tenant, name: `Mono ${STAMP}`, document_type: "cuit", document_number: CUIT_MONO, iva_condition: "monotributo" },
      ] as never)
      .select("id, name");
    if (cErr || !cust) throw cErr ?? new Error("customers");
    const cs = cust as { id: string; name: string }[];
    ctx.customerRi = cs.find((c) => c.name.startsWith("RI"))!.id;
    ctx.customerMono = cs.find((c) => c.name.startsWith("Mono"))!.id;
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

  it("datos fiscales: el dueño guarda, el cajero no; CUIT con dígito verificador", async () => {
    const bad = await rpc(ctx.owner.client, "tax_settings_save", { p: { iva_condition: "responsable_inscripto", cuit: "30500000004" } });
    expect(bad.error?.message).toMatch(/invalid_cuit/);
    const ok = await rpc(ctx.owner.client, "tax_settings_save", {
      p: { iva_condition: "responsable_inscripto", cuit: "30-50000000-3", iibb_jurisdiction: "902" },
    });
    expect(ok.error).toBeNull();
    expect((ok.data as { iva_condition: string }).iva_condition).toBe("responsable_inscripto");
    const caj = await rpc(ctx.cashier.client, "tax_settings_save", { p: { iva_condition: "monotributo" } });
    expect(caj.error?.message).toMatch(/forbidden/);
  });

  it("matriz de paridad: sale_tax_preview da lo mismo que lib/tax/engine.ts", async () => {
    let emitter = "";
    for (const c of TAX_CASES) {
      if (c.emitter !== emitter) {
        const s = await rpc(ctx.owner.client, "tax_settings_save", { p: { iva_condition: c.emitter } });
        expect(s.error).toBeNull();
        emitter = c.emitter;
      }
      const r = await rpc(ctx.owner.client, "sale_tax_preview", { p_items: matrixPreviewItems(c), p_total: c.total });
      expect(r.error, c.name).toBeNull();
      const d = r.data as {
        lines: { tax_rate_code: string; taxed_total: number; net: number; iva: number; internal: number }[];
        iva: { code: string; base: number; amount: number }[];
        net_taxed: number;
        net_exempt: number;
        net_untaxed: number;
        iva_total: number;
        internal_total: number;
      };
      expect(
        d.lines.map((l) => ({ code: l.tax_rate_code, taxed: Number(l.taxed_total), net: Number(l.net), iva: Number(l.iva), internal: Number(l.internal) })),
        c.name,
      ).toEqual(c.expected.lines);
      expect(d.iva.map((g) => ({ code: g.code, base: Number(g.base), amount: Number(g.amount) })), c.name).toEqual(c.expected.iva);
      expect(Number(d.net_taxed), c.name).toBe(c.expected.netTaxed);
      expect(Number(d.net_exempt), c.name).toBe(c.expected.netExempt);
      expect(Number(d.net_untaxed), c.name).toBe(c.expected.netUntaxed);
      expect(Number(d.iva_total), c.name).toBe(c.expected.ivaTotal);
      expect(Number(d.internal_total), c.name).toBe(c.expected.internalTotal);
    }
    await rpc(ctx.owner.client, "tax_settings_save", { p: { iva_condition: "responsable_inscripto" } });
  });

  it("regímenes y padrón: el dueño los carga; cajero y negocio sin plan no", async () => {
    const reg = await ctx.owner.client.from("tax_regimes").insert([
      // Multi-row de PostgREST: toda fila lleva todas las claves (la que falta va null, no default).
      { tenant_id: ctx.tenant, tax: "iibb", role: "perception", jurisdiction: "902", name: "IIBB ARBA", padron_source: "arba", min_amount: 10, default_rate: null, base_kind: "net", applies_to: ["responsable_inscripto", "monotributo", "exento"] },
      { tenant_id: ctx.tenant, tax: "iva", role: "perception", jurisdiction: null, name: "IVA RG 2408", padron_source: "none", min_amount: 0, default_rate: 3, base_kind: "net_taxed", applies_to: ["responsable_inscripto"] },
      { tenant_id: ctx.tenant, tax: "iibb", role: "retention", jurisdiction: "902", name: "Ret ARBA", padron_source: "arba", min_amount: 0, default_rate: null, base_kind: "net", applies_to: ["responsable_inscripto", "monotributo", "exento"] },
    ] as never);
    expect(reg.error).toBeNull();
    const caj = await ctx.cashier.client
      .from("tax_regimes")
      .insert({ tenant_id: ctx.tenant, tax: "iibb", role: "perception", jurisdiction: "901", name: "x" } as never);
    expect(caj.error).not.toBeNull();
    const b = await ctx.ownerB.client
      .from("tax_regimes")
      .insert({ tenant_id: ctx.tenantB, tax: "iibb", role: "perception", jurisdiction: "902", name: "x" } as never);
    expect(b.error).not.toBeNull();
    const bPad = await rpc(ctx.ownerB.client, "tax_padron_import_start", { p: { jurisdiction: "902", format: "arba" } });
    expect(bPad.error?.message).toMatch(/feature_not_in_plan: percepciones_retenciones/);

    const start = await rpc(ctx.owner.client, "tax_padron_import_start", {
      p: { jurisdiction: "902", format: "arba", kind: "both", file_name: "PadronRGS.txt" },
    });
    expect(start.error).toBeNull();
    const id = start.data as string;
    const bad = await rpc(ctx.owner.client, "tax_padron_import_rows", {
      p_import: id,
      p_rows: [{ cuit: "30712345670", valid_from: shift(-5), valid_to: shift(20), perception_rate: 1 }],
    });
    expect(bad.error?.message).toMatch(/invalid_rows/);
    const rows = await rpc(ctx.owner.client, "tax_padron_import_rows", {
      p_import: id,
      p_rows: [
        { cuit: CUIT_RI, valid_from: shift(-5), valid_to: shift(20), perception_rate: 1.5, retention_rate: 0.75 },
        { cuit: CUIT_MONO, valid_from: shift(-5), valid_to: shift(20), perception_rate: 0, retention_rate: 0 },
      ],
    });
    expect(rows.data).toBe(2);
    const fin = await rpc(ctx.owner.client, "tax_padron_import_finish", { p_import: id, p: {} });
    expect((fin.data as { status: string }).status).toBe("ready");

    const direct = await ctx.owner.client
      .from("tax_padron_entries")
      .insert({ import_id: id, tenant_id: ctx.tenant, jurisdiction: "902", cuit: CUIT_RI, valid_from: today(), valid_to: today(), perception_rate: 9 } as never);
    expect(direct.error).not.toBeNull();

    const look = await rpc(ctx.owner.client, "tax_padron_lookup", { p_cuit: "30-71234567-1" });
    expect(look.data).toEqual([expect.objectContaining({ jurisdiction: "902", perception_rate: 1.5, retention_rate: 0.75 })]);
    const lookB = await ctx.ownerB.client.from("tax_padron_entries").select("cuit").eq("cuit", CUIT_RI);
    expect(lookB.data ?? []).toHaveLength(0);
  });

  it("create_sale percibe IVA e IIBB a un RI del padrón, guarda el desglose y exige cubrirlas", async () => {
    const p21 = TAX_PRODUCTS.find((p) => p.key === "p21")!;
    const items = [{ product_id: p21.id, quantity: 10, unit_price: 1210, discount: 0 }];
    const prev = await rpc(ctx.cashier.client, "sale_tax_preview", { p_items: items, p_total: 12100, p_customer: ctx.customerRi });
    const perc = prev.data as { perception_total: number; letter: string; perceptions: { tax: string; amount: number; source: string }[] };
    expect(perc.letter).toBe("A");
    expect(perc.perceptions.map((p) => [p.tax, Number(p.amount), p.source])).toEqual([
      ["iva", 300, "default"],
      ["iibb", 150, "padron"],
    ]);

    const short = await rpc(ctx.cashier.client, "create_sale", {
      p_items: items,
      p_payments: [{ method: "cash", amount: 12100 }],
      p_customer_id: ctx.customerRi,
    });
    expect(short.error?.message).toMatch(/insufficient_payment/);

    const ok = await rpc(ctx.cashier.client, "create_sale", {
      p_items: items,
      p_payments: [{ method: "cash", amount: 12550 }],
      p_customer_id: ctx.customerRi,
    });
    expect(ok.error).toBeNull();
    const res = ok.data as { sale_id: string; total: number; perception_total: number; cbte_letter: string };
    expect(Number(res.total)).toBe(12550);
    expect(res.cbte_letter).toBe("A");
    ctx.saleId = res.sale_id;

    const { data: sale } = await ctx.owner.client
      .from("sales")
      .select("total, discount_total, tax_total, net_taxed, iva_total, perception_total, cbte_letter")
      .eq("id", res.sale_id)
      .single();
    expect(sale).toMatchObject({ cbte_letter: "A" });
    const s = sale as Record<string, number>;
    expect(Number(s.net_taxed)).toBe(10000);
    expect(Number(s.iva_total)).toBe(2100);
    expect(Number(s.perception_total)).toBe(450);
    expect(Number(s.tax_total)).toBe(2550);
    expect(Number(s.discount_total)).toBe(0);

    const { data: lines } = await ctx.owner.client.from("sale_tax_lines" as never).select("kind, tax, amount").eq("sale_id", res.sale_id);
    expect((lines as { kind: string }[]).map((l) => l.kind).sort()).toEqual(["iva", "perception", "perception"]);
    const { data: other } = await ctx.ownerB.client.from("sale_tax_lines" as never).select("id").eq("sale_id", res.sale_id);
    expect(other ?? []).toHaveLength(0);
  });

  it("monotributista con alícuota 0 en el padrón: factura A sin percepciones", async () => {
    const pex = TAX_PRODUCTS.find((p) => p.key === "pex")!;
    const r = await rpc(ctx.cashier.client, "create_sale", {
      p_items: [{ product_id: pex.id, quantity: 1, unit_price: 500, discount: 0 }],
      p_payments: [{ method: "cash", amount: 500 }],
      p_customer_id: ctx.customerMono,
    });
    expect(r.error).toBeNull();
    expect(r.data).toMatchObject({ cbte_letter: "A", perception_total: 0 });
  });

  it("retención sugerida desde el padrón para la orden de pago", async () => {
    const { data: sup, error } = await ctx.admin
      .from("suppliers")
      .insert({ tenant_id: ctx.tenant, name: `Prov ${STAMP}`, cuit: CUIT_RI } as never)
      .select("id")
      .single();
    expect(error).toBeNull();
    const r = await rpc(ctx.owner.client, "tax_retention_suggest", {
      p_supplier: (sup as { id: string }).id,
      p_allocations: [],
      p_amount: 100000,
    });
    expect(r.data).toEqual([expect.objectContaining({ kind: "iibb", amount: 750, source: "padron" })]);
    const caj = await rpc(ctx.cashier.client, "tax_retention_suggest", { p_supplier: (sup as { id: string }).id, p_amount: 1 });
    expect(caj.error?.message).toMatch(/forbidden/);
  });

  it("documento del cliente validado en el servidor e internos gateados", async () => {
    const bad = await ctx.owner.client
      .from("customers")
      .insert({ tenant_id: ctx.tenant, name: "X", document_type: "cuit", document_number: "20123456789" } as never);
    expect(bad.error?.message).toMatch(/invalid_cuit/);
    const b = await ctx.ownerB.client
      .from("products")
      .insert({ tenant_id: ctx.tenantB, name: "x", price: 1, internal_tax_mode: "fixed", internal_tax_amount: 1 } as never);
    expect(b.error?.message).toMatch(/impuestos_internos/);
    const legacy = await ctx.ownerB.client
      .from("products")
      .insert({ tenant_id: ctx.tenantB, name: `legacy ${STAMP}`, price: 1, tax_rate: 10.5 } as never)
      .select("tax_rate_code")
      .single();
    expect((legacy.data as { tax_rate_code: string }).tax_rate_code).toBe("10.5");
  });

  it("reporte de IVA ventas y aislamiento del staff interno", async () => {
    const r = await rpc(ctx.owner.client, "report_iva_ventas", { p_from: shift(-1), p_to: shift(1) });
    expect(r.error).toBeNull();
    const d = r.data as { perception_total: number; by_letter: { letter: string }[] };
    expect(Number(d.perception_total)).toBe(450);
    expect(d.by_letter.map((x) => x.letter)).toContain("A");
    const caj = await rpc(ctx.cashier.client, "report_iva_ventas", { p_from: today(), p_to: today() });
    expect(caj.error?.message).toMatch(/forbidden/);
    const { data: leaks, error } = await ctx.admin.rpc("rls_internal_scope_leaks" as never);
    expect(error).toBeNull();
    expect(leaks ?? []).toHaveLength(0);
  });
});
