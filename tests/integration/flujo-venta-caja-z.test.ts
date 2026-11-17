// @vitest-environment node
// =============================================================================
// OPS-21 · Flujo completo de caja: apertura → ventas → movimientos → anulación
// → cierre con arqueo → Z correlativo por caja, y auditoría de cada paso.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea datos (guard de host local,
// igual que rls-intents-expire). audit_logs es inmutable (ADR-083): el cleanup
// no la toca.
//
// Contratos reales (no se cambia ninguna RPC ni migración):
//   * open_cash_shift(p_register_id, p_opening_amount) → uuid del turno.
//   * create_sale(p_items, p_payments, p_discount_total, …, p_cash_shift_id)
//     → jsonb { sale_id, number, total, … }. Cada pago es una fila en payments
//     y un cash_movements type='sale' con su payment_method.
//   * VUELTO: el servidor no lo modela. El POS (lib/pos/checkoutMath.ts,
//     CheckoutSheet) manda en p_payments lo COBRADO (= total de la línea); lo
//     "recibido" y el vuelto (recibido − cobrado) quedan en el cliente. Si se
//     mandara el recibido, create_sale lo acepta (paga de más) y el esperado de
//     caja quedaría inflado por el vuelto: por eso el test manda lo cobrado.
//   * Ingreso / egreso manual: NO hay RPC. Es un INSERT por REST en
//     cash_movements (type 'income' | 'expense', amount > 0, reason), como
//     modules/cash/api.ts › addMovement; lo valida trg_cash_movements_guard
//     (turno propio y abierto, PIN si la política cash_in / cash_out lo pide;
//     por defecto apagada).
//   * void_sale(p_sale_id, p_reason) → void. Repone products.stock, deja
//     stock_movements reason 'sale_void' y un cash_movements 'sale_void' por
//     cada pago. Pide la capacidad sales.void (el dueño la tiene).
//   * close_cash_shift(p_shift_id, p_closing_amount, p_notes, p_pending_action)
//     → numeric: la DIFERENCIA (contado − esperado), no el Z. El Z se lee de
//     cash_z_closures (una fila por turno): z_number (correlativo del negocio),
//     store_z_number y register_z_number (por sucursal y por caja, trigger
//     czc_numbering, ADR-080), expected_amount, closing_amount, difference,
//     sales_count / sales_total / discounts_total (ventas completadas),
//     voids_count / voids_total, cash_in / cash_out, payment_breakdown (ventas
//     BRUTAS por medio: suma los cash_movements 'sale', sin restar las
//     anulaciones) y count_detail.methods (esperado NETO de anulaciones por
//     medio; efectivo con esperado / contado / diferencia; H159).
//   * Esperado de efectivo = apertura + income − expense + ventas en efectivo
//     − anulaciones en efectivo (cash_movements del turno).
//   * audit_logs: triggers genéricos write_audit_log (action = TG_OP). Apertura
//     = INSERT en 'cash_shifts'; cierre = UPDATE en 'cash_shifts' con status
//     open → closed; anulación = UPDATE en 'sales' con status completed →
//     voided (after_data.void_reason). No hay acciones con nombre propio para
//     estos tres pasos.
//
// PRUEBA NEGATIVA (aceptación de OPS-21; requiere Docker, no se versiona):
//   en una copia local, cambiar en expectedCash() el signo del egreso
//   (`- MOVES.expense` → `+ MOVES.expense`). El esperado del test pasa de
//   17.000 a 19.400 y el contado (esperado − 50) a 19.350. Fallan:
//     - expect(expected_amount).toBe(expectedCash()) → 17000 ≠ 19400;
//     - expect(diff).toBe(-50) → la RPC devuelve 19350 − 17000 = 2350;
//     - count_detail.methods.cash (expected / diff).
//   Correr `npx vitest run tests/integration/flujo-venta-caja-z.test.ts` con
//   las variables SUPABASE_TEST_* de `supabase status` y ver el rojo; revertir.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
// Crea negocios, ventas y cierres: sólo contra un Supabase local.
const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(URL_ ?? "");
const enabled = Boolean(URL_ && ANON && SERVICE && isLocal);

