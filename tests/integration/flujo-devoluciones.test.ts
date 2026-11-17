// @vitest-environment node
// =============================================================================
// OPS-22 · Flujo de devoluciones: parcial, total, con el turno original
// cerrado, nota de crédito en la cola fiscal y rechazos por negocio y por rol.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea datos (guard de host local,
// igual que flujo-venta-caja-z). audit_logs es inmutable (ADR-083): el cleanup
// no la toca.
//
// Contrato real de return_sale_v2 (última definición: migración
// 20261108600000_perf_f4_create_sale_tenant; no se cambia ninguna RPC):
//   * return_sale_v2(p_sale_id, p_items jsonb [{ sale_item_id, quantity }],
//       p_reason_id = null, p_refund = 'cash' ('cash' | 'store_credit' |
//       'account'), p_customer_id = null, p_allowed_branch_ids = null,
//       p_cash_shift_id = null, p_mp_payment_id = null, p_mp_amount = null)
//     → jsonb { return_id, number, total, refund, stock_destination,
//       voucher_code, voucher_expires_at, account_credited, cash_refund,
//       mp_amount, mp_refund_id, rest_amount }. SECURITY DEFINER; el negocio
//     sale de current_tenant_id() (la venta de otro negocio da sale_not_found).
//   * Validación de cantidad por línea: quantity ≤ sale_items.quantity −
//     returned_qty, si no 'qty_exceeds' (la línea se toma FOR UPDATE y
//     returned_qty se suma en la misma transacción: una línea repetida en
//     p_items también se controla). Cantidad ≤ 0 se ignora; sin nada devuelto,
//     'empty_return'. La venta NO cambia de estado (sigue 'completed') aun
//     devuelta entera: lo que frena la segunda devolución es returned_qty.
//   * Turno: resolve_sale_shift(p_cash_shift_id, estricto si es efectivo).
//     Con turno explícito exige que exista, esté abierto (shift_not_open), la
//     sucursal permitida y que sea propio (shift_not_owned, salvo caja
//     compartida). Sin turno explícito y una sola sucursal: el turno ABIERTO
//     del usuario (o, con caja compartida, el último abierto). En efectivo sin
//     turno: 'no_open_shift'. Por eso, con el turno de la venta ya cerrado, el
//     egreso cae en el turno abierto actual de quien devuelve.
//   * Caja: un cash_movements type='expense', payment_method='cash', amount =
//     total devuelto (menos lo acreditado a cuenta corriente), reason
//     'Devolución venta #<n>', reference_id = return_id, en el turno resuelto.
//   * Stock: con motivo de destino 'resale' (o sin motivo) repone
//     products.stock (track_stock) y deja stock_movements reason='return',
//     reference_id = return_id, store_id = sucursal del turno.
//   * audit_logs: 'return_created' (entity sale_returns) y 'return_restock'
//     (entity stock_movements, entity_id = producto) con auth.uid() de actor.
//   * Roles: la RPC no chequea rol; lo hace trg_role_write_guard al insertar en
//     sale_returns (también dentro de SECURITY DEFINER): viewer →
//     'forbidden_read_only'; el resto necesita la capacidad 'sales.return'
//     (dueño, encargado y cajero la tienen). Además trg_sale_returns_supervisor
//     pide PIN según la política 'sale_return' (apagada por defecto).
//   * Fiscal: arca_returns_enqueue (AFTER INSERT/UPDATE of total en
//     sale_returns, migración 20261101100100) llama a arca_enqueue_return si
//     arca_settings.enabled: con la feature facturacion_afip y un
//     fiscal_documents origin='sale' no cancelado/rechazado de la venta, crea
//     la NC (origin='return', assoc_document_id = factura) y luego le copia el
//     total. No se llama a ARCA: el worker es otro proceso.
//   * PIN (SEC-59, 20270124100000): trg_sale_returns_supervisor corre BEFORE
//     INSERT y BEFORE UPDATE OF total. La cabecera entra con total 0 (no
//     evalúa) y la política 'sale_return' se evalúa una sola vez cuando el
//     UPDATE fija el total real: 'supervisor_required:sale_return' sin token,
//     'supervisor_token_invalid' con un token de monto menor. Antes del arreglo
//     sólo corría en el INSERT (total 0) y con umbral > 0 nunca pedía PIN.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
// Crea negocios, ventas y devoluciones: sólo contra un Supabase local.
const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(URL_ ?? "");
const enabled = Boolean(URL_ && ANON && SERVICE && isLocal);

