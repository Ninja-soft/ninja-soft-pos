// @vitest-environment node
// =============================================================================
// Libro IVA Digital (ADR-076, migración 20261103100000): gating por plan y rol,
// aislamiento por negocio, sólo comprobantes aprobados de producción, bloqueo
// por comprobantes sin CAE, compras del mes y auditoría al generar.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { RECORD_LENGTH, FILE_NAMES, buildLibroIva, type LibroData } from "@/lib/tax/libroIva";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `liva-test-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type User = { id: string; client: SupabaseClient };
type Ctx = {
  admin: SupabaseClient;
  tenant: string;
  tenantB: string;
  owner: User;
  cashier: User;
  ownerB: User;
  userIds: string[];
  productId: string;
  today: string;
  period: string;
  approvedDoc: string;
  pendingDoc: string;
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

async function sale(): Promise<string> {
  const r = await rpc(ctx.cashier.client, "create_sale", {
    p_items: [{ product_id: ctx.productId, quantity: 1, unit_price: 121, discount: 0 }],
    p_payments: [{ method: "cash", amount: 121 }],
  });
  if (r.error) throw new Error(r.error.message);
  const saleId = (r.data as { sale_id: string }).sale_id;
  const { data: doc, error } = await ctx.admin.from("fiscal_documents").select("id").eq("sale_id", saleId).single();
  if (error || !doc) throw error ?? new Error("fiscal_document");
  return (doc as { id: string }).id;
}

describe.skipIf(!enabled)("Libro IVA Digital · gating, RLS, período y auditoría", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];
    ctx.today = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
    ctx.period = ctx.today.slice(0, 7);

    const { data: t, error } = await admin
      .from("tenants")
      .insert([
        { name: `Libro A ${STAMP}`, slug: `la-${STAMP}`, status: "active" },
        { name: `Libro B ${STAMP}`, slug: `lb-${STAMP}`, status: "active" },
      ])
      .select("id, slug");
    if (error || !t) throw error ?? new Error("tenants");
    const rows = t as { id: string; slug: string }[];
    ctx.tenant = rows.find((x) => x.slug === `la-${STAMP}`)!.id;
    ctx.tenantB = rows.find((x) => x.slug === `lb-${STAMP}`)!.id;

    const { error: aErr } = await admin
      .from("subscription_addons")
      .insert({ tenant_id: ctx.tenant, addon_key: "facturacion_afip", status: "active", source: "granted" });
    if (aErr) throw aErr;

    ctx.owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenant, "owner");
    ctx.cashier = await makeUser(admin, `caj-${STAMP}@test.local`, ctx.tenant, "cashier");
    ctx.ownerB = await makeUser(admin, `ownerb-${STAMP}@test.local`, ctx.tenantB, "owner");
    ctx.userIds.push(ctx.owner.id, ctx.cashier.id, ctx.ownerB.id);

    const tax = await rpc(ctx.owner.client, "tax_settings_save", { p: { iva_condition: "responsable_inscripto", cuit: "30-50000000-3" } });
    if (tax.error) throw new Error(tax.error.message);
    const arca = await rpc(ctx.owner.client, "arca_settings_save", { p: { enabled: true } });
    if (arca.error) throw new Error(arca.error.message);

    const { data: store, error: sErr } = await ctx.owner.client
      .from("stores")
      .insert({ name: "Centro", afip_pos_number: 3 } as never)
      .select("id")
      .single();
    if (sErr || !store) throw sErr ?? new Error("store");
    const { data: reg, error: rErr } = await ctx.owner.client
      .from("cash_registers")
      .insert({ store_id: (store as { id: string }).id, name: "Caja 1" } as never)
      .select("id")
      .single();
    if (rErr || !reg) throw rErr ?? new Error("register");
    const sh = await rpc(ctx.cashier.client, "open_cash_shift", { p_register_id: (reg as { id: string }).id, p_opening_amount: 0 });
    if (sh.error) throw new Error(sh.error.message);
    const { data: prod, error: pErr } = await ctx.owner.client
      .from("products")
      .insert({ tenant_id: ctx.tenant, name: `Prod ${STAMP}`, price: 121, tax_rate_code: "21" } as never)
      .select("id")
      .single();
    if (pErr || !prod) throw pErr ?? new Error("product");
    ctx.productId = (prod as { id: string }).id;

    // Tres ventas: una aprobada en producción, una todavía sin CAE en
    // producción y una aprobada en homologación (no va al libro).
    ctx.approvedDoc = await sale();
    ctx.pendingDoc = await sale();
    const homoDoc = await sale();
    const approve = (id: string, env: string, nro: number, cae: string) =>
      admin
        .from("fiscal_documents")
        .update({
          environment: env, status: "aprobado", cbte_nro: nro, cbte_fch: ctx.today, doc_tipo: 99, doc_nro: "0",
          imp_total: 121, cae, cae_vto: ctx.today, approved_at: new Date().toISOString(),
        })
        .eq("id", id);
    const a1 = await approve(ctx.approvedDoc, "produccion", 1, "76412345678901");
    if (a1.error) throw a1.error;
    const a2 = await approve(homoDoc, "homologacion", 1, "76412345678902");
    if (a2.error) throw a2.error;
    const p1 = await admin.from("fiscal_documents").update({ environment: "produccion", status: "requiere_accion" }).eq("id", ctx.pendingDoc);
    if (p1.error) throw p1.error;

    // Proveedores y comprobantes de compra (inserción multi-fila: todas las
    // claves en cada fila).
    const { data: sup, error: supErr } = await admin
      .from("suppliers")
      .insert([
        { tenant_id: ctx.tenant, name: "Mayorista Güemes", cuit: "30712345671", iva_condition: "responsable_inscripto" },
        { tenant_id: ctx.tenant, name: "Fletes Ramírez", cuit: "20123456786", iva_condition: "monotributo" },
        { tenant_id: ctx.tenantB, name: "Proveedor de B", cuit: "33699999992", iva_condition: "responsable_inscripto" },
      ])
      .select("id, tenant_id, name");
    if (supErr || !sup) throw supErr ?? new Error("suppliers");
    const s = sup as { id: string; tenant_id: string; name: string }[];
    const sid = (name: string) => s.find((x) => x.name === name)!.id;
    const { error: invErr } = await admin.from("supplier_invoices").insert([
      {
        tenant_id: ctx.tenant, supplier_id: sid("Mayorista Güemes"), kind: "invoice", letter: "A", point_of_sale: 2, number: 1234,
        issue_date: ctx.today, vat_lines: [{ rate: 21, net: 1000, vat: 210 }], exempt_amount: 0, non_taxed_amount: 0,
        other_taxes: [{ kind: "percepcion_iibb", amount: 20, jurisdiction: "902" }], net_total: 1000, vat_total: 210,
        other_taxes_total: 20, total: 1230,
      },
      {
        tenant_id: ctx.tenant, supplier_id: sid("Fletes Ramírez"), kind: "invoice", letter: "C", point_of_sale: 1, number: 77,
        issue_date: ctx.today, vat_lines: [{ rate: 0, net: 500, vat: 0 }], exempt_amount: 0, non_taxed_amount: 0,
        other_taxes: [], net_total: 500, vat_total: 0, other_taxes_total: 0, total: 500,
      },
      {
        tenant_id: ctx.tenantB, supplier_id: sid("Proveedor de B"), kind: "invoice", letter: "A", point_of_sale: 9, number: 9,
        issue_date: ctx.today, vat_lines: [{ rate: 21, net: 100, vat: 21 }], exempt_amount: 0, non_taxed_amount: 0,
        other_taxes: [], net_total: 100, vat_total: 21, other_taxes_total: 0, total: 121,
      },
    ]);
    if (invErr) throw invErr;
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

  it("gating: cajero no, negocio sin facturación electrónica no, anónimo no", async () => {
    const caj = await rpc(ctx.cashier.client, "libro_iva_data", { p_period: `${ctx.period}-01` });
    expect(caj.error?.message).toMatch(/forbidden/);
    const b = await rpc(ctx.ownerB.client, "libro_iva_data", { p_period: `${ctx.period}-01` });
    expect(b.error?.message).toMatch(/feature_not_in_plan: facturacion_afip/);
    const anon = createClient(URL_!, ANON!, { auth: { persistSession: false } });
    const a = await rpc(anon, "libro_iva_data", { p_period: `${ctx.period}-01` });
    expect(a.error).not.toBeNull();
    const cajLog = await rpc(ctx.cashier.client, "libro_iva_log", { p_period: `${ctx.period}-01`, p_summary: {} });
    expect(cajLog.error?.message).toMatch(/forbidden/);
  });

  it("período futuro rechazado", async () => {
    const r = await rpc(ctx.owner.client, "libro_iva_data", { p_period: "2999-01-01" });
    expect(r.error?.message).toMatch(/period_invalid/);
  });

  it("sólo lo aprobado en producción y del propio negocio; lo sin CAE bloquea", async () => {
    const r = await rpc(ctx.owner.client, "libro_iva_data", { p_period: `${ctx.period}-01` });
    expect(r.error).toBeNull();
    const data = r.data as LibroData;
    expect(data.ventas.map((v) => v.id)).toEqual([ctx.approvedDoc]);
    expect(data.pending.map((p) => p.id)).toEqual([ctx.pendingDoc]);
    expect(data.homologacion_count).toBe(1);
    expect(data.compras.map((c) => c.supplier.name).sort()).toEqual(["Fletes Ramírez", "Mayorista Güemes"]);
    expect(data.emitter.cuit).toBe("30500000003");

    const built = buildLibroIva(data);
    expect(built.issues.filter((i) => i.level === "error").map((i) => i.code)).toEqual(["pendientes_cae"]);
  });

  it("resuelto lo pendiente, el libro se arma y la generación queda auditada", async () => {
    await ctx.admin.from("fiscal_documents").update({ status: "cancelado" }).eq("id", ctx.pendingDoc);
    const r = await rpc(ctx.owner.client, "libro_iva_data", { p_period: `${ctx.period}-01` });
    const built = buildLibroIva(r.data as LibroData);
    expect(built.summary.errors).toBe(0);
    const ventas = built.files.find((f) => f.name === FILE_NAMES.ventasCbte)!.content.split("\r\n").filter(Boolean);
    expect(ventas).toHaveLength(1);
    expect(ventas[0]).toHaveLength(RECORD_LENGTH.ventasCbte);
    expect(ventas[0]!.slice(108, 123)).toBe("000000000012100");

    const log = await rpc(ctx.owner.client, "libro_iva_log", { p_period: `${ctx.period}-01`, p_summary: { ventas: built.summary.ventas } });
    expect(log.error).toBeNull();
    const { data: logs } = await ctx.admin
      .from("audit_logs")
      .select("action, entity_type, after_data, actor_user_id")
      .eq("tenant_id", ctx.tenant)
      .eq("action", "libro_iva_generated");
    expect(logs).toEqual([
      expect.objectContaining({
        entity_type: "libro_iva_digital",
        actor_user_id: ctx.owner.id,
        after_data: expect.objectContaining({ period: ctx.period }),
      }),
    ]);
    const bad = await rpc(ctx.owner.client, "libro_iva_log", { p_period: `${ctx.period}-01`, p_summary: [] });
    expect(bad.error?.message).toMatch(/summary_invalid/);
  });

  it("staff interno sin fugas de is_internal y otro negocio sin acceso", async () => {
    const leaks = await rpc(ctx.admin, "rls_internal_scope_leaks");
    expect(leaks.error).toBeNull();
    expect((leaks.data as unknown[] | null) ?? []).toHaveLength(0);
    const other = await rpc(ctx.ownerB.client, "libro_iva_log", { p_period: `${ctx.period}-01`, p_summary: {} });
    expect(other.error?.message).toMatch(/feature_not_in_plan/);
  });
});
