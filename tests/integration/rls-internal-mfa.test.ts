// @vitest-environment node
// =============================================================================
// MFA TOTP del staff interno (SEC-23 · ADR-186, migración
// 20270122100000_sec23_internal_mfa).
//
// (A) is_internal() / internal_scope() / internal_tenant_360 con el flag
//     global internal_mfa_required prendido y apagado. Corre con psql contra
//     DB_URL (local) DENTRO DE UNA TRANSACCIÓN que termina en rollback: prender
//     el flag nunca se ve desde otras conexiones, así que no afecta a las demás
//     suites internas que corren en paralelo. Las claims del JWT se simulan con
//     request.jwt.claims, como hace PostgREST.
// (B) internal_mfa_reset: sólo super_admin, nunca a sí mismo, auditado. Con
//     los clientes de Supabase (mismas variables que tests/integration/rls.test.ts)
//     y el flag apagado (estado por defecto).
//
// Sin las variables, cada parte se salta. NUNCA apuntar a producción.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// ── (A) psql ───────────────────────────────────────────────────────────────
const DB_URL = process.env.DB_URL;
const isLocal = (() => {
  try {
    return ["127.0.0.1", "localhost", "host.docker.internal"].includes(new URL(DB_URL ?? "").hostname);
  } catch {
    return false;
  }
})();
const hasPsql = (() => {
  try {
    execFileSync("psql", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const psqlEnabled = Boolean(DB_URL && isLocal && hasPsql);

/** Corre el script y devuelve las líneas `R clave=valor` emitidas con raise notice. */
function probe(sql: string): Record<string, string> {
  const r = spawnSync("psql", [DB_URL!, "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
    encoding: "utf8",
    input: sql,
  });
  if (r.status !== 0) throw new Error(`psql falló: ${r.stderr}`);
  const out: Record<string, string> = {};
  for (const line of `${r.stdout}\n${r.stderr}`.split(/\r?\n/)) {
    const m = line.match(/R ([a-z0-9_]+)=(.*)$/);
    if (m) out[m[1]!] = m[2]!.trim();
  }
  return out;
}

const claims = (sub: string, aal: "aal1" | "aal2", appMeta: Record<string, unknown>) =>
  JSON.stringify({ sub, role: "authenticated", aal, app_metadata: appMeta }).replace(/'/g, "''");

/** Bloque DO que reporta is_internal(), internal_scope() y la ficha 360. */
const report = (prefix: string, tenant: string) => `
do $$
begin
  raise notice 'R ${prefix}_is_internal=%', public.is_internal();
  raise notice 'R ${prefix}_scope=%', public.internal_scope();
  begin
    perform public.internal_tenant_360('${tenant}'::uuid);
    raise notice 'R ${prefix}_360=ok';
  exception when others then
    raise notice 'R ${prefix}_360=err:%', sqlerrm;
  end;
end $$;`;

describe.skipIf(!psqlEnabled)("MFA del staff · is_internal() con el flag (transacción + rollback)", () => {
  const stamp = Math.random().toString(36).slice(2, 8);
  const tenant = randomUUID();
  const staff = randomUUID();
  const owner = randomUUID();
  const staffMeta = { is_internal: true, internal_level: "admin" };
  let r: Record<string, string> = {};

  beforeAll(() => {
    r = probe(`
begin;
insert into public.tenants (id, name, slug, status)
values ('${tenant}', 'MFA ${stamp}', 'mfa-${stamp}', 'active');
insert into public.system_settings (key, value) values ('internal_mfa_required', 'false'::jsonb)
  on conflict (key) do update set value = excluded.value;
select set_config('request.headers', '{"x-ninja-scope":"internal"}', true);

-- Flag APAGADO: staff aal1 igual que siempre.
select set_config('request.jwt.claims', '${claims(staff, "aal1", staffMeta)}', true);
set local role authenticated;
${report("off_aal1", tenant)}
reset role;

-- Flag PRENDIDO.
update public.system_settings set value = 'true'::jsonb where key = 'internal_mfa_required';
set local role authenticated;
do $$ begin raise notice 'R flag_on=%', public.internal_mfa_required(); end $$;
${report("on_aal1", tenant)}
select set_config('request.jwt.claims', '${claims(staff, "aal2", staffMeta)}', true);
${report("on_aal2", tenant)}
-- Usuario de negocio (no staff): nada cambia.
select set_config('request.jwt.claims', '${claims(owner, "aal1", { current_tenant_id: tenant })}', true);
do $$ begin raise notice 'R on_owner_is_internal=%', public.is_internal(); end $$;
reset role;
rollback;
`);
  }, 60_000);

  it("flag apagado: staff aal1 pasa como hoy", () => {
    expect(r.off_aal1_is_internal).toBe("t");
    expect(r.off_aal1_scope).toBe("t");
    expect(r.off_aal1_360).toBe("ok");
  });

  it("flag prendido: staff aal1 recibe forbidden en internal_tenant_360", () => {
    expect(r.flag_on).toBe("t");
    expect(r.on_aal1_is_internal).toBe("f");
    expect(r.on_aal1_scope).toBe("f");
    expect(r.on_aal1_360).toMatch(/^err:forbidden/);
  });

  it("flag prendido: staff aal2 pasa", () => {
    expect(r.on_aal2_is_internal).toBe("t");
    expect(r.on_aal2_scope).toBe("t");
    expect(r.on_aal2_360).toBe("ok");
  });

  it("flag prendido: un usuario de negocio sigue sin ser interno", () => {
    expect(r.on_owner_is_internal).toBe("f");
  });

  it("el rollback deja el flag apagado", () => {
    const after = probe(`do $$ begin raise notice 'R flag=%', public.internal_mfa_required(); end $$;`);
    expect(after.flag).toBe("f");
  });

  it("el cache del flag por transacción sólo endurece: forjar el GUC no apaga la exigencia", () => {
    const out = probe(`
begin;
select set_config('request.headers', '{"x-ninja-scope":"internal"}', true);
select set_config('request.jwt.claims', '${claims(staff, "aal1", staffMeta)}', true);
-- Flag prendido y GUC forjado en 'off': sigue exigiendo aal2.
insert into public.system_settings (key, value) values ('internal_mfa_required', 'true'::jsonb)
  on conflict (key) do update set value = excluded.value;
set local role authenticated;
select set_config('ninja.internal_mfa_required', 'off', true);
do $$ begin raise notice 'R forged_off=%', public.is_internal(); end $$;
reset role;
-- Flag apagado y GUC forjado en 'on': sólo puede endurecer (aal1 queda afuera).
update public.system_settings set value = 'false'::jsonb where key = 'internal_mfa_required';
set local role authenticated;
select set_config('ninja.internal_mfa_required', 'on', true);
do $$ begin raise notice 'R forged_on=%', public.is_internal(); end $$;
reset role;
rollback;`);
    expect(out.forged_off).toBe("f");
    expect(out.forged_on).toBe("f");
  });

  it("anon no puede leer el flag", () => {
    const out = probe(`
begin;
set local role anon;
do $$
begin
  perform public.internal_mfa_required();
  raise notice 'R anon=ok';
exception when others then
  raise notice 'R anon=err:%', sqlerrm;
end $$;
rollback;`);
    expect(out.anon).toMatch(/^err:permission denied/);
  });
});

// ── (B) internal_mfa_reset ─────────────────────────────────────────────────
const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const apiEnabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `mfa-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type User = { id: string; client: SupabaseClient };
type RpcResult = { data: unknown; error: { message: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcResult>;

describe.skipIf(!apiEnabled)("MFA del staff · internal_mfa_reset", () => {
  const ctx = {} as {
    admin: SupabaseClient;
    tenant: string;
    owner: User;
    staffAdmin: User;
    staffSuper: User;
    staffTarget: User;
    userIds: string[];
  };

  async function makeUser(email: string, appMeta: Record<string, unknown>, tenantRole?: string): Promise<User> {
    const { data, error } = await ctx.admin.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
      app_metadata: appMeta,
    });
    if (error) throw error;
    const id = data.user!.id;
    ctx.userIds.push(id);
    await ctx.admin.from("users").upsert({ id, email, full_name: email.split("@")[0] });
    if (tenantRole) {
      const { error: tuErr } = await ctx.admin
        .from("tenant_users")
        .insert({ tenant_id: ctx.tenant, user_id: id, role: tenantRole, status: "active" });
      if (tuErr) throw tuErr;
    }
    const client = createClient(URL_!, ANON!, {
      auth: { persistSession: false },
      global: { headers: { "x-ninja-scope": "internal" } },
    });
    const { error: sErr } = await client.auth.signInWithPassword({ email, password: PASSWORD });
    if (sErr) throw sErr;
    return { id, client };
  }

  beforeAll(async () => {
    ctx.admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.userIds = [];
    const { data: t, error } = await ctx.admin
      .from("tenants")
      .insert({ name: `MFA ${STAMP}`, slug: STAMP, status: "active" })
      .select("id")
      .single();
    if (error || !t) throw error ?? new Error("tenant");
    ctx.tenant = t.id as string;
    ctx.owner = await makeUser(`owner-${STAMP}@test.local`, { current_tenant_id: ctx.tenant }, "owner");
    ctx.staffAdmin = await makeUser(`adm-${STAMP}@test.local`, { is_internal: true, internal_level: "admin" });
    ctx.staffSuper = await makeUser(`sup-${STAMP}@test.local`, { is_internal: true, internal_level: "super_admin" });
    ctx.staffTarget = await makeUser(`tgt-${STAMP}@test.local`, { is_internal: true, internal_level: "support" });
  }, 120_000);

  afterAll(async () => {
    if (!ctx.admin) return;
    // audit_logs es de sólo agregado (ADR-083): sus filas quedan.
    await ctx.admin.from("tenant_users").delete().eq("tenant_id", ctx.tenant);
    await ctx.admin.from("tenants").delete().eq("id", ctx.tenant);
    for (const id of ctx.userIds) {
      await ctx.admin.from("users").delete().eq("id", id);
      await ctx.admin.auth.admin.deleteUser(id);
    }
  }, 120_000);

  const reset = (u: User, target: string, motivo = "perdió el teléfono") =>
    rpc(u.client, "internal_mfa_reset", { p_user_id: target, p_motivo: motivo });

  it("rechaza a quien no es super_admin", async () => {
    expect((await reset(ctx.staffAdmin, ctx.staffTarget.id)).error?.message).toMatch(/forbidden/);
    expect((await reset(ctx.owner, ctx.staffTarget.id)).error?.message).toMatch(/forbidden/);
  });

  it("rechaza sin el contexto del panel interno", async () => {
    const plain = createClient(URL_!, ANON!, { auth: { persistSession: false } });
    await plain.auth.signInWithPassword({ email: `sup-${STAMP}@test.local`, password: PASSWORD });
    expect((await reset({ id: ctx.staffSuper.id, client: plain }, ctx.staffTarget.id)).error?.message).toMatch(/forbidden/);
  });

  it("super_admin no puede resetearse a sí mismo ni a alguien que no es staff, y pide motivo", async () => {
    expect((await reset(ctx.staffSuper, ctx.staffSuper.id)).error?.message).toMatch(/cannot_reset_self/);
    expect((await reset(ctx.staffSuper, ctx.owner.id)).error?.message).toMatch(/not_internal_staff/);
    expect((await reset(ctx.staffSuper, ctx.staffTarget.id, "  ")).error?.message).toMatch(/reason_required/);
  });

  it("super_admin resetea a otro miembro del staff y queda auditado", async () => {
    const r = await reset(ctx.staffSuper, ctx.staffTarget.id);
    expect(r.error).toBeNull();
    expect(r.data).toMatchObject({ ok: true, factors_deleted: 0, sessions_revoked: true });
    const { data: logs } = await ctx.admin
      .from("audit_logs")
      .select("actor_user_id, action, reason, after_data")
      .eq("entity_id", ctx.staffTarget.id)
      .eq("action", "internal_mfa_reset");
    expect(logs).toHaveLength(1);
    expect(logs![0]).toMatchObject({
      actor_user_id: ctx.staffSuper.id,
      action: "internal_mfa_reset",
      reason: "perdió el teléfono",
      // Resultado real del corte de sesiones (la del target existía: signIn).
      after_data: { factors_deleted: 0, sessions_revoked: true, sessions_error: null },
    });
    expect((logs![0] as { after_data: { sessions_deleted: number } }).after_data.sessions_deleted).toBeGreaterThanOrEqual(1);
  });
});
