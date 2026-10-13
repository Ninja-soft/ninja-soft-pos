// @vitest-environment node
// =============================================================================
// Facturación electrónica ARCA (ADR-072, migraciones 20261101100000 a
// 20261101100200): secretos ilegibles, RLS por negocio y rol, gating por plan,
// encolado por trigger sin frenar la venta, checklist de producción, cola con
// dead-letter, contingencia CAEA y aislamiento del staff interno.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos. No llama a
// ARCA: la Edge no interviene (el worker se simula con las RPC de service_role).
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `arca-test-${Math.random().toString(36).slice(2, 8)}`;
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
  storeId: string;
  productId: string;
  docId: string;
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

describe.skipIf(!enabled)("facturación ARCA · RLS, gating, cola y contingencia", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];
    const { data: t, error } = await admin
      .from("tenants")
      .insert([
        { name: `Arca A ${STAMP}`, slug: `aa-${STAMP}`, status: "active" },
        { name: `Arca B ${STAMP}`, slug: `ab-${STAMP}`, status: "active" },
      ])
      .select("id, slug");
    if (error || !t) throw error ?? new Error("tenants");
    const rows = t as { id: string; slug: string }[];
    ctx.tenant = rows.find((x) => x.slug === `aa-${STAMP}`)!.id;
    ctx.tenantB = rows.find((x) => x.slug === `ab-${STAMP}`)!.id;

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

    const { data: store, error: sErr } = await ctx.owner.client
      .from("stores")
      .insert({ name: "Centro", afip_pos_number: 3 } as never)
      .select("id")
      .single();
    if (sErr || !store) throw sErr ?? new Error("store");
    ctx.storeId = (store as { id: string }).id;
    const { data: reg, error: rErr } = await ctx.owner.client
      .from("cash_registers")
      .insert({ store_id: ctx.storeId, name: "Caja 1" } as never)
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

  it("certificados, tickets y plataforma: ilegibles para todos por PostgREST", async () => {
    await rpc(ctx.admin, "arca_certificate_store", {
      p_tenant: ctx.tenant,
      p_user: ctx.owner.id,
      p: {
        environment: "homologacion",
        status: "active",
        cert_pem: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
        key_enc: "v1:QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=",
        cuit: "30500000003",
        not_after: "2030-01-01T00:00:00Z",
      },
    });
    for (const table of ["arca_certificates", "arca_tickets", "arca_platform", "arca_platform_tickets"]) {
      const r = await ctx.owner.client.from(table as never).select("*");
      expect(r.error !== null || (r.data ?? []).length === 0, table).toBe(true);
    }
    const ins = await ctx.owner.client
      .from("arca_certificates" as never)
      .insert({ tenant_id: ctx.tenant, environment: "produccion", key_enc: "v1:x", cert_pem: "-----BEGIN CERTIFICATE-----x" } as never);
    expect(ins.error).not.toBeNull();
    const cfg = await rpc(ctx.owner.client, "arca_config_get");
    expect(cfg.error).toBeNull();
    const certs = (cfg.data as { certificates: Record<string, unknown>[] }).certificates;
    expect(certs).toHaveLength(1);
    expect(certs[0]).not.toHaveProperty("key_enc");
    expect(certs[0]).not.toHaveProperty("cert_pem");
  });

  it("configuración: dueño sí; cajero no; negocio sin plan no; delegado no disponible", async () => {
    const caj = await rpc(ctx.cashier.client, "arca_config_get");
    expect(caj.error?.message).toMatch(/forbidden/);
    const cajSave = await rpc(ctx.cashier.client, "arca_settings_save", { p: { enabled: true } });
    expect(cajSave.error?.message).toMatch(/forbidden/);
    const b = await rpc(ctx.ownerB.client, "arca_settings_save", { p: { enabled: true } });
    expect(b.error?.message).toMatch(/feature_not_in_plan: facturacion_afip/);
    const del = await rpc(ctx.owner.client, "arca_settings_save", { p: { auth_mode: "delegado" } });
    expect(del.error?.message).toMatch(/platform_not_configured/);
    const ok = await rpc(ctx.owner.client, "arca_settings_save", { p: { enabled: true } });
    expect(ok.error).toBeNull();
    expect(ok.data).toMatchObject({ enabled: true, auth_mode: "propio", environment: "homologacion" });
    const { data: logs } = await ctx.admin
      .from("audit_logs")
      .select("action")
      .eq("tenant_id", ctx.tenant)
      .in("action", ["arca_settings_updated", "arca_certificate_uploaded"]);
    expect((logs ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("la venta se completa y la factura B queda en la cola, visible para el cajero y no para otro negocio", async () => {
    const r = await rpc(ctx.cashier.client, "create_sale", {
      p_items: [{ product_id: ctx.productId, quantity: 1, unit_price: 121, discount: 0 }],
      p_payments: [{ method: "cash", amount: 121 }],
    });
    expect(r.error).toBeNull();
    ctx.saleId = (r.data as { sale_id: string }).sale_id;
    const { data: docs } = await ctx.cashier.client
      .from("fiscal_documents" as never)
      .select("id, status, cbte_tipo, pto_vta, origin, environment")
      .eq("sale_id", ctx.saleId);
    expect(docs).toEqual([expect.objectContaining({ status: "pendiente", cbte_tipo: 6, pto_vta: 3, origin: "sale", environment: "homologacion" })]);
    ctx.docId = (docs as { id: string }[])[0]!.id;
    const other = await ctx.ownerB.client.from("fiscal_documents" as never).select("id").eq("sale_id", ctx.saleId);
    expect(other.data ?? []).toHaveLength(0);
    const direct = await ctx.owner.client
      .from("fiscal_documents" as never)
      .update({ status: "aprobado", cae: "12345678901234" } as never)
      .eq("id", ctx.docId)
      .select("id");
    expect(direct.error !== null || (direct.data ?? []).length === 0).toBe(true);
    const st = await rpc(ctx.cashier.client, "arca_status");
    expect(st.data).toMatchObject({ enabled: true, contingency: false, pending: 1 });
  });

  it("worker: toma con lease, número antes de mandar, aprobado con CAE; dead-letter tras agotar reintentos", async () => {
    const claim = await rpc(ctx.admin, "arca_claim", { p_tenant: ctx.tenant, p_limit: 5 });
    expect(claim.data).toEqual([expect.objectContaining({ id: ctx.docId, recovering: false })]);
    const again = await rpc(ctx.admin, "arca_claim", { p_tenant: ctx.tenant, p_limit: 5 });
    expect(again.data).toEqual([]);
    const caj = await rpc(ctx.cashier.client, "arca_claim", { p_tenant: ctx.tenant });
    expect(caj.error).not.toBeNull();
    await rpc(ctx.admin, "arca_mark_sending", { p_doc: ctx.docId, p: { cbte_nro: 12, cbte_fch: "2026-10-13", concepto: 1, doc_tipo: 99, doc_nro: "0" } });
    const ok = await rpc(ctx.admin, "arca_apply_result", {
      p_doc: ctx.docId,
      p: { outcome: "aprobado", cbte_nro: 12, cbte_fch: "2026-10-13", cae: "76412345678901", cae_vto: "2026-10-23", qr_url: "https://www.afip.gob.ar/fe/qr/?p=e30=" },
    });
    expect(ok.data).toMatchObject({ status: "aprobado" });
    const { data: doc } = await ctx.cashier.client.from("fiscal_documents" as never).select("status, cae, cbte_nro").eq("id", ctx.docId).single();
    expect(doc).toMatchObject({ status: "aprobado", cae: "76412345678901", cbte_nro: 12 });

    // Devolución → NC pendiente; se agotan los reintentos → dead-letter.
    const { data: ret } = await ctx.admin
      .from("sale_returns")
      .insert({ tenant_id: ctx.tenant, sale_id: ctx.saleId, number: 1, refund_method: "cash", total: 60.5 })
      .select("id")
      .single();
    expect(ret).toBeTruthy();
    const { data: nc } = await ctx.admin.from("fiscal_documents").select("id, status, cbte_tipo, assoc_document_id").eq("return_id", (ret as { id: string }).id).single();
    expect(nc).toMatchObject({ status: "pendiente", cbte_tipo: 8, assoc_document_id: ctx.docId });
    await ctx.admin.from("fiscal_documents").update({ status: "enviando", attempts: 10 }).eq("id", (nc as { id: string }).id);
    const dead = await rpc(ctx.admin, "arca_apply_result", { p_doc: (nc as { id: string }).id, p: { outcome: "reintentar", error_code: "sin_respuesta", error_msg: "timeout" } });
    expect(dead.data).toMatchObject({ status: "requiere_accion", dead_letter: true });
    const retry = await rpc(ctx.owner.client, "arca_document_retry", { p_id: (nc as { id: string }).id });
    expect(retry.data).toMatchObject({ status: "pendiente" });
    const cajRetry = await rpc(ctx.cashier.client, "arca_document_retry", { p_id: (nc as { id: string }).id });
    expect(cajRetry.error?.message).toMatch(/forbidden/);
  });

  it("producción bloqueada sin checklist; contingencia CAEA con punto de venta exclusivo", async () => {
    const prod = await rpc(ctx.owner.client, "arca_set_environment", { p_environment: "produccion", p_reason: "test" });
    expect(prod.error?.message).toMatch(/checklist_incomplete/);
    const inUse = await rpc(ctx.owner.client, "arca_settings_save", { p: { caea_enabled: true, caea_pto_vta: 3 } });
    expect(inUse.error?.message).toMatch(/caea_pto_vta_in_use/);
    const on = await rpc(ctx.owner.client, "arca_settings_save", { p: { caea_enabled: true, caea_pto_vta: 90 } });
    expect(on.error).toBeNull();
    const tasks = await rpc(ctx.admin, "arca_caea_tasks", { p_tenant: ctx.tenant });
    expect((tasks.data as { request: unknown[] }).request.length).toBeGreaterThan(0);

    const today = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
    const d = Number(today.slice(8, 10));
    await rpc(ctx.admin, "arca_caea_store", {
      p_tenant: ctx.tenant,
      p_env: "homologacion",
      p: {
        periodo: Number(today.slice(0, 4) + today.slice(5, 7)),
        orden: d <= 15 ? 1 : 2,
        caea: "31423456789012",
        fch_vig_desde: today,
        fch_vig_hasta: today,
        fch_tope_inf: today,
      },
    });
    const r = await rpc(ctx.cashier.client, "create_sale", {
      p_items: [{ product_id: ctx.productId, quantity: 1, unit_price: 121, discount: 0 }],
      p_payments: [{ method: "cash", amount: 121 }],
    });
    const saleId = (r.data as { sale_id: string }).sale_id;
    const { data: doc } = await ctx.admin.from("fiscal_documents").select("id").eq("sale_id", saleId).single();
    const id = (doc as { id: string }).id;
    await rpc(ctx.admin, "arca_claim", { p_tenant: ctx.tenant, p_ids: [id] });
    const issued = await rpc(ctx.admin, "arca_caea_issue", { p_doc: id, p: { error_code: "sin_respuesta" } });
    expect(issued.data).toMatchObject({ caea: "31423456789012", pto_vta: 90, cbte_nro: 1 });
    const st = await rpc(ctx.cashier.client, "arca_status");
    expect(st.data).toMatchObject({ contingency: true });
    const inf = await rpc(ctx.admin, "arca_caea_inform_result", { p_doc: id, p: { outcome: "rechazado", error_code: "1504", error_msg: "x" } });
    expect(inf.data).toMatchObject({ status: "requiere_accion", inform_status: "rechazado" });
  });

  it("staff interno: sin fugas de is_internal en policies", async () => {
    const { data: leaks, error } = await ctx.admin.rpc("rls_internal_scope_leaks" as never);
    expect(error).toBeNull();
    expect(leaks ?? []).toHaveLength(0);
  });
});
