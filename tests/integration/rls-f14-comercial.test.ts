// @vitest-environment node
// =============================================================================
// F14 primer corte (ADR-092, migraciones 20261109200000 a 20261109200400):
// maker-checker de promociones y recargos, alertas de margen, conteo cíclico
// y garantías por serie. RLS, rol, plan y auditoría.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea datos.
//
// Escenario: negocio A con las cuatro features y promociones (add-ons),
// dueño, encargado y cajero (el cajero abre SU turno y vende en él);
// negocio B sin las features opcionales.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `f14-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type User = { id: string; client: SupabaseClient };
type Ctx = {
  admin: SupabaseClient;
  tenant: string;
  tenantB: string;
  owner: User;
  manager: User;
  cashier: User;
  ownerB: User;
  userIds: string[];
  store: string;
  phone: string;
  yerba: string;
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

async function auditActions(entityId: string): Promise<string[]> {
  const { data } = await ctx.admin.from("audit_logs").select("action").eq("entity_id", entityId);
  return ((data ?? []) as { action: string }[]).map((r) => r.action);
}

describe.skipIf(!enabled)("F14 · gobierno comercial, márgenes, conteo cíclico y series", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];
    const { data: t, error } = await admin
      .from("tenants")
      .insert([
        { name: `F14 A ${STAMP}`, slug: `fa-${STAMP}`, status: "active" },
        { name: `F14 B ${STAMP}`, slug: `fb-${STAMP}`, status: "active" },
      ])
      .select("id, slug");
    if (error || !t) throw error ?? new Error("tenants");
    const rows = t as { id: string; slug: string }[];
    ctx.tenant = rows.find((x) => x.slug === `fa-${STAMP}`)!.id;
    ctx.tenantB = rows.find((x) => x.slug === `fb-${STAMP}`)!.id;

    // Insert multi-fila: todas las claves en cada fila.
    const { error: aErr } = await admin.from("subscription_addons").insert(
      ["promociones", "aprobaciones_comerciales", "conteo_ciclico", "garantias_serie"].map((key) => ({
        tenant_id: ctx.tenant,
        addon_key: key,
        status: "active",
        source: "granted",
      })),
    );
    if (aErr) throw aErr;

    ctx.owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenant, "owner");
    ctx.manager = await makeUser(admin, `mgr-${STAMP}@test.local`, ctx.tenant, "manager");
    ctx.cashier = await makeUser(admin, `caj-${STAMP}@test.local`, ctx.tenant, "cashier");
    ctx.ownerB = await makeUser(admin, `ownerb-${STAMP}@test.local`, ctx.tenantB, "owner");
    ctx.userIds.push(ctx.owner.id, ctx.manager.id, ctx.cashier.id, ctx.ownerB.id);

    const { data: prods, error: pErr } = await ctx.owner.client
      .from("products")
      .insert([
        { tenant_id: ctx.tenant, name: `Celular ${STAMP}`, price: 100000, cost: 70000, track_stock: true, is_serialized: true, warranty_months: 12 },
        { tenant_id: ctx.tenant, name: `Yerba ${STAMP}`, price: 1000, cost: 700, track_stock: true, is_serialized: false, warranty_months: 0 },
      ] as never)
      .select("id, name");
    if (pErr || !prods) throw pErr ?? new Error("products");
    const ps = prods as { id: string; name: string }[];
    ctx.phone = ps.find((p) => p.name.startsWith("Celular"))!.id;
    ctx.yerba = ps.find((p) => p.name.startsWith("Yerba"))!.id;

    const { data: store, error: sErr } = await ctx.owner.client.from("stores").insert({ name: "Centro" } as never).select("id").single();
    if (sErr || !store) throw sErr ?? new Error("store");
    ctx.store = (store as { id: string }).id;
    const { data: reg, error: rErr } = await ctx.owner.client
      .from("cash_registers")
      .insert({ store_id: ctx.store, name: "Caja 1" } as never)
      .select("id")
      .single();
    if (rErr || !reg) throw rErr ?? new Error("register");
    // El cajero abre SU turno y vende en él (regla de caja propia).
    const sh = await rpc(ctx.cashier.client, "open_cash_shift", { p_register_id: (reg as { id: string }).id, p_opening_amount: 0 });
    if (sh.error) throw new Error(sh.error.message);
  }, 180_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin || !ctx.tenant) return;
    for (const t of [ctx.tenant, ctx.tenantB]) {
      await admin.from("subscription_addons").delete().eq("tenant_id", t);
      // audit_logs es inmutable (ADR-083): si el negocio no se puede borrar
      // por sus auditorías, queda (datos de prueba con sello único).
      await admin.from("tenants").delete().eq("id", t);
    }
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  // ── H63 · maker-checker ───────────────────────────────────────────────────
  it("sólo el dueño prende el circuito; otro negocio sin la feature no puede", async () => {
    const byManager = await rpc(ctx.manager.client, "commercial_governance_save", { p: { enabled: true } });
    expect(byManager.error?.message).toMatch(/forbidden/);

    const ok = await rpc(ctx.owner.client, "commercial_governance_save", {
      p: { enabled: true, promo_mode: "high_impact", promo_pct: 20, surcharge_mode: "all", request_ttl_days: 7 },
    });
    expect(ok.error).toBeNull();
    expect((ok.data as { enabled: boolean }).enabled).toBe(true);

    const b = await rpc(ctx.ownerB.client, "commercial_governance_save", { p: { enabled: true } });
    expect(b.error?.message).toMatch(/feature_not_in_plan: aprobaciones_comerciales/);

    // Nadie escribe la política ni las solicitudes por REST.
    const direct = await ctx.owner.client
      .from("commercial_change_requests")
      .insert({ tenant_id: ctx.tenant, entity_type: "promotions", entity_id: ctx.tenant, kind: "create", proposed: {}, expires_at: new Date().toISOString() } as never);
    expect(direct.error).not.toBeNull();
  });

  it("promo de alto impacto del encargado queda inactiva y pendiente; la de bajo impacto pasa", async () => {
    const high = await ctx.manager.client
      .from("promotions")
      .insert({ tenant_id: ctx.tenant, name: `30% todo ${STAMP}`, scope: "cart", action_type: "percent", action_value: 30, is_active: true } as never)
      .select("id, is_active")
      .single();
    expect(high.error).toBeNull();
    expect((high.data as { is_active: boolean }).is_active).toBe(false);

    const low = await ctx.manager.client
      .from("promotions")
      .insert({ tenant_id: ctx.tenant, name: `5% todo ${STAMP}`, scope: "cart", action_type: "percent", action_value: 5, is_active: true } as never)
      .select("id, is_active")
      .single();
    expect(low.error).toBeNull();
    expect((low.data as { is_active: boolean }).is_active).toBe(true);

    const pending = await rpc(ctx.manager.client, "commercial_requests", { p_status: "pending" });
    expect(pending.error).toBeNull();
    const reqs = pending.data as { id: string; entity_id: string; proposed: Record<string, unknown> }[];
    const req = reqs.find((r) => r.entity_id === (high.data as { id: string }).id);
    expect(req?.proposed).toEqual({ is_active: true });
    expect(reqs.some((r) => r.entity_id === (low.data as { id: string }).id)).toBe(false);

    // El cajero no ve la bandeja (ni por REST ni por RPC).
    const cajRest = await ctx.cashier.client.from("commercial_change_requests").select("id");
    expect(cajRest.data ?? []).toEqual([]);
    const cajRpc = await rpc(ctx.cashier.client, "commercial_requests", { p_status: "pending" });
    expect(cajRpc.error?.message).toMatch(/forbidden/);

    // El encargado no se aprueba a sí mismo.
    const self = await rpc(ctx.manager.client, "commercial_change_decide", { p_id: req!.id, p_approve: true });
    expect(self.error?.message).toMatch(/forbidden/);

    // Criterio H63: el dueño aprueba y el audit log conserva el circuito.
    const ok = await rpc(ctx.owner.client, "commercial_change_decide", { p_id: req!.id, p_approve: true });
    expect(ok.error).toBeNull();
    expect((ok.data as { status: string }).status).toBe("approved");
    const after = await ctx.owner.client.from("promotions").select("is_active").eq("id", (high.data as { id: string }).id).single();
    expect((after.data as { is_active: boolean }).is_active).toBe(true);
    const actions = await auditActions(req!.id);
    expect(actions).toEqual(expect.arrayContaining(["commercial_change_requested", "commercial_change_approved"]));

    // El encargado recibe el aviso de la decisión.
    const notes = await ctx.manager.client.from("notifications").select("title").eq("type", "comercial");
    expect(((notes.data ?? []) as { title: string }[]).map((n) => n.title)).toContain("Cambio aprobado");
  });

  it("recargo nuevo del encargado: el dueño rechaza con motivo; un cambio de recargo queda propuesto", async () => {
    const created = await ctx.manager.client
      .from("payment_plans")
      .insert({ tenant_id: ctx.tenant, label: `Visa 6 ${STAMP}`, surcharge_pct: 18, provider_key: null, base: "credito", brand: "visa", installments: 6, code: `v6-${STAMP}`, is_active: true } as never)
      .select("id, is_active")
      .single();
    expect(created.error).toBeNull();
    expect((created.data as { is_active: boolean }).is_active).toBe(false);
    const planId = (created.data as { id: string }).id;

    const list = await rpc(ctx.owner.client, "commercial_requests", { p_status: "pending" });
    const req = (list.data as { id: string; entity_id: string }[]).find((r) => r.entity_id === planId)!;
    const noReason = await rpc(ctx.owner.client, "commercial_change_decide", { p_id: req.id, p_approve: false });
    expect(noReason.error?.message).toMatch(/reason_required/);
    const rejected = await rpc(ctx.owner.client, "commercial_change_decide", { p_id: req.id, p_approve: false, p_note: "Muy alto" });
    expect(rejected.error).toBeNull();
    const still = await ctx.owner.client.from("payment_plans").select("is_active").eq("id", planId).single();
    expect((still.data as { is_active: boolean }).is_active).toBe(false);

    // Plan activo del dueño: el encargado sube el recargo y la fila no cambia.
    const own = await ctx.owner.client
      .from("payment_plans")
      .insert({ tenant_id: ctx.tenant, label: `Master 3 ${STAMP}`, surcharge_pct: 8, provider_key: null, base: "credito", brand: "master", installments: 3, code: `m3-${STAMP}`, is_active: true } as never)
      .select("id, is_active")
      .single();
    expect(own.error).toBeNull();
    expect((own.data as { is_active: boolean }).is_active).toBe(true);
    const ownId = (own.data as { id: string }).id;

    const upd = await ctx.manager.client.from("payment_plans").update({ surcharge_pct: 12 } as never).eq("id", ownId);
    expect(upd.error).toBeNull();
    const unchanged = await ctx.owner.client.from("payment_plans").select("surcharge_pct").eq("id", ownId).single();
    expect(Number((unchanged.data as { surcharge_pct: number }).surcharge_pct)).toBe(8);

    const list2 = await rpc(ctx.owner.client, "commercial_requests", { p_status: "pending" });
    const req2 = (list2.data as { id: string; entity_id: string; proposed: Record<string, unknown> }[]).find((r) => r.entity_id === ownId)!;
    expect(Number(req2.proposed.surcharge_pct)).toBe(12);
    const ok = await rpc(ctx.owner.client, "commercial_change_decide", { p_id: req2.id, p_approve: true });
    expect(ok.error).toBeNull();
    const applied = await ctx.owner.client.from("payment_plans").select("surcharge_pct, is_active").eq("id", ownId).single();
    expect(Number((applied.data as { surcharge_pct: number }).surcharge_pct)).toBe(12);
    expect((applied.data as { is_active: boolean }).is_active).toBe(true);
  });

  // ── H67 · márgenes ────────────────────────────────────────────────────────
  it("alertas de margen: dueño y encargado sí, cajero no; aviso al cruzar el mínimo", async () => {
    const caj = await rpc(ctx.cashier.client, "margin_alerts");
    expect(caj.error?.message).toMatch(/forbidden/);

    const set = await rpc(ctx.owner.client, "margin_settings_save", { p_min_margin_pct: 25, p_notify: true });
    expect(set.error).toBeNull();

    // Yerba: 1000 / 700 = 30 %. Sube el costo a 800 (20 %): cruza el 25 %.
    const up = await ctx.owner.client.from("products").update({ cost: 800 } as never).eq("id", ctx.yerba);
    expect(up.error).toBeNull();

    const alerts = await rpc(ctx.manager.client, "margin_alerts");
    expect(alerts.error).toBeNull();
    const row = (alerts.data as { product_id: string; level: string; suggested_price: number }[]).find((r) => r.product_id === ctx.yerba);
    expect(row?.level).toBe("low");
    expect(Number(row?.suggested_price)).toBeCloseTo(1066.67, 2);

    const notes = await ctx.owner.client.from("notifications").select("title").eq("type", "comercial");
    expect(((notes.data ?? []) as { title: string }[]).map((n) => n.title)).toContain("Margen bajo");

    const sum = await rpc(ctx.owner.client, "margin_summary");
    expect(Number((sum.data as { low: number }).low)).toBeGreaterThanOrEqual(1);
  });

  // ── H64 · conteo cíclico ──────────────────────────────────────────────────
  it("conteo cíclico: el cajero no cuenta; el dueño cuenta y queda la exactitud", async () => {
    const caj = await rpc(ctx.cashier.client, "cycle_count_due", { p_store_id: ctx.store });
    expect(caj.error?.message).toMatch(/forbidden/);
    const b = await rpc(ctx.ownerB.client, "cycle_count_policy_get");
    expect(b.error?.message).toMatch(/feature_not_in_plan: conteo_ciclico/);

    const due = await rpc(ctx.owner.client, "cycle_count_due", { p_store_id: ctx.store });
    expect(due.error).toBeNull();
    const ids = (due.data as { product_id: string }[]).map((r) => r.product_id);
    expect(ids).toContain(ctx.yerba);

    const sub = await rpc(ctx.owner.client, "cycle_count_submit", {
      p_store_id: ctx.store,
      p_lines: [
        { product_id: ctx.yerba, variant_id: null, counted: 4, abc_class: "C" },
        { product_id: ctx.phone, variant_id: null, counted: 0, abc_class: "C" },
      ],
      p_notes: "Conteo de prueba",
    });
    expect(sub.error).toBeNull();
    const res = sub.data as { id: string; lines: number; exact: number; accuracy_pct: number };
    expect(res.lines).toBe(2);
    expect(res.exact).toBe(1); // el celular estaba en 0
    expect(Number(res.accuracy_pct)).toBe(50);

    const stock = await ctx.owner.client.from("product_stock").select("qty").eq("store_id", ctx.store).eq("product_id", ctx.yerba).single();
    expect(Number((stock.data as { qty: number }).qty)).toBe(4);

    // Contados hoy: ya no aparecen.
    const again = await rpc(ctx.owner.client, "cycle_count_due", { p_store_id: ctx.store });
    expect((again.data as { product_id: string }[]).map((r) => r.product_id)).not.toContain(ctx.yerba);

    const dup = await rpc(ctx.owner.client, "cycle_count_submit", {
      p_store_id: ctx.store,
      p_lines: [
        { product_id: ctx.yerba, variant_id: null, counted: 1, abc_class: "C" },
        { product_id: ctx.yerba, variant_id: null, counted: 2, abc_class: "C" },
      ],
    });
    expect(dup.error?.message).toMatch(/duplicate_lines/);
    expect(await auditActions(res.id)).toContain("cycle_count_applied");
  });

  // ── H64 · garantías por serie ─────────────────────────────────────────────
  it("garantía por serie: el cajero vende en su turno, consulta y abre el reclamo; el dueño lo resuelve", async () => {
    // Las promos de carrito de los tests anteriores (30% y 5%) aplicarían a esta venta: se apagan para
    // que el escenario de serie no dependa del motor de promociones (create_sale exige promo_discount).
    await ctx.admin.from("promotions").update({ is_active: false } as never).eq("tenant_id", ctx.tenant);
    const serial = `IMEI${STAMP}`.toUpperCase();
    const stock = await rpc(ctx.owner.client, "adjust_store_stock", {
      p_store_id: ctx.store,
      p_product_id: ctx.phone,
      p_variant_id: null,
      p_qty: 1,
      p_mode: "delta",
      p_reason: "purchase",
    });
    expect(stock.error).toBeNull();
    const sale = await rpc(ctx.cashier.client, "create_sale", {
      p_items: [{ product_id: ctx.phone, quantity: 1, unit_price: 100000, discount: 0, serial }],
      p_payments: [{ method: "cash", amount: 100000 }],
    });
    expect(sale.error).toBeNull();

    const look = await rpc(ctx.cashier.client, "serial_lookup", { p_serial: ` ${serial.toLowerCase()} ` });
    expect(look.error).toBeNull();
    const info = look.data as { sales: { in_warranty: boolean; manufacturer_months: number; warranty_until: string }[] };
    expect(info.sales).toHaveLength(1);
    expect(info.sales[0]!.in_warranty).toBe(true);
    expect(info.sales[0]!.manufacturer_months).toBe(12);

    const b = await rpc(ctx.ownerB.client, "serial_lookup", { p_serial: serial });
    expect(b.error?.message).toMatch(/feature_not_in_plan: garantias_serie/);

    const claim = await rpc(ctx.cashier.client, "serial_claim_open", { p_serial: serial, p_reason: "No carga" });
    expect(claim.error).toBeNull();
    const claimId = claim.data as string;

    const cajUpd = await rpc(ctx.cashier.client, "serial_claim_update", { p_id: claimId, p_status: "resolved", p_resolution: "x" });
    expect(cajUpd.error?.message).toMatch(/forbidden/);

    const noRes = await rpc(ctx.owner.client, "serial_claim_update", { p_id: claimId, p_status: "resolved" });
    expect(noRes.error?.message).toMatch(/resolution_required/);
    const ok = await rpc(ctx.owner.client, "serial_claim_update", { p_id: claimId, p_status: "resolved", p_resolution: "Cambio de batería" });
    expect(ok.error).toBeNull();

    const row = await ctx.cashier.client.from("serial_warranty_claims").select("status, in_warranty").eq("id", claimId).single();
    expect(row.data).toEqual({ status: "resolved", in_warranty: true });
    const direct = await ctx.owner.client.from("serial_warranty_claims").update({ status: "open" } as never).eq("id", claimId);
    expect(direct.error).not.toBeNull();
    expect(await auditActions(claimId)).toEqual(expect.arrayContaining(["serial_claim_opened", "serial_claim_updated"]));
  });
});
