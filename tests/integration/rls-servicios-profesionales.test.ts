// @vitest-environment node
// =============================================================================
// ADR-116: servicios profesionales.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
//
//   · service_clarifications: RLS por negocio, escritura dueño/encargado, sin
//     DELETE físico.
//   · Un servicio no lleva stock (trigger).
//   · create_sale: la aclaración del renglón, el detalle y las aclaraciones
//     predefinidas llegan a sale_items; p_service a sales; una llamada vieja
//     (sin p_service) sigue andando y toma la fecha de la venta.
//   · arca_snapshot: has_services y el período (concepto 2 / 3 en la cola).
// audit_logs es inmutable (ADR-083): el cleanup no la toca.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `srv-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type Ctx = {
  admin: SupabaseClient;
  tenantA: string;
  tenantB: string;
  ownerA: SupabaseClient;
  cashierA: SupabaseClient;
  ownerB: SupabaseClient;
  userIds: string[];
  shift: string;
  service: string;
  product: string;
  clarA: string;
  clarB: string;
};
const ctx = {} as Ctx;

async function makeUser(admin: SupabaseClient, email: string, tenantId: string, role: string) {
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

type RpcRes = { data: unknown; error: { message: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcRes>;

const todayAr = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
const plusDays = (iso: string, d: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);

describe.skipIf(!enabled)("ADR-116 · servicios profesionales", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];
    const { data: tenants, error: tErr } = await admin
      .from("tenants")
      .insert([
        { name: `SRV A ${STAMP}`, slug: `srva-${STAMP}`, status: "active", industry: "servicios" },
        { name: `SRV B ${STAMP}`, slug: `srvb-${STAMP}`, status: "active" },
      ])
      .select("id");
    if (tErr || !tenants) throw tErr ?? new Error("tenants");
    ctx.tenantA = tenants[0]!.id;
    ctx.tenantB = tenants[1]!.id;

    const ownerA = await makeUser(admin, `srv-owner-a-${STAMP}@test.local`, ctx.tenantA, "owner");
    const cashierA = await makeUser(admin, `srv-cashier-a-${STAMP}@test.local`, ctx.tenantA, "cashier");
    const ownerB = await makeUser(admin, `srv-owner-b-${STAMP}@test.local`, ctx.tenantB, "owner");
    ctx.ownerA = ownerA.client;
    ctx.cashierA = cashierA.client;
    ctx.ownerB = ownerB.client;
    ctx.userIds.push(ownerA.id, cashierA.id, ownerB.id);

    const st = await ownerA.client.from("stores").insert({ name: "Laboratorio" } as never).select("id").single();
    if (st.error || !st.data) throw st.error ?? new Error("store");
    const reg = await ownerA.client
      .from("cash_registers")
      .insert({ store_id: (st.data as unknown as { id: string }).id, name: "Caja 1" } as never)
      .select("id")
      .single();
    if (reg.error || !reg.data) throw reg.error ?? new Error("caja");
    const sh = await rpc(cashierA.client, "open_cash_shift", {
      p_register_id: (reg.data as unknown as { id: string }).id,
      p_opening_amount: 0,
    });
    if (sh.error) throw new Error(sh.error.message);
    ctx.shift = sh.data as string;
  }, 150_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin) return;
    for (const t of [ctx.tenantA, ctx.tenantB].filter(Boolean)) {
      await admin.from("service_clarifications" as never).delete().eq("tenant_id", t);
      await admin.from("tenants").delete().eq("id", t);
    }
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("aclaraciones: el dueño las carga, cada negocio ve las suyas y el cajero no escribe", async () => {
    const a = await ctx.ownerA
      .from("service_clarifications" as never)
      .insert({ title: "Muestras", body: "Incluye toma de muestras en planta" } as never)
      .select("id")
      .single();
    expect(a.error).toBeNull();
    ctx.clarA = (a.data as unknown as { id: string }).id;
    const b = await ctx.ownerB
      .from("service_clarifications" as never)
      .insert({ title: "Ajena", body: "De otro negocio" } as never)
      .select("id")
      .single();
    expect(b.error).toBeNull();
    ctx.clarB = (b.data as unknown as { id: string }).id;

    const seenA = await ctx.ownerA.from("service_clarifications" as never).select("id");
    expect((seenA.data as unknown as { id: string }[]).map((r) => r.id)).toEqual([ctx.clarA]);
    const seenCashier = await ctx.cashierA.from("service_clarifications" as never).select("id");
    expect((seenCashier.data as unknown as { id: string }[]).length).toBe(1);

    const cross = await ctx.ownerA
      .from("service_clarifications" as never)
      .insert({ tenant_id: ctx.tenantB, title: "x", body: "x" } as never);
    expect(cross.error).not.toBeNull();
    const byCashier = await ctx.cashierA
      .from("service_clarifications" as never)
      .insert({ title: "Cajero", body: "x" } as never);
    expect(byCashier.error).not.toBeNull();
    const upd = await ctx.cashierA
      .from("service_clarifications" as never)
      .update({ title: "cambiado" } as never)
      .eq("id", ctx.clarA)
      .select("id");
    expect((upd.data as unknown[] | null)?.length ?? 0).toBe(0);
    await ctx.ownerA.from("service_clarifications" as never).delete().eq("id", ctx.clarA);
    const still = await ctx.admin.from("service_clarifications" as never).select("id").eq("id", ctx.clarA);
    expect((still.data as unknown[]).length).toBe(1);
  });

  it("un servicio queda sin stock", async () => {
    const p = await ctx.ownerA
      .from("products")
      .insert({
        name: `Análisis ${STAMP}`,
        price: 1000,
        is_service: true,
        track_stock: true,
        unit: "analisis",
        invoice_detail: "Recuento de aerobios\n- Coliformes",
        service_clarification_ids: [ctx.clarA, ctx.clarB],
      } as never)
      .select("id, track_stock")
      .single();
    expect(p.error).toBeNull();
    expect((p.data as unknown as { track_stock: boolean }).track_stock).toBe(false);
    ctx.service = (p.data as unknown as { id: string }).id;
    const g = await ctx.ownerA.from("products").insert({ name: `Frasco ${STAMP}`, price: 100, stock: 10 } as never).select("id").single();
    expect(g.error).toBeNull();
    ctx.product = (g.data as unknown as { id: string }).id;
  });

  it("create_sale guarda la aclaración, el detalle y el período; la factura lleva concepto 3", async () => {
    const today = todayAr();
    const due = plusDays(today, 15);
    const r = await rpc(ctx.cashierA, "create_sale", {
      p_items: [
        { product_id: ctx.service, quantity: 2, unit_price: 1000, discount: 0, line_note: "Muestras N° 45 y 46\nLote 2381" },
        { product_id: ctx.product, quantity: 1, unit_price: 100, discount: 0 },
      ],
      p_payments: [{ method: "cash", amount: 2100 }],
      p_cash_shift_id: ctx.shift,
      p_service: { from: plusDays(today, -9), to: today, due },
    });
    expect(r.error).toBeNull();
    const out = r.data as { sale_id: string; service: { lines: number } };
    expect(out.service.lines).toBe(1);

    const items = await ctx.admin
      .from("sale_items")
      .select("product_id, line_note, line_detail, line_clarifications, unit_label")
      .eq("sale_id", out.sale_id);
    const srv = (items.data as unknown as Record<string, unknown>[]).find((i) => i.product_id === ctx.service)!;
    const good = (items.data as unknown as Record<string, unknown>[]).find((i) => i.product_id === ctx.product)!;
    expect(srv.line_note).toBe("Muestras N° 45 y 46\nLote 2381");
    expect(srv.line_detail).toBe("Recuento de aerobios\n- Coliformes");
    // La de otro negocio no entra.
    expect(srv.line_clarifications).toEqual(["Incluye toma de muestras en planta"]);
    expect(srv.unit_label).toBe("analisis");
    expect(good.unit_label).toBeNull();

    const s = await ctx.admin.from("sales").select("service_from, service_to, payment_due").eq("id", out.sale_id).single();
    expect(s.data).toEqual({ service_from: plusDays(today, -9), service_to: today, payment_due: due });

    // La foto de la cola fiscal lleva servicios + productos y el período.
    const doc = await ctx.admin
      .from("fiscal_documents")
      .insert({ tenant_id: ctx.tenantA, sale_id: out.sale_id, origin: "sale", environment: "homologacion", status: "pendiente" } as never)
      .select("id")
      .single();
    if (!doc.error && doc.data) {
      const snap = await rpc(ctx.admin, "arca_snapshot", { p_doc: (doc.data as unknown as { id: string }).id });
      expect(snap.error).toBeNull();
      const v = snap.data as { has_services: boolean; has_goods: boolean; sale: Record<string, unknown> };
      expect(v.has_services && v.has_goods).toBe(true);
      expect(v.sale.payment_due).toBe(due);
      await ctx.admin.from("fiscal_documents").delete().eq("id", (doc.data as unknown as { id: string }).id);
    }
  });

  it("una llamada vieja (sin p_service) sigue andando: período = fecha de la venta", async () => {
    const r = await rpc(ctx.cashierA, "create_sale", {
      p_items: [{ product_id: ctx.service, quantity: 1, unit_price: 1000, discount: 0 }],
      p_payments: [{ method: "cash", amount: 1000 }],
      p_cash_shift_id: ctx.shift,
    });
    expect(r.error).toBeNull();
    const id = (r.data as { sale_id: string }).sale_id;
    const s = await ctx.admin.from("sales").select("service_from, service_to, payment_due").eq("id", id).single();
    const t = todayAr();
    expect(s.data).toEqual({ service_from: t, service_to: t, payment_due: t });
  });

  it("valida el período y el vencimiento", async () => {
    const base = {
      p_items: [{ product_id: ctx.service, quantity: 1, unit_price: 1000, discount: 0 }],
      p_payments: [{ method: "cash", amount: 1000 }],
      p_cash_shift_id: ctx.shift,
    };
    const t = todayAr();
    const bad = await rpc(ctx.cashierA, "create_sale", { ...base, p_service: { from: t, to: plusDays(t, -1) } });
    expect(bad.error?.message).toMatch(/service_period_invalid/);
    const late = await rpc(ctx.cashierA, "create_sale", { ...base, p_service: { due: plusDays(t, -1) } });
    expect(late.error?.message).toMatch(/service_due_invalid/);
  });

  it("sin servicios no guarda período aunque llegue p_service", async () => {
    const r = await rpc(ctx.cashierA, "create_sale", {
      p_items: [{ product_id: ctx.product, quantity: 1, unit_price: 100, discount: 0, line_note: "Frasco para la muestra 47" }],
      p_payments: [{ method: "cash", amount: 100 }],
      p_cash_shift_id: ctx.shift,
      p_service: { from: todayAr() },
    });
    expect(r.error).toBeNull();
    const id = (r.data as { sale_id: string }).sale_id;
    const s = await ctx.admin.from("sales").select("service_from").eq("id", id).single();
    expect((s.data as { service_from: string | null }).service_from).toBeNull();
    const it = await ctx.admin.from("sale_items").select("line_note").eq("sale_id", id).single();
    expect((it.data as { line_note: string }).line_note).toBe("Frasco para la muestra 47");
  });
});
