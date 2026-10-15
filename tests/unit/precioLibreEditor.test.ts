// ADR-151: precio a definir al cobrar (lógica pura, carrito del POS y
// repreciado) y chequeos estáticos de las migraciones (copias fieles de
// create_sale, trg_order_item_price, _price_bulk_execute y price_bulk_revert
// con sólo bloques marcados, gating, permisos y auditoría).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  isOpenPrice,
  openPriceError,
  openPriceErrorText,
  openPriceRange,
  openPriceRangeText,
  openPriceSettingsError,
  parseOpenPriceError,
  parseTypedPrice,
} from "@/lib/prices/openPrice";
import { cartRepriceChanges } from "@/lib/prices/cartReprice";
import { repriceChanges } from "@/lib/pos/priceMismatch";
import { useCartStore } from "@/modules/pos/store";
import { saleErrorTitle } from "@/modules/pos/screen/usePosSale";
import { openPriceColumns } from "@/modules/products/api";
import { ProductSchema } from "@/modules/products/schemas";

const fmt = (n: number) => `$${n}`;

describe("precio libre: lógica pura", () => {
  it("isOpenPrice y rango con sugerido", () => {
    expect(isOpenPrice({ price_mode: "open" })).toBe(true);
    expect(isOpenPrice({ price_mode: "fixed" })).toBe(false);
    expect(isOpenPrice(null)).toBe(false);
    expect(openPriceRange({ price_mode: "open", open_price_min: "500", open_price_max: null, price: 0 })).toEqual({
      min: 500,
      max: null,
      suggested: null,
    });
    expect(openPriceRange({ price: "1200.5" }).suggested).toBe(1200.5);
  });

  it("openPriceError es espejo de _open_price_ok (> 0, mínimo y máximo con medio centavo)", () => {
    expect(openPriceError(null, null, null)).toBe("required");
    expect(openPriceError(0, null, null)).toBe("required");
    expect(openPriceError(-5, null, null)).toBe("required");
    expect(openPriceError(1, null, null)).toBeNull();
    expect(openPriceError(499.99, 500, null)).toBe("below_min");
    expect(openPriceError(499.996, 500, null)).toBeNull();
    expect(openPriceError(5000.01, null, 5000)).toBe("above_max");
    expect(openPriceError(5000, 500, 5000)).toBeNull();
  });

  it("textos del rango y de los errores", () => {
    expect(openPriceRangeText(10, 20, fmt)).toBe("Entre $10 y $20");
    expect(openPriceRangeText(10, null, fmt)).toBe("Desde $10");
    expect(openPriceRangeText(null, 20, fmt)).toBe("Hasta $20");
    expect(openPriceRangeText(null, null, fmt)).toBeNull();
    expect(openPriceErrorText("below_min", 10, null, fmt)).toBe("El mínimo es $10");
    expect(openPriceErrorText("above_max", null, 20, fmt)).toBe("El máximo es $20");
    expect(openPriceErrorText("required", null, null, fmt)).toBe("Ingresá el precio");
  });

  it("validación de la ficha", () => {
    expect(openPriceSettingsError(null, null)).toBeNull();
    expect(openPriceSettingsError(-1, null)).toMatch(/negativo/);
    expect(openPriceSettingsError(null, 0)).toMatch(/mayor a 0/);
    expect(openPriceSettingsError(10, 5)).toMatch(/mayor que el máximo/);
    expect(openPriceSettingsError(10, 10)).toBeNull();
  });

  it("precio tipeado con coma o punto", () => {
    expect(parseTypedPrice("1.234,5")).toBe(1234.5);
    expect(parseTypedPrice("1234.567")).toBe(1234.57);
    expect(parseTypedPrice("  ")).toBeNull();
    expect(parseTypedPrice("abc")).toBeNull();
  });

  it("lee el error del servidor", () => {
    const e = new Error(
      'open_price_out_of_range:{"product_id": "p1", "variant_id": null, "min": 500, "max": null, "received": 100}',
    );
    expect(parseOpenPriceError(e)).toEqual({ productId: "p1", min: 500, max: null, received: 100 });
    expect(parseOpenPriceError(new Error("price_mismatch:{}"))).toBeNull();
    expect(saleErrorTitle(e.message)).toMatch(/fuera del mínimo o el máximo/);
  });

  it("el formulario sólo manda el modo si se tocó (base sin la migración)", () => {
    expect(openPriceColumns({ price_mode: undefined, open_price_min: 5, open_price_max: 9 })).toEqual({});
    expect(openPriceColumns({ price_mode: "open", open_price_min: 5, open_price_max: null })).toEqual({
      price_mode: "open",
      open_price_min: 5,
      open_price_max: null,
    });
    expect(openPriceColumns({ price_mode: "fixed", open_price_min: 5, open_price_max: 9 })).toEqual({
      price_mode: "fixed",
      open_price_min: null,
      open_price_max: null,
    });
  });

  it("el schema rechaza mínimo mayor que máximo en modo libre", () => {
    const base = { name: "Análisis", price: 0, price_mode: "open" as const };
    expect(ProductSchema.safeParse({ ...base, open_price_min: "100", open_price_max: "50" }).success).toBe(false);
    const ok = ProductSchema.safeParse({ ...base, open_price_min: "", open_price_max: "50" });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.open_price_min).toBeNull();
  });
});

