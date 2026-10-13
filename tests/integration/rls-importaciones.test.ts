// @vitest-environment node
// =============================================================================
// Importaciones XLSX (TX-4 · ADR-078, migraciones 20261104100000/100100):
// RPCs import_products / customers / stock / price_lists / stores /
// warranty_plans / return_reasons.
//   • Rol: dueño y encargado importan; el cajero nunca (forbidden).
//   • Feature: sin importacion_excel no hay importación; las entidades
//     gateadas (garantías, listas de precios, varias sucursales) se rechazan.
//   • Dry-run (p_apply = false) no escribe nada, ni auditoría.
//   • Aplicar crea/actualiza/omite por fila y deja una entrada en audit_logs.
//   • Negocio ajeno: un SKU igual en otro negocio no se toca.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
//
// Escenario: negocio A (importacion_excel, garantias, listas_precios y
// devoluciones por addon) con su sucursal Centro, dueño, encargado y cajero. Negocio B
// (importacion_excel, sin garantías, listas ni multi_sucursal) con su sucursal
// y su dueño. Negocio C sin importacion_excel.
// Los inserts multi-fila llevan todas las claves en cada fila (PostgREST
// completa con null, no con el default, las claves que faltan).
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `imp-test-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type User = { id: string; client: SupabaseClient };
type Ctx = {
  admin: SupabaseClient;
  tenantA: string;
  tenantB: string;
  tenantC: string;
  owner: User;
  manager: User;
  cashier: User;
  ownerB: User;
  ownerC: User;
  centro: string;
  storeB: string;
  listA: string;
  userIds: string[];
};
const ctx = {} as Ctx;

type Result = {
  applied: boolean;
  created: number;
  updated: number;
  skipped: number;
  errors: number;
  rows: { row: number; action: string; message: string | null }[];
};
type RpcResult = { data: unknown; error: { message: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcResult>;

// Fila de producto con TODAS las claves (igual que manda el navegador).
const product = (row: number, over: Record<string, unknown>) => ({
  _row: row,
  name: null,
  sku: null,
  barcode: null,
  price: null,
  cost: null,
  category: null,
  brand: null,
  tax_rate: null,
  unit: null,
  stock: null,
  stock_min: null,
  track_stock: null,
  ...over,
});

const SKU = `SKU-${STAMP}`;

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

async function productsBySku(tenant: string, sku: string) {
  const { data } = await ctx.admin.from("products").select("id, name, price, stock, tax_rate").eq("tenant_id", tenant).eq("sku", sku);
  return (data ?? []) as { id: string; name: string; price: number; stock: number; tax_rate: number }[];
}

async function importAudits(tenant: string, entity: string) {
  const { data } = await ctx.admin
    .from("audit_logs")
    .select("id, after_data")
    .eq("tenant_id", tenant)
    .eq("entity_type", entity)
    .eq("action", "imported");
  return (data ?? []) as { id: string; after_data: Record<string, unknown> }[];
}

describe.skipIf(!enabled)("importaciones XLSX · RPC, rol, feature y dry-run", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];
    const { data: tenants, error } = await admin
      .from("tenants")
      .insert([
        { name: `Imp A ${STAMP}`, slug: `impa-${STAMP}`, status: "active" },
        { name: `Imp B ${STAMP}`, slug: `impb-${STAMP}`, status: "active" },
        { name: `Imp C ${STAMP}`, slug: `impc-${STAMP}`, status: "active" },
      ])
      .select("id, slug");
    if (error || !tenants) throw error ?? new Error("tenants");
    ctx.tenantA = tenants.find((t) => t.slug === `impa-${STAMP}`)!.id;
    ctx.tenantB = tenants.find((t) => t.slug === `impb-${STAMP}`)!.id;
    ctx.tenantC = tenants.find((t) => t.slug === `impc-${STAMP}`)!.id;

    const { error: addErr } = await admin.from("subscription_addons").insert([
      { tenant_id: ctx.tenantA, addon_key: "importacion_excel", status: "active", source: "granted" },
      { tenant_id: ctx.tenantA, addon_key: "garantias", status: "active", source: "granted" },
      { tenant_id: ctx.tenantA, addon_key: "listas_precios", status: "active", source: "granted" },
      { tenant_id: ctx.tenantA, addon_key: "devoluciones", status: "active", source: "granted" },
      { tenant_id: ctx.tenantB, addon_key: "importacion_excel", status: "active", source: "granted" },
    ]);
    if (addErr) throw addErr;

    ctx.owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenantA, "owner");
    ctx.manager = await makeUser(admin, `enc-${STAMP}@test.local`, ctx.tenantA, "manager");
    ctx.cashier = await makeUser(admin, `caj-${STAMP}@test.local`, ctx.tenantA, "cashier");
    ctx.ownerB = await makeUser(admin, `owner-b-${STAMP}@test.local`, ctx.tenantB, "owner");
    ctx.ownerC = await makeUser(admin, `owner-c-${STAMP}@test.local`, ctx.tenantC, "owner");
    ctx.userIds.push(ctx.owner.id, ctx.manager.id, ctx.cashier.id, ctx.ownerB.id, ctx.ownerC.id);

    const { data: c, error: e1 } = await ctx.owner.client.from("stores").insert({ name: "Centro", code: "CEN" } as never).select("id").single();
    if (e1 || !c) throw e1 ?? new Error("centro");
    ctx.centro = (c as unknown as { id: string }).id;
    const { data: b, error: e2 } = await ctx.ownerB.client.from("stores").insert({ name: "Unica", code: "UNI" } as never).select("id").single();
    if (e2 || !b) throw e2 ?? new Error("store B");
    ctx.storeB = (b as unknown as { id: string }).id;

    const { data: l, error: e3 } = await admin
      .from("price_lists")
      .insert({ tenant_id: ctx.tenantA, name: "Mayorista", channel: "custom", is_active: true } as never)
      .select("id")
      .single();
    if (e3 || !l) throw e3 ?? new Error("lista");
    ctx.listA = (l as unknown as { id: string }).id;
  }, 120_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin) return;
    for (const t of [ctx.tenantA, ctx.tenantB, ctx.tenantC].filter(Boolean)) {
      for (const table of [
        "price_label_queue",
        "price_schedules",
        "price_list_items",
        "price_lists",
        "product_price_history",
        "product_stock",
        "stock_movements",
        "products",
        "categories",
        "brands",
        "customers",
        "warranty_plans",
        "return_reasons",
        "cash_registers",
        "stores",
        "audit_logs",
        "subscription_addons",
        "tenant_users",
      ]) {
        await admin.from(table as never).delete().eq("tenant_id", t);
      }
      await admin.from("tenants").delete().eq("id", t);
    }
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 120_000);

  it("el cajero nunca importa (ni revisión ni aplicación)", async () => {
    for (const apply of [false, true]) {
      const r = await rpc(ctx.cashier.client, "import_products", {
        p_rows: [product(2, { name: "X", sku: `${SKU}-caj`, price: 10 })],
        p_apply: apply,
      });
      expect(r.error?.message).toMatch(/forbidden/);
    }
    expect(await productsBySku(ctx.tenantA, `${SKU}-caj`)).toHaveLength(0);
  });

  it("sin importacion_excel en el plan no hay importación", async () => {
    const r = await rpc(ctx.ownerC.client, "import_customers", {
      p_rows: [{ _row: 2, name: "Cliente", document_type: null, document_number: null, iva_condition: null, email: null, phone: null, address: null, notes: null }],
    });
    expect(r.error?.message).toMatch(/feature_not_in_plan: importacion_excel/);
  });

  it("el dry-run predice crear y errores por fila pero no escribe nada", async () => {
    const r = await rpc(ctx.owner.client, "import_products", {
      p_rows: [
        product(2, { name: "Yerba 1kg", sku: SKU, price: 2500, category: `Almacén ${STAMP}`, stock: 10 }),
        product(3, { name: "Sin precio", sku: `${SKU}-np` }),
      ],
      p_apply: false,
      p_file_name: "productos.xlsx",
    });
    expect(r.error).toBeNull();
    const res = r.data as Result;
    expect(res.applied).toBe(false);
    expect(res.created).toBe(1);
    expect(res.errors).toBe(1);
    expect(res.rows.find((x) => x.row === 3)).toMatchObject({ action: "error", message: "import_price_required" });

    expect(await productsBySku(ctx.tenantA, SKU)).toHaveLength(0);
    const { data: cats } = await ctx.admin.from("categories").select("id").eq("tenant_id", ctx.tenantA).eq("name", `Almacén ${STAMP}`);
    expect(cats ?? []).toHaveLength(0);
    expect(await importAudits(ctx.tenantA, "products")).toHaveLength(0);
  });

  it("aplicar crea, deja auditoría y la segunda vez actualiza u omite", async () => {
    const first = await rpc(ctx.manager.client, "import_products", {
      p_rows: [product(2, { name: "Yerba 1kg", sku: SKU, price: 2500, category: `Almacén ${STAMP}`, stock: 10 })],
      p_apply: true,
      p_file_name: "productos.xlsx",
    });
    expect(first.error).toBeNull();
    expect((first.data as Result).created).toBe(1);
    const [p] = await productsBySku(ctx.tenantA, SKU);
    expect(p).toMatchObject({ name: "Yerba 1kg" });
    expect(Number(p!.price)).toBe(2500);
    expect(Number(p!.stock)).toBe(10);
    expect(Number(p!.tax_rate)).toBe(21);
    const audits = await importAudits(ctx.tenantA, "products");
    expect(audits).toHaveLength(1);
    expect(audits[0]!.after_data).toMatchObject({ file: "productos.xlsx", created: 1, source: "xlsx" });

    const same = await rpc(ctx.owner.client, "import_products", {
      p_rows: [product(2, { name: "Yerba 1kg", sku: SKU, price: 2500 })],
      p_apply: true,
    });
    expect((same.data as Result).rows[0]).toMatchObject({ action: "skip", message: "unchanged" });

    const changed = await rpc(ctx.owner.client, "import_products", {
      p_rows: [product(2, { name: "Yerba 1kg", sku: SKU, price: 2700, stock: 99 })],
      p_apply: true,
    });
    expect((changed.data as Result).rows[0]).toMatchObject({ action: "update", message: "stock_ignored" });
    const [after] = await productsBySku(ctx.tenantA, SKU);
    expect(Number(after!.price)).toBe(2700);
    expect(Number(after!.stock)).toBe(10); // el stock no se pisa al actualizar
    expect(Number(after!.tax_rate)).toBe(21); // vacío = no cambia
  });

  it("negocio ajeno: el mismo SKU en otro negocio crea el suyo y no toca el de A", async () => {
    const r = await rpc(ctx.ownerB.client, "import_products", {
      p_rows: [product(2, { name: "Yerba de B", sku: SKU, price: 1 })],
      p_apply: true,
    });
    expect((r.data as Result).created).toBe(1);
    const [a] = await productsBySku(ctx.tenantA, SKU);
    expect(a!.name).toBe("Yerba 1kg");
    expect(Number(a!.price)).toBe(2700);
    expect(await productsBySku(ctx.tenantB, SKU)).toHaveLength(1);
  });

  it("stock: el dry-run no mueve stock; aplicar deja el conteo en la sucursal", async () => {
    const row = { _row: 2, store: "CEN", sku: SKU, barcode: null, qty: 7, min_qty: null, max_qty: null, location: null };
    const dry = await rpc(ctx.owner.client, "import_stock", { p_rows: [row] });
    expect(dry.error).toBeNull();
    expect((dry.data as Result).rows[0]!.action).toBe("update");
    const { data: before } = await ctx.admin.from("product_stock").select("qty").eq("store_id", ctx.centro);
    expect((before ?? []).map((x) => Number((x as { qty: number }).qty))).toEqual([10]);

    const ok = await rpc(ctx.owner.client, "import_stock", { p_rows: [row], p_apply: true });
    expect((ok.data as Result).updated).toBe(1);
    const [p] = await productsBySku(ctx.tenantA, SKU);
    expect(Number(p!.stock)).toBe(7);

    const missing = await rpc(ctx.owner.client, "import_stock", {
      p_rows: [{ ...row, sku: "NO-EXISTE", store: "Inexistente" }],
    });
    expect((missing.data as Result).rows[0]).toMatchObject({ action: "error", message: "import_store_not_found" });
  });

  it("listas: precio base y lista con la feature; sin listas_precios la fila da error", async () => {
    const rows = [
      { _row: 2, list: "Precio de venta", sku: SKU, barcode: null, price: 2800, effective_at: null },
      { _row: 3, list: "Mayorista", sku: SKU, barcode: null, price: 2400, effective_at: null },
    ];
    const a = await rpc(ctx.owner.client, "import_price_lists", { p_rows: rows, p_apply: true });
    expect(a.error).toBeNull();
    expect((a.data as Result).rows.map((x) => x.action)).toEqual(["update", "create"]);
    const { data: item } = await ctx.admin.from("price_list_items").select("price").eq("price_list_id", ctx.listA);
    expect(Number((item?.[0] as { price: number }).price)).toBe(2400);

    const b = await rpc(ctx.ownerB.client, "import_price_lists", {
      p_rows: [{ _row: 2, list: "Mayorista", sku: SKU, barcode: null, price: 1, effective_at: null }],
    });
    expect((b.data as Result).rows[0]).toMatchObject({ action: "error", message: "import_list_not_found" });
  });

  it("garantías: con la feature se importan; sin garantias en el plan, rechazo", async () => {
    const row = { _row: 2, label: `Plan 12 ${STAMP}`, months: 12, price: null, price_pct: 10, commission_pct: 5, description: null, sort: 1, is_active: true };
    const a = await rpc(ctx.owner.client, "import_warranty_plans", { p_rows: [row], p_apply: true });
    expect((a.data as Result).created).toBe(1);
    const b = await rpc(ctx.ownerB.client, "import_warranty_plans", { p_rows: [row] });
    expect(b.error?.message).toMatch(/feature_not_in_plan: garantias/);
  });

  it("sucursales: B sin varias sucursales no puede crear una segunda; sí actualizar la suya", async () => {
    const base = { code: null, short_name: null, address: null, city: null, province: null, postal_code: null, phone: null, email: null, afip_pos_number: null, notes: null };
    const r = await rpc(ctx.ownerB.client, "import_stores", {
      p_rows: [
        { _row: 2, ...base, name: "Unica", city: "Rosario" },
        { _row: 3, ...base, name: "Segunda" },
      ],
      p_apply: true,
    });
    expect(r.error).toBeNull();
    const res = r.data as Result;
    expect(res.rows[0]!.action).toBe("update");
    expect(res.rows[1]!.action).toBe("error");
    expect(res.rows[1]!.message).toMatch(/multi_sucursal|max_stores/);
    const { data: stores } = await ctx.admin.from("stores").select("id").eq("tenant_id", ctx.tenantB);
    expect(stores ?? []).toHaveLength(1);
  });

  it("clientes y motivos: crea y después reconoce el existente", async () => {
    const cust = { _row: 2, name: "Ana", document_type: "dni", document_number: "30.123.456", iva_condition: "consumidor_final", email: null, phone: null, address: null, notes: null };
    expect(((await rpc(ctx.owner.client, "import_customers", { p_rows: [cust], p_apply: true })).data as Result).created).toBe(1);
    const again = await rpc(ctx.owner.client, "import_customers", {
      p_rows: [{ ...cust, document_number: "30123456", phone: "341555" }],
      p_apply: true,
    });
    expect((again.data as Result).rows[0]!.action).toBe("update");

    const reason = { _row: 2, label: "Fallado", code: `fall_${STAMP.slice(-6)}`, stock_destination: "loss", sort: 1, is_active: true };
    expect(((await rpc(ctx.owner.client, "import_return_reasons", { p_rows: [reason], p_apply: true })).data as Result).created).toBe(1);
    const skip = await rpc(ctx.owner.client, "import_return_reasons", { p_rows: [reason] });
    expect((skip.data as Result).rows[0]!.action).toBe("skip");
  });
});
