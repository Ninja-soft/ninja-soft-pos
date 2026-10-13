// @vitest-environment node
// =============================================================================
// Seguridad H117 y H118 (ADR-083, migración 20261106200000).
//
// H118: current_tenant_id() devuelve el negocio del JWT sólo con membresía
// activa (o staff en internal_scope()). Un JWT con otro negocio, o un miembro
// dado de baja con la sesión viva, no ven nada.
// H117: audit_logs inmutable (ni cliente ni service_role editan o borran),
// retención que no toca lo fiscal y cadena de hashes que detecta alteraciones.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `sec-test-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type User = { id: string; email: string; client: SupabaseClient };
type Ctx = {
  admin: SupabaseClient;
  tenantA: string;
  tenantB: string;
  ownerA: User;
  ownerB: User;
  forger: User;
  leaver: User;
  staff: User;
  staffInternal: SupabaseClient;
  productB: string;
  productA: string;
  userIds: string[];
};
const ctx = {} as Ctx;

type RpcResult = { data: unknown; error: { message: string; code?: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcResult>;

async function signIn(email: string, headers?: Record<string, string>): Promise<SupabaseClient> {
  const client = createClient(URL_!, ANON!, {
    auth: { persistSession: false },
    ...(headers ? { global: { headers } } : {}),
  });
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw error;
  return client;
}

async function makeUser(
  admin: SupabaseClient,
  email: string,
  appMeta: Record<string, unknown>,
  membership?: { tenantId: string; role: string },
): Promise<User> {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    app_metadata: appMeta,
  });
  if (error) throw error;
  const id = data.user!.id;
  await admin.from("users").upsert({ id, email, full_name: email.split("@")[0] });
  if (membership) {
    const { error: tuErr } = await admin
      .from("tenant_users")
      .insert({ tenant_id: membership.tenantId, user_id: id, role: membership.role, status: "active" });
    if (tuErr) throw tuErr;
  }
  ctx.userIds.push(id);
  return { id, email, client: await signIn(email) };
}

const monthsAgo = (m: number) => {
  const d = new Date();
  d.setMonth(d.getMonth() - m);
  return d.toISOString();
};

