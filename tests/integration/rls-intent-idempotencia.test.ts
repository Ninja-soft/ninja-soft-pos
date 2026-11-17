// @vitest-environment node
// =============================================================================
// PAY-08 · Idempotencia del webhook a nivel base: 5 entregas = 1 venta.
//
// Los proveedores reintentan el webhook (y el sondeo de la Edge pisa lo mismo):
// la misma acreditación llega varias veces, a veces a la vez. Esta suite
// demuestra, contra la base real, que eso deja UNA venta, UN pago, UN
// movimiento de caja y UN movimiento de stock. Sólo tests: no cambia ninguna
// RPC ni migración.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea datos (guard de host local,
// igual que flujo-venta-caja-z). audit_logs es inmutable (ADR-083): el cleanup
// no la toca.
//
// Contratos reales (leídos de las migraciones, no se cambian acá):
//   * Webhooks (mobbex_webhook, modo_webhook): update del intent con service_role
//     y `.neq("status", "approved")` para acreditar; `.eq("status", "pending")`
//     para rechazar / vencer (mobbex). _mp_intent_transition (PAY-28,
//     20270127100000) hace lo mismo para Mercado Pago: p_only_pending=false →
//     status <> 'approved'; true → status = 'pending'. Devuelve true si cambió.
//   * Transición rejected → approved: PERMITIDA (status <> 'approved' la deja
//     pasar; no hay trigger que la frene). approved → rejected: NO (el rechazo
//     sólo mueve un intent pending). Un intent acreditado no vuelve atrás.
//   * create_sale (última definición: 20270123100000_sec43_create_sale_idempotency)
//     con un pago {method:'qr', reference:<intent uuid>}: busca el intent del
//     NEGOCIO ACTUAL; si no está approved → 'qr_not_approved'; si ya tiene
//     sale_id o un pago qr de este negocio ya lo referencia → 'qr_already_charged'
//     (ambos RAISE sin errcode → SQLSTATE P0001). Al grabar ancla
//     mp_payment_intents.sale_id. Red de seguridad por carrera: índice único
//     payments_qr_reference_uniq (tenant_id, reference) where method='qr'
//     → 23505 si dos create_sale pasan el chequeo a la vez.
//   * Cobros en espera (ADR-048): trigger AFTER UPDATE OF status en
//     mp_payment_intents (sólo si el status cambió) → _pc_complete (lock de la
//     fila del cobro y del intent; un cobro completado devuelve su venta).
//     complete_pending_charge (POS / "Reintentar") llama al mismo _pc_complete.
//     pending_charges_intent_uidx: un intent, un cobro.
//   * Intent de OTRO negocio en create_sale: la búsqueda filtra por tenant, así
//     que no "se encuentra"; la línea se trata como QR SIN intent (como la de
//     "dividir cuenta"): con alguna feature de QR en el plan se graba, sin
//     anclar ni tocar el intent ajeno (que sigue cobrable una vez por su dueño).
//     Sin feature de QR → 'qr_not_allowed'. El otro negocio tampoco lo ve por
//     RLS (mpi_select) ni lo puede escribir.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
// Crea negocios, ventas y cobros: sólo contra un Supabase local.
const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(URL_ ?? "");
const enabled = Boolean(URL_ && ANON && SERVICE && isLocal);

