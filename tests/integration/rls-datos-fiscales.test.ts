// @vitest-environment node
// =============================================================================
// Datos fiscales del cliente para la factura de NinjaSoft (F20-3 · ADR-117,
// migración 20261113300000): RLS por negocio y rol (dueño o encargado),
// historia con una sola fila vigente, fallback a los datos de la empresa,
// verificación sólo con una consulta al padrón grabada por service_role,
// edición interna con motivo y nivel, y aislamiento del staff (internal_scope).
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos. No llama a
// ARCA (la consulta al padrón se simula insertando en platform_fiscal_lookups).
// No modifica platform_issuer_profile (es global).
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `fis-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

function cuit(prefix: string, body: string): string {
  const d = `${prefix}${body}`;
  const w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let s = 0;
  for (let i = 0; i < 10; i++) s += Number(d[i]) * w[i]!;
  let c = 11 - (s % 11);
  if (c === 11) c = 0;
  if (c === 10) c = 9;
  return d + c;
}
const rnd = () => String(Math.floor(10_000_000 + Math.random() * 89_999_999));
const CUIT_A = cuit("30", rnd());
const CUIT_OTHER = cuit("20", rnd());

type User = { id: string; client: SupabaseClient };
type Ctx = {
  admin: SupabaseClient;
  tenantA: string;
  tenantB: string;
  owner: User;
  manager: User;
  cashier: User;
  ownerB: User;
  staffAdmin: User;
  staffSupport: User;
  staffNoScope: User;
  userIds: string[];
};
const ctx = {} as Ctx;

type RpcRes = { data: unknown; error: { message: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcRes>;

async function makeUser(
  admin: SupabaseClient,
  email: string,
  appMeta: Record<string, unknown>,
  opts: { membership?: { tenantId: string; role: string }; internalHeader?: boolean } = {},
): Promise<User> {
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true, app_metadata: appMeta });
  if (error) throw error;
  const id = data.user!.id;
  ctx.userIds.push(id);
  await admin.from("users").upsert({ id, email, full_name: email.split("@")[0] });
  if (opts.membership) {
    const { error: e } = await admin
      .from("tenant_users")
      .insert({ tenant_id: opts.membership.tenantId, user_id: id, role: opts.membership.role, status: "active" });
    if (e) throw e;
  }
  const client = createClient(URL_!, ANON!, {
    auth: { persistSession: false },
    ...(opts.internalHeader ? { global: { headers: { "x-ninja-scope": "internal" } } } : {}),
  });
  const { error: sErr } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr) throw sErr;
  return { id, client };
}

describe.skipIf(!enabled)("datos fiscales del cliente (F20-3) · RLS, historia y padrón", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];
    const { data: t, error } = await admin
      .from("tenants")
      .insert([
        { name: `Fiscal A ${STAMP}`, slug: `fa-${STAMP}`, status: "active" },
        { name: `Fiscal B ${STAMP}`, slug: `fb-${STAMP}`, status: "active" },
      ])
      .select("id, slug");
    if (error || !t) throw error ?? new Error("tenants");
    const rows = t as { id: string; slug: string }[];
    ctx.tenantA = rows.find((x) => x.slug === `fa-${STAMP}`)!.id;
    ctx.tenantB = rows.find((x) => x.slug === `fb-${STAMP}`)!.id;
    const { error: tsErr } = await admin
      .from("tax_settings")
      .insert({ tenant_id: ctx.tenantA, cuit: CUIT_A, iva_condition: "responsable_inscripto" });
    if (tsErr) throw tsErr;

    const m = (tenantId: string, role: string) => ({ membership: { tenantId, role } });
    ctx.owner = await makeUser(admin, `own-${STAMP}@test.local`, { current_tenant_id: ctx.tenantA }, m(ctx.tenantA, "owner"));
    ctx.manager = await makeUser(admin, `man-${STAMP}@test.local`, { current_tenant_id: ctx.tenantA }, m(ctx.tenantA, "manager"));
    ctx.cashier = await makeUser(admin, `caj-${STAMP}@test.local`, { current_tenant_id: ctx.tenantA }, m(ctx.tenantA, "cashier"));
    ctx.ownerB = await makeUser(admin, `ownb-${STAMP}@test.local`, { current_tenant_id: ctx.tenantB }, m(ctx.tenantB, "owner"));
    ctx.staffAdmin = await makeUser(admin, `sadm-${STAMP}@test.local`, { is_internal: true, internal_level: "admin" }, { internalHeader: true });
    ctx.staffSupport = await makeUser(admin, `ssup-${STAMP}@test.local`, { is_internal: true, internal_level: "support" }, { internalHeader: true });
    ctx.staffNoScope = await makeUser(admin, `snos-${STAMP}@test.local`, { is_internal: true, internal_level: "admin" });
  }, 120_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin) return;
    await admin.from("platform_fiscal_lookups").delete().in("cuit", [CUIT_A, CUIT_OTHER]);
    for (const t of [ctx.tenantA, ctx.tenantB].filter(Boolean)) {
      await admin.from("tenant_billing_profiles").delete().eq("tenant_id", t);
      await admin.from("tax_settings").delete().eq("tenant_id", t);
      await admin.from("tenant_users").delete().eq("tenant_id", t);
      await admin.from("tenants").delete().eq("id", t);
    }
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 120_000);

  it("sin fila: datos de la empresa y email del dueño", async () => {
    const r = await rpc(ctx.owner.client, "my_billing_profile");
    expect(r.error).toBeNull();
    const eff = (r.data as { effective: Record<string, unknown> }).effective;
    expect(eff.source).toBe("company");
    expect(eff.doc_nro).toBe(CUIT_A);
    expect(eff.email).toBe(`own-${STAMP}@test.local`);
    expect(eff.verified).toBe(false);
  });

  it("sin CUIT: consumidor final", async () => {
    const r = await rpc(ctx.ownerB.client, "my_billing_profile");
    expect((r.data as { effective: { source: string } }).effective.source).toBe("consumidor_final");
  });

  it("el cajero no lee ni escribe", async () => {
    expect((await rpc(ctx.cashier.client, "my_billing_profile")).error?.message).toMatch(/forbidden/);
    expect((await rpc(ctx.cashier.client, "owner_set_billing_profile", { p: { use_company_data: true } })).error?.message).toMatch(/forbidden/);
  });

  it("el encargado guarda otro titular (manual) y queda historia", async () => {
    const r1 = await rpc(ctx.manager.client, "owner_set_billing_profile", {
      p: { use_company_data: false, holder_type: "empresa", doc_nro: CUIT_OTHER, razon_social: "Estudio SA", iva_condition: "monotributo" },
    });
    expect(r1.error).toBeNull();
    expect((r1.data as { verification: string }).verification).toBe("manual");
    const r2 = await rpc(ctx.owner.client, "owner_set_billing_profile", { p: { use_company_data: true, email_facturacion: "facturas@a.com" } });
    expect(r2.error).toBeNull();
    const { data: rows } = await ctx.owner.client.from("tenant_billing_profiles" as never).select("id, valid_to").eq("tenant_id", ctx.tenantA);
    const list = (rows ?? []) as { valid_to: string | null }[];
    expect(list).toHaveLength(2);
    expect(list.filter((x) => x.valid_to === null)).toHaveLength(1);
  });

  it("CUIT con dígito verificador inválido se rechaza", async () => {
    const bad = CUIT_OTHER.slice(0, 10) + String((Number(CUIT_OTHER[10]) + 1) % 10);
    const r = await rpc(ctx.owner.client, "owner_set_billing_profile", {
      p: { use_company_data: false, holder_type: "empresa", doc_nro: bad, razon_social: "X", iva_condition: "monotributo" },
    });
    expect(r.error?.message).toMatch(/invalid_cuit/);
  });

  it("sin escritura directa y sin ver otros negocios", async () => {
    const ins = await ctx.owner.client.from("tenant_billing_profiles" as never).insert({ tenant_id: ctx.tenantA } as never);
    expect(ins.error).not.toBeNull();
    const { data } = await ctx.ownerB.client.from("tenant_billing_profiles" as never).select("id").eq("tenant_id", ctx.tenantA);
    expect(data ?? []).toHaveLength(0);
    const { data: lk } = await ctx.owner.client.from("platform_fiscal_lookups" as never).select("id");
    expect(lk ?? []).toHaveLength(0);
  });

  it("use_padron exige una consulta grabada por service_role y toma sus datos", async () => {
    const miss = await rpc(ctx.owner.client, "owner_set_billing_profile", {
      p: { use_company_data: false, holder_type: "empresa", doc_nro: CUIT_OTHER, razon_social: "x", iva_condition: "monotributo", use_padron: true },
    });
    expect(miss.error?.message).toMatch(/padron_lookup_missing/);
    // El negocio no puede fabricarse la consulta.
    const fake = await ctx.owner.client
      .from("platform_fiscal_lookups" as never)
      .insert({ cuit: CUIT_OTHER, environment: "homologacion", status: "ok", result: {} } as never);
    expect(fake.error).not.toBeNull();
    await ctx.admin.from("platform_fiscal_lookups").insert({
      cuit: CUIT_OTHER,
      environment: "homologacion",
      status: "ok",
      result: { razon_social: "ESTUDIO S.A.", iva_condition: "responsable_inscripto", domicilio: "ROSARIO" },
      tenant_id: ctx.tenantA,
    });
    const ok = await rpc(ctx.owner.client, "owner_set_billing_profile", {
      p: { use_company_data: false, holder_type: "empresa", doc_nro: CUIT_OTHER, razon_social: "x", iva_condition: "monotributo", use_padron: true },
    });
    expect(ok.error).toBeNull();
    expect(ok.data).toMatchObject({ verification: "padron", verified: true, razon_social: "ESTUDIO S.A.", iva_condition: "responsable_inscripto" });
  });

  it("staff: support lee, no edita; admin edita con motivo y queda auditado", async () => {
    const get = await rpc(ctx.staffSupport.client, "internal_billing_profile_get", { p_tenant: ctx.tenantA });
    expect(get.error).toBeNull();
    expect((get.data as { history: unknown[] }).history.length).toBeGreaterThanOrEqual(3);
    const sup = await rpc(ctx.staffSupport.client, "internal_set_billing_profile", { p_tenant: ctx.tenantA, p: { use_company_data: true }, p_reason: "prueba" });
    expect(sup.error?.message).toMatch(/forbidden/);
    const noReason = await rpc(ctx.staffAdmin.client, "internal_set_billing_profile", { p_tenant: ctx.tenantA, p: { use_company_data: true }, p_reason: "" });
    expect(noReason.error?.message).toMatch(/reason_required/);
    const ok = await rpc(ctx.staffAdmin.client, "internal_set_billing_profile", {
      p_tenant: ctx.tenantA,
      p: { use_company_data: true, staff_verified: true },
      p_reason: `constancia revisada ${STAMP}`,
    });
    expect(ok.error).toBeNull();
    expect(ok.data).toMatchObject({ verification: "staff", verified: true, source: "company" });
    const { data: aud } = await ctx.admin
      .from("audit_logs")
      .select("action, reason, actor_user_id")
      .eq("tenant_id", ctx.tenantA)
      .eq("entity_type", "tenant_billing_profile")
      .eq("action", "internal_billing_profile_set");
    expect((aud ?? []).some((a) => (a as { reason: string }).reason === `constancia revisada ${STAMP}`)).toBe(true);
  });

  it("overview interno para el filtro de verificados", async () => {
    const r = await rpc(ctx.staffSupport.client, "internal_billing_profiles_overview");
    expect(r.error).toBeNull();
    const rows = r.data as { tenant_id: string; verified: boolean }[];
    expect(rows.find((x) => x.tenant_id === ctx.tenantA)?.verified).toBe(true);
    expect(rows.find((x) => x.tenant_id === ctx.tenantB)?.verified).toBe(false);
  });

  it("staff sin el header de scope no ve nada (nunca OR is_internal)", async () => {
    const { data } = await ctx.staffNoScope.client.from("tenant_billing_profiles" as never).select("id");
    expect(data ?? []).toHaveLength(0);
    const r = await rpc(ctx.staffNoScope.client, "internal_billing_profile_get", { p_tenant: ctx.tenantA });
    expect(r.error?.message).toMatch(/forbidden/);
  });

  it("el emisor sólo lo cambia un super_admin", async () => {
    const r = await rpc(ctx.staffAdmin.client, "internal_set_platform_issuer", { p_env: "homologacion", p: {}, p_reason: "prueba" });
    expect(r.error?.message).toMatch(/forbidden/);
    const g = await rpc(ctx.owner.client, "internal_platform_issuer_get");
    expect(g.error?.message).toMatch(/forbidden/);
  });

  it("guardarraíl: ninguna política de negocio usa is_internal() sin internal_scope()", async () => {
    const { data: leaks, error } = await ctx.admin.rpc("rls_internal_scope_leaks" as never);
    expect(error).toBeNull();
    expect(leaks ?? []).toHaveLength(0);
  });
});