describe("precio libre en el carrito del POS", () => {
  beforeEach(() => useCartStore.getState().clear());
  const prod = { id: "p1", name: "Relevamiento", sku: null };
  const range = { min: 500, max: 5000, suggested: 1000 };

  it("cada alta es una línea propia y addProduct no se fusiona con ella", () => {
    const s = useCartStore.getState();
    s.addOpenPrice(prod, 1800, range);
    s.addOpenPrice(prod, 900, range);
    s.addProduct({ ...prod, price: 1000 });
    const lines = useCartStore.getState().lines;
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ unitPrice: 1800, quantity: 1, openPrice: range });
    expect(lines[2]!.openPrice).toBeUndefined();
  });

  it("editar el precio de la línea libre no pide motivo ni marca precio manual", () => {
    useCartStore.getState().addOpenPrice(prod, 1800, range);
    const id = useCartStore.getState().lines[0]!.lineId;
    useCartStore.getState().setOpenLinePrice(id, 2500);
    const l = useCartStore.getState().lines[0]!;
    expect(l.unitPrice).toBe(2500);
    expect(l.priceOverride).toBeFalsy();
  });

  it("no se reprecia por lista, cliente ni price_mismatch", () => {
    useCartStore.getState().addOpenPrice(prod, 1800, range);
    const lines = useCartStore.getState().lines;
    expect(cartRepriceChanges(lines, () => 1000)).toEqual([]);
    expect(repriceChanges(lines, [{ productId: "p1", variantId: null, expected: 1000, received: 1800 }])).toEqual([]);
    useCartStore.getState().applyServerPrices([{ lineId: lines[0]!.lineId, to: 1000 }]);
    expect(useCartStore.getState().lines[0]!.unitPrice).toBe(1800);
  });
});