const STAMP = `ops22-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

// ---------------------------------------------------------------------------
// Escenario
// ---------------------------------------------------------------------------
const OPENING = 5_000;
const OPENING_2 = 2_000;
// chicle: devolución por debajo del umbral de PIN (caso 7d).
const PRICES = { yerba: 1000, galletitas: 1500, chicle: 200 } as const;
type Prod = keyof typeof PRICES;
const PIN_THRESHOLD = 500;

// ---------------------------------------------------------------------------
// Infra
// ---------------------------------------------------------------------------
type RpcRes = { data: unknown; error: { message: string } | null };
const rpc = (
  c: SupabaseClient,
  fn: string,
  args: Record<string, unknown> = {},
) => c.rpc(fn as never, args as never) as unknown as Promise<RpcRes>;
type Row = Record<string, unknown>;
type Sold = {
  id: string;
  number: number;
  item: string;
  product: Prod;
  qty: number;
};

type Ctx = {
  admin: SupabaseClient;
  owner: SupabaseClient;
  ownerId: string;
  cashier: SupabaseClient;
  cashierId: string;
  cashierEmail: string;
  viewer: SupabaseClient;
  otherCashier: SupabaseClient;
  tenant: string;
  tenantB: string;
  store: string;
  register: string;
  customer: string;
  products: Record<Prod, string>;
  shift1: string;
  shift2: string;
  sales: Record<string, Sold>;
  userIds: string[];
};
const ctx = {
  userIds: [] as string[],
  sales: {} as Record<string, Sold>,
} as Ctx;

async function makeUser(
  admin: SupabaseClient,
  email: string,
  tenantId: string,
  role: string,
) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    app_metadata: { current_tenant_id: tenantId },
  });
  if (error) throw error;
  const id = data.user!.id;
  await admin
    .from("users")
    .upsert({ id, email, full_name: email.split("@")[0] });
  const { error: tuErr } = await admin
    .from("tenant_users")
    .insert({ tenant_id: tenantId, user_id: id, role, status: "active" });
  if (tuErr) throw tuErr;
  const client = createClient(URL_!, ANON!, {
    auth: { persistSession: false },
  });
  const { error: sErr } = await client.auth.signInWithPassword({
    email,
    password: PASSWORD,
  });
  if (sErr) throw sErr;
  return { id, client };
}

async function rowsOf(table: string, col: string, value: string) {
  const { data, error } = await ctx.admin
    .from(table as never)
    .select("*")
    .eq(col, value);
  if (error) throw new Error(`${table}: ${error.message}`);
  return (data ?? []) as unknown as Row[];
}

async function stockOf(p: Prod) {
  const { data, error } = await ctx.admin
    .from("products")
    .select("stock")
    .eq("id", ctx.products[p])
    .single();
  if (error) throw error;
  return Number((data as unknown as { stock: number }).stock);
}

async function returnedQty(sold: Sold) {
  const [it] = await rowsOf("sale_items", "id", sold.item);
  return Number(it!.returned_qty ?? 0);
}

type Move = { type: string; payment_method: string | null; amount: number };

/** Movimientos de caja del turno (tipo, medio y monto). */
async function movesOf(shift: string): Promise<Move[]> {
  const rows = await rowsOf("cash_movements", "cash_shift_id", shift);
  return rows.map((m) => ({
    type: String(m.type),
    payment_method: (m.payment_method as string | null) ?? null,
    amount: Number(m.amount),
  }));
}

/** Efectivo del turno según sus movimientos (sin la apertura). */
async function cashNetOf(shift: string) {
  const sign: Record<string, number> = {
    sale: 1,
    income: 1,
    sale_void: -1,
    expense: -1,
  };
  return (await movesOf(shift))
    .filter((m) => m.type !== "sale" || m.payment_method === "cash")
    .reduce((a, m) => a + (sign[m.type] ?? 0) * m.amount, 0);
}

async function returnsOf(sold: Sold) {
  return rowsOf("sale_returns", "sale_id", sold.id);
}

/** Lo que una devolución rechazada no tiene que haber tocado. */
async function snapshot(sold: Sold, shift: string) {
  return {
    stock: await stockOf(sold.product),
    returned: await returnedQty(sold),
    returns: (await returnsOf(sold)).length,
    moves: (await movesOf(shift)).length,
    cash: await cashNetOf(shift),
  };
}

async function sell(key: string, p: Prod, qty: number) {
  const r = await rpc(ctx.cashier, "create_sale", {
    p_items: [
      {
        product_id: ctx.products[p],
        quantity: qty,
        unit_price: PRICES[p],
        discount: 0,
      },
    ],
    p_payments: [{ method: "cash", amount: PRICES[p] * qty }],
  });
  if (r.error) throw new Error(`create_sale ${key}: ${r.error.message}`);
  const res = r.data as { sale_id: string; number: number };
  const items = await rowsOf("sale_items", "sale_id", res.sale_id);
  expect(items, key).toHaveLength(1);
  const sold: Sold = {
    id: res.sale_id,
    number: Number(res.number),
    item: items[0]!.id as string,
    product: p,
    qty,
  };
  ctx.sales[key] = sold;
  return sold;
}

const giveBack = (
  c: SupabaseClient,
  sold: Sold,
  qty: number,
  extra: Record<string, unknown> = {},
) =>
  rpc(c, "return_sale_v2", {
    p_sale_id: sold.id,
    p_items: [{ sale_item_id: sold.item, quantity: qty }],
    p_refund: "cash",
    ...extra,
  });

describe.skipIf(!enabled)("OPS-22 · flujo de devoluciones", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, {
      auth: { persistSession: false },
    });
    ctx.admin = admin;

    const { data: t, error: tErr } = await admin
      .from("tenants")
      .insert([
        { name: `OPS22 ${STAMP}`, slug: `ops22-${STAMP}`, status: "active" },
        { name: `OPS22 B ${STAMP}`, slug: `ops22b-${STAMP}`, status: "active" },
      ])
      .select("id, slug");
    if (tErr || !t) throw tErr ?? new Error("tenants");
    const trows = t as { id: string; slug: string }[];
    ctx.tenant = trows.find((x) => x.slug === `ops22-${STAMP}`)!.id;
    ctx.tenantB = trows.find((x) => x.slug === `ops22b-${STAMP}`)!.id;

    // Facturación ARCA para el caso 4 (sólo la feature: se prende en el caso).
    const { error: addonErr } = await admin.from("subscription_addons").insert({
      tenant_id: ctx.tenant,
      addon_key: "facturacion_afip",
      status: "active",
      source: "granted",
    });
    if (addonErr) throw addonErr;

    const owner = await makeUser(
      admin,
      `owner-${STAMP}@test.local`,
      ctx.tenant,
      "owner",
    );
    const cashier = await makeUser(
      admin,
      `caj-${STAMP}@test.local`,
      ctx.tenant,
      "cashier",
    );
    const viewer = await makeUser(
      admin,
      `ver-${STAMP}@test.local`,
      ctx.tenant,
      "viewer",
    );
    const other = await makeUser(
      admin,
      `cajb-${STAMP}@test.local`,
      ctx.tenantB,
      "cashier",
    );
    ctx.owner = owner.client;
    ctx.ownerId = owner.id;
    ctx.cashier = cashier.client;
    ctx.cashierId = cashier.id;
    ctx.cashierEmail = `caj-${STAMP}@test.local`;
    ctx.viewer = viewer.client;
    ctx.otherCashier = other.client;
    ctx.userIds.push(owner.id, cashier.id, viewer.id, other.id);

    // Punto de venta 3: lo usa la factura del caso 4 (sin ARCA prendido no hace nada).
    const st = await ctx.owner
      .from("stores")
      .insert({ name: "Centro", afip_pos_number: 3 } as never)
      .select("id")
      .single();
    if (st.error || !st.data) throw st.error ?? new Error("store");
    ctx.store = (st.data as unknown as { id: string }).id;

    const reg = await ctx.owner
      .from("cash_registers")
      .insert({ store_id: ctx.store, name: "Caja 1" } as never)
      .select("id")
      .single();
    if (reg.error || !reg.data) throw reg.error ?? new Error("register");
    ctx.register = (reg.data as unknown as { id: string }).id;

    const ps = await admin
      .from("pos_settings")
      .upsert({ tenant_id: ctx.tenant, allow_negative_stock: true } as never, {
        onConflict: "tenant_id",
      });
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
      (Object.keys(PRICES) as Prod[]).map((p) => [
        p,
        prows.find((r) => r.name.startsWith(`${p} `))!.id,
      ]),
    ) as Record<Prod, string>;

    const cu = await admin
      .from("customers")
      .insert({ tenant_id: ctx.tenant, name: `Cliente ${STAMP}` } as never)
      .select("id")
      .single();
    if (cu.error || !cu.data) throw cu.error ?? new Error("customer");
    ctx.customer = (cu.data as unknown as { id: string }).id;

    // El cajero abre su turno: vende y devuelve en él.
    const sh = await rpc(ctx.cashier, "open_cash_shift", {
      p_register_id: ctx.register,
      p_opening_amount: OPENING,
    });
    if (sh.error) throw new Error(sh.error.message);
    ctx.shift1 = sh.data as string;
  }, 120_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin || !ctx.tenant) return;
    for (const tenant of [ctx.tenant, ctx.tenantB]) {
      await admin.from("subscription_addons").delete().eq("tenant_id", tenant);
      await admin.from("security_settings").delete().eq("tenant_id", tenant);
      // audit_logs es inmutable (ADR-083): si el negocio no se puede borrar
      // por sus auditorías, queda (datos de prueba con sello único).
      await admin.from("tenants").delete().eq("id", tenant);
    }
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("1. devolución parcial en efectivo: egreso en el turno, stock repuesto y auditoría", async () => {
    const sold = await sell("parcial", "yerba", 3);
    const stockSold = await stockOf("yerba");
    expect(stockSold).toBe(100 - 3);
    const cashBefore = await cashNetOf(ctx.shift1);
    expect(cashBefore).toBe(3 * PRICES.yerba);

    const r = await giveBack(ctx.cashier, sold, 1, {
      p_cash_shift_id: ctx.shift1,
    });
    expect(r.error).toBeNull();
    const res = r.data as Row;
    expect(res).toMatchObject({ refund: "cash", stock_destination: "resale" });
    expect(Number(res.total)).toBe(PRICES.yerba);
    expect(Number(res.cash_refund)).toBe(PRICES.yerba);
    expect(Number(res.account_credited)).toBe(0);
    const ret = res.return_id as string;

    const [row] = await rowsOf("sale_returns", "id", ret);
    expect(row).toMatchObject({
      tenant_id: ctx.tenant,
      sale_id: sold.id,
      refund_method: "cash",
    });
    expect(Number(row!.total)).toBe(PRICES.yerba);
    const [line] = await rowsOf("sale_return_items", "return_id", ret);
    expect(line).toMatchObject({
      sale_item_id: sold.item,
      product_id: ctx.products.yerba,
      restock: "stock",
    });
    expect(Number(line!.quantity)).toBe(1);
    expect(await returnedQty(sold)).toBe(1);
    // La venta sigue completada: la devolución no la anula.
    const [sale] = await rowsOf("sales", "id", sold.id);
    expect(sale!.status).toBe("completed");

    // Stock: vuelve la unidad, con su movimiento atado a la devolución.
    expect(await stockOf("yerba")).toBe(stockSold + 1);
    const sm = await rowsOf("stock_movements", "reference_id", ret);
    expect(
      sm.map((m) => [m.product_id, m.reason, Number(m.delta), m.store_id]),
    ).toEqual([[ctx.products.yerba, "return", 1, ctx.store]]);

    // Caja: un egreso en efectivo en el turno del cajero.
    const cash = await rowsOf("cash_movements", "reference_id", ret);
    expect(cash).toHaveLength(1);
    expect(cash[0]).toMatchObject({
      tenant_id: ctx.tenant,
      cash_shift_id: ctx.shift1,
      type: "expense",
      payment_method: "cash",
      reason: `Devolución venta #${sold.number}`,
    });
    expect(Number(cash[0]!.amount)).toBe(PRICES.yerba);
    expect(await cashNetOf(ctx.shift1)).toBe(cashBefore - PRICES.yerba);

    // Auditoría: alta de la devolución y reingreso de stock, con el cajero de actor.
    const { data: logs, error } = await ctx.admin
      .from("audit_logs")
      .select("action, entity_type, entity_id, actor_user_id, after_data")
      .eq("tenant_id", ctx.tenant)
      .in("action", ["return_created", "return_restock"]);
    expect(error).toBeNull();
    const audit = (logs ?? []) as unknown as {
      action: string;
      entity_type: string;
      entity_id: string;
      actor_user_id: string;
      after_data: Row;
    }[];
    const created = audit.filter(
      (a) => a.action === "return_created" && a.entity_id === ret,
    );
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      entity_type: "sale_returns",
      actor_user_id: ctx.cashierId,
    });
    expect(created[0]!.after_data).toMatchObject({
      sale_id: sold.id,
      refund: "cash",
      stock_destination: "resale",
    });
    expect(Number(created[0]!.after_data.total)).toBe(PRICES.yerba);
    const restock = audit.filter(
      (a) => a.action === "return_restock" && a.after_data.return_id === ret,
    );
    expect(restock).toHaveLength(1);
    expect(restock[0]).toMatchObject({
      entity_type: "stock_movements",
      entity_id: ctx.products.yerba,
      actor_user_id: ctx.cashierId,
    });
    expect(Number(restock[0]!.after_data.qty)).toBe(1);
  });

  it("2. devolución total; no se devuelve más de lo vendido (ni de una vez ni en dos)", async () => {
    const sold = await sell("total", "galletitas", 2);
    const before = await snapshot(sold, ctx.shift1);
    expect(before.stock).toBe(100 - 2);

    // De una vez: 3 de 2.
    const over = await giveBack(ctx.cashier, sold, 3);
    expect(over.error?.message).toMatch(/qty_exceeds/);
    // La misma línea repetida en el pedido (1 + 2 > 2) tampoco pasa.
    const dup = await rpc(ctx.cashier, "return_sale_v2", {
      p_sale_id: sold.id,
      p_items: [
        { sale_item_id: sold.item, quantity: 1 },
        { sale_item_id: sold.item, quantity: 2 },
      ],
      p_refund: "cash",
    });
    expect(dup.error?.message).toMatch(/qty_exceeds/);
    // Nada quedó a medias: la RPC es una transacción.
    expect(await snapshot(sold, ctx.shift1)).toEqual(before);

    // Total.
    const r = await giveBack(ctx.cashier, sold, 2);
    expect(r.error).toBeNull();
    const total = 2 * PRICES.galletitas;
    expect(Number((r.data as Row).total)).toBe(total);
    expect(Number((r.data as Row).cash_refund)).toBe(total);
    const ret = (r.data as Row).return_id as string;
    expect(await stockOf("galletitas")).toBe(before.stock + 2);
    expect(await returnedQty(sold)).toBe(2);
    const cash = await rowsOf("cash_movements", "reference_id", ret);
    expect(
      cash.map((m) => [
        m.cash_shift_id,
        m.type,
        m.payment_method,
        Number(m.amount),
      ]),
    ).toEqual([[ctx.shift1, "expense", "cash", total]]);
    expect(await cashNetOf(ctx.shift1)).toBe(before.cash - total);
    const [sale] = await rowsOf("sales", "id", sold.id);
    expect(sale!.status).toBe("completed");

    // Segunda devolución sobre la misma línea: rechazada, sin efectos.
    const after = await snapshot(sold, ctx.shift1);
    const again = await giveBack(ctx.cashier, sold, 1);
    expect(again.error?.message).toMatch(/qty_exceeds/);
    expect(await snapshot(sold, ctx.shift1)).toEqual(after);
    expect(after.returns).toBe(1);
  });

  it("3. con el turno de la venta cerrado, el egreso va al turno abierto actual", async () => {
    const sold = await sell("turno-cerrado", "yerba", 1);
    const [sale] = await rowsOf("sales", "id", sold.id);
    expect(sale!.cash_shift_id).toBe(ctx.shift1);

    // Esperado del turno 1: apertura + ventas en efectivo − devoluciones
    // (casos 1 y 2: 3.000 − 1.000 + 3.000 − 3.000; este: + 1.000).
    const expected =
      OPENING +
      3 * PRICES.yerba -
      PRICES.yerba +
      2 * PRICES.galletitas -
      2 * PRICES.galletitas +
      PRICES.yerba;
    expect(OPENING + (await cashNetOf(ctx.shift1))).toBe(expected);
    const close = await rpc(ctx.cashier, "close_cash_shift", {
      p_shift_id: ctx.shift1,
      p_closing_amount: expected,
    });
    expect(close.error).toBeNull();
    expect(Number(close.data)).toBe(0);
    const [closed] = await rowsOf("cash_shifts", "id", ctx.shift1);
    expect(closed!.status).toBe("closed");
    expect(Number(closed!.expected_amount)).toBe(expected);
    const shift1Moves = (await movesOf(ctx.shift1)).length;

    // Sin turno abierto, en efectivo no se puede devolver.
    const stock0 = await stockOf("yerba");
    const noShift = await giveBack(ctx.cashier, sold, 1);
    expect(noShift.error?.message).toMatch(/no_open_shift/);

    const sh = await rpc(ctx.cashier, "open_cash_shift", {
      p_register_id: ctx.register,
      p_opening_amount: OPENING_2,
    });
    expect(sh.error).toBeNull();
    ctx.shift2 = sh.data as string;

    // Pedir el turno cerrado a mano tampoco.
    const explicitClosed = await giveBack(ctx.cashier, sold, 1, {
      p_cash_shift_id: ctx.shift1,
    });
    expect(explicitClosed.error?.message).toMatch(/shift_not_open/);
    expect(await stockOf("yerba")).toBe(stock0);
    expect(await returnsOf(sold)).toHaveLength(0);

    // Sin turno explícito: el abierto del cajero.
    const r = await giveBack(ctx.cashier, sold, 1);
    expect(r.error).toBeNull();
    const ret = (r.data as Row).return_id as string;
    const cash = await rowsOf("cash_movements", "reference_id", ret);
    expect(
      cash.map((m) => [
        m.cash_shift_id,
        m.type,
        m.payment_method,
        Number(m.amount),
      ]),
    ).toEqual([[ctx.shift2, "expense", "cash", PRICES.yerba]]);
    // El turno cerrado no se toca; el abierto queda en apertura − devolución.
    expect(await movesOf(ctx.shift1)).toHaveLength(shift1Moves);
    expect(OPENING + (await cashNetOf(ctx.shift1))).toBe(expected);
    expect(OPENING_2 + (await cashNetOf(ctx.shift2))).toBe(
      OPENING_2 - PRICES.yerba,
    );
    expect(await stockOf("yerba")).toBe(stock0 + 1);
    const sm = await rowsOf("stock_movements", "reference_id", ret);
    expect(sm.map((m) => [m.reason, Number(m.delta), m.store_id])).toEqual([
      ["return", 1, ctx.store],
    ]);
  });

  it("4. NC fiscal: con ARCA en homologación y la venta facturada, la devolución encola la nota de crédito", async () => {
    // Contexto ARCA mínimo, sin certificados (no se llama a ARCA): IVA y CUIT
    // del negocio, ARCA prendido en homologación desde siempre y punto de
    // venta 3 en la sucursal (beforeAll).
    const tax = await rpc(ctx.owner, "tax_settings_save", {
      p: { iva_condition: "responsable_inscripto", cuit: "30-50000000-3" },
    });
    expect(tax.error).toBeNull();
    const arca = await ctx.admin.from("arca_settings").upsert(
      {
        tenant_id: ctx.tenant,
        enabled: true,
        environment: "homologacion",
        start_at: "2000-01-01T00:00:00Z",
      } as never,
      { onConflict: "tenant_id" },
    );
    expect(arca.error).toBeNull();

    const sold = await sell("fiscal", "yerba", 2);
    const docs = (await rowsOf("fiscal_documents", "sale_id", sold.id)).filter(
      (d) => d.origin === "sale",
    );
    expect(docs).toHaveLength(1);
    const invoice = docs[0]!;
    expect(invoice).toMatchObject({
      environment: "homologacion",
      cbte_letter: "B",
      pto_vta: 3,
      status: "pendiente",
    });
    // "Factura emitida": se aprueba a mano (lo haría el worker con la respuesta de ARCA).
    const ok = await ctx.admin
      .from("fiscal_documents")
      .update({
        status: "aprobado",
        cbte_nro: 1,
        cbte_fch: "2026-11-17",
        cae: "76412345678901",
        cae_vto: "2026-11-27",
      } as never)
      .eq("id", invoice.id as string);
    expect(ok.error).toBeNull();

    const stock0 = await stockOf("yerba");
    const cash0 = await cashNetOf(ctx.shift2);
    const r = await giveBack(ctx.cashier, sold, 1);
    expect(r.error).toBeNull();
    const ret = (r.data as Row).return_id as string;
    expect(Number((r.data as Row).total)).toBe(PRICES.yerba);

    // La fila de la NC existe en la cola (pendiente, asociada a la factura).
    const nc = await rowsOf("fiscal_documents", "return_id", ret);
    expect(nc).toHaveLength(1);
    expect(nc[0]).toMatchObject({
      tenant_id: ctx.tenant,
      sale_id: sold.id,
      origin: "return",
      assoc_document_id: invoice.id,
      environment: "homologacion",
      cbte_letter: "B",
      cbte_tipo: 8,
      pto_vta: 3,
      status: "pendiente",
      cbte_nro: null,
      cae: null,
    });
    // El total se completa después de los renglones (UPDATE of total).
    expect(Number(nc[0]!.imp_total)).toBe(PRICES.yerba);

    expect(await stockOf("yerba")).toBe(stock0 + 1);
    const cash = await rowsOf("cash_movements", "reference_id", ret);
    expect(
      cash.map((m) => [m.cash_shift_id, m.type, Number(m.amount)]),
    ).toEqual([[ctx.shift2, "expense", PRICES.yerba]]);
    expect(await cashNetOf(ctx.shift2)).toBe(cash0 - PRICES.yerba);
  });

  it("5. el cajero de otro negocio no puede devolver la venta", async () => {
    const sold = ctx.sales.parcial!;
    const before = await snapshot(sold, ctx.shift2);
    const r = await giveBack(ctx.otherCashier, sold, 1);
    expect(r.error?.message).toMatch(/sale_not_found/);
    const credit = await giveBack(ctx.otherCashier, sold, 1, {
      p_refund: "store_credit",
      p_customer_id: ctx.customer,
    });
    expect(credit.error?.message).toMatch(/sale_not_found/);
    expect(await snapshot(sold, ctx.shift2)).toEqual(before);
  });

  it("6. el viewer (sólo lectura) no puede devolver", async () => {
    const sold = ctx.sales.parcial!;
    const before = await snapshot(sold, ctx.shift2);
    // En efectivo no tiene turno propio: el del cajero no es suyo.
    const cash = await giveBack(ctx.viewer, sold, 1, {
      p_cash_shift_id: ctx.shift2,
    });
    expect(cash.error?.message).toMatch(/shift_not_owned|store_not_allowed/);
    const noShift = await giveBack(ctx.viewer, sold, 1);
    expect(noShift.error?.message).toMatch(/no_open_shift/);
    // Con vale (no pide turno) llega al alta y la frena la guarda de rol.
    const credit = await giveBack(ctx.viewer, sold, 1, {
      p_refund: "store_credit",
      p_customer_id: ctx.customer,
    });
    expect(credit.error?.message).toMatch(/forbidden_read_only/);
    expect(await snapshot(sold, ctx.shift2)).toEqual(before);
    const { data: vouchers } = await ctx.admin
      .from("store_credit_vouchers")
      .select("id")
      .eq("tenant_id", ctx.tenant);
    expect(vouchers ?? []).toHaveLength(0);
  });

  it("7a. el dueño pide PIN de supervisor para devoluciones desde $500", async () => {
    const save = await rpc(ctx.owner, "security_settings_save", {
      p: {
        pin_policy: {
          sale_return: { enabled: true, threshold: PIN_THRESHOLD },
        },
      },
    });
    expect(save.error).toBeNull();
    const { data } = await ctx.admin
      .from("security_settings")
      .select("pin_policy")
      .eq("tenant_id", ctx.tenant)
      .single();
    expect(
      (data as unknown as { pin_policy: Row }).pin_policy.sale_return,
    ).toMatchObject({
      enabled: true,
      threshold: PIN_THRESHOLD,
    });
  });

  // SEC-59: antes el trigger corría sólo en el INSERT (total 0) y con umbral
  // > 0 nunca pedía PIN. Ahora se evalúa cuando el UPDATE fija el total real.
  it("7b. una devolución de $1.000 sin PIN de supervisor se rechaza sin efectos", async () => {
    const sold = ctx.sales.parcial!;
    const before = await snapshot(sold, ctx.shift2);
    const r = await giveBack(ctx.cashier, sold, 1);
    expect(r.error?.message).toMatch(/supervisor_required:sale_return/);
    expect(await snapshot(sold, ctx.shift2)).toEqual(before);
  });

  it("7c. con un token de supervisor la devolución pasa; un token de monto menor no alcanza", async () => {
    const sold = ctx.sales.parcial!;
    const mint = async (amount: number) => {
      const { data, error } = await ctx.admin
        .from("supervisor_auth_tokens")
        .insert({
          tenant_id: ctx.tenant,
          action: "sale_return",
          supervisor_id: ctx.ownerId,
          requested_by: ctx.cashierId,
          reason: "Devolución autorizada",
          amount,
          expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
        } as never)
        .select("id")
        .single();
      if (error || !data) throw error ?? new Error("token");
      return (data as unknown as { id: string }).id;
    };
    const withToken = async (token: string) => {
      const client = createClient(URL_!, ANON!, {
        auth: { persistSession: false },
        global: { headers: { "x-ninja-supervisor-token": token } },
      });
      const { error } = await client.auth.signInWithPassword({
        email: ctx.cashierEmail,
        password: PASSWORD,
      });
      if (error) throw error;
      return client;
    };

    // El token queda atado al monto: uno de $500 no cubre $1.000.
    const before = await snapshot(sold, ctx.shift2);
    const low = await giveBack(await withToken(await mint(PIN_THRESHOLD)), sold, 1);
    expect(low.error?.message).toMatch(/supervisor_token_invalid/);
    expect(await snapshot(sold, ctx.shift2)).toEqual(before);

    const token = await mint(PRICES.yerba);
    const r = await giveBack(await withToken(token), sold, 1);
    expect(r.error).toBeNull();
    const ret = (r.data as Row).return_id as string;
    expect(Number((r.data as Row).total)).toBe(PRICES.yerba);
    const after = await snapshot(sold, ctx.shift2);
    expect(after).toMatchObject({
      stock: before.stock + 1,
      returned: before.returned + 1,
      returns: before.returns + 1,
      cash: before.cash - PRICES.yerba,
    });

    // Se consumió una sola vez, con la venta de referencia, y quedó auditado.
    const [tok] = await rowsOf("supervisor_auth_tokens", "id", token);
    expect(tok!.consumed_at).not.toBeNull();
    expect(tok!.consumed_ref).toBe(sold.id);
    const { data: used } = await ctx.admin
      .from("audit_logs")
      .select("after_data")
      .eq("tenant_id", ctx.tenant)
      .eq("action", "supervisor_override_used");
    const mine = ((used ?? []) as unknown as { after_data: Row }[]).filter(
      (u) => u.after_data.token_id === token,
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]!.after_data).toMatchObject({
      pin_action: "sale_return",
      ref_id: sold.id,
    });
    expect(Number(mine[0]!.after_data.amount)).toBe(PRICES.yerba);
    const [row] = await rowsOf("sale_returns", "id", ret);
    expect(Number(row!.total)).toBe(PRICES.yerba);
  });

  it("7d. una devolución por debajo del umbral no pide PIN", async () => {
    const sold = await sell("bajo-umbral", "chicle", 1);
    const before = await snapshot(sold, ctx.shift2);
    const r = await giveBack(ctx.cashier, sold, 1);
    expect(r.error).toBeNull();
    expect(Number((r.data as Row).total)).toBe(PRICES.chicle);
    expect(await snapshot(sold, ctx.shift2)).toMatchObject({
      returned: before.returned + 1,
      returns: before.returns + 1,
      cash: before.cash - PRICES.chicle,
    });
  });
});
