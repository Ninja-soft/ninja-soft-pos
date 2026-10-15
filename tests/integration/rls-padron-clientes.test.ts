// @vitest-environment node
// =============================================================================
// Padrón de ARCA para los negocios y tipo de comprobante forzado (ADR-133,
// migraciones 20261128100000 y 20261128100100):
//   · arca_padron_lookups: el dueño o encargado ve lo suyo, el cajero y otro
//     negocio no; nadie escribe desde el navegador (ni la cache).
//   · Cliente "verificado": sólo con una consulta ok del mismo CUIT hecha por
//     el negocio (la graba service_role, como la Edge) y los datos salen de la
//     cache, no del navegador; cambiar la condición o el documento lo baja.
//   · Datos del negocio (tenant_branding) con la misma regla.
//   · Cupo diario cortado a medianoche de Argentina (arca_padron_usage).
//   · cbte_letter_check (SQL) = checkLetter (TS) en toda la matriz, y
//     _arca_blocker frena A a consumidor final.
//   · Guardarraíles RLS en 0.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar a producción. No llama a ARCA ni emite comprobantes: la
// consulta se simula insertando en arca_padron_lookups y arca_padron_cache.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { checkLetter } from "@/lib/billing/cbteOptions";
import { FISCAL_CONDITIONS } from "@/lib/tax/catalog";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `pad-${Math.random().toString(36).slice(2, 8)}`;
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
const CUIT_CLIENT = cuit("30", rnd());
const CUIT_OTHER = cuit("20", rnd());
const CUIT_OWN = cuit("30", rnd());

type User = { id: string; client: SupabaseClient };
const ctx = {} as {
  admin: SupabaseClient;
  tenantA: string;
  tenantB: string;
  owner: User;
  cashier: User;
  ownerB: User;
  userIds: string[];
  env: string;
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
  ctx.userIds.push(id);
  await admin.from("users").upsert({ id, email, full_name: email.split("@")[0] });
  const { error: e } = await admin.from("tenant_users").insert({ tenant_id: tenantId, user_id: id, role, status: "active" });
  if (e) throw e;
  const client = createClient(URL_!, ANON!, { auth: { persistSession: false } });
  const { error: sErr } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr) throw sErr;
  return { id, client };
}

const persona = (cond: string) => ({
  cuit: CUIT_CLIENT,
  razon_social: "ACME SA",
  iva_condition: cond,
  tipo_persona: "JURIDICA",
  activa: true,
  avisos: [],
});

