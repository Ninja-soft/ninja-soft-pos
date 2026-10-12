// @vitest-environment node
// =============================================================================
// ADR-060: PIN autenticador (rotativo, de un uso y app TOTP).
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
//
// Escenario: negocio A con la feature por addon (dueña, encargado y cajera) y
// negocio B (otro dueño) para el aislamiento.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { base32Decode, totp } from "@/lib/security/otp";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `pa-test-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type User = { id: string; email: string; client: SupabaseClient };
const ctx = {} as {
  admin: SupabaseClient;
  tenant: string;
  tenantB: string;
  owner: User;
  manager: User;
  cashier: User;
  ownerB: User;
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
  return { id, email, client };
}

type RpcOut = { data: unknown; error: { message: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcOut>;
const obj = (r: RpcOut) => r.data as Record<string, unknown>;

async function newTenant(admin: SupabaseClient, name: string) {
  const { data, error } = await admin
    .from("tenants")
    .insert({ name, slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${STAMP}`, status: "active" })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("tenant");
  return data.id as string;
}

describe.skipIf(!enabled)("ADR-060 · PIN autenticador", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];
    ctx.tenant = await newTenant(admin, `Pin A ${STAMP}`);
    ctx.tenantB = await newTenant(admin, `Pin B ${STAMP}`);
    const { error: addonErr } = await admin
      .from("subscription_addons")
      .insert({ tenant_id: ctx.tenant, addon_key: "pin_autenticador", status: "active", source: "granted" });
    if (addonErr) throw addonErr;
    ctx.owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenant, "owner");
    ctx.manager = await makeUser(admin, `enc-${STAMP}@test.local`, ctx.tenant, "manager");
    ctx.cashier = await makeUser(admin, `caj-${STAMP}@test.local`, ctx.tenant, "cashier");
    ctx.ownerB = await makeUser(admin, `ownerb-${STAMP}@test.local`, ctx.tenantB, "owner");
    ctx.userIds.push(ctx.owner.id, ctx.manager.id, ctx.cashier.id, ctx.ownerB.id);

    // Anulaciones sólo con PIN de un uso; retiros con cualquier modo.
    const policy = await rpc(ctx.owner.client, "security_settings_get");
    const base = (obj(policy).pin_policy ?? {}) as Record<string, unknown>;
    const r = await rpc(ctx.owner.client, "security_settings_save", {
      p: {
        pin_rotation_hours: 12,
        pin_one_time_max_minutes: 10,
        pin_policy: {
          ...base,
          sale_void: { enabled: true, threshold: 0, modes: ["one_time"] },
          cash_out: { enabled: true, threshold: 0 },
        },
      },
    });
    if (r.error) throw new Error(r.error.message);
  }, 120_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin) return;
    for (const t of [ctx.tenant, ctx.tenantB].filter(Boolean)) {
      await admin.from("supervisor_one_time_pins").delete().eq("tenant_id", t);
      await admin.from("supervisor_pin_methods").delete().eq("tenant_id", t);
      await admin.from("supervisor_pin_guard").delete().eq("tenant_id", t);
      await admin.from("supervisor_auth_tokens").delete().eq("tenant_id", t);
      await admin.from("account_supervisor_pins").delete().eq("tenant_id", t);
      await admin.from("security_settings").delete().eq("tenant_id", t);
      await admin.from("subscription_addons").delete().eq("tenant_id", t);
      await admin.from("audit_logs").delete().eq("tenant_id", t);
      await admin.from("tenants").delete().eq("id", t);
    }
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("nadie lee secretos, hashes ni la guarda por PostgREST (ni el dueño)", async () => {
    await rpc(ctx.manager.client, "supervisor_rotating_enable", { p_regenerate: false });
    await rpc(ctx.manager.client, "supervisor_one_time_create", { p_minutes: 2 });
    for (const u of [ctx.owner, ctx.manager, ctx.cashier, ctx.ownerB]) {
      for (const table of ["supervisor_pin_methods", "supervisor_one_time_pins", "supervisor_pin_guard"]) {
        const { data, error } = await u.client.from(table).select("*");
        expect(error !== null || (data ?? []).length === 0, `${u.email} leyó ${table}`).toBe(true);
      }
    }
    const mine = await rpc(ctx.manager.client, "supervisor_my_pins");
    expect(JSON.stringify(mine.data)).not.toMatch(/secret|hash|salt/i);
    const list = await rpc(ctx.manager.client, "supervisor_one_time_list");
    expect(JSON.stringify(list.data)).not.toMatch(/code|hash|salt/i);
  });

  it("la cajera no genera PIN ni ve el rotativo; las funciones internas no se exponen", async () => {
    expect((await rpc(ctx.cashier.client, "supervisor_one_time_create", { p_minutes: 2 })).error?.message).toMatch(/forbidden/);
    expect((await rpc(ctx.cashier.client, "supervisor_rotating_code")).error?.message).toMatch(/forbidden/);
    expect((await rpc(ctx.cashier.client, "supervisor_totp_begin", { p_step: 30 })).error?.message).toMatch(/forbidden/);
    expect((await rpc(ctx.cashier.client, "otp_hotp", { p_secret: "\\x00", p_counter: 1 })).error).not.toBeNull();
    expect((await rpc(ctx.cashier.client, "_pin_guard_ok", { p_tenant: ctx.tenant, p_kind: "requester", p_subject: ctx.cashier.id })).error).not.toBeNull();
  });

  it("PIN de un uso: alcance, un solo uso y marca de quién lo usó", async () => {
    const created = obj(
      await rpc(ctx.manager.client, "supervisor_one_time_create", {
        p_minutes: 5,
        p_action: "sale_void",
        p_max_amount: 1000,
        p_note: "Ticket 1",
      }),
    );
    const code = String(created.code);
    expect(code).toMatch(/^[0-9]{6}$/);
    const over = obj(
      await rpc(ctx.cashier.client, "supervisor_authorize", {
        p_action: "sale_void",
        p_supervisor_id: ctx.manager.id,
        p_pin: code,
        p_amount: 1500,
        p_reason: "Cliente arrepentido",
      }),
    );
    expect(over.error).toBe("one_time_scope");
    const ok = obj(
      await rpc(ctx.cashier.client, "supervisor_authorize", {
        p_action: "sale_void",
        p_supervisor_id: ctx.manager.id,
        p_pin: code,
        p_amount: 900,
        p_reason: "Cliente arrepentido",
      }),
    );
    expect(ok).toMatchObject({ ok: true, mode: "one_time" });
    const again = obj(
      await rpc(ctx.cashier.client, "supervisor_authorize", {
        p_action: "sale_void",
        p_supervisor_id: ctx.manager.id,
        p_pin: code,
        p_amount: 900,
        p_reason: "Otra vez",
      }),
    );
    expect(again.ok).toBe(false);
    const list = (await rpc(ctx.manager.client, "supervisor_one_time_list")).data as { id: string; used_at: string | null }[];
    expect(list.find((c) => c.id === created.id)?.used_at).toBeTruthy();
    await rpc(ctx.owner.client, "supervisor_unlock", { p_user_id: ctx.cashier.id });
    await rpc(ctx.owner.client, "supervisor_unlock", { p_user_id: ctx.manager.id });
  });

  it("rotativo: sirve en su ventana para retiros, no para la anulación de un uso", async () => {
    const code = String(obj(await rpc(ctx.manager.client, "supervisor_rotating_code")).code);
    const ok = obj(
      await rpc(ctx.cashier.client, "supervisor_authorize", {
        p_action: "cash_out",
        p_supervisor_id: ctx.manager.id,
        p_pin: code,
        p_amount: 500,
        p_reason: "Pago a proveedor",
      }),
    );
    expect(ok).toMatchObject({ ok: true, mode: "rotating" });
    const voidTry = obj(
      await rpc(ctx.cashier.client, "supervisor_authorize", {
        p_action: "sale_void",
        p_supervisor_id: ctx.manager.id,
        p_pin: code,
        p_amount: 100,
        p_reason: "No permitido",
      }),
    );
    expect(voidTry.ok).toBe(false);
    await rpc(ctx.owner.client, "supervisor_unlock", { p_user_id: ctx.cashier.id });
    await rpc(ctx.owner.client, "supervisor_unlock", { p_user_id: ctx.manager.id });
  });

  it("app autenticadora: enrolar con QR, confirmar y no repetir un paso", async () => {
    const enroll = obj(await rpc(ctx.owner.client, "supervisor_totp_begin", { p_step: 30 }));
    const secret = base32Decode(String(enroll.secret_base32));
    const now = Math.floor(Date.now() / 1000);
    const conf = await rpc(ctx.owner.client, "supervisor_totp_confirm", { p_code: await totp(secret, now) });
    expect(conf.error).toBeNull();
    const next = await totp(secret, now + 30);
    const ok = obj(
      await rpc(ctx.cashier.client, "supervisor_authorize", {
        p_action: "cash_out",
        p_supervisor_id: ctx.owner.id,
        p_pin: next,
        p_amount: 50,
        p_reason: "Cambio",
      }),
    );
    expect(ok).toMatchObject({ ok: true, mode: "totp" });
    const replay = obj(
      await rpc(ctx.cashier.client, "supervisor_authorize", {
        p_action: "cash_out",
        p_supervisor_id: ctx.owner.id,
        p_pin: next,
        p_amount: 50,
        p_reason: "Cambio",
      }),
    );
    expect(replay.ok).toBe(false);
    await rpc(ctx.owner.client, "supervisor_unlock", { p_user_id: ctx.cashier.id });
    await rpc(ctx.owner.client, "supervisor_unlock", { p_user_id: ctx.owner.id });
  });

  it("otro negocio: no revoca, no autoriza y no genera sin la feature", async () => {
    const created = obj(await rpc(ctx.manager.client, "supervisor_one_time_create", { p_minutes: 2 }));
    expect((await rpc(ctx.ownerB.client, "supervisor_one_time_revoke", { p_id: created.id })).error?.message).toMatch(/not_found/);
    const auth = await rpc(ctx.ownerB.client, "supervisor_authorize", {
      p_action: "cash_out",
      p_supervisor_id: ctx.manager.id,
      p_pin: String(created.code),
      p_amount: 10,
      p_reason: "x x x",
    });
    expect(auth.error?.message).toMatch(/supervisor_not_found/);
    expect((await rpc(ctx.ownerB.client, "supervisor_one_time_create", { p_minutes: 2 })).error?.message).toMatch(
      /feature_not_in_plan: pin_autenticador/,
    );
  });

  it("bloqueo por quien pide tras N fallos, auditado", async () => {
    for (let i = 0; i < 5; i++) {
      await rpc(ctx.cashier.client, "supervisor_authorize", {
        p_action: "cash_out",
        p_supervisor_id: i < 4 ? ctx.owner.id : ctx.manager.id,
        p_pin: "111111",
        p_amount: 10,
        p_reason: "x x x",
      });
    }
    const locked = obj(
      await rpc(ctx.cashier.client, "supervisor_authorize", {
        p_action: "cash_out",
        p_supervisor_id: ctx.manager.id,
        p_pin: String(obj(await rpc(ctx.manager.client, "supervisor_rotating_code")).code),
        p_amount: 10,
        p_reason: "x x x",
      }),
    );
    expect(locked.error).toBe("requester_locked");
    const { data } = await ctx.admin
      .from("audit_logs")
      .select("action")
      .eq("tenant_id", ctx.tenant)
      .eq("action", "supervisor_requester_locked");
    expect((data ?? []).length).toBeGreaterThanOrEqual(1);
  });
});
