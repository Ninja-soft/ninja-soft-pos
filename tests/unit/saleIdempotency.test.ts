// SEC-43 (ADR-187): clave de idempotencia del cobro (create_sale y wrappers).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SALE_REQUEST_STORAGE_KEY,
  loadSaleRequestKey,
  nextSaleRequestKey,
  pendingSaleRequestKey,
  saleCartSignature,
  saleRequestMismatchMessage,
  saveSaleRequestKey,
  type SaleCartIdentity,
} from "@/lib/pos/saleRequestKey";

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

function memStore() {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

describe("clave del cobro en el POS", () => {
  it("el reintento del mismo cobro reusa la clave", () => {
    const newId = ids();
    const first = nextSaleRequestKey(null, saleCartSignature(cart()), newId);
    const retry = nextSaleRequestKey(first, saleCartSignature(cart()), newId);
    expect(first.key).toBe("id-1");
    expect(retry).toBe(first);
  });

  it("una venta nueva (después de confirmar) lleva otra clave aunque el carrito sea igual", () => {
    const newId = ids();
    const sig = saleCartSignature(cart());
    const first = nextSaleRequestKey(null, sig, newId);
    // usePosSale descarta la clave al confirmar la venta o vaciar el carrito.
    expect(nextSaleRequestKey(null, sig, newId).key).not.toBe(first.key);
  });

  it("si cambia el carrito, el cliente o el origen, es otro cobro", () => {
    const newId = ids();
    const first = nextSaleRequestKey(null, saleCartSignature(cart()), newId);
    const moreQty = cart({ items: [{ product_id: "p1", quantity: 2, unit_price: 100, discount: 0 }] });
    expect(nextSaleRequestKey(first, saleCartSignature(moreQty), newId).key).not.toBe(first.key);
    expect(nextSaleRequestKey(first, saleCartSignature(cart({ customerId: "c1" })), newId).key).not.toBe(first.key);
    expect(nextSaleRequestKey(first, saleCartSignature(cart({ tableOrderId: "t1" })), newId).key).not.toBe(first.key);
  });

  it("la firma no depende del orden de las claves y no lleva los pagos", () => {
    const a = cart({ items: [{ product_id: "p1", quantity: 1, unit_price: 100 }] });
    const b = cart({ items: [{ unit_price: 100, quantity: 1, product_id: "p1" }] });
    expect(saleCartSignature(a)).toBe(saleCartSignature(b));
    expect(saleCartSignature(a)).not.toMatch(/payment/);
  });

  it("por defecto la clave es un uuid", () => {
    const k = nextSaleRequestKey(null, "x");
    expect(k.key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("la venta offline después del corte lleva la clave pendiente sólo si es el mismo carrito", () => {
    const sig = saleCartSignature(cart());
    const k = nextSaleRequestKey(null, sig, ids());
    expect(pendingSaleRequestKey(k, sig)).toBe("id-1");
    expect(pendingSaleRequestKey(k, saleCartSignature(cart({ customerId: "c1" })))).toBeNull();
    expect(pendingSaleRequestKey(null, sig)).toBeNull();
  });

  it("la clave pendiente sobrevive a una recarga (sessionStorage) y se borra", () => {
    const st = memStore();
    saveSaleRequestKey({ key: "k1", cart: "c" }, st);
    expect(loadSaleRequestKey(st)).toEqual({ key: "k1", cart: "c" });
    saveSaleRequestKey(null, st);
    expect(st.m.has(SALE_REQUEST_STORAGE_KEY)).toBe(false);
    expect(loadSaleRequestKey(st)).toBeNull();
    // Basura o storage que tira: null, sin romper el cobro.
    st.m.set(SALE_REQUEST_STORAGE_KEY, "{no json");
    expect(loadSaleRequestKey(st)).toBeNull();
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadSaleRequestKey(broken)).toBeNull();
    expect(() => saveSaleRequestKey({ key: "k", cart: "c" }, broken)).not.toThrow();
  });

  it("sale_request_mismatch: mensaje con el número de la venta ya registrada", () => {
    expect(saleRequestMismatchMessage("sale_request_mismatch: 1234")).toBe(
      "Esta venta ya se registró (N° 1234) con otros datos. Revisá Ventas antes de volver a cobrar.",
    );
    expect(saleRequestMismatchMessage("sale_request_mismatch")).toBe(
      "Esta venta ya se registró con otros datos. Revisá Ventas antes de volver a cobrar.",
    );
    expect(saleRequestMismatchMessage("price_mismatch")).toBeNull();
  });

  it("el POS la manda a create_sale, dentro de p_sale con reparto y en la venta offline", () => {
    const api = read("modules/pos/api.ts");
    expect(api).toContain("...(clientRequestId ? { p_client_request_id: clientRequestId } : {}),");
    expect(api).toMatch(/\{ p_sale: args, p_plan: fulfillment \}/);
    const hook = read("modules/pos/screen/usePosSale.ts");
    expect(hook).toContain("clientRequestId: key.key,");
    expect(hook).toContain("...(pendingKey ? { client_request_id: pendingKey } : {}),");
    expect(hook).toContain("saleRequestMismatchMessage(msg)");
    // La conciliación que crea una venta también manda una clave estable.
    expect(read("components/reports/processors/LineActionModals.tsx")).toMatch(/useState\(newSaleRequestId\)/);
  });
});

// ---------------------------------------------------------------------------
// Migración: copias exactas de producción con bloques marcados SEC-43.
// ---------------------------------------------------------------------------
const fnText = (s: string, start: RegExp) => {
  const i = s.search(start);
  expect(i, String(start)).toBeGreaterThanOrEqual(0);
  const rest = s.slice(i);
  const m = rest.match(/\n(AS|as) (\$[a-z]*\$)\n/)!;
  const from = m.index! + m[0].length;
  return { head: rest.slice(0, m.index!), body: rest.slice(from, rest.indexOf(`\n${m[2]}`, from - 1)) };
};
/**
 * Quita lo agregado por SEC-43: bloques entre marcas, argumentos agregados al
 * final de una lista (`, x)  -- SEC-43` → `)`) y renglones marcados.
 */
const strip = (s: string) =>
  s
    .replace(/[ \t]*-- SEC-43 >>>[\s\S]*?-- <<< SEC-43\n/g, "")
    .replace(/,\s*\n[^\n]*-- SEC-43[^\n]*/g, (m) => {
      const code = m.replace(/\s*-- SEC-43.*$/, "");
      const i = code.lastIndexOf(")");
      return i >= 0 ? code.slice(i) : "";
    })
    .replace(/\n[^\n]*-- SEC-43[^\n]*/g, "");
const ws = (s: string) => s.replace(/\$function\$|\$\$/g, "$tag$").replace(/\s+/g, " ").trim();

const COPIES: [string, string, RegExp][] = [
  ["create_sale", "20261219100100_precio_libre_editor_precios.sql", /create or replace function public\.create_sale\(/],
  [
    "pos_sale_create_fulfilled",
    "20261215100000_cobro_envio_costo.sql",
    /create or replace function public\.pos_sale_create_fulfilled\(/,
  ],
  [
    "pos_sale_create_delivery",
    "20261226100000_logistica_l1_direcciones.sql",
    /create or replace function public\.pos_sale_create_delivery\(/,
  ],
  ["_offline_run_sale", "20261103200000_venta_offline.sql", /create or replace function (public\.)?_offline_run_sale\(/],
];

describe("migración 20270123100000_sec43_create_sale_idempotency", () => {
  it("columnas, índice único parcial por negocio y helpers internos sin EXECUTE de clientes", () => {
    expect(MIG).toContain("alter table public.sales add column if not exists client_request_id uuid;");
    expect(MIG).toContain("alter table public.sales add column if not exists client_request_hash text;");
    expect(MIG).toMatch(
      /create unique index if not exists sales_client_request_uniq\s+on public\.sales \(tenant_id, client_request_id\)\s+where client_request_id is not null;/,
    );
    for (const sig of [
      "_sale_request_replay(uuid, uuid, text)",
      "_sale_request_plan_hash(jsonb, jsonb)",
      "_sale_replay_result(uuid, uuid)",
      "_sale_fulfilled_replay_result(uuid, uuid)",
    ]) {
      expect(MIG).toContain(`revoke all on function public.${sig} from public, anon, authenticated;`);
    }
    expect(MIG).toMatch(/raise exception 'sale_request_mismatch: %', v_number/);
    expect(MIG).toMatch(/'replayed', true\)/);
    expect(MIG).toMatch(/'has_pickup_code', d\.pickup_code_hash is not null/);
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

  it.each(COPIES)("%s es la de producción más los bloques SEC-43", (_name, file, re) => {
    const prod = fnText(read(`supabase/migrations/${file}`), re);
    const mine = fnText(MIG, re);
    expect(prod.body.length).toBeGreaterThan(1000);
    expect(ws(strip(mine.body))).toBe(ws(prod.body));
    // Encabezado: mismo texto de pg_get_functiondef donde la copia anterior también lo usaba.
    if (/\n RETURNS jsonb/.test(prod.head)) {
      expect(mine.head.replace(", p_client_request_id uuid DEFAULT NULL::uuid", "")).toBe(prod.head);
    }
  });

  it("los wrappers mantienen sus grants de producción", () => {
    expect(MIG).toContain("grant execute on function public.pos_sale_create_fulfilled(jsonb, jsonb) to authenticated;");
    expect(MIG).toContain("grant execute on function public.pos_sale_create_delivery(jsonb, jsonb) to authenticated;");
    expect(MIG).toContain(
      "revoke all on function public._offline_run_sale(jsonb, uuid, uuid, timestamptz) from public, anon, authenticated;",
    );
  });

  it("create_sale mira la clave antes de cualquier efecto y la guarda con la huella", () => {
    const { body } = fnText(MIG, /create or replace function public\.create_sale\(/);
    const check = body.indexOf("return _sale_replay_result(v_tenant, v_replay);");
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(body.indexOf("for update"));
    expect(check).toBeLessThan(body.indexOf("insert into"));
    expect(body).toContain("client_request_id, client_request_hash)  -- SEC-43");
    expect(body).toContain("p_client_request_id, v_req_hash)  -- SEC-43");
    expect(body).toContain(
      "on conflict (tenant_id, client_request_id) where client_request_id is not null do nothing",
    );
    // El insert de la venta es lo primero que escribe: nada antes que deshacer.
    const firstInsert = body.indexOf("insert into ");
    expect(body.slice(firstInsert, firstInsert + 20)).toBe("insert into sales (t");
    expect(body.slice(0, firstInsert)).not.toMatch(/\bupdate \w+\s+set\b/);
    // La huella no lleva turno, notas, nombre de promo ni servicio (la venta
    // offline después de un corte tiene que dar la misma).
    const hash = body.slice(body.indexOf("v_req_hash := coalesce("), body.indexOf("v_replay := _sale_request_replay("));
    for (const k of ["p_cash_shift_id", "p_notes", "p_promo_name", "p_service"]) expect(hash).not.toContain(k);
  });

  it("los wrappers miran la clave antes de escribir", () => {
    const pf = fnText(MIG, /create or replace function public\.pos_sale_create_fulfilled\(/).body;
    expect(pf.indexOf("return _sale_fulfilled_replay_result(v_tenant, v_replay)")).toBeLessThan(
      pf.indexOf("transfer_move_stock("),
    );
    expect(pf).toContain("p_client_request_id => v_req  -- SEC-43");
    const pd = fnText(MIG, /create or replace function public\.pos_sale_create_delivery\(/).body;
    const replay = pd.indexOf("return _sale_fulfilled_replay_result(v_tenant, v_replay)");
    expect(replay).toBeGreaterThan(0);
    expect(replay).toBeLessThan(pd.indexOf("_customer_address_insert("));
    expect(replay).toBeLessThan(pd.indexOf("update dispatches"));
    const po = fnText(MIG, /create or replace function (public\.)?_offline_run_sale\(/).body;
    expect(po).toContain("v_req := nullif(p_payload ->> 'client_request_id', '')::uuid;");
    expect(po).toContain("p_client_request_id => v_req);  -- SEC-43");
    expect(po).toMatch(/if not coalesce\(\(v_res ->> 'replayed'\)::boolean, false\) then/);
  });

  it("grants.expected.json tiene la firma nueva y los helpers", () => {
    const g = JSON.parse(read("supabase/security/grants.expected.json")) as {
      functions: { sig: string; anon: boolean; authenticated: boolean; secdef: boolean }[];
    };
    const sigs = g.functions.map((f) => f.sig);
    expect(sigs.filter((s) => s.startsWith("create_sale("))).toEqual([
      "create_sale(p_items jsonb, p_payments jsonb, p_discount_total numeric, p_customer_id uuid, p_notes text, p_extras jsonb, p_table_order_id uuid, p_delivery_order_id uuid, p_promo_discount numeric, p_promo_id uuid, p_promo_name text, p_coupon_id uuid, p_cash_shift_id uuid, p_service jsonb, p_client_request_id uuid)",
    ]);
    for (const sig of [
      "_sale_replay_result(p_tenant uuid, p_sale uuid)",
      "_sale_fulfilled_replay_result(p_tenant uuid, p_sale uuid)",
      "_sale_request_replay(p_tenant uuid, p_req uuid, p_hash text)",
      "_sale_request_plan_hash(p_sale jsonb, p_plan jsonb)",
    ]) {
      expect(g.functions.find((f) => f.sig === sig), sig).toMatchObject({ anon: false, authenticated: false });
    }
  });
});
