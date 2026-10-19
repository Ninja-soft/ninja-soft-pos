// @vitest-environment node
// =============================================================================
// Ficha del cliente 360 completa (ADR-169, migración 20270108100000): cambios
// de la ficha auditados en la línea de tiempo, adjuntos (tabla, RPC y bucket
// privado customer-files) y aislamiento entre negocios.
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

const STAMP = `c360c-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";
const BUCKET = "customer-files";

type User = { id: string; client: SupabaseClient };
type RpcResult = { data: unknown; error: { message: string } | null };
type Timeline = { items: { kind: string; id: string; sub: string; extra: Record<string, unknown> | null }[] };

const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcResult>;

const ctx = {} as {
  admin: SupabaseClient;
  tenantA: string;
  tenantB: string;
  owner: User;
  cashier: User;
  ownerB: User;
  customer: string;
  customerB: string;
  userIds: string[];
};

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

const pdf = () => new Blob(["%PDF-1.4\n% prueba\n"], { type: "application/pdf" });

describe.skipIf(!enabled)("cliente 360 completo · cambios, adjuntos y aislamiento", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];
    const { data: tenants, error } = await admin
      .from("tenants")
      .insert([
        { name: `C360C A ${STAMP}`, slug: `c360ca-${STAMP}`, status: "active" },
        { name: `C360C B ${STAMP}`, slug: `c360cb-${STAMP}`, status: "active" },
      ])
      .select("id");
    if (error || !tenants) throw error ?? new Error("tenants");
    ctx.tenantA = tenants[0]!.id;
    ctx.tenantB = tenants[1]!.id;
    const { error: addErr } = await admin.from("subscription_addons").insert([
      { tenant_id: ctx.tenantA, addon_key: "clientes_360", status: "active", source: "granted" },
      { tenant_id: ctx.tenantB, addon_key: "clientes_360", status: "active", source: "granted" },
    ]);
    if (addErr) throw addErr;

    ctx.owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenantA, "owner");
    ctx.cashier = await makeUser(admin, `caj-${STAMP}@test.local`, ctx.tenantA, "cashier");
    ctx.ownerB = await makeUser(admin, `owner-b-${STAMP}@test.local`, ctx.tenantB, "owner");
    ctx.userIds.push(ctx.owner.id, ctx.cashier.id, ctx.ownerB.id);

    const { data: cu, error: cuErr } = await admin
      .from("customers")
      .insert([
        { tenant_id: ctx.tenantA, name: `Cliente A ${STAMP}` },
        { tenant_id: ctx.tenantB, name: `Cliente B ${STAMP}` },
      ])
      .select("id, tenant_id");
    if (cuErr || !cu) throw cuErr ?? new Error("customers");
    ctx.customer = cu.find((c) => c.tenant_id === ctx.tenantA)!.id as string;
    ctx.customerB = cu.find((c) => c.tenant_id === ctx.tenantB)!.id as string;
  }, 120_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin) return;
    for (const t of [ctx.tenantA, ctx.tenantB].filter(Boolean)) {
      const { data: files } = await admin.storage.from(BUCKET).list(t, { limit: 100 });
      for (const dir of files ?? []) {
        const { data: inner } = await admin.storage.from(BUCKET).list(`${t}/${dir.name}`, { limit: 100 });
        const paths = (inner ?? []).map((f) => `${t}/${dir.name}/${f.name}`);
        if (paths.length) await admin.storage.from(BUCKET).remove(paths);
      }
      await admin.from("customer_attachments" as never).delete().eq("tenant_id", t);
      await admin.from("audit_logs").delete().eq("tenant_id", t);
      await admin.from("customers").delete().eq("tenant_id", t);
      await admin.from("subscription_addons").delete().eq("tenant_id", t);
      await admin.from("tenant_users").delete().eq("tenant_id", t);
      await admin.from("tenants").delete().eq("id", t);
    }
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("una edición de la ficha aparece en la línea de tiempo con antes y después", async () => {
    const { error } = await ctx.owner.client.from("customers").update({ phone: "3415550000" } as never).eq("id", ctx.customer);
    expect(error).toBeNull();
    const r = await rpc(ctx.owner.client, "customer_360_timeline", { p_customer: ctx.customer, p_kinds: ["change"] });
    expect(r.error).toBeNull();
    const items = (r.data as Timeline).items;
    const upd = items.find((i) => i.sub === "UPDATE");
    expect(upd).toBeTruthy();
    const extra = upd!.extra as { before: { phone: string | null }; after: { phone: string } };
    expect(extra.before.phone).toBeNull();
    expect(extra.after.phone).toBe("3415550000");
  });

  it("el otro negocio no ve los cambios ni la ficha", async () => {
    const r = await rpc(ctx.ownerB.client, "customer_360_timeline", { p_customer: ctx.customer, p_kinds: ["change"] });
    expect(r.error?.message).toMatch(/customer_not_found/);
  });

  it("sube, registra, lista, descarga y da de baja un adjunto", async () => {
    const path = `${ctx.tenantA}/${ctx.customer}/${crypto.randomUUID()}-contrato.pdf`;
    const up = await ctx.owner.client.storage.from(BUCKET).upload(path, pdf(), { contentType: "application/pdf" });
    expect(up.error).toBeNull();
    const add = await rpc(ctx.owner.client, "customer_attachment_add", {
      p_customer: ctx.customer,
      p_path: path,
      p_file_name: "contrato.pdf",
      p_mime_type: "application/pdf",
      p_size_bytes: 20,
      p_note: "Contrato firmado",
    });
    expect(add.error).toBeNull();
    const id = (add.data as { id: string }).id;

    const { data: rows } = await ctx.cashier.client.from("customer_attachments" as never).select("id").eq("customer_id", ctx.customer);
    expect((rows as unknown as { id: string }[]).map((x) => x.id)).toContain(id);
    const signed = await ctx.cashier.client.storage.from(BUCKET).createSignedUrl(path, 60);
    expect(signed.error).toBeNull();

    // El cajero no puede borrar lo que subió el dueño.
    const delCaj = await rpc(ctx.cashier.client, "customer_attachment_delete", { p_id: id });
    expect(delCaj.error?.message).toMatch(/forbidden/);
    const del = await rpc(ctx.owner.client, "customer_attachment_delete", { p_id: id });
    expect(del.error).toBeNull();

    const tl = await rpc(ctx.owner.client, "customer_360_timeline", { p_customer: ctx.customer, p_kinds: ["attachment"] });
    expect((tl.data as Timeline).items[0]).toMatchObject({ kind: "attachment", sub: "deleted" });
  });

  it("aislamiento: el otro negocio no lee, no sube ni registra adjuntos ajenos", async () => {
    const path = `${ctx.tenantA}/${ctx.customer}/${crypto.randomUUID()}-a.pdf`;
    await ctx.owner.client.storage.from(BUCKET).upload(path, pdf(), { contentType: "application/pdf" });

    const { data: rows } = await ctx.ownerB.client.from("customer_attachments" as never).select("id").eq("tenant_id", ctx.tenantA);
    expect(rows).toEqual([]);
    const signed = await ctx.ownerB.client.storage.from(BUCKET).createSignedUrl(path, 60);
    expect(signed.error).toBeTruthy();
    const upB = await ctx.ownerB.client.storage
      .from(BUCKET)
      .upload(`${ctx.tenantA}/${ctx.customer}/intruso.pdf`, pdf(), { contentType: "application/pdf" });
    expect(upB.error).toBeTruthy();
    const addB = await rpc(ctx.ownerB.client, "customer_attachment_add", {
      p_customer: ctx.customer,
      p_path: path,
      p_file_name: "a.pdf",
      p_mime_type: "application/pdf",
      p_size_bytes: 20,
    });
    expect(addB.error?.message).toMatch(/customer_not_found/);
    // Ruta de otro cliente o de otro negocio con su propio cliente: rechazada.
    const badPath = await rpc(ctx.ownerB.client, "customer_attachment_add", {
      p_customer: ctx.customerB,
      p_path: path,
      p_file_name: "a.pdf",
      p_mime_type: "application/pdf",
      p_size_bytes: 20,
    });
    expect(badPath.error?.message).toMatch(/attachment_bad_path/);
  });
});