const STAMP = `pay08-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";
const PRICE = 1000;
const DELIVERIES = 5;

type Shop = {
  tenant: string;
  owner: SupabaseClient;
  ownerId: string;
  shift: string;
  product: string;
};
type Ctx = { admin: SupabaseClient; a: Shop; b: Shop; userIds: string[] };
const ctx = { userIds: [] as string[] } as unknown as Ctx;

type Row = Record<string, unknown>;
type RpcErr = { message: string; code?: string };
type RpcRes = { data: unknown; error: RpcErr | null };
const rpc = (
  c: SupabaseClient,
  fn: string,
  args: Record<string, unknown> = {},
) => c.rpc(fn as never, args as never) as unknown as Promise<RpcRes>;
const obj = (r: RpcRes) => r.data as Row;

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

/** Negocio con dueño, sucursal, caja, turno abierto del dueño y un producto con stock. */
async function makeShop(
  admin: SupabaseClient,
  tag: string,
  addons: string[],
): Promise<Shop> {
  const { data: t, error: tErr } = await admin
    .from("tenants")
    .insert({
      name: `PAY08 ${tag} ${STAMP}`,
      slug: `${tag}-${STAMP}`,
      status: "active",
    })
    .select("id")
    .single();
  if (tErr || !t) throw tErr ?? new Error("tenant");
  const tenant = (t as { id: string }).id;

  const { error: addonErr } = await admin
    .from("subscription_addons")
    .insert(
      addons.map((key) => ({
        tenant_id: tenant,
        addon_key: key,
        status: "active",
        source: "granted",
      })),
    );
  if (addonErr) throw addonErr;

  const owner = await makeUser(
    admin,
    `pay08-owner-${tag}-${STAMP}@test.local`,
    tenant,
    "owner",
  );
  ctx.userIds.push(owner.id);

  const st = await admin
    .from("stores")
    .insert({
      tenant_id: tenant,
      name: `Local ${tag} ${STAMP}`,
      is_default: true,
    } as never)
    .select("id")
    .single();
  if (st.error || !st.data) throw st.error ?? new Error("store");
  const store = (st.data as unknown as { id: string }).id;

  const reg = await admin
    .from("cash_registers")
    .insert({
      tenant_id: tenant,
      store_id: store,
      name: `Caja ${tag} ${STAMP}`,
    } as never)
    .select("id")
    .single();
  if (reg.error || !reg.data) throw reg.error ?? new Error("caja");

  const pr = await admin
    .from("products")
    .insert({
      tenant_id: tenant,
      name: `Yerba ${tag} ${STAMP}`,
      price: PRICE,
      cost: 500,
      stock: 100,
    } as never)
    .select("id")
    .single();
  if (pr.error || !pr.data) throw pr.error ?? new Error("product");

  const sh = await rpc(owner.client, "open_cash_shift", {
    p_register_id: (reg.data as unknown as { id: string }).id,
    p_opening_amount: 0,
  });
  if (sh.error) throw new Error(sh.error.message);

  return {
    tenant,
    owner: owner.client,
    ownerId: owner.id,
    shift: sh.data as string,
    product: (pr.data as unknown as { id: string }).id,
  };
}

// ---------------------------------------------------------------------------
// Proveedor simulado (service_role, igual que las Edges)
// ---------------------------------------------------------------------------
async function newIntent(shop: Shop, amount = PRICE): Promise<string> {
  const { data, error } = await ctx.admin
    .from("mp_payment_intents")
    .insert({
      tenant_id: shop.tenant,
      amount,
      provider_key: "pagos360",
    } as never)
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("intent");
  return (data as unknown as { id: string }).id;
}

/** Entrega "approved" como mobbex_webhook / modo_webhook: `.neq("status","approved")`. Filas cambiadas. */
async function webhookApproved(
  intent: string,
  delivery: number,
): Promise<number> {
  const { data, error } = await ctx.admin
    .from("mp_payment_intents")
    .update({
      status: "approved",
      mp_payment_id: `op-${STAMP}-${delivery}`,
    } as never)
    .eq("id", intent)
    .neq("status", "approved")
    .select("id");
  if (error) throw error;
  return (data ?? []).length;
}

/** Entrega "rejected" como mobbex_webhook: sólo mueve un intent pending. Filas cambiadas. */
async function webhookRejected(intent: string): Promise<number> {
  const { data, error } = await ctx.admin
    .from("mp_payment_intents")
    .update({ status: "rejected" } as never)
    .eq("id", intent)
    .eq("status", "pending")
    .select("id");
  if (error) throw error;
  return (data ?? []).length;
}

/** Entrega por la RPC de PAY-28 (camino de Mercado Pago). */
async function mpTransition(
  intent: string,
  status: string,
  onlyPending: boolean,
  delivery: number,
) {
  const r = await rpc(ctx.admin, "_mp_intent_transition", {
    p_intent: intent,
    p_status: status,
    p_mp_payment_id: `mp-${STAMP}-${delivery}`,
    p_only_pending: onlyPending,
  });
  if (r.error) throw new Error(r.error.message);
  return r.data as boolean;
}

const times = <T>(n: number, f: (i: number) => Promise<T>) =>
  Promise.all(Array.from({ length: n }, (_, i) => f(i)));

// ---------------------------------------------------------------------------
// POS y lecturas
// ---------------------------------------------------------------------------
const sellQr = (shop: Shop, intent: string, amount = PRICE) =>
  rpc(shop.owner, "create_sale", {
    p_items: [
      { product_id: shop.product, quantity: 1, unit_price: PRICE, discount: 0 },
    ],
    p_payments: [{ method: "qr", amount, reference: intent }],
    p_cash_shift_id: shop.shift,
  });

async function park(shop: Shop, intent: string): Promise<string> {
  const r = await rpc(shop.owner, "park_pending_charge", {
    p_intent_id: intent,
    p_sale: {
      items: [
        {
          product_id: shop.product,
          quantity: 1,
          unit_price: PRICE,
          discount: 0,
        },
      ],
      extras: [],
      discount_total: 0,
    },
    p_cart: { lines: [] },
    p_lines: [
      {
        name: "Yerba",
        quantity: 1,
        unit_price: PRICE,
        discount: 0,
        subtotal: PRICE,
      },
    ],
    p_cash_shift_id: shop.shift,
    p_channel: "link",
    p_share_url: "https://example.com/pay",
    p_expires_minutes: 120,
  });
  if (r.error) throw new Error(r.error.message);
  return obj(r).id as string;
}

async function rows(table: string, filters: Record<string, string>) {
  let q = ctx.admin.from(table as never).select("*");
  for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
  const { data, error } = await q;
  if (error) throw new Error(`${table}: ${error.message}`);
  return (data ?? []) as unknown as Row[];
}

async function one(table: string, id: string): Promise<Row> {
  const [r] = await rows(table, { id });
  if (!r) throw new Error(`${table} ${id} no existe`);
  return r;
}

async function salesCount(shop: Shop): Promise<number> {
  const { count, error } = await ctx.admin
    .from("sales")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", shop.tenant);
  if (error) throw error;
  return count ?? 0;
}

async function stockOf(shop: Shop): Promise<number> {
  return Number((await one("products", shop.product)).stock);
}

type Snap = { sales: number; stock: number };
const snap = async (shop: Shop): Promise<Snap> => ({
  sales: await salesCount(shop),
  stock: await stockOf(shop),
});

/**
 * El intent dejó exactamente UNA venta en el negocio: una venta más, un pago qr
 * que lo referencia, un movimiento de caja 'sale' en el turno, un movimiento
 * de stock y una unidad menos; el intent queda anclado a esa venta.
 */
async function expectOneSale(
  shop: Shop,
  intent: string,
  before: Snap,
): Promise<string> {
  expect(await salesCount(shop)).toBe(before.sales + 1);

  const pays = await rows("payments", {
    tenant_id: shop.tenant,
    method: "qr",
    reference: intent,
  });
  expect(pays).toHaveLength(1);
  const saleId = pays[0]!.sale_id as string;
  expect(Number(pays[0]!.amount)).toBe(PRICE);

  const sale = await one("sales", saleId);
  expect(sale).toMatchObject({
    tenant_id: shop.tenant,
    status: "completed",
    cash_shift_id: shop.shift,
  });
  expect(Number(sale.total)).toBe(PRICE);
  expect(await rows("payments", { sale_id: saleId })).toHaveLength(1);

  const cash = await rows("cash_movements", { reference_id: saleId });
  expect(cash).toHaveLength(1);
  expect(cash[0]).toMatchObject({
    type: "sale",
    payment_method: "qr",
    cash_shift_id: shop.shift,
  });
  expect(Number(cash[0]!.amount)).toBe(PRICE);

  expect(await rows("stock_movements", { reference_id: saleId })).toHaveLength(
    1,
  );
  expect(await stockOf(shop)).toBe(before.stock - 1);

  const i = await one("mp_payment_intents", intent);
  expect(i).toMatchObject({ status: "approved", sale_id: saleId });
  return saleId;
}

describe.skipIf(!enabled)(
  "PAY-08 · idempotencia del webhook: 5 entregas = 1 venta",
  () => {
    beforeAll(async () => {
      ctx.admin = createClient(URL_!, SERVICE!, {
        auth: { persistSession: false },
      });
      // A: QR por Pagos360 + cobros en espera. B: sólo QR (para el caso cruzado).
      ctx.a = await makeShop(ctx.admin, "a", ["pagos360", "cobros_en_espera"]);
      ctx.b = await makeShop(ctx.admin, "b", ["pagos360"]);
    }, 150_000);

    afterAll(async () => {
      const { admin } = ctx;
      if (!admin) return;
      for (const t of [ctx.a?.tenant, ctx.b?.tenant].filter(
        Boolean,
      ) as string[]) {
        await admin
          .from("pending_charge_events" as never)
          .delete()
          .eq("tenant_id", t);
        await admin
          .from("pending_charges" as never)
          .delete()
          .eq("tenant_id", t);
        await admin.from("subscription_addons").delete().eq("tenant_id", t);
        // audit_logs es inmutable (ADR-083): si el negocio no se puede borrar por
        // sus auditorías, queda (datos de prueba con sello único).
        await admin.from("tenants").delete().eq("id", t);
      }
      for (const id of ctx.userIds) {
        await admin.from("users").delete().eq("id", id);
        await admin.auth.admin.deleteUser(id);
      }
    }, 60_000);

    it("1 · pending + 5 'approved' simultáneos: 1 fila cambia; create_sale dos veces → 1 venta", async () => {
      const intent = await newIntent(ctx.a);
      const before = await snap(ctx.a);

      // Antes de acreditarse, el POS no puede cerrar la venta con ese intent.
      const early = await sellQr(ctx.a, intent);
      expect(early.error?.message).toBe("qr_not_approved");

      const changed = await times(DELIVERIES, (n) =>
        webhookApproved(intent, n),
      );
      expect(changed.reduce((s, n) => s + n, 0)).toBe(1);
      // Una entrega tardía más (ya acreditado) tampoco cambia nada.
      expect(await webhookApproved(intent, 99)).toBe(0);
      expect(await mpTransition(intent, "approved", false, 99)).toBe(false);

      const first = await sellQr(ctx.a, intent);
      expect(first.error).toBeNull();
      const again = await sellQr(ctx.a, intent);
      // Código real: RAISE 'qr_already_charged' sin errcode → SQLSTATE P0001.
      expect(again.error?.message).toBe("qr_already_charged");
      expect(again.error?.code).toBe("P0001");

      const saleId = await expectOneSale(ctx.a, intent, before);
      expect(saleId).toBe(obj(first).sale_id);
    });

    it("1b · cinco create_sale simultáneos con el mismo intent → 1 venta (los demás, error legible)", async () => {
      const intent = await newIntent(ctx.a);
      expect(await webhookApproved(intent, 0)).toBe(1);
      const before = await snap(ctx.a);

      const res = await times(DELIVERIES, () => sellQr(ctx.a, intent));
      const ok = res.filter((r) => r.error === null);
      const ko = res.filter((r) => r.error !== null);
      expect(ok).toHaveLength(1);
      expect(ko).toHaveLength(DELIVERIES - 1);
      // Según quién llegue primero: el chequeo del intent (P0001) o, si dos lo
      // pasan a la vez, el índice payments_qr_reference_uniq (23505).
      for (const r of ko) {
        expect(r.error!.message).toMatch(
          /qr_already_charged|payments_qr_reference_uniq/,
        );
      }

      const saleId = await expectOneSale(ctx.a, intent, before);
      expect(saleId).toBe(obj(ok[0]!).sale_id);
    });

    it("2 · cobro en espera: 5 acreditaciones + 5 'Reintentar' → 1 venta del lado del servidor", async () => {
      const intent = await newIntent(ctx.a);
      const chargeId = await park(ctx.a, intent);
      const before = await snap(ctx.a);

      // 5 entregas por la RPC de Mercado Pago (PAY-28): una sola cambia el
      // status, así que el trigger de cobros en espera corre una sola vez.
      const changed = await times(DELIVERIES, (n) =>
        mpTransition(intent, "approved", false, n),
      );
      expect(changed.filter(Boolean)).toHaveLength(1);
      // Y 5 más estilo mobbex/modo: ninguna cambia nada.
      expect(
        (
          await times(DELIVERIES, (n) => webhookApproved(intent, 10 + n))
        ).reduce((s, n) => s + n, 0),
      ).toBe(0);

      const c = await one("pending_charges", chargeId);
      expect(c.status).toBe("completed");
      const saleId = await expectOneSale(ctx.a, intent, before);
      expect(c.sale_id).toBe(saleId);

      // El POS sondea / el cajero aprieta "Reintentar" 5 veces a la vez: todas
      // devuelven la misma venta y no se crea otra.
      const retries = await times(DELIVERIES, () =>
        rpc(ctx.a.owner, "complete_pending_charge", {
          p_id: chargeId,
          p_force: false,
        }),
      );
      for (const r of retries) {
        expect(r.error).toBeNull();
        expect(obj(r)).toMatchObject({ status: "completed", sale_id: saleId });
      }
      // Y el POS tampoco puede volver a cobrarlo por su lado.
      const pos = await sellQr(ctx.a, intent);
      expect(pos.error?.message).toBe("qr_already_charged");

      await expectOneSale(ctx.a, intent, before);
      const done = await rows("pending_charge_events", {
        pending_charge_id: chargeId,
        kind: "completed",
      });
      expect(done).toHaveLength(1);
    });

    it("3 · rejected y después approved (×5): la transición está permitida y acredita una sola vez", async () => {
      const intent = await newIntent(ctx.a);
      const chargeId = await park(ctx.a, intent);
      const before = await snap(ctx.a);

      expect(await webhookRejected(intent)).toBe(1);
      expect((await one("mp_payment_intents", intent)).status).toBe("rejected");
      // El rechazo sólo deja un evento: el cobro sigue esperando, sin venta.
      expect(await one("pending_charges", chargeId)).toMatchObject({
        status: "waiting",
        sale_id: null,
      });
      expect(await salesCount(ctx.a)).toBe(before.sales);

      // Contrato de hoy: rejected → approved PASA (status <> 'approved').
      const changed = await times(DELIVERIES, (n) =>
        webhookApproved(intent, n),
      );
      expect(changed.reduce((s, n) => s + n, 0)).toBe(1);

      expect((await one("pending_charges", chargeId)).status).toBe("completed");
      const saleId = await expectOneSale(ctx.a, intent, before);

      // approved → rejected NO pasa (ni por webhook ni por la RPC de PAY-28).
      expect(await webhookRejected(intent)).toBe(0);
      expect(await mpTransition(intent, "rejected", true, 99)).toBe(false);
      expect(await one("mp_payment_intents", intent)).toMatchObject({
        status: "approved",
        sale_id: saleId,
      });

      // Ni el POS lo vuelve a cobrar.
      expect((await sellQr(ctx.a, intent)).error?.message).toBe(
        "qr_already_charged",
      );
      await expectOneSale(ctx.a, intent, before);
    });

    it("4 · el intent de otro negocio no se puede usar en create_sale", async () => {
      const intent = await newIntent(ctx.a);
      expect(await webhookApproved(intent, 0)).toBe(1);
      const beforeA = await snap(ctx.a);
      const beforeB = await snap(ctx.b);

      // RLS: B no lo ve ni lo escribe.
      const { data: seen } = await ctx.b.owner
        .from("mp_payment_intents")
        .select("id")
        .eq("id", intent);
      expect(seen ?? []).toEqual([]);
      await ctx.b.owner
        .from("mp_payment_intents")
        .update({ status: "cancelled" } as never)
        .eq("id", intent);
      expect((await one("mp_payment_intents", intent)).status).toBe("approved");

      // create_sale de B con el intent de A: la búsqueda es del negocio de B, el
      // intent no aparece y la línea cuenta como QR sin intent (B tiene QR en el
      // plan). Se graba en B SIN anclar ni tocar el intent de A.
      const cross = await sellQr(ctx.b, intent);
      expect(cross.error).toBeNull();
      const crossSale = obj(cross).sale_id as string;
      expect(await one("sales", crossSale)).toMatchObject({
        tenant_id: ctx.b.tenant,
      });
      expect(await salesCount(ctx.b)).toBe(beforeB.sales + 1);
      expect(await one("mp_payment_intents", intent)).toMatchObject({
        tenant_id: ctx.a.tenant,
        sale_id: null,
      });
      expect(await salesCount(ctx.a)).toBe(beforeA.sales);
      expect(await stockOf(ctx.a)).toBe(beforeA.stock);

      // Para A el intent sigue intacto: se cobra una vez, y sólo una.
      const own = await sellQr(ctx.a, intent);
      expect(own.error).toBeNull();
      expect((await sellQr(ctx.a, intent)).error?.message).toBe(
        "qr_already_charged",
      );
      const saleId = await expectOneSale(ctx.a, intent, beforeA);
      expect(saleId).toBe(obj(own).sale_id);
    });
  },
);