describe("migraciones 20261219100000 y 20261219100100", () => {
  const DIR = join(process.cwd(), "supabase", "migrations");
  const feat = readFileSync(join(DIR, "20261219100000_features_precio_libre_editor.sql"), "utf8");
  const sql = readFileSync(join(DIR, "20261219100100_precio_libre_editor_precios.sql"), "utf8");
  const adr116 = readFileSync(join(DIR, "20261114100000_servicios_profesionales.sql"), "utf8");
  const adr102 = readFileSync(join(DIR, "20261110200100_canales_delivery_modelo.sql"), "utf8");
  const adr140 = readFileSync(join(DIR, "20261207100200_precios_actualizacion_dolar.sql"), "utf8");
  const body = (s: string, fn: RegExp) => {
    const i = s.search(fn);
    const end = s.slice(i).search(/\n\$(function)?\$;/);
    return s.slice(i, i + end);
  };
  const ws = (s: string) => s.replace(/\s+/g, " ").trim();
  const strip151 = (s: string) =>
    s
      .replace(/[ \t]*-- ADR-151 >>>[\s\S]*?-- <<< ADR-151\n/g, "")
      .split("\n")
      .filter((l) => !l.includes("ADR-151"))
      .join("\n");
  const fromDecl = (s: string) => s.slice(s.search(/\n(declare|begin)\b/));

  it("features BASE con su key en los planes", () => {
    expect(feat).toMatch(/\('precio_libre',[\s\S]*?'catalogo', true, 76\)/);
    expect(feat).toMatch(/\('editor_precios',[\s\S]*?'catalogo', true, 77\)/);
    expect(feat).toContain("on conflict (key) do nothing");
    expect(feat).toContain("jsonb_build_object('precio_libre', true)");
    expect(feat).toContain("jsonb_build_object('editor_precios', true)");
  });

  it("create_sale copia la de ADR-116 y sólo agrega bloques marcados", () => {
    const fn = /create or replace function public\.create_sale\(/;
    const raw = body(sql, fn);
    const a = ws(body(adr116, fn));
    expect(a.length).toBeGreaterThan(1000);
    expect(ws(strip151(raw))).toBe(a);
    // Misma firma: no se borra nada ni quedan sobrecargas.
    expect(sql).not.toMatch(/drop function if exists public\.create_sale/);
    expect(raw).toContain("p_cash_shift_id uuid DEFAULT NULL::uuid, p_service jsonb DEFAULT NULL::jsonb)");
    // Lo marca el producto (no el POS), con rango, offline como conflicto y auditoría.
    expect(raw).toContain("select * into v_or from _open_price_range(v_tenant, v_pid);");
    expect(raw).not.toMatch(/v_j ->> 'open_price'/);
    expect(raw).toContain("_open_price_ok(v_obase, v_or.o_min, v_or.o_max)");
    expect(raw).toContain("'open_price_out_of_range:'");
    expect(raw).toContain("'kind', 'open_price_out_of_range'");
    expect(raw).toContain("'sale_open_price'");
    for (const ins of raw.match(/insert into \w+ \([^)]*\)/g) ?? []) expect(ins, ins).toContain("tenant_id");
    const SIG = "jsonb, jsonb, numeric, uuid, text, jsonb, uuid, uuid, numeric, uuid, text, uuid, uuid, jsonb";
    expect(sql).toContain(`revoke all on function public.create_sale(${SIG}) from public, anon;`);
    expect(sql).toContain(`grant execute on function public.create_sale(${SIG}) to authenticated;`);
  });

  it("es la última definición de create_sale", () => {
    const later = readdirSync(DIR)
      .filter((f) => f.endsWith(".sql") && f > "20261219100100_precio_libre_editor_precios.sql")
      .map((f) => readFileSync(join(DIR, f), "utf8"));
    for (const s of later) expect(s).not.toMatch(/function (public\.)?create_sale\(/);
  });

  it("trg_order_item_price, _price_bulk_execute y price_bulk_revert son copias de producción con bloques marcados", () => {
    for (const [src, fn] of [
      [adr102, /create or replace function (public\.)?trg_order_item_price\(/],
      [adr140, /create or replace function (public\.)?_price_bulk_execute\(/],
      [adr140, /create or replace function (public\.)?price_bulk_revert\(/],
    ] as const) {
      const mine = ws(fromDecl(strip151(body(sql, fn))));
      const orig = ws(fromDecl(body(src, fn)));
      expect(orig.length).toBeGreaterThan(300);
      expect(mine).toBe(orig);
    }
    expect(body(sql, /create or replace function (public\.)?_price_bulk_execute\(/)).toContain(
      "return _price_bulk_edit_execute(p_batch);",
    );
  });

  it("columnas del producto con check y gating por trigger", () => {
    expect(sql).toMatch(/add column if not exists price_mode text not null default 'fixed'/);
    expect(sql).toMatch(/price_mode in \('fixed', 'open'\)/);
    expect(sql).toMatch(/open_price_min is null or open_price_max is null or open_price_min <= open_price_max/);
    expect(sql).toContain("raise exception 'feature_not_in_plan: precio_libre'");
    expect(sql).toMatch(/before insert or update of price_mode, open_price_min, open_price_max on products/);
    expect(sql).toMatch(/o_open := coalesce\(o_open, false\) and coalesce\(tenant_has_feature_for\(p_tenant, 'precio_libre'\), false\)/);
  });

  it("editor: dueño o encargado, gating, listas sólo con listas_precios y lote del motor de ADR-058", () => {
    const rows = body(sql, /create or replace function price_editor_rows\(/);
    const save = body(sql, /create or replace function price_editor_save\(/);
    for (const f of [rows, save]) {
      expect(f).toContain("_price_bulk_v2_role_check()");
      expect(f).toContain("raise exception 'feature_not_in_plan: editor_precios'");
    }
    expect(save).toContain("raise exception 'feature_not_in_plan: listas_precios'");
    expect(save).toContain("raise exception 'list_currency_not_editable'");
    expect(save).toContain("raise exception 'cost_in_usd'");
    expect(save).toMatch(/insert into price_bulk_batches \(tenant_id[\s\S]*?3, jsonb_build_object\('source', 'editor'\), 'editor'\)/);
    expect(save).toContain("'price_bulk_created'");
    expect(save).toMatch(/price_pro_enabled\(v_tenant\) and coalesce\(stock_my_role\(\), ''\) <> 'owner'/);
    expect(sql).toMatch(/check \(engine = any \(array\[1, 2, 3\]\)\)/);
    expect(sql).toMatch(/'cost', 'edit'\]/);
    expect(sql).toMatch(/array\['manual', 'auto', 'editor'\]/);
    for (const ins of sql.match(/insert into \w+ \([^)]*\)/g) ?? []) expect(ins, ins).toContain("tenant_id");
  });

  it("toda función SECURITY DEFINER fija search_path y las internas no se exponen", () => {
    const fns = sql.split(/create or replace function /i).slice(1);
    expect(fns.length).toBeGreaterThanOrEqual(10);
    for (const f of fns) {
      const head = f.slice(0, f.search(/\$(function)?\$/));
      if (/security definer/i.test(head)) expect(head, head.slice(0, 60)).toMatch(/set search_path/i);
    }
    for (const n of ["trg_products_price_mode()", "_open_price_range(uuid, uuid)", "_price_bulk_edit_execute(uuid)"]) {
      expect(sql).toContain(`revoke all on function ${n} from public, anon, authenticated;`);
    }
    expect(sql).toContain("grant execute on function price_editor_rows(jsonb) to authenticated;");
    expect(sql).toContain("grant execute on function price_editor_save(jsonb) to authenticated;");
  });

  it("sin em dash en las migraciones nuevas", () => {
    expect(feat).not.toContain("—");
    expect(sql.replace(body(sql, /create or replace function public\.create_sale\(/), "")).not.toContain("—");
  });
});
