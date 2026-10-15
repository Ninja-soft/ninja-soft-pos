// @vitest-environment node
// =============================================================================
// Gestor de Mercado Libre, parte B (H141 · ADR-132, migraciones
// 20261127100100 a 20261127100300): aislamiento de reclamos, fotos de
// reputación, embudos y plantillas; gating por `mercadolibre_gestor`; roles;
// ingesta sólo por service_role; fechas de la foto en hora de Argentina;
// guardarraíles de RLS en 0.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea datos.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `mlp-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";
const ML_USER = 850000000 + Math.floor(Math.random() * 90_000_000);
const CLAIM_ID = String(5_000_000_000 + Math.floor(Math.random() * 900_000_000));

type User = { id: string; client: SupabaseClient };
type RpcRes = { data: unknown; error: { message: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcRes>;

/** Fecha de hoy en Argentina (UTC-3) como la calcula ml_ar_today(). */
const arToday = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);

const ctx = {} as {
  admin: SupabaseClient;
  tA: string;
  tB: string;
  tC: string;
  ownerA: User;
  cashierA: User;
  viewerA: User;
  ownerB: User;
  ownerC: User;
  userIds: string[];
  accA: string;
  accB: string;
  accC: string;
  claimRow: string;
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

const claimPayload = (over: Record<string, unknown> = {}) => ({
  claim_id: CLAIM_ID,
  resource: "order",
  resource_id: "2000000123",
  type: "mediations",
  stage: "claim",
  status: "opened",
  reason_id: "PDD9939",
  kind: "reclamo",
  due_at: "2026-10-17T21:00:00.000Z",
  action_responsible: "respondent",
  my_actions: [{ action: "send_message_to_complainant", mandatory: true, due_date: "2026-10-17T21:00:00.000Z" }],
  detail_title: "Producto distinto",
  affects_reputation: true,
  date_created: "2026-10-15T12:00:00-03:00",
  last_updated: "2026-10-15T13:00:00-03:00",
  ...over,
});

describe.skipIf(!enabled)("Gestor de Mercado Libre · posventa, reputación y embudos", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];
    const { data: t, error } = await admin
      .from("tenants")
      .insert([
        { name: `MLP A ${STAMP}`, slug: `mlpa-${STAMP}`, status: "active" },
        { name: `MLP B ${STAMP}`, slug: `mlpb-${STAMP}`, status: "active" },
        { name: `MLP C ${STAMP}`, slug: `mlpc-${STAMP}`, status: "active" },
      ])
      .select("id, slug");
    if (error || !t) throw error ?? new Error("tenants");
    const rows = t as { id: string; slug: string }[];
    ctx.tA = rows.find((x) => x.slug === `mlpa-${STAMP}`)!.id;
    ctx.tB = rows.find((x) => x.slug === `mlpb-${STAMP}`)!.id;
    ctx.tC = rows.find((x) => x.slug === `mlpc-${STAMP}`)!.id;
    // A y B con el gestor; C sólo con la integración base.
    const addons = [
      ...[ctx.tA, ctx.tB].flatMap((tenant) => [
        { tenant_id: tenant, addon_key: "mercadolibre", status: "active", source: "granted" },
        { tenant_id: tenant, addon_key: "mercadolibre_gestor", status: "active", source: "granted" },
      ]),
      { tenant_id: ctx.tC, addon_key: "mercadolibre", status: "active", source: "granted" },
    ];
    const { error: aErr } = await admin.from("subscription_addons").insert(addons);
    if (aErr) throw aErr;

    ctx.ownerA = await makeUser(admin, `mlpowa-${STAMP}@test.local`, ctx.tA, "owner");
    ctx.cashierA = await makeUser(admin, `mlpcsa-${STAMP}@test.local`, ctx.tA, "cashier");
    ctx.viewerA = await makeUser(admin, `mlpvwa-${STAMP}@test.local`, ctx.tA, "viewer");
    ctx.ownerB = await makeUser(admin, `mlpowb-${STAMP}@test.local`, ctx.tB, "owner");
    ctx.ownerC = await makeUser(admin, `mlpowc-${STAMP}@test.local`, ctx.tC, "owner");
    ctx.userIds.push(ctx.ownerA.id, ctx.cashierA.id, ctx.viewerA.id, ctx.ownerB.id, ctx.ownerC.id);

    const accs = await admin
      .from("ml_accounts")
      .insert([
        { tenant_id: ctx.tA, ml_user_id: ML_USER, nickname: "MLP_A", site_id: "MLA" },
        { tenant_id: ctx.tB, ml_user_id: ML_USER + 1, nickname: "MLP_B", site_id: "MLA" },
        { tenant_id: ctx.tC, ml_user_id: ML_USER + 2, nickname: "MLP_C", site_id: "MLA" },
      ])
      .select("id, tenant_id");
    if (accs.error || !accs.data) throw accs.error ?? new Error("accounts");
    const a = accs.data as { id: string; tenant_id: string }[];
    ctx.accA = a.find((x) => x.tenant_id === ctx.tA)!.id;
    ctx.accB = a.find((x) => x.tenant_id === ctx.tB)!.id;
    ctx.accC = a.find((x) => x.tenant_id === ctx.tC)!.id;
  }, 150_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin || !ctx.tA) return;
    for (const t of [ctx.tA, ctx.tB, ctx.tC]) {
      await admin.from("ml_accounts").delete().eq("tenant_id", t);
      await admin.from("ml_board_stages").delete().eq("tenant_id", t);
      await admin.from("ml_reply_templates").delete().eq("tenant_id", t);
      await admin.from("notifications").delete().eq("target_tenant_id", t);
      await admin.from("subscription_addons").delete().eq("tenant_id", t);
      await admin.from("tenants").delete().eq("id", t);
    }
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("la ingesta es sólo de service_role; crea el reclamo, marca candidato a exclusión y avisa", async () => {
    const asOwner = await rpc(ctx.ownerA.client, "ml_claim_upsert", { p_account: ctx.accA, p: claimPayload() });
    expect(asOwner.error).not.toBeNull();
    const r = await rpc(ctx.admin, "ml_claim_upsert", { p_account: ctx.accA, p: claimPayload() });
    expect(r.error).toBeNull();
    expect((r.data as { inserted: boolean }).inserted).toBe(true);
    const { data } = await ctx.ownerA.client.from("ml_claims").select("id, exclusion_status, status").eq("claim_id", CLAIM_ID);
    expect(data).toHaveLength(1);
    const row = (data as { id: string; exclusion_status: string; status: string }[])[0]!;
    ctx.claimRow = row.id;
    expect(row.exclusion_status).toBe("candidato");
    const n = await ctx.admin.from("notifications").select("id").eq("target_tenant_id", ctx.tA).eq("type", "mercadolibre");
    expect((n.data ?? []).length).toBeGreaterThanOrEqual(1);
    // Sin el gestor, la ingesta no escribe.
    const c = await rpc(ctx.admin, "ml_claim_upsert", { p_account: ctx.accC, p: claimPayload({ claim_id: "1" }) });
    expect((c.data as { error: string }).error).toBe("feature_off");
  });

  it("aislamiento: otro negocio no ve los reclamos ni las fotos; nadie escribe por REST", async () => {
    const b = await ctx.ownerB.client.from("ml_claims").select("id").eq("claim_id", CLAIM_ID);
    expect(b.data ?? []).toHaveLength(0);
    const ins = await ctx.ownerA.client.from("ml_claims").insert({ tenant_id: ctx.tA, account_id: ctx.accA, claim_id: 1 } as never);
    expect(ins.error).not.toBeNull();
    const upd = await ctx.ownerA.client.from("ml_claims").update({ status: "closed" } as never).eq("id", ctx.claimRow).select("id");
    expect(upd.data ?? []).toHaveLength(0);
    const snap = await ctx.ownerA.client
      .from("ml_reputation_snapshots")
      .insert({ tenant_id: ctx.tA, account_id: ctx.accA, snap_date: arToday() } as never);
    expect(snap.error).not.toBeNull();
  });

  it("foto diaria con la fecha de Argentina, una por día", async () => {
    const s = { level_id: "5_green", power_seller_status: "silver", sales_completed: 300, claims: { rate: 0.004 }, cancellations: { rate: 0 }, delayed: { rate: 0.02 } };
    const r1 = await rpc(ctx.admin, "ml_reputation_snapshot_save", { p_account: ctx.accA, p: s, p_alerts: [] });
    expect(r1.error).toBeNull();
    const r2 = await rpc(ctx.admin, "ml_reputation_snapshot_save", { p_account: ctx.accA, p: { ...s, claims: { rate: 0.006 } }, p_alerts: [] });
    expect(r2.error).toBeNull();
    const { data } = await ctx.ownerA.client.from("ml_reputation_snapshots").select("snap_date, claims_rate").eq("account_id", ctx.accA);
    expect(data).toHaveLength(1);
    const row = (data as { snap_date: string; claims_rate: number }[])[0]!;
    expect(row.snap_date).toBe(arToday());
    expect(Number(row.claims_rate)).toBeCloseTo(0.006, 5);
    const today = await rpc(ctx.ownerA.client, "ml_ar_today");
    expect(today.data).toBe(arToday());
  });

  it("gating y roles en las RPC de la UI", async () => {
    const noGestor = await rpc(ctx.ownerC.client, "ml_board_stages_ensure", { p_board: "sales" });
    expect(noGestor.error?.message).toMatch(/feature_not_in_plan: mercadolibre_gestor/);
    const viewer = await rpc(ctx.viewerA.client, "ml_board_stages_ensure", { p_board: "sales" });
    expect(viewer.error?.message).toMatch(/forbidden/);
    const cashierCfg = await rpc(ctx.cashierA.client, "ml_gestor_settings_save", { p_account: ctx.accA, p: {} });
    expect(cashierCfg.error?.message).toMatch(/forbidden/);
    const other = await rpc(ctx.ownerB.client, "ml_claim_exclusion_set", { p_claim: ctx.claimRow, p_status: "pedida" });
    expect(other.error?.message).toMatch(/not_found/);
    const ok = await rpc(ctx.ownerA.client, "ml_claim_exclusion_set", { p_claim: ctx.claimRow, p_status: "pedida", p_note: "formulario" });
    expect(ok.error).toBeNull();
    const { data: audit } = await ctx.admin.from("audit_logs").select("action").eq("tenant_id", ctx.tA).eq("action", "ml_claim_exclusion_set");
    expect(audit).toHaveLength(1);
  });

  it("embudos: etapas por defecto, el cajero mueve y asigna dentro del negocio", async () => {
    const st = await rpc(ctx.cashierA.client, "ml_board_stages_ensure", { p_board: "claims" });
    expect(st.error).toBeNull();
    const stages = st.data as { id: string; auto_key: string | null }[];
    expect(stages.map((s) => s.auto_key)).toEqual(["new", null, "waiting", "resolved"]);
    const mv = await rpc(ctx.cashierA.client, "ml_board_card_set", {
      p_board: "claims",
      p_account: ctx.accA,
      p_ref_key: CLAIM_ID,
      p: { stage_id: stages[1]!.id, assigned_to: ctx.cashierA.id },
    });
    expect(mv.error).toBeNull();
    const { data: claim } = await ctx.ownerA.client.from("ml_claims").select("assigned_to").eq("id", ctx.claimRow).single();
    expect((claim as { assigned_to: string }).assigned_to).toBe(ctx.cashierA.id);
    const foreign = await rpc(ctx.ownerA.client, "ml_board_card_set", { p_board: "claims", p_account: ctx.accA, p_ref_key: CLAIM_ID, p: { assigned_to: ctx.ownerB.id } });
    expect(foreign.error?.message).toMatch(/invalid_user/);
    const otherAcc = await rpc(ctx.ownerA.client, "ml_board_card_set", { p_board: "claims", p_account: ctx.accB, p_ref_key: CLAIM_ID, p: {} });
    expect(otherAcc.error?.message).toMatch(/not_found/);
    const cards = await ctx.ownerB.client.from("ml_board_cards").select("id");
    expect(cards.data ?? []).toHaveLength(0);
  });

  it("plantillas: dueño crea, cajero no; baja lógica", async () => {
    const c = await rpc(ctx.cashierA.client, "ml_reply_template_save", { p_id: null, p: { scope: "claim", name: "Foto", body: "Mandanos una foto." } });
    expect(c.error?.message).toMatch(/forbidden/);
    const o = await rpc(ctx.ownerA.client, "ml_reply_template_save", { p_id: null, p: { scope: "claim", name: "Foto", body: "Mandanos una foto." } });
    expect(o.error).toBeNull();
    const list = await ctx.cashierA.client.from("ml_reply_templates").select("id").is("deleted_at", null);
    expect(list.data).toHaveLength(1);
    const del = await rpc(ctx.ownerA.client, "ml_reply_template_delete", { p_id: o.data });
    expect(del.error).toBeNull();
    const after = await ctx.cashierA.client.from("ml_reply_templates").select("id").is("deleted_at", null);
    expect(after.data ?? []).toHaveLength(0);
  });

  it("la entrada del worker y la Edge no se llaman desde la API", async () => {
    for (const [fn, args] of [
      ["ml_reputation_snapshot_save", { p_account: ctx.accA, p: {}, p_alerts: [] }],
      ["ml_claims_stamp", { p_account: ctx.accA, p_ids: [1] }],
      ["ml_claim_audit", { p_account: ctx.accA, p_user: ctx.ownerA.id, p_claim: ctx.claimRow, p_action: "ml_claim_x_sent", p_data: {} }],
      ["ml_gestor_accounts_due", { p_kind: "claims" }],
      ["ml_edge_guard_gestor", { p_tenant: ctx.tA, p_user: ctx.ownerA.id, p_manage: true }],
    ] as const) {
      const r = await rpc(ctx.ownerA.client, fn, args as unknown as Record<string, unknown>);
      expect(r.error).not.toBeNull();
    }
  });

  it("guardarraíles de RLS en 0", async () => {
    for (const fn of ["rls_internal_scope_leaks", "rls_bare_current_tenant_policies", "rls_policies_without_initplan"]) {
      const { data, error } = await ctx.admin.rpc(fn as never);
      expect(error).toBeNull();
      expect(data ?? []).toHaveLength(0);
    }
  });
});