const STAMP = `ops21-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

// ---------------------------------------------------------------------------
// Escenario (datos de entrada: los esperados se calculan de acá)
// ---------------------------------------------------------------------------
const OPENING = 10_000;
const DIFFERENCE = -50;
const PRICES = { yerba: 1000, galletitas: 1500 } as const;
type Prod = keyof typeof PRICES;
type Pay = { method: "cash" | "debit"; amount: number };
type SaleSpec = {
  key: string;
  items: { p: Prod; qty: number }[];
  discount: number;
  /** Lo que se manda en p_payments (lo cobrado), a partir del total. */
  pays: (total: number) => Pay[];
  /** Sólo efectivo con vuelto: lo que entregó el cliente. */
  received?: number;
};

const SALES: SaleSpec[] = [
  { key: "efectivo", items: [{ p: "yerba", qty: 2 }], discount: 0, pays: (t) => [{ method: "cash", amount: t }] },
  { key: "debito", items: [{ p: "galletitas", qty: 1 }], discount: 0, pays: (t) => [{ method: "debit", amount: t }] },
  {
    key: "mixta",
    items: [
      { p: "yerba", qty: 1 },
      { p: "galletitas", qty: 1 },
    ],
    discount: 0,
    pays: (t) => [
      { method: "cash", amount: 1000 },
      { method: "debit", amount: t - 1000 },
    ],
  },
  { key: "descuento", items: [{ p: "yerba", qty: 3 }], discount: 300, pays: (t) => [{ method: "cash", amount: t }] },
  // Pagó con $2.000 una venta de $1.500: se cobra 1.500, el vuelto (500) no va al servidor.
  {
    key: "vuelto",
    items: [{ p: "galletitas", qty: 1 }],
    discount: 0,
    pays: (t) => [{ method: "cash", amount: t }],
    received: 2000,
  },
];
const VOIDED = "efectivo";
const VOID_REASON = "Cliente se arrepintió (OPS-21)";
const MOVES = { income: 3000, expense: 1200 };

const subtotalOf = (s: SaleSpec) => s.items.reduce((a, i) => a + PRICES[i.p] * i.qty, 0);
const totalOf = (s: SaleSpec) => subtotalOf(s) - s.discount;
const paysOf = (s: SaleSpec) => s.pays(totalOf(s));
const byKey = (k: string) => SALES.find((s) => s.key === k)!;
const sumMethod = (sales: SaleSpec[], m: Pay["method"]) =>
  sales.reduce((a, s) => a + paysOf(s).filter((p) => p.method === m).reduce((b, p) => b + p.amount, 0), 0);
const live = () => SALES.filter((s) => s.key !== VOIDED);

/** Efectivo esperado: apertura + ventas en efectivo − anulada + ingreso − egreso. */
const expectedCash = () =>
  OPENING + sumMethod(SALES, "cash") - sumMethod([byKey(VOIDED)], "cash") + MOVES.income - MOVES.expense;

// ---------------------------------------------------------------------------
// Infra
// ---------------------------------------------------------------------------
type RpcRes = { data: unknown; error: { message: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcRes>;
type Row = Record<string, unknown>;

type Ctx = {
  admin: SupabaseClient;
  owner: SupabaseClient;
  ownerId: string;
  tenant: string;
  store: string;
  reg1: string;
  reg2: string;
  products: Record<Prod, string>;
  shift: string;
  sales: Record<string, string>;
  stockBeforeVoid: number;
  zFirst: Row;
  userIds: string[];
};
const ctx = { userIds: [] as string[], sales: {} as Record<string, string> } as Ctx;

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
  const { error: tuErr } = await admin
    .from("tenant_users")
    .insert({ tenant_id: tenantId, user_id: id, role, status: "active" });
  if (tuErr) throw tuErr;
  const client = createClient(URL_!, ANON!, { auth: { persistSession: false } });
  const { error: sErr } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr) throw sErr;
  return { id, client };
}

async function rowsOf(table: string, col: string, value: string) {
  const { data, error } = await ctx.admin.from(table as never).select("*").eq(col, value);
  if (error) throw new Error(`${table}: ${error.message}`);
  return (data ?? []) as unknown as Row[];
}

async function stockOf(product: string) {
  const { data, error } = await ctx.admin.from("products").select("stock").eq("id", product).single();
  if (error) throw error;
  return Number((data as unknown as { stock: number }).stock);
}

async function zOf(shift: string) {
  const rows = await rowsOf("cash_z_closures", "cash_shift_id", shift);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function auditsOf(entityType: string, entityId: string) {
  const { data, error } = await ctx.admin
    .from("audit_logs")
    .select("action, actor_user_id, before_data, after_data")
    .eq("tenant_id", ctx.tenant)
    .eq("entity_type", entityType)
    .eq("entity_id", entityId);
  if (error) throw error;
  return (data ?? []) as unknown as {
    action: string;
    actor_user_id: string | null;
    before_data: Row | null;
    after_data: Row | null;
  }[];
}

const sell = (spec: SaleSpec, shift: string | null) =>
  rpc(ctx.owner, "create_sale", {
    p_items: spec.items.map((i) => ({
      product_id: ctx.products[i.p],
      quantity: i.qty,
      unit_price: PRICES[i.p],
      discount: 0,
    })),
    p_payments: paysOf(spec),
    p_discount_total: spec.discount,
    ...(shift ? { p_cash_shift_id: shift } : {}),
  });

const openShift = async (register: string, amount: number) => {
  const r = await rpc(ctx.owner, "open_cash_shift", { p_register_id: register, p_opening_amount: amount });
  if (r.error) throw new Error(r.error.message);
  return r.data as string;
};

describe.skipIf(!enabled)("OPS-21 · flujo venta → caja → cierre Z", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;

    const { data: t, error: tErr } = await admin
      .from("tenants")
      .insert({ name: `OPS21 ${STAMP}`, slug: `ops21-${STAMP}`, status: "active" })
      .select("id")
      .single();
    if (tErr || !t) throw tErr ?? new Error("tenant");
    ctx.tenant = (t as { id: string }).id;

    // Descuento manual (feature no básica) y segunda caja para probar el
    // correlativo por caja.
    const { error: addonErr } = await admin.from("subscription_addons").insert(
      ["descuentos", "multi_caja"].map((key) => ({
        tenant_id: ctx.tenant,
        addon_key: key,
        status: "active",
        source: "granted",
      })),
    );
    if (addonErr) throw addonErr;

    // Un solo actor: el dueño abre, vende, anula (sales.void) y cierra.
    const owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenant, "owner");
    ctx.owner = owner.client;
    ctx.ownerId = owner.id;
    ctx.userIds.push(owner.id);

    const st = await ctx.owner.from("stores").insert({ name: "Centro" } as never).select("id").single();
    if (st.error || !st.data) throw st.error ?? new Error("store");
    ctx.store = (st.data as unknown as { id: string }).id;

    const ps = await admin
      .from("pos_settings")
      .upsert({ tenant_id: ctx.tenant, allow_negative_stock: true } as never, { onConflict: "tenant_id" });
    if (ps.error) throw ps.error;

    const pr = await admin
      .from("products")
      .insert(
        (Object.keys(PRICES) as Prod[]).map((p) => ({
          tenant_id: ctx.tenant,
          name: `${p} ${STAMP}`,
          price: PRICES[p],
          cost: PRICES[p] / 2,
          stock: 100,
        })) as never,
      )
      .select("id, name");
    if (pr.error || !pr.data) throw pr.error ?? new Error("products");
    const prows = pr.data as unknown as { id: string; name: string }[];
    ctx.products = Object.fromEntries(
      (Object.keys(PRICES) as Prod[]).map((p) => [p, prows.find((r) => r.name.startsWith(`${p} `))!.id]),
    ) as Record<Prod, string>;

    const regs = await ctx.owner
      .from("cash_registers")
      .insert([1, 2].map((n) => ({ store_id: ctx.store, name: `Caja ${n}` })) as never)
      .select("id, name");
    if (regs.error || !regs.data) throw regs.error ?? new Error("registers");
    const rrows = regs.data as unknown as { id: string; name: string }[];
    ctx.reg1 = rrows.find((r) => r.name === "Caja 1")!.id;
    ctx.reg2 = rrows.find((r) => r.name === "Caja 2")!.id;
  }, 120_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin || !ctx.tenant) return;
    await admin.from("subscription_addons").delete().eq("tenant_id", ctx.tenant);
    // audit_logs es inmutable (ADR-083): si el negocio no se puede borrar por
    // sus auditorías, queda (datos de prueba con sello único).
    await admin.from("tenants").delete().eq("id", ctx.tenant);
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("1. abre el turno de la Caja 1 con $10.000", async () => {
    ctx.shift = await openShift(ctx.reg1, OPENING);
    const [shift] = await rowsOf("cash_shifts", "id", ctx.shift);
    expect(shift).toMatchObject({ status: "open", tenant_id: ctx.tenant, cash_register_id: ctx.reg1 });
    expect(Number(shift!.opening_amount)).toBe(OPENING);
  });

  it("2. cinco ventas: efectivo, débito, mixta, con descuento y efectivo con vuelto", async () => {
    for (const spec of SALES) {
      const r = await sell(spec, ctx.shift);
      expect(r.error, spec.key).toBeNull();
      const res = r.data as Row;
      expect(Number(res.total), spec.key).toBe(totalOf(spec));
      ctx.sales[spec.key] = res.sale_id as string;

      const [sale] = await rowsOf("sales", "id", ctx.sales[spec.key]!);
      expect(sale, spec.key).toMatchObject({ status: "completed", cash_shift_id: ctx.shift });
      expect(Number(sale!.discount_total), spec.key).toBe(spec.discount);

      const pays = await rowsOf("payments", "sale_id", ctx.sales[spec.key]!);
      const sent = paysOf(spec);
      expect(pays.map((p) => [p.method, Number(p.amount)]).sort(), spec.key).toEqual(
        sent.map((p) => [p.method, p.amount]).sort(),
      );
      // Una fila de caja por pago, con su medio.
      expect(await rowsOf("cash_movements", "reference_id", ctx.sales[spec.key]!), spec.key).toHaveLength(sent.length);
    }
    // El vuelto queda del lado del POS: se cobró el total, no lo recibido.
    const change = byKey("vuelto");
    expect(change.received! - totalOf(change)).toBe(500);
    expect(sumMethod([change], "cash")).toBe(totalOf(change));
  });

  it("3. ingreso y egreso manual en el turno propio", async () => {
    const inc = await ctx.owner
      .from("cash_movements")
      .insert({ cash_shift_id: ctx.shift, type: "income", amount: MOVES.income, reason: "Cambio del banco" } as never);
    expect(inc.error).toBeNull();
    const exp = await ctx.owner
      .from("cash_movements")
      .insert({ cash_shift_id: ctx.shift, type: "expense", amount: MOVES.expense, reason: "Pago a proveedor" } as never);
    expect(exp.error).toBeNull();

    const moves = await rowsOf("cash_movements", "cash_shift_id", ctx.shift);
    expect(moves.filter((m) => m.type === "income").map((m) => Number(m.amount))).toEqual([MOVES.income]);
    expect(moves.filter((m) => m.type === "expense").map((m) => Number(m.amount))).toEqual([MOVES.expense]);
  });

  it("4. anula la venta en efectivo con motivo: repone stock y contramovimiento de caja", async () => {
    const saleId = ctx.sales[VOIDED]!;
    const voided = byKey(VOIDED);
    ctx.stockBeforeVoid = await stockOf(ctx.products.yerba);

    const r = await rpc(ctx.owner, "void_sale", { p_sale_id: saleId, p_reason: VOID_REASON });
    expect(r.error).toBeNull();

    const [sale] = await rowsOf("sales", "id", saleId);
    expect(sale).toMatchObject({ status: "voided", void_reason: VOID_REASON, voided_by: ctx.ownerId });

    const qty = voided.items.filter((i) => i.p === "yerba").reduce((a, i) => a + i.qty, 0);
    expect(await stockOf(ctx.products.yerba)).toBe(ctx.stockBeforeVoid + qty);
    const stockBack = (await rowsOf("stock_movements", "reference_id", saleId)).filter((m) => m.reason === "sale_void");
    expect(stockBack.map((m) => Number(m.delta))).toEqual([qty]);

    const cashBack = (await rowsOf("cash_movements", "reference_id", saleId)).filter((m) => m.type === "sale_void");
    expect(cashBack.map((m) => [m.payment_method, Number(m.amount)])).toEqual(
      paysOf(voided).map((p) => [p.method, p.amount]),
    );

    // Una venta anulada no se anula dos veces.
    const again = await rpc(ctx.owner, "void_sale", { p_sale_id: saleId, p_reason: VOID_REASON });
    expect(again.error?.message).toMatch(/sale_not_found_or_not_voidable/);
  });

  it("5. cierra con arqueo $50 abajo del esperado: diferencia y Z con totales por medio", async () => {
    const expected = expectedCash();
    const counted = expected + DIFFERENCE;

    const r = await rpc(ctx.owner, "close_cash_shift", {
      p_shift_id: ctx.shift,
      p_closing_amount: counted,
      p_notes: "Faltan $50 en el arqueo",
    });
    expect(r.error).toBeNull();
    // Contrato: close_cash_shift devuelve la diferencia (numeric), no el Z.
    expect(Number(r.data)).toBe(DIFFERENCE);

    const [shift] = await rowsOf("cash_shifts", "id", ctx.shift);
    expect(shift!.status).toBe("closed");
    expect(Number(shift!.expected_amount)).toBe(expected);
    expect(Number(shift!.closing_amount)).toBe(counted);

    const z = await zOf(ctx.shift);
    ctx.zFirst = z;
    expect(z).toMatchObject({ tenant_id: ctx.tenant, store_id: ctx.store, cash_register_id: ctx.reg1 });
    expect(Number(z.z_number)).toBe(1);
    expect(Number(z.store_z_number)).toBe(1);
    expect(Number(z.register_z_number)).toBe(1);

    expect(Number(z.opening_amount)).toBe(OPENING);
    expect(Number(z.expected_amount)).toBe(expected);
    expect(Number(z.closing_amount)).toBe(counted);
    expect(Number(z.difference)).toBe(DIFFERENCE);

    expect(Number(z.sales_count)).toBe(live().length);
    expect(Number(z.sales_total)).toBe(live().reduce((a, s) => a + totalOf(s), 0));
    expect(Number(z.discounts_total)).toBe(live().reduce((a, s) => a + s.discount, 0));
    expect(Number(z.voids_count)).toBe(1);
    expect(Number(z.voids_total)).toBe(totalOf(byKey(VOIDED)));
    expect(Number(z.cash_in)).toBe(MOVES.income);
    expect(Number(z.cash_out)).toBe(MOVES.expense);

    // payment_breakdown: ventas BRUTAS por medio (incluye la que después se anuló).
    const breakdown = z.payment_breakdown as Record<string, number>;
    expect(Object.keys(breakdown).sort()).toEqual(["cash", "debit"]);
    expect(Number(breakdown.cash)).toBe(sumMethod(SALES, "cash"));
    expect(Number(breakdown.debit)).toBe(sumMethod(SALES, "debit"));

    // count_detail (H159): esperado NETO por medio y el arqueo del efectivo.
    const methods = (z.count_detail as { methods: Record<string, Row> }).methods;
    expect(Number(methods.cash!.expected)).toBe(expected);
    expect(Number(methods.cash!.counted)).toBe(counted);
    expect(Number(methods.cash!.diff)).toBe(DIFFERENCE);
    expect(Number(methods.debit!.expected)).toBe(sumMethod(live(), "debit"));
    expect(methods.debit!.counted).toBeNull(); // sin cash_shift_save_count no hay contado por medio
  });

  it("6. vender con el turno cerrado da error y no toca stock", async () => {
    const before = await stockOf(ctx.products.yerba);
    const explicit = await sell(byKey("efectivo"), ctx.shift);
    expect(explicit.error?.message).toMatch(/shift_not_open/);
    // Sin turno explícito tampoco: el dueño no tiene otro turno abierto.
    const inferred = await sell(byKey("efectivo"), null);
    expect(inferred.error?.message).toMatch(/no_open_shift/);
    expect(await stockOf(ctx.products.yerba)).toBe(before);
    // Y no se puede mover plata en un turno cerrado.
    const mv = await ctx.owner
      .from("cash_movements")
      .insert({ cash_shift_id: ctx.shift, type: "income", amount: 10, reason: "Tarde" } as never);
    expect(mv.error?.message).toMatch(/shift_not_open/);
  });

  it("7. Z correlativo por caja: Caja 2 arranca en 1, Caja 1 sigue en 2; el del negocio no salta", async () => {
    // Caja 2: turno vacío.
    const shift2 = await openShift(ctx.reg2, 0);
    const c2 = await rpc(ctx.owner, "close_cash_shift", { p_shift_id: shift2, p_closing_amount: 0 });
    expect(c2.error).toBeNull();
    expect(Number(c2.data)).toBe(0);

    // Caja 1 otra vez, con el fondo del cierre anterior (lo que propone el POS).
    const counted1 = Number(ctx.zFirst.closing_amount);
    const shift3 = await openShift(ctx.reg1, counted1);
    const [opened] = await rowsOf("cash_shifts", "id", shift3);
    expect(Number(opened!.opening_suggested)).toBe(counted1);
    const c3 = await rpc(ctx.owner, "close_cash_shift", { p_shift_id: shift3, p_closing_amount: counted1 });
    expect(c3.error).toBeNull();
    expect(Number(c3.data)).toBe(0);

    const z2 = await zOf(shift2);
    const z3 = await zOf(shift3);
    expect(z2).toMatchObject({ cash_register_id: ctx.reg2 });
    expect(z3).toMatchObject({ cash_register_id: ctx.reg1 });
    expect(Number(z2.register_z_number)).toBe(1);
    expect(Number(z3.register_z_number)).toBe(Number(ctx.zFirst.register_z_number) + 1);
    // Del negocio y de la sucursal: 1, 2, 3 sin huecos.
    expect([ctx.zFirst, z2, z3].map((z) => Number(z.z_number))).toEqual([1, 2, 3]);
    expect([ctx.zFirst, z2, z3].map((z) => Number(z.store_z_number))).toEqual([1, 2, 3]);
  });

  it("8. audit_logs: una entrada por apertura, anulación y cierre", async () => {
    const shiftLog = await auditsOf("cash_shifts", ctx.shift);
    const opens = shiftLog.filter((a) => a.action === "INSERT");
    expect(opens).toHaveLength(1);
    expect(opens[0]!.actor_user_id).toBe(ctx.ownerId);
    expect(Number(opens[0]!.after_data!.opening_amount)).toBe(OPENING);

    const closes = shiftLog.filter(
      (a) => a.action === "UPDATE" && a.before_data?.status === "open" && a.after_data?.status === "closed",
    );
    expect(closes).toHaveLength(1);
    expect(closes[0]!.actor_user_id).toBe(ctx.ownerId);
    expect(Number(closes[0]!.after_data!.closing_amount)).toBe(expectedCash() + DIFFERENCE);
    expect(Number(closes[0]!.after_data!.expected_amount)).toBe(expectedCash());

    const voids = (await auditsOf("sales", ctx.sales[VOIDED]!)).filter(
      (a) => a.action === "UPDATE" && a.before_data?.status === "completed" && a.after_data?.status === "voided",
    );
    expect(voids).toHaveLength(1);
    expect(voids[0]!.actor_user_id).toBe(ctx.ownerId);
    expect(voids[0]!.after_data!.void_reason).toBe(VOID_REASON);
  });
});