describe.skipIf(!enabled)("padrón de ARCA para los negocios (ADR-133)", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];
    const { data: t, error } = await admin
      .from("tenants")
      .insert([
        { name: `Padron A ${STAMP}`, slug: `pa-${STAMP}`, status: "active" },
        { name: `Padron B ${STAMP}`, slug: `pb-${STAMP}`, status: "active" },
      ])
      .select("id, slug");
    if (error || !t) throw error ?? new Error("tenants");
    const rows = t as { id: string; slug: string }[];
    ctx.tenantA = rows.find((x) => x.slug === `pa-${STAMP}`)!.id;
    ctx.tenantB = rows.find((x) => x.slug === `pb-${STAMP}`)!.id;
    ctx.owner = await makeUser(admin, `own-${STAMP}@test.local`, ctx.tenantA, "owner");
    ctx.cashier = await makeUser(admin, `caj-${STAMP}@test.local`, ctx.tenantA, "cashier");
    ctx.ownerB = await makeUser(admin, `ownb-${STAMP}@test.local`, ctx.tenantB, "owner");
    const { data: cfg } = await admin.from("arca_padron_config").select("environment").eq("id", true).single();
    ctx.env = (cfg as { environment: string }).environment;
  }, 120_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin) return;
    await admin.from("arca_padron_cache").delete().in("cuit", [CUIT_CLIENT, CUIT_OTHER, CUIT_OWN]);
    for (const t of [ctx.tenantA, ctx.tenantB].filter(Boolean)) {
      await admin.from("arca_padron_lookups").delete().eq("tenant_id", t);
      await admin.from("customers").delete().eq("tenant_id", t);
      await admin.from("tenant_branding").delete().eq("tenant_id", t);
      await admin.from("tenant_users").delete().eq("tenant_id", t);
      await admin.from("tenants").delete().eq("id", t);
    }
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 120_000);

  const simulateLookup = async (tenantId: string, c: string, cond = "responsable_inscripto") => {
    await ctx.admin.from("arca_padron_cache").upsert(
      { cuit: c, environment: ctx.env, status: "ok", result: { ...persona(cond), cuit: c } },
      { onConflict: "cuit,environment" },
    );
    await ctx.admin
      .from("arca_padron_lookups")
      .insert({ tenant_id: tenantId, cuit: c, environment: ctx.env, source: "arca", status: "ok" });
  };

  it("nadie escribe la cache ni el registro desde el navegador", async () => {
    const c = await ctx.owner.client
      .from("arca_padron_cache" as never)
      .insert({ cuit: CUIT_OTHER, environment: ctx.env, status: "ok", result: {} } as never);
    expect(c.error).not.toBeNull();
    const l = await ctx.owner.client
      .from("arca_padron_lookups" as never)
      .insert({ tenant_id: ctx.tenantA, cuit: CUIT_OTHER, environment: ctx.env, source: "arca", status: "ok" } as never);
    expect(l.error).not.toBeNull();
  });

  it("el cliente no se puede declarar verificado sin consulta", async () => {
    const r = await ctx.owner.client.from("customers").insert({
      name: "Sin consulta",
      document_type: "cuit",
      document_number: CUIT_OTHER,
      iva_condition: "responsable_inscripto",
      fiscal_verification: "padron",
    } as never);
    expect(r.error?.message).toMatch(/padron_verification_missing/);
  });

  it("con la consulta del negocio queda verificado y los datos salen de la cache", async () => {
    await simulateLookup(ctx.tenantA, CUIT_CLIENT);
    const { data, error } = await ctx.owner.client
      .from("customers")
      .insert({
        name: "ACME",
        document_type: "cuit",
        document_number: CUIT_CLIENT,
        iva_condition: "responsable_inscripto",
        fiscal_verification: "padron",
        // El navegador no puede inventar estos datos: el trigger los pisa.
        fiscal_verified_condition: "monotributo",
        fiscal_padron: { razon_social: "TRUCHO" },
      } as never)
      .select("id, fiscal_verification, fiscal_verified_condition, fiscal_verified_at, fiscal_padron")
      .single();
    expect(error).toBeNull();
    const row = data as unknown as {
      id: string;
      fiscal_verification: string;
      fiscal_verified_condition: string;
      fiscal_verified_at: string;
      fiscal_padron: { razon_social: string };
    };
    expect(row.fiscal_verification).toBe("padron");
    expect(row.fiscal_verified_condition).toBe("responsable_inscripto");
    expect(row.fiscal_padron.razon_social).toBe("ACME SA");
    expect(row.fiscal_verified_at).toBeTruthy();

    // Otra condición: pasa a "cargado a mano".
    const u1 = await ctx.owner.client
      .from("customers")
      .update({ iva_condition: "exento" } as never)
      .eq("id", row.id)
      .select("fiscal_verification")
      .single();
    expect((u1.data as unknown as { fiscal_verification: string }).fiscal_verification).toBe("manual");

    // Otro documento: se borra la verificación anterior.
    const u2 = await ctx.owner.client
      .from("customers")
      .update({ document_number: CUIT_OTHER } as never)
      .eq("id", row.id)
      .select("fiscal_verified_at, fiscal_padron")
      .single();
    expect(u2.data).toMatchObject({ fiscal_verified_at: null, fiscal_padron: null });
  });

  it("la consulta de otro negocio no sirve", async () => {
    await simulateLookup(ctx.tenantA, CUIT_OTHER);
    const r = await ctx.ownerB.client.from("customers").insert({
      name: "Ajeno",
      document_type: "cuit",
      document_number: CUIT_OTHER,
      iva_condition: "responsable_inscripto",
      fiscal_verification: "padron",
    } as never);
    expect(r.error?.message).toMatch(/padron_verification_missing/);
  });

  it("RLS del registro: el dueño ve lo suyo; el cajero y otro negocio no", async () => {
    const own = await ctx.owner.client.from("arca_padron_lookups" as never).select("id, tenant_id");
    const rows = (own.data ?? []) as { tenant_id: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((x) => x.tenant_id === ctx.tenantA)).toBe(true);
    const caj = await ctx.cashier.client.from("arca_padron_lookups" as never).select("id");
    expect(caj.data ?? []).toHaveLength(0);
    const other = await ctx.ownerB.client.from("arca_padron_lookups" as never).select("id").eq("tenant_id", ctx.tenantA);
    expect(other.data ?? []).toHaveLength(0);
  });

  it("datos del negocio en Marca con la misma regla", async () => {
    const miss = await ctx.owner.client
      .from("tenant_branding")
      .upsert({ tenant_id: ctx.tenantA, cuit: CUIT_OWN, fiscal_source: "padron" } as never, { onConflict: "tenant_id" });
    expect(miss.error?.message).toMatch(/padron_verification_missing/);
    await simulateLookup(ctx.tenantA, CUIT_OWN, "monotributo");
    const ok = await ctx.owner.client
      .from("tenant_branding")
      .upsert({ tenant_id: ctx.tenantA, cuit: CUIT_OWN, fiscal_source: "padron", fiscal_verified_at: new Date().toISOString() } as never, {
        onConflict: "tenant_id",
      })
      .select("fiscal_source, fiscal_padron")
      .single();
    expect(ok.error).toBeNull();
    expect(ok.data).toMatchObject({ fiscal_source: "padron", fiscal_padron: { iva_condition: "monotributo" } });
  });

  it("el cupo diario corta a medianoche de Argentina", async () => {
    // Hoy 00:30 en Buenos Aires = 03:30 UTC; ayer 23:30 en Buenos Aires = hoy 02:30 UTC.
    const ar = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date());
    const todayAr = `${ar}T03:30:00Z`;
    const yesterdayAr = `${ar}T02:30:00Z`;
    if (new Date(todayAr).getTime() > Date.now()) return; // corre antes de las 00:30 de Argentina
    await ctx.admin.from("arca_padron_lookups").insert([
      { tenant_id: ctx.tenantB, cuit: CUIT_OTHER, environment: ctx.env, source: "arca", status: "ok", created_at: todayAr },
      { tenant_id: ctx.tenantB, cuit: CUIT_OTHER, environment: ctx.env, source: "arca", status: "ok", created_at: yesterdayAr },
      { tenant_id: ctx.tenantB, cuit: CUIT_OTHER, environment: ctx.env, source: "cache", status: "ok", created_at: todayAr },
    ]);
    const { data, error } = await ctx.admin.rpc("arca_padron_usage", { p_tenant: ctx.tenantB });
    expect(error).toBeNull();
    expect((data as { tenant_day: number }).tenant_day).toBe(1);
  });

  it("cbte_letter_check (SQL) = checkLetter (TS) en toda la matriz", async () => {
    const emitters = [null, "responsable_inscripto", "monotributo", "exento"];
    for (const e of emitters) {
      for (const r of FISCAL_CONDITIONS) {
        for (const hasCuit of [true, false]) {
          for (const issuesM of [false, true]) {
            for (const letter of ["A", "B", "C", "M", "E"]) {
              const { data } = await ctx.admin.rpc("cbte_letter_check", {
                p_emitter: e,
                p_receptor: r,
                p_has_cuit: hasCuit,
                p_issues_m: issuesM,
                p_letter: letter,
              });
              expect(data ?? null, `${e} ${r} ${hasCuit} ${issuesM} ${letter}`).toBe(checkLetter(e, r, { hasCuit, issuesM }, letter));
            }
          }
        }
      }
    }
  }, 120_000);

  it("guardarraíles RLS en 0", async () => {
    for (const fn of ["rls_internal_scope_leaks", "rls_bare_current_tenant_policies", "rls_policies_without_initplan"]) {
      const { data, error } = await ctx.admin.rpc(fn);
      expect(error, fn).toBeNull();
      expect(data ?? [], fn).toHaveLength(0);
    }
  });
});
