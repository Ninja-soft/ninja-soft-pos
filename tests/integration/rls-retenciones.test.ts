// @vitest-environment node
// =============================================================================
// Retenciones como agente (ADR-079, migraciones 20261104200000 y
// 20261104200100): paridad del cálculo SQL con lib/tax/retentions.ts (misma
// matriz), orden de pago con certificados correlativos y acumulado mensual,
// anulación, exportación auditada, gating por plan y rol y RLS por negocio.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { RET_CASES } from "../fixtures/retentionMatrix";
import { buildExport, type WithholdingExportRow } from "@/lib/tax/sicore";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `ret-test-${Math.random().toString(36).slice(2, 8)}`;
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
  today: string;
  month: string;
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

describe.skipIf(!enabled)("Retenciones como agente · paridad, certificados, gating y RLS", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];
    ctx.today = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
    ctx.month = `${ctx.today.slice(0, 7)}-01`;

    const t = await must(
      admin
        .from("tenants")
        .insert([
          { name: `Ret A ${STAMP}`, slug: `ra-${STAMP}`, status: "active" },
          { name: `Ret B ${STAMP}`, slug: `rb-${STAMP}`, status: "active" },
          { name: `Ret N ${STAMP}`, slug: `rn-${STAMP}`, status: "active" },
        ])
        .select("id, slug"),
    );
    const rows = t as { id: string; slug: string }[];
    ctx.tenant = rows.find((x) => x.slug === `ra-${STAMP}`)!.id;
    ctx.tenantB = rows.find((x) => x.slug === `rb-${STAMP}`)!.id;
    ctx.tenantN = rows.find((x) => x.slug === `rn-${STAMP}`)!.id;

    // Inserción multi-fila por PostgREST: todas las claves en cada fila.
    await must(
      admin.from("subscription_addons").insert([
        { tenant_id: ctx.tenant, addon_key: "compras", status: "active", source: "granted" },
        { tenant_id: ctx.tenant, addon_key: "percepciones_retenciones", status: "active", source: "granted" },
        { tenant_id: ctx.tenant, addon_key: "impuestos_iva", status: "active", source: "granted" },
        { tenant_id: ctx.tenantB, addon_key: "compras", status: "active", source: "granted" },
        { tenant_id: ctx.tenantB, addon_key: "percepciones_retenciones", status: "active", source: "granted" },
        { tenant_id: ctx.tenantN, addon_key: "compras", status: "active", source: "granted" },
      ]),
    );

    ctx.owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenant, "owner");
    ctx.cashier = await makeUser(admin, `caj-${STAMP}@test.local`, ctx.tenant, "cashier");
    ctx.ownerB = await makeUser(admin, `ownerb-${STAMP}@test.local`, ctx.tenantB, "owner");
    ctx.ownerN = await makeUser(admin, `ownern-${STAMP}@test.local`, ctx.tenantN, "owner");
    ctx.userIds.push(ctx.owner.id, ctx.cashier.id, ctx.ownerB.id, ctx.ownerN.id);

    const tax = await rpc(ctx.owner.client, "tax_settings_save", {
      p: { iva_condition: "responsable_inscripto", cuit: "30-50000000-3" },
    });
    if (tax.error) throw new Error(tax.error.message);
  }, 180_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin || !ctx.tenant) return;
    for (const tenant of [ctx.tenant, ctx.tenantB, ctx.tenantN]) {
      await admin.from("subscription_addons").delete().eq("tenant_id", tenant);
      await admin.from("audit_logs").delete().eq("tenant_id", tenant);
      await admin.from("tenants").delete().eq("id", tenant);
    }
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("paridad SQL ↔ TypeScript con la matriz de retenciones", async () => {
    const { admin } = ctx;
    for (const c of RET_CASES) {
      // Estado limpio del negocio para el caso.
      await admin.from("tax_regimes").update({ deleted_at: new Date().toISOString() }).eq("tenant_id", ctx.tenant).is("deleted_at", null);
      await admin.from("tax_padron_imports").delete().eq("tenant_id", ctx.tenant);
      await admin.from("suppliers").update({ deleted_at: new Date().toISOString() }).eq("tenant_id", ctx.tenant).is("deleted_at", null);

      const sup = (await must(
        admin
          .from("suppliers")
          .insert({ tenant_id: ctx.tenant, name: `Prov ${c.name.slice(0, 40)}`, cuit: c.supplier.cuit, iva_condition: c.supplier.iva_condition })
          .select("id")
          .single(),
      )) as { id: string };
      await must(
        ctx.owner.client.from("supplier_tax_profiles").insert({
          tenant_id: ctx.tenant,
          supplier_id: sup.id,
          ganancias_condition: c.supplier.ganancias_condition,
          ganancias_concept: c.supplier.ganancias_concept,
          suss_code: c.supplier.suss_code,
        } as never),
      );
      // Regímenes como dueño, multi-fila con todas las claves.
      const regs = (await must(
        ctx.owner.client
          .from("tax_regimes")
          .insert(
            c.regimes.map((r) => ({
              tenant_id: ctx.tenant,
              tax: r.tax,
              role: "retention",
              jurisdiction: r.jurisdiction,
              name: r.name,
              padron_source: r.padron_source,
              default_rate: r.default_rate,
              rates_by_condition: r.rates_by_condition,
              base_kind: r.base_kind,
              min_base: r.min_base,
              min_amount: r.min_amount,
              applies_to: r.applies_to,
            })) as never,
          )
          .select("id, tax, jurisdiction"),
      )) as { id: string; tax: string; jurisdiction: string | null }[];
      const keyOf = (id: string) => {
        const r = regs.find((x) => x.id === id)!;
        return c.regimes.find((x) => x.tax === r.tax && x.jurisdiction === r.jurisdiction)!.key;
      };
      for (const r of c.regimes) {
        const rate = c.padron?.[r.key];
        if (rate == null) continue;
        const imp = (await must(
          admin
            .from("tax_padron_imports")
            .insert({ tenant_id: ctx.tenant, jurisdiction: r.jurisdiction, format: r.padron_source, kind: "retention", status: "ready" })
            .select("id")
            .single(),
        )) as { id: string };
        await must(
          admin.from("tax_padron_entries").insert({
            import_id: imp.id, tenant_id: ctx.tenant, jurisdiction: r.jurisdiction, cuit: c.supplier.cuit,
            valid_from: ctx.month, valid_to: "2999-12-31", retention_rate: rate,
          }),
        );
      }
      for (const e of c.exemptions ?? []) {
        await must(
          ctx.owner.client.from("tax_exemptions").insert({
            tenant_id: ctx.tenant, party: "supplier", party_id: sup.id, tax: e.tax, jurisdiction: e.jurisdiction,
            pct: e.pct, valid_from: ctx.month,
          } as never),
        );
      }
      if (c.prior) {
        const gan = regs.find((r) => r.tax === "ganancias")!;
        const pay = (await must(
          admin
            .from("supplier_payments")
            .insert({
              tenant_id: ctx.tenant, number: 900000 + RET_CASES.indexOf(c), supplier_id: sup.id, method: "otro",
              amount: c.prior.base, net_paid: c.prior.base, withholdings_total: 0, kind: "order", paid_date: ctx.today,
            })
            .select("id")
            .single(),
        )) as { id: string };
        await must(
          admin.from("tax_withholdings").insert({
            tenant_id: ctx.tenant, payment_id: pay.id, payment_number: 1, payment_total: c.prior.base, supplier_id: sup.id,
            regime_id: gan.id, tax: "ganancias", date: ctx.today, period: ctx.month, concept_code: c.supplier.ganancias_concept,
            payment_base: c.prior.base, amount: c.prior.withheld, reason: "applied",
            certificate_number: c.prior.withheld > 0 ? 1 : null,
          }),
        );
      }
      let allocations: { invoice_id: string; amount: number }[] = [];
      if (c.invoice) {
        const i = c.invoice;
        const inv = (await must(
          admin
            .from("supplier_invoices")
            .insert({
              tenant_id: ctx.tenant, supplier_id: sup.id, kind: "invoice", letter: "A", point_of_sale: 1,
              number: 1 + RET_CASES.indexOf(c), issue_date: ctx.today, net_total: i.net_total, vat_total: i.vat_total,
              exempt_amount: i.exempt_amount, non_taxed_amount: i.non_taxed_amount, total: i.total,
            })
            .select("id")
            .single(),
        )) as { id: string };
        allocations = [{ invoice_id: inv.id, amount: i.alloc }];
      }

      const r = await rpc(ctx.owner.client, "tax_retention_preview", {
        p: { supplier_id: sup.id, allocations, amount: c.amount ?? 0, date: ctx.today },
      });
      expect(r.error, c.name).toBeNull();
      const res = r.data as { total: number; lines: { regime_id: string; applies: boolean; reason: string; amount: number }[] };
      expect(Number(res.total), c.name).toBe(c.expectTotal);
      for (const e of c.expect) {
        const l = res.lines.find((x) => keyOf(x.regime_id) === e.key)!;
        expect({ k: e.key, applies: l.applies, reason: l.reason, amount: Number(l.amount) }, c.name).toEqual({
          k: e.key,
          applies: e.applies,
          reason: e.reason,
          amount: e.amount,
        });
      }
    }
  }, 300_000);

  it("orden de pago: recalcula en el servidor, numera certificados, acumula en el mes y anula", async () => {
    const { admin } = ctx;
    await admin.from("tax_regimes").update({ deleted_at: new Date().toISOString() }).eq("tenant_id", ctx.tenant).is("deleted_at", null);
    await admin.from("suppliers").update({ deleted_at: new Date().toISOString() }).eq("tenant_id", ctx.tenant).is("deleted_at", null);
    await must(
      ctx.owner.client.from("tax_regimes").insert([
        { tenant_id: ctx.tenant, tax: "ganancias", role: "retention", jurisdiction: null, name: "Ganancias", padron_source: "none", default_rate: null, base_kind: "net" },
        { tenant_id: ctx.tenant, tax: "iibb", role: "retention", jurisdiction: "902", name: "IIBB ARBA", padron_source: "none", default_rate: 1, base_kind: "net" },
      ] as never),
    );
    const sup = (await must(
      admin
        .from("suppliers")
        .insert({ tenant_id: ctx.tenant, name: `Servicios ${STAMP}`, cuit: "30712345671", iva_condition: "responsable_inscripto" })
        .select("id")
        .single(),
    )) as { id: string };
    const invs = (await must(
      admin
        .from("supplier_invoices")
        .insert([
          { tenant_id: ctx.tenant, supplier_id: sup.id, kind: "invoice", letter: "A", point_of_sale: 7, number: 10, issue_date: ctx.today, net_total: 100000, vat_total: 21000, total: 121000 },
          { tenant_id: ctx.tenant, supplier_id: sup.id, kind: "invoice", letter: "A", point_of_sale: 7, number: 11, issue_date: ctx.today, net_total: 50000, vat_total: 10500, total: 60500 },
        ])
        .select("id, number"),
    )) as { id: string; number: number }[];
    const inv = (n: number) => invs.find((i) => i.number === n)!.id;
    const op = (invoice: string, alloc: number, net: number, expected: number) =>
      rpc(ctx.owner.client, "supplier_payment_order_create", {
        p: {
          supplier_id: sup.id, paid_date: ctx.today, lines: [{ method: "transferencia", amount: net, reference: "TRF" }],
          allocations: [{ invoice_id: invoice, amount: alloc }], withholdings: [],
          agent_retentions: true, agent_expected_total: expected,
          retention_options: { ganancias_concept: "094", save_profile: true },
        },
      });

    const stale = await op(inv(10), 121000, 119343.4, 1);
    expect(stale.error?.message).toMatch(/retentions_changed/);
    const first = await op(inv(10), 121000, 119343.4, 1656.6);
    expect(first.error).toBeNull();
    const second = await op(inv(11), 60500, 59000, 1500);
    expect(second.error).toBeNull();

    const wh = (await must(
      ctx.owner.client
        .from("tax_withholdings")
        .select("payment_id, tax, amount, certificate, prior_base, prior_withheld, status")
        .eq("supplier_id", sup.id)
        .order("created_at"),
    )) as { payment_id: string; tax: string; amount: number; certificate: string; prior_base: number; prior_withheld: number }[];
    const of = (pay: unknown, tax: string) => wh.find((w) => w.payment_id === pay && w.tax === tax)!;
    expect(of(first.data, "ganancias")).toMatchObject({ certificate: "GAN-00000001" });
    expect(Number(of(first.data, "ganancias").amount)).toBe(656.6);
    expect(of(second.data, "ganancias")).toMatchObject({ certificate: "GAN-00000002" });
    expect(Number(of(second.data, "ganancias").amount)).toBe(1000);
    expect(Number(of(second.data, "ganancias").prior_withheld)).toBe(656.6);
    expect(of(second.data, "iibb")).toMatchObject({ certificate: "IIBB902-00000002" });

    const pay = (await must(
      ctx.owner.client.from("supplier_payments").select("withholdings_total, net_paid, amount").eq("id", first.data as string).single(),
    )) as { withholdings_total: number; net_paid: number; amount: number };
    expect(Number(pay.withholdings_total)).toBe(1656.6);
    expect(Number(pay.amount)).toBe(121000);

    const profile = (await must(
      ctx.owner.client.from("supplier_tax_profiles").select("ganancias_concept").eq("supplier_id", sup.id).single(),
    )) as { ganancias_concept: string };
    expect(profile.ganancias_concept).toBe("094");

    // Anular la primera: sus retenciones quedan anuladas y el número no se reutiliza.
    const v = await rpc(ctx.owner.client, "supplier_payment_void", { p_id: first.data, p_reason: "prueba" });
    expect(v.error).toBeNull();
    const after = (await must(
      ctx.owner.client.from("tax_withholdings").select("status").eq("payment_id", first.data as string),
    )) as { status: string }[];
    expect(after.every((x) => x.status === "voided")).toBe(true);

    const ex = await rpc(ctx.owner.client, "tax_withholdings_export", { p_period: ctx.today, p_format: "sicore" });
    expect(ex.error).toBeNull();
    const data = ex.data as { agent: { cuit: string; name: string }; rows: WithholdingExportRow[] };
    expect(data.rows.map((r) => r.certificate)).toEqual(["GAN-00000002"]);
    const file = buildExport("sicore", data.agent, ctx.today, data.rows.map((r) => ({ ...r, amount: Number(r.amount) })));
    expect(file.records).toBe(1);

    const { data: logs } = await admin
      .from("audit_logs")
      .select("action")
      .eq("tenant_id", ctx.tenant)
      .in("action", ["tax_withholdings_issued", "tax_withholdings_voided", "tax_withholdings_exported"]);
    const actions = ((logs ?? []) as { action: string }[]).map((l) => l.action);
    expect(actions).toEqual(expect.arrayContaining(["tax_withholdings_issued", "tax_withholdings_voided", "tax_withholdings_exported"]));
  }, 120_000);

  it("gating y RLS: cajero, otro negocio, plan sin la feature y anónimo", async () => {
    const caj = await rpc(ctx.cashier.client, "tax_retention_preview", { p: { supplier_id: ctx.tenant, amount: 1 } });
    expect(caj.error?.message).toMatch(/forbidden/);
    const cajRows = await ctx.cashier.client.from("tax_withholdings").select("id");
    expect(cajRows.data ?? []).toHaveLength(0);
    const cajIns = await ctx.cashier.client
      .from("tax_ret_concept_settings")
      .insert({ tenant_id: ctx.tenant, tax: "ganancias", code: "094", is_active: true } as never);
    expect(cajIns.error).not.toBeNull();

    const bRows = await ctx.ownerB.client.from("tax_withholdings").select("id");
    expect(bRows.data ?? []).toHaveLength(0);
    const bProf = await ctx.ownerB.client.from("supplier_tax_profiles").select("id");
    expect(bProf.data ?? []).toHaveLength(0);
    const bExp = await rpc(ctx.ownerB.client, "tax_withholdings_export", { p_period: ctx.today, p_format: "sicore" });
    expect((bExp.data as { rows: unknown[] }).rows).toHaveLength(0);

    const n = await rpc(ctx.ownerN.client, "tax_withholdings_list", { p_from: ctx.month, p_to: ctx.today });
    expect(n.error?.message).toMatch(/feature_not_in_plan: percepciones_retenciones/);
    const nIns = await ctx.ownerN.client
      .from("tax_ret_concept_settings")
      .insert({ tenant_id: ctx.tenantN, tax: "ganancias", code: "094", is_active: true } as never);
    expect(nIns.error).not.toBeNull();

    // Ajuste del negocio: inserción multi-fila con todas las claves y código inválido rechazado.
    const ok = await ctx.owner.client.from("tax_ret_concept_settings").insert([
      { tenant_id: ctx.tenant, tax: "ganancias", code: "078", is_active: true, min_non_taxable: null, rate_registered: null, rate_unregistered: null, min_withholding: null, sicore_regime_code: null, notes: null },
      { tenant_id: ctx.tenant, tax: "suss", code: "limpieza", is_active: true, min_non_taxable: null, rate_registered: null, rate_unregistered: null, min_withholding: null, sicore_regime_code: "755", notes: "contador" },
    ] as never);
    expect(ok.error).toBeNull();
    const bad = await ctx.owner.client
      .from("tax_ret_concept_settings")
      .insert({ tenant_id: ctx.tenant, tax: "ganancias", code: "999", is_active: true } as never);
    expect(bad.error?.message).toMatch(/invalid_concept/);
    const list = await rpc(ctx.owner.client, "tax_ret_concepts_list", {});
    const suss = (list.data as { tax: string; code: string; sicore_regime_code: string | null }[]).find(
      (c) => c.tax === "suss" && c.code === "limpieza",
    );
    expect(suss?.sicore_regime_code).toBe("755");

    const anon = createClient(URL_!, ANON!, { auth: { persistSession: false } });
    const a = await rpc(anon, "tax_retention_preview", { p: {} });
    expect(a.error).not.toBeNull();
    const aRows = await anon.from("tax_withholdings").select("id");
    expect(aRows.data ?? []).toHaveLength(0);

    const leaks = await rpc(ctx.admin, "rls_internal_scope_leaks");
    expect((leaks.data as unknown[] | null) ?? []).toHaveLength(0);
  }, 60_000);
});