describe.skipIf(!enabled)("seguridad H117 y H118 · membresía y auditoría inmutable", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];

    const { data: tenants, error } = await admin
      .from("tenants")
      .insert([
        { name: `Sec A ${STAMP}`, slug: `seca-${STAMP}`, status: "active" },
        { name: `Sec B ${STAMP}`, slug: `secb-${STAMP}`, status: "active" },
      ])
      .select("id, slug");
    if (error || !tenants) throw error ?? new Error("tenants");
    ctx.tenantA = tenants.find((t) => t.slug === `seca-${STAMP}`)!.id;
    ctx.tenantB = tenants.find((t) => t.slug === `secb-${STAMP}`)!.id;

    ctx.ownerA = await makeUser(admin, `owner-a-${STAMP}@test.local`, { current_tenant_id: ctx.tenantA }, { tenantId: ctx.tenantA, role: "owner" });
    ctx.ownerB = await makeUser(admin, `owner-b-${STAMP}@test.local`, { current_tenant_id: ctx.tenantB }, { tenantId: ctx.tenantB, role: "owner" });
    // Miembro de A con el negocio B forzado en el JWT.
    ctx.forger = await makeUser(admin, `forger-${STAMP}@test.local`, { current_tenant_id: ctx.tenantB }, { tenantId: ctx.tenantA, role: "manager" });
    // Miembro de A que después se da de baja.
    ctx.leaver = await makeUser(admin, `leaver-${STAMP}@test.local`, { current_tenant_id: ctx.tenantA }, { tenantId: ctx.tenantA, role: "cashier" });
    // Staff interno sin membresía, con el negocio B en el JWT.
    ctx.staff = await makeUser(admin, `staff-${STAMP}@test.local`, { is_internal: true, internal_level: "admin", current_tenant_id: ctx.tenantB });
    ctx.staffInternal = await signIn(ctx.staff.email, { "x-ninja-scope": "internal" });

    const { data: products, error: pErr } = await admin
      .from("products")
      .insert([
        { tenant_id: ctx.tenantA, name: `Prod A ${STAMP}`, price: 100 },
        { tenant_id: ctx.tenantB, name: `Prod B ${STAMP}`, price: 200 },
      ])
      .select("id, tenant_id");
    if (pErr || !products) throw pErr ?? new Error("products");
    ctx.productA = products.find((p) => p.tenant_id === ctx.tenantA)!.id;
    ctx.productB = products.find((p) => p.tenant_id === ctx.tenantB)!.id;
  }, 90_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin) return;
    for (const t of [ctx.tenantA, ctx.tenantB].filter(Boolean)) {
      // audit_logs es inmutable: sus filas de prueba quedan en la base local.
      await admin.from("products").delete().eq("tenant_id", t);
      await admin.from("tenant_users").delete().eq("tenant_id", t);
      await admin.from("tenants").delete().eq("id", t);
    }
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  // ---------------------------------------------------------------------------
  // H118
  // ---------------------------------------------------------------------------
  describe("H118 · current_tenant_id() por membresía", () => {
    it("el dueño ve su negocio y current_tenant_id() lo devuelve", async () => {
      const cur = await rpc(ctx.ownerA.client, "current_tenant_id");
      expect(cur.error).toBeNull();
      expect(cur.data).toBe(ctx.tenantA);
      const { data } = await ctx.ownerA.client.from("products").select("id").eq("id", ctx.productA);
      expect(data?.length).toBe(1);
    });

    it("un JWT con un negocio ajeno no ve nada de ese negocio ni escribe en él", async () => {
      const cur = await rpc(ctx.forger.client, "current_tenant_id");
      expect(cur.error).toBeNull();
      expect(cur.data).toBeNull();

      const byId = await ctx.forger.client.from("products").select("id").eq("id", ctx.productB);
      expect(byId.data ?? []).toEqual([]);
      const all = await ctx.forger.client.from("products").select("id, tenant_id");
      expect((all.data ?? []).filter((p) => p.tenant_id === ctx.tenantB)).toEqual([]);
      const tenantRow = await ctx.forger.client.from("tenants").select("id").eq("id", ctx.tenantB);
      expect(tenantRow.data ?? []).toEqual([]);

      const ins = await ctx.forger.client
        .from("products")
        .insert({ tenant_id: ctx.tenantB, name: `Forjado ${STAMP}`, price: 1 });
      expect(ins.error).not.toBeNull();

      const audit = await ctx.forger.client.from("audit_logs").insert({
        tenant_id: ctx.tenantB,
        entity_type: "test",
        action: `forged_${STAMP}`,
      });
      expect(audit.error).not.toBeNull();
    });

    it("cambiar el negocio en el perfil (user_metadata) no cambia el negocio activo", async () => {
      const upd = await ctx.ownerA.client.auth.updateUser({ data: { current_tenant_id: ctx.tenantB } });
      expect(upd.error).toBeNull();
      await ctx.ownerA.client.auth.refreshSession();
      const cur = await rpc(ctx.ownerA.client, "current_tenant_id");
      expect(cur.data).toBe(ctx.tenantA);
      const byId = await ctx.ownerA.client.from("products").select("id").eq("id", ctx.productB);
      expect(byId.data ?? []).toEqual([]);
    });

    it("ensure_current_tenant corrige un negocio activo inválido por la membresía real", async () => {
      const r = await rpc(ctx.forger.client, "ensure_current_tenant");
      expect(r.error).toBeNull();
      expect(r.data).toBe(true);
      const { data: u } = await ctx.admin.auth.admin.getUserById(ctx.forger.id);
      expect((u.user?.app_metadata as { current_tenant_id?: string }).current_tenant_id).toBe(ctx.tenantA);
      await ctx.forger.client.auth.refreshSession();
      const cur = await rpc(ctx.forger.client, "current_tenant_id");
      expect(cur.data).toBe(ctx.tenantA);
      const again = await rpc(ctx.forger.client, "ensure_current_tenant");
      expect(again.data).toBe(false);
    });

    it("un miembro dado de baja deja de ver su ex negocio sin esperar a que venza el JWT", async () => {
      const before = await ctx.leaver.client.from("products").select("id").eq("id", ctx.productA);
      expect(before.data?.length).toBe(1);

      const { error } = await ctx.admin
        .from("tenant_users")
        .update({ status: "inactive" })
        .eq("tenant_id", ctx.tenantA)
        .eq("user_id", ctx.leaver.id);
      expect(error).toBeNull();

      // Mismo JWT (todavía dice tenantA): la RLS ya no lo deja pasar.
      const cur = await rpc(ctx.leaver.client, "current_tenant_id");
      expect(cur.data).toBeNull();
      const after = await ctx.leaver.client.from("products").select("id").eq("id", ctx.productA);
      expect(after.data ?? []).toEqual([]);
      const ensure = await rpc(ctx.leaver.client, "ensure_current_tenant");
      expect(ensure.data).toBe(false);
    });

    it("staff interno: sin membresía no tiene negocio fuera de /internal; con internal_scope sí", async () => {
      const plain = await rpc(ctx.staff.client, "current_tenant_id");
      expect(plain.data).toBeNull();
      const plainRows = await ctx.staff.client.from("products").select("id").eq("id", ctx.productB);
      expect(plainRows.data ?? []).toEqual([]);

      const scoped = await rpc(ctx.staffInternal, "current_tenant_id");
      expect(scoped.error).toBeNull();
      expect(scoped.data).toBe(ctx.tenantB);
    });

    it("ADR-052: el guard de is_internal sigue en 0 y las policies centrales usan (select current_tenant_id())", async () => {
      const leaks = await rpc(ctx.admin, "rls_internal_scope_leaks");
      expect(leaks.error).toBeNull();
      expect(leaks.data).toEqual([]);

      const bare = await rpc(ctx.admin, "rls_bare_current_tenant_policies");
      expect(bare.error).toBeNull();
      const tables = new Set(((bare.data as { tablename: string }[]) ?? []).map((r) => r.tablename));
      for (const t of ["products", "customers", "sales", "payments", "cash_shifts", "audit_logs", "tenant_users", "stores"]) {
        expect(tables.has(t)).toBe(false);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // H117
  // ---------------------------------------------------------------------------
  describe("H117 · audit_logs inmutable, retención y cadena", () => {
    it("nadie edita ni borra audit_logs: ni el dueño por PostgREST ni el service_role", async () => {
      const { data: row, error } = await ctx.admin
        .from("audit_logs")
        .insert({ tenant_id: ctx.tenantB, entity_type: "test", action: `immutable_${STAMP}`, reason: "original" })
        .select("id, reason")
        .single();
      expect(error).toBeNull();
      const id = (row as { id: string }).id;

      const upd = await ctx.ownerB.client.from("audit_logs").update({ reason: "cambiado" }).eq("id", id).select("id");
      expect(upd.error !== null || (upd.data ?? []).length === 0).toBe(true);
      const del = await ctx.ownerB.client.from("audit_logs").delete().eq("id", id).select("id");
      expect(del.error !== null || (del.data ?? []).length === 0).toBe(true);

      const admUpd = await ctx.admin.from("audit_logs").update({ reason: "cambiado" }).eq("id", id);
      expect(admUpd.error).not.toBeNull();
      const admDel = await ctx.admin.from("audit_logs").delete().eq("id", id);
      expect(admDel.error).not.toBeNull();

      const { data: still } = await ctx.admin.from("audit_logs").select("id, reason").eq("id", id).single();
      expect(still).toMatchObject({ id, reason: "original" });
    });

    it("la retención y el sellado no se pueden llamar desde el cliente", async () => {
      const ret = await rpc(ctx.ownerB.client, "audit_retention_run", { p_tenant: ctx.tenantB, p_dry_run: false });
      expect(ret.error).not.toBeNull();
      const seal = await rpc(ctx.ownerB.client, "audit_chain_seal", { p_tenant: ctx.tenantB, p_limit: 10 });
      expect(seal.error).not.toBeNull();
      const ver = await rpc(ctx.ownerB.client, "audit_chain_verify", { p_tenant: ctx.tenantB });
      expect(ver.error).not.toBeNull();
    });

    it("desde el cliente no se elige created_at (no se puede antedatar para que la retención lo borre)", async () => {
      const action = `backdate_${STAMP}`;
      const ins = await ctx.ownerB.client.from("audit_logs").insert({
        tenant_id: ctx.tenantB,
        entity_type: "test",
        action,
        created_at: monthsAgo(40),
      });
      expect(ins.error).toBeNull();
      const { data } = await ctx.admin.from("audit_logs").select("created_at").eq("action", action).single();
      const age = Date.now() - new Date((data as { created_at: string }).created_at).getTime();
      expect(age).toBeLessThan(10 * 60 * 1000);
    });

    it("la retención borra lo vencido no fiscal y no toca las acciones fiscales", async () => {
      // Multi-fila: todas las claves en cada fila.
      const rows = [
        { tenant_id: ctx.tenantA, entity_type: "products", action: "UPDATE", reason: `old_plain_${STAMP}`, created_at: monthsAgo(30) },
        { tenant_id: ctx.tenantA, entity_type: "sales", action: "sale_voided", reason: `old_fiscal_sale_${STAMP}`, created_at: monthsAgo(30) },
        { tenant_id: ctx.tenantA, entity_type: "fiscal_documents", action: "arca_document_enqueued", reason: `old_fiscal_arca_${STAMP}`, created_at: monthsAgo(30) },
        { tenant_id: ctx.tenantA, entity_type: "products", action: "UPDATE", reason: `recent_plain_${STAMP}`, created_at: monthsAgo(1) },
      ];
      const { error } = await ctx.admin.from("audit_logs").insert(rows);
      expect(error).toBeNull();

      const run = await rpc(ctx.admin, "audit_retention_run", { p_tenant: ctx.tenantA, p_dry_run: false });
      expect(run.error).toBeNull();
      expect((run.data as { deleted: number }).deleted).toBeGreaterThanOrEqual(1);

      const { data: left } = await ctx.admin
        .from("audit_logs")
        .select("reason")
        .eq("tenant_id", ctx.tenantA)
        .in("reason", rows.map((r) => r.reason));
      const reasons = new Set(((left ?? []) as { reason: string }[]).map((r) => r.reason));
      expect(reasons.has(`old_plain_${STAMP}`)).toBe(false);
      expect(reasons.has(`old_fiscal_sale_${STAMP}`)).toBe(true);
      expect(reasons.has(`old_fiscal_arca_${STAMP}`)).toBe(true);
      expect(reasons.has(`recent_plain_${STAMP}`)).toBe(true);

      // Lo borrado deja lápida: la cadena sigue verificando.
      const ver = await rpc(ctx.admin, "audit_chain_verify", { p_tenant: ctx.tenantA });
      expect(ver.error).toBeNull();
      expect(ver.data).toMatchObject({ ok: true });
    });

    it("la cadena verifica y detecta una fila alterada, una faltante y un eslabón cambiado", async () => {
      const rows = [1, 2, 3].map((n) => ({
        tenant_id: ctx.tenantB,
        entity_type: "test",
        action: `chain_${n}_${STAMP}`,
        reason: `cadena ${n}`,
        after_data: { n, label: `fila ${n}` },
      }));
      const { error } = await ctx.admin.from("audit_logs").insert(rows);
      expect(error).toBeNull();

      const sealed = await rpc(ctx.admin, "audit_chain_seal", { p_tenant: ctx.tenantB, p_limit: 1000 });
      expect(sealed.error).toBeNull();
      expect(sealed.data as number).toBeGreaterThanOrEqual(3);

      const ver = await rpc(ctx.admin, "audit_chain_verify", { p_tenant: ctx.tenantB });
      expect(ver.error).toBeNull();
      expect(ver.data).toMatchObject({ ok: true, unsealed: 0 });

      // El panel interno (staff con internal_scope) también puede verificar.
      const verStaff = await rpc(ctx.staffInternal, "audit_chain_verify", { p_tenant: ctx.tenantB });
      expect(verStaff.error).toBeNull();
      expect(verStaff.data).toMatchObject({ ok: true });

      const { data: chain } = await ctx.admin
        .from("audit_logs")
        .select("*")
        .eq("tenant_id", ctx.tenantB)
        .not("chain_seq", "is", null)
        .order("chain_seq", { ascending: true });
      // Sólo las 3 filas de esta prueba (consecutivas en la cadena): otras filas
      // del negocio traen numéricos en jsonb (p. ej. 0.00) que JavaScript
      // reescribe al ir y volver, y eso cambiaría su hash fuera de la base.
      const list = ((chain ?? []) as Record<string, unknown>[]).filter((r) =>
        String(r.action).endsWith(`_${STAMP}`) && String(r.action).startsWith("chain_"),
      );
      expect(list.length).toBe(3);
      expect(Number(list[2]!.chain_seq) - Number(list[0]!.chain_seq)).toBe(2);

      const ok = await rpc(ctx.admin, "audit_chain_check", { p_rows: list });
      expect(ok.error).toBeNull();
      expect(ok.data).toMatchObject({ ok: true });

      // Contenido alterado.
      const target = 1;
      const altered = list.map((r, i) => (i === target ? { ...r, reason: "cadena (editada)" } : r));
      const bad = await rpc(ctx.admin, "audit_chain_check", { p_rows: altered });
      const badData = bad.data as { ok: boolean; issues: { seq: number; kind: string }[] };
      expect(badData.ok).toBe(false);
      expect(badData.issues).toContainEqual(expect.objectContaining({ seq: list[target]!.chain_seq, kind: "altered" }));

      // Fila faltante.
      const missing = list.filter((_, i) => i !== target);
      const gap = await rpc(ctx.admin, "audit_chain_check", { p_rows: missing });
      const gapData = gap.data as { ok: boolean; issues: { kind: string }[] };
      expect(gapData.ok).toBe(false);
      expect(gapData.issues.map((i) => i.kind)).toContain("gap");

      // Fila y su row_hash reescritos: el eslabón ya no cierra.
      const rehashed = list.map((r, i) => (i === target ? { ...r, row_hash: "0".repeat(64) } : r));
      const link = await rpc(ctx.admin, "audit_chain_check", { p_rows: rehashed });
      const linkData = link.data as { ok: boolean; issues: { kind: string }[] };
      expect(linkData.ok).toBe(false);
      expect(linkData.issues.map((i) => i.kind)).toContain("hash_mismatch");
    });
  });
});
