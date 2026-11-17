// SEC-43 (ADR-187): clave de idempotencia del cobro online (create_sale).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nextSaleRequestKey, saleCartSignature, type SaleCartIdentity } from "@/lib/pos/saleRequestKey";

const ROOT = join(__dirname, "..", "..");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8").replace(/\r\n/g, "\n");
const MIG = read("supabase/migrations/20270123100000_sec43_create_sale_idempotency.sql");

const cart = (over: Partial<SaleCartIdentity> = {}): SaleCartIdentity => ({
  items: [{ product_id: "p1", quantity: 1, unit_price: 100, discount: 0 }],
  customerId: null,
  tableOrderId: null,
  deliveryOrderId: null,
  appointmentId: null,
  reservationId: null,
  ...over,
});

const ids = () => {
  let n = 0;
  return () => `id-${++n}`;
};

describe("clave del cobro en el POS", () => {
  it("el reintento del mismo cobro reusa la clave", () => {
    const newId = ids();
    const sig = saleCartSignature(cart());
    const first = nextSaleRequestKey(null, sig, newId);
    const retry = nextSaleRequestKey(first, saleCartSignature(cart()), newId);
    expect(first.key).toBe("id-1");
    expect(retry.key).toBe("id-1");
    expect(retry).toBe(first);
  });

  it("una venta nueva (después de confirmar) lleva otra clave aunque el carrito sea igual", () => {
    const newId = ids();
    const sig = saleCartSignature(cart());
    const first = nextSaleRequestKey(null, sig, newId);
    // usePosSale descarta la clave al confirmar la venta.
    const next = nextSaleRequestKey(null, sig, newId);
    expect(next.key).not.toBe(first.key);
  });

  it("si cambia el carrito, el cliente o el origen, es otro cobro", () => {
    const newId = ids();
    const first = nextSaleRequestKey(null, saleCartSignature(cart()), newId);
    const moreQty = cart({ items: [{ product_id: "p1", quantity: 2, unit_price: 100, discount: 0 }] });
    expect(nextSaleRequestKey(first, saleCartSignature(moreQty), newId).key).not.toBe(first.key);
    expect(nextSaleRequestKey(first, saleCartSignature(cart({ customerId: "c1" })), newId).key).not.toBe(first.key);
    expect(nextSaleRequestKey(first, saleCartSignature(cart({ tableOrderId: "t1" })), newId).key).not.toBe(first.key);
  });

  it("la firma no depende del orden de las claves", () => {
    const a = cart({ items: [{ product_id: "p1", quantity: 1, unit_price: 100 }] });
    const b = cart({ items: [{ unit_price: 100, quantity: 1, product_id: "p1" }] });
    expect(saleCartSignature(a)).toBe(saleCartSignature(b));
  });

  it("por defecto la clave es un uuid", () => {
    const k = nextSaleRequestKey(null, "x");
    expect(k.key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("el POS la manda a create_sale y dentro de p_sale con reparto", () => {
    const api = read("modules/pos/api.ts");
    expect(api).toContain("...(clientRequestId ? { p_client_request_id: clientRequestId } : {}),");
    expect(api).toMatch(/\{ p_sale: args, p_plan: fulfillment \}/);
    const hook = read("modules/pos/screen/usePosSale.ts");
    expect(hook).toContain("clientRequestId: requestKey.current.key,");
    expect(hook).toMatch(/requestKey\.current = null;/);
  });
});

// ---------------------------------------------------------------------------
// Migración: copias exactas de producción con bloques marcados SEC-43.
// ---------------------------------------------------------------------------
const fnText = (s: string, start: RegExp) => {
  const i = s.search(start);
  expect(i, String(start)).toBeGreaterThanOrEqual(0);
  const rest = s.slice(i);
  const tag = rest.match(/\nAS (\$[a-z]*\$)\n/)![1]!;
  const from = rest.indexOf(`\nAS ${tag}\n`);
  return { head: rest.slice(0, from), body: rest.slice(from, rest.indexOf(`\n${tag}`, from + 5)) };
};
/** Quita lo agregado por SEC-43: bloques entre marcas y renglones marcados. */
const strip = (s: string) =>
  s
    .replace(/[ \t]*-- SEC-43 >>>[\s\S]*?-- <<< SEC-43\n/g, "")
    .replace(/,\s*\n[^\n]*-- SEC-43[^\n]*/g, (m) => (m.includes(")") ? ")" : ""));
const ws = (s: string) => s.replace(/\$function\$|\$\$/g, "$tag$").replace(/\s+/g, " ").trim();

describe("migración 20270123100000_sec43_create_sale_idempotency", () => {
  it("columna, índice único parcial por negocio y helper interno sin EXECUTE de clientes", () => {
    expect(MIG).toContain("alter table public.sales add column if not exists client_request_id uuid;");
    expect(MIG).toMatch(
      /create unique index if not exists sales_client_request_uniq\s+on public\.sales \(tenant_id, client_request_id\)\s+where client_request_id is not null;/,
    );
    expect(MIG).toContain(
      "revoke all on function public._sale_replay_result(uuid, uuid) from public, anon, authenticated;",
    );
  });

  it("create_sale: una sola firma, con la clave al final y los grants de producción", () => {
    const OLD = "jsonb, jsonb, numeric, uuid, text, jsonb, uuid, uuid, numeric, uuid, text, uuid, uuid, jsonb";
    expect(MIG).toContain(`drop function public.create_sale(${OLD});`);
    expect(MIG.indexOf("drop function public.create_sale(")).toBeLessThan(
      MIG.indexOf("create or replace function public.create_sale("),
    );
    expect(MIG).toContain(`revoke all on function public.create_sale(${OLD}, uuid) from public, anon;`);
    expect(MIG).toContain(`grant execute on function public.create_sale(${OLD}, uuid) to authenticated, service_role;`);
    expect(MIG).toMatch(/p_service jsonb DEFAULT NULL::jsonb, p_client_request_id uuid DEFAULT NULL::uuid\)\n RETURNS jsonb/);
  });

  it("create_sale es la de producción (ADR-151) más los bloques SEC-43", () => {
    const prod = fnText(
      read("supabase/migrations/20261219100100_precio_libre_editor_precios.sql"),
      /create or replace function public\.create_sale\(/,
    );
    const mine = fnText(MIG, /create or replace function public\.create_sale\(/);
    expect(prod.body.length).toBeGreaterThan(50_000);
    expect(ws(strip(mine.body))).toBe(ws(prod.body));
    expect(mine.head.replace(", p_client_request_id uuid DEFAULT NULL::uuid", "")).toBe(prod.head);
  });

  it("create_sale mira la clave antes de cualquier efecto y la guarda en la venta", () => {
    const { body } = fnText(MIG, /create or replace function public\.create_sale\(/);
    const check = body.indexOf("return _sale_replay_result(v_tenant, v_replay);");
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(body.indexOf("for update"));
    expect(check).toBeLessThan(body.indexOf("insert into"));
    expect(body).toMatch(/pg_advisory_xact_lock\(hashtext\('sale_request:' \|\| v_tenant::text \|\| ':' \|\| p_client_request_id::text\)\)/);
    expect(body).toContain(
      "on conflict (tenant_id, client_request_id) where client_request_id is not null do nothing",
    );
    // El insert de la venta es lo primero que escribe: nada antes que deshacer.
    const firstInsert = body.indexOf("insert into ");
    expect(body.slice(firstInsert, firstInsert + 20)).toBe("insert into sales (t");
    expect(body.slice(0, firstInsert)).not.toMatch(/\bupdate \w+\s+set\b/);
  });

  it("pos_sale_create_fulfilled es la de producción (ADR-146) más los bloques SEC-43", () => {
    const prod = fnText(
      read("supabase/migrations/20261215100000_cobro_envio_costo.sql"),
      /create or replace function public\.pos_sale_create_fulfilled\(/,
    );
    const mine = fnText(MIG, /create or replace function public\.pos_sale_create_fulfilled\(/);
    expect(ws(strip(mine.body))).toBe(ws(prod.body));
    expect(mine.head).toBe(prod.head);
    // La clave se mira antes de mover stock entre sucursales y se pasa a create_sale.
    expect(mine.body.indexOf("return _sale_replay_result(v_tenant, v_replay)")).toBeLessThan(
      mine.body.indexOf("transfer_move_stock("),
    );
    expect(mine.body).toContain("p_client_request_id => v_req  -- SEC-43");
    expect(MIG).toContain("grant execute on function public.pos_sale_create_fulfilled(jsonb, jsonb) to authenticated;");
  });

  it("grants.expected.json tiene la firma nueva y el helper", () => {
    const g = JSON.parse(read("supabase/security/grants.expected.json")) as {
      functions: { sig: string; anon: boolean; authenticated: boolean; secdef: boolean }[];
    };
    const sigs = g.functions.map((f) => f.sig);
    expect(sigs.filter((s) => s.startsWith("create_sale("))).toEqual([
      "create_sale(p_items jsonb, p_payments jsonb, p_discount_total numeric, p_customer_id uuid, p_notes text, p_extras jsonb, p_table_order_id uuid, p_delivery_order_id uuid, p_promo_discount numeric, p_promo_id uuid, p_promo_name text, p_coupon_id uuid, p_cash_shift_id uuid, p_service jsonb, p_client_request_id uuid)",
    ]);
    expect(g.functions.find((f) => f.sig === "_sale_replay_result(p_tenant uuid, p_sale uuid)")).toMatchObject({
      anon: false,
      authenticated: false,
      secdef: true,
    });
  });
});
