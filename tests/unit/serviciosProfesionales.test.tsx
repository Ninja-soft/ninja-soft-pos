// ADR-116: servicios profesionales. Vocabulario del catálogo, payload del POS
// (aclaración por renglón y período), factura con la aclaración debajo del
// servicio y chequeos estáticos de la migración (create_sale copia fiel de
// ADR-096 con p_service opcional). La lógica SQL la cubre
// tests/integration/rls-servicios-profesionales.test.ts; la cola fiscal
// (concepto 2/3 con fechas), tests/unit/arcaWorker.test.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import {
  catalogVocab,
  defaultServicePeriod,
  effectiveCatalogMode,
  serviceLineBlocks,
  servicePeriodError,
  simpleTextLines,
  todayAr,
  unitLabel,
} from "@/lib/catalog/mode";
import { buildSaleItemsAndExtras, type SaleArgsLine } from "@/modules/pending-charges/logic";
import { cartToSaleLines, saleErrorTitle } from "@/modules/pos/screen/usePosSale";
import { lineHasServiceEdits, useCartStore, type CartLine } from "@/modules/pos/store";
import { invoiceFromTicket } from "@/lib/invoices/fromTicket";
import { sampleServiceSale } from "@/lib/invoices/samples";
import { serviceOfItem, serviceOfSale } from "@/lib/invoices/serviceFields";
import { InvoiceDocument } from "@/components/invoices/InvoiceDocument";
import { A4_MODELS } from "@/lib/invoices/models";
import { legalRequirements } from "@/lib/invoices/legal";
import { resolveInvoiceStyle } from "@/lib/invoices/style";

describe("modo del catálogo", () => {
  it("el rubro Servicios profesionales arranca en servicios; lo elegido manda", () => {
    expect(effectiveCatalogMode(null, "servicios")).toBe("servicios");
    expect(effectiveCatalogMode(null, "kiosco")).toBe("productos");
    expect(effectiveCatalogMode(undefined, null)).toBe("productos");
    expect(effectiveCatalogMode("mixto", "servicios")).toBe("mixto");
    expect(effectiveCatalogMode("productos", "servicios")).toBe("productos");
    expect(effectiveCatalogMode("cualquiera", "servicios")).toBe("servicios");
  });

  it("vocabulario: Productos → Servicios", () => {
    expect(catalogVocab("servicios")).toMatchObject({ title: "Servicios", newLabel: "Nuevo servicio", newIsService: true });
    expect(catalogVocab("mixto")).toMatchObject({ title: "Productos y servicios", newIsService: false });
    expect(catalogVocab("productos")).toMatchObject({ title: "Productos", newLabel: "Nuevo producto" });
  });

  it("unidades y texto con formato simple", () => {
    expect(unitLabel("analisis")).toBe("análisis");
    expect(unitLabel("un")).toBe("unidad");
    expect(unitLabel(null)).toBe("unidad");
    expect(unitLabel("km")).toBe("km");
    expect(simpleTextLines("Incluye:\n- Toma de muestras\n•  Informe\n\n  ")).toEqual([
      { bullet: false, text: "Incluye:" },
      { bullet: true, text: "Toma de muestras" },
      { bullet: true, text: "Informe" },
    ]);
    expect(
      serviceLineBlocks({ detail: "Análisis\n- Coliformes", clarifications: ["CAA art. 982", " "], note: "Lote 2381" }),
    ).toEqual([
      { bullet: false, text: "Análisis" },
      { bullet: true, text: "Coliformes" },
      { bullet: true, text: "CAA art. 982" },
      { bullet: false, text: "Lote 2381" },
    ]);
  });

  it("período del servicio: mismo criterio que el servidor", () => {
    const now = new Date("2026-10-14T02:00:00Z"); // 13/10 23:00 en Argentina
    expect(todayAr(now)).toBe("2026-10-13");
    expect(defaultServicePeriod(now)).toEqual({ from: "2026-10-13", to: "2026-10-13", due: "2026-10-13" });
    expect(servicePeriodError({ from: "2026-10-01", to: "2026-10-10", due: "2026-10-30" }, "2026-10-13")).toBeNull();
    expect(servicePeriodError({ from: "2026-10-10", to: "2026-10-01", due: "2026-10-30" }, "2026-10-13")).toMatch(/termina antes/);
    expect(servicePeriodError({ from: "2026-10-01", to: "2026-10-10", due: "2026-10-12" }, "2026-10-13")).toMatch(/anterior a hoy/);
    expect(servicePeriodError({ from: "", to: "2026-10-10", due: "2026-10-30" }, "2026-10-13")).toMatch(/fechas/);
    expect(saleErrorTitle("service_period_invalid")).toMatch(/período/);
    expect(saleErrorTitle("service_due_invalid")).toMatch(/vencimiento/);
  });
});

describe("payload del POS", () => {
  const line = (p: Partial<SaleArgsLine>): SaleArgsLine => ({
    productId: "srv-1",
    name: "Análisis microbiológico",
    quantity: 1,
    unitPrice: 72600,
    discount: 0,
    ...p,
  });

  it("la aclaración del renglón viaja a create_sale; sin editar, el servidor usa la del servicio", () => {
    const { items } = buildSaleItemsAndExtras(
      [
        line({ lineNote: "  Lote 2381\nMuestra N° 45 " }),
        line({ lineDetail: "Otro alcance", clarificationIds: ["c1", "c2"] }),
        line({}),
        line({ lineDetail: null, clarificationIds: [] }),
      ],
      [],
    );
    expect(items[0]).toMatchObject({ line_note: "Lote 2381\nMuestra N° 45" });
    expect(items[0]).not.toHaveProperty("line_detail");
    expect(items[0]).not.toHaveProperty("clarification_ids");
    expect(items[1]).toMatchObject({ line_detail: "Otro alcance", clarification_ids: ["c1", "c2"] });
    expect(items[2]).not.toHaveProperty("line_note");
    expect(items[2]).not.toHaveProperty("line_detail");
    // Sacar todo explícitamente: detalle vacío y sin aclaraciones.
    expect(items[3]).toMatchObject({ line_detail: "", clarification_ids: [] });
  });

  it("el carrito pasa sus datos de servicio y no fusiona renglones aclarados", () => {
    const base: CartLine = { lineId: "l1", productId: "srv-1", name: "Análisis", sku: null, unitPrice: 100, quantity: 1, discount: 0, unit: "un" };
    expect(cartToSaleLines([{ ...base, lineNote: "Lote 1" }])[0]).toMatchObject({ lineNote: "Lote 1" });
    expect(cartToSaleLines([base])[0]).not.toHaveProperty("lineNote");
    expect(lineHasServiceEdits(base)).toBe(false);
    expect(lineHasServiceEdits({ ...base, clarificationIds: [] })).toBe(true);

    useCartStore.getState().clear();
    const add = () => useCartStore.getState().addProduct({ id: "srv-1", name: "Análisis", sku: null, price: 100 });
    add();
    add();
    expect(useCartStore.getState().lines).toHaveLength(1);
    const id = useCartStore.getState().lines[0]!.lineId;
    useCartStore.getState().setLineService(id, { lineNote: "Muestra 45" });
    add();
    const lines = useCartStore.getState().lines;
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ quantity: 2, lineNote: "Muestra 45" });
    useCartStore.getState().setServicePeriod({ from: "2026-10-01", to: "2026-10-10", due: "2026-10-30" });
    useCartStore.getState().clear();
    expect(useCartStore.getState().servicePeriod).toBeNull();
  });
});

describe("factura de servicios", () => {
  beforeEach(() => useCartStore.getState().clear());

  it("la aclaración de cada renglón y el período llegan al comprobante", () => {
    const doc = invoiceFromTicket(sampleServiceSale(null));
    expect(doc.concepto).toBe(2);
    expect(doc.servicePeriod).toEqual({ from: "2026-10-01", to: "2026-10-10" });
    expect(doc.paymentDue).toBe("2026-10-30");
    expect(doc.lines[0]).toMatchObject({ unit: "análisis", quantity: 3 });
    expect(doc.lines[0]!.detailLines).toEqual([
      { bullet: false, text: "Según CAA art. 982" },
      { bullet: true, text: "Recuento de aerobios mesófilos" },
      { bullet: true, text: "Coliformes totales y Escherichia coli" },
      { bullet: true, text: "Pseudomonas aeruginosa" },
      { bullet: true, text: "Incluye toma de muestras en planta" },
      { bullet: false, text: "Muestras N° 45, 46 y 47 · Tanque de reserva y línea de envasado" },
    ]);
    expect(doc.lines[2]).toMatchObject({ unit: "informe", detailLines: [{ bullet: false, text: "Lote 2381 · Para presentar en ASSAL" }] });
  });

  it("sin factura: el concepto sale de los renglones (servicios y productos → 3)", () => {
    const s = sampleServiceSale(null);
    const mixed = {
      ...s,
      sale: { ...s.sale, fiscal: null },
      items: [...s.items, { id: "g1", product_name: "Frasco estéril", quantity: 2, unit_price: 1000, subtotal: 2000 }],
    };
    const doc = invoiceFromTicket(mixed);
    expect(doc.fiscal).toBe(false);
    expect(doc.concepto).toBe(3);
    expect(doc.servicePeriod).toEqual({ from: "2026-10-01", to: "2026-10-10" });
    expect(doc.lines[3]).not.toHaveProperty("detailLines");
    expect(doc.lines[3]!.unit).toBe("unidad");
  });

  it("factura de servicios vieja sin período: el que se informó a ARCA (la fecha del comprobante)", () => {
    const s = sampleServiceSale(null);
    const old = { ...s, sale: { ...s.sale, service_from: null, service_to: null, payment_due: null } };
    const doc = invoiceFromTicket(old);
    expect(doc.servicePeriod).toEqual({ from: "2026-10-13", to: "2026-10-13" });
    expect(doc.paymentDue).toBe("2026-10-13");
  });

  it("productos solos: sin período ni texto extra (igual que antes)", () => {
    const s = sampleServiceSale(null);
    const goods = {
      ...s,
      sale: { ...s.sale, fiscal: null, service_from: null, service_to: null, payment_due: null },
      items: [{ id: "g1", product_name: "Frasco", quantity: 1, unit_price: 10, subtotal: 10 }],
    };
    const doc = invoiceFromTicket(goods);
    expect(doc.concepto).toBeNull();
    expect(doc.servicePeriod).toBeNull();
    expect(doc.lines[0]).toEqual(expect.not.objectContaining({ detailLines: expect.anything() }));
  });

  for (const m of A4_MODELS) {
    it(`A4 ${m.name}: aclaraciones debajo del servicio y período facturado`, () => {
      const doc = invoiceFromTicket(sampleServiceSale(null));
      const style = resolveInvoiceStyle({ a4_model: m.key }, null, { pro: true, unbranded: true });
      const { container } = render(<InvoiceDocument doc={doc} style={style} format="a4" />);
      const text = container.textContent ?? "";
      expect(text).toContain("01/10/2026 al 10/10/2026");
      expect(text).toContain("30/10/2026");
      expect(text).toContain("Incluye toma de muestras en planta");
      expect(text).toContain("Muestras N° 45, 46 y 47");
      expect(container.querySelectorAll("[data-service-detail]").length).toBe(3);
      const keys = new Set(Array.from(container.querySelectorAll("[data-legal]")).map((e) => e.getAttribute("data-legal")));
      expect(legalRequirements(doc, "a4").filter((k) => !keys.has(k))).toEqual([]);
    });
  }

  it("ticket 80 mm: también lleva la aclaración", () => {
    const doc = invoiceFromTicket(sampleServiceSale(null));
    const style = resolveInvoiceStyle({}, null, { pro: true, unbranded: true });
    for (const model of ["clasico", "compacto", "destacado"] as const) {
      const { container } = render(<InvoiceDocument doc={doc} style={style} format="80" model={model} />);
      expect(container.textContent).toContain("Lote 2381");
      expect(container.querySelectorAll("[data-service-detail]").length).toBe(3);
    }
  });

  it("lee las columnas nuevas de la venta y sus renglones", () => {
    expect(serviceOfSale({ service_from: "2026-10-01", service_to: null, payment_due: "2026-10-30" })).toEqual({
      service_from: "2026-10-01",
      service_to: "2026-10-01",
      payment_due: "2026-10-30",
    });
    expect(serviceOfSale({ service_from: null })).toEqual({});
    expect(serviceOfItem({ unit_label: "hora", line_note: "x", line_clarifications: ["a", "", 3], line_detail: " " })).toEqual({
      unit_label: "hora",
      line_note: "x",
      line_clarifications: ["a"],
    });
  });
});

describe("migración 20261114100000", () => {
  const DIR = join(process.cwd(), "supabase", "migrations");
  const sql = readFileSync(join(DIR, "20261114100000_servicios_profesionales.sql"), "utf8");
  const adr096 = readFileSync(join(DIR, "20261109500000_create_sale_reservas_garantia.sql"), "utf8");
  const arca = readFileSync(join(DIR, "20261101100100_arca_facturacion.sql"), "utf8");
  const body = (s: string, fn: RegExp) => {
    const i = s.search(fn);
    const end = s.slice(i).search(/\n\$(function)?\$;/);
    return s.slice(i, i + end);
  };
  const ws = (s: string) => s.replace(/\s+/g, " ");
  const strip115 = (s: string) =>
    s
      .replace(", p_service jsonb DEFAULT NULL::jsonb)", ")")
      .replace(/[ \t]*-- ADR-116 >>>[\s\S]*?-- <<< ADR-116\n/g, "")
      .split("\n")
      .filter((l) => !l.includes("ADR-116"))
      .join("\n");

  it("create_sale copia la de ADR-096 y sólo agrega p_service y bloques marcados", () => {
    const fn = /create or replace function public\.create_sale\(/;
    const raw = body(sql, fn);
    const a = ws(body(adr096, fn));
    expect(a.length).toBeGreaterThan(1000);
    expect(ws(strip115(raw))).toBe(a);
    expect(raw).toContain("p_cash_shift_id uuid DEFAULT NULL::uuid, p_service jsonb DEFAULT NULL::jsonb)");
    expect(raw).toContain("_sale_apply_service(v_tenant, v_sale_id, p_items, v_line_ids, p_service, v_now_ar::date)");
  });

  it("borra la firma vieja (sin sobrecargas ambiguas) y vuelve a dar permisos", () => {
    const SIG = "jsonb, jsonb, numeric, uuid, text, jsonb, uuid, uuid, numeric, uuid, text, uuid, uuid";
    expect(sql).toContain(`drop function if exists public.create_sale(${SIG});`);
    expect(sql).toContain(`grant execute on function public.create_sale(${SIG}, jsonb) to authenticated;`);
    expect(sql).toContain(`revoke all on function public.create_sale(${SIG}, jsonb) from public, anon;`);
    expect(sql).toMatch(/revoke all on function _sale_apply_service\([^)]*\) from public, anon, authenticated;/);
  });

  it("arca_snapshot copia la de ADR-072 y suma el período del servicio", () => {
    const fn = /create or replace function arca_snapshot\(/;
    const raw = body(sql, fn);
    const stripped = raw
      .split("\n")
      .filter((l) => !l.includes("ADR-116") && !l.includes("'service_from', v_sale.service_from"))
      .join("\n");
    expect(ws(stripped)).toBe(ws(body(arca, fn)));
    expect(raw).toContain("'service_from', v_sale.service_from, 'service_to', v_sale.service_to, 'payment_due', v_sale.payment_due");
  });

  it("tabla nueva con tenant_id, RLS (select current_tenant_id()), baja lógica y auditoría", () => {
    expect(sql).toMatch(/create table if not exists service_clarifications \([\s\S]*tenant_id\s+uuid not null[\s\S]*deleted_at\s+timestamptz/);
    expect(sql).toContain("alter table service_clarifications enable row level security;");
    const policies = sql.match(/create policy[\s\S]*?;/g) ?? [];
    expect(policies.length).toBe(3);
    for (const p of policies) {
      expect(p).toContain("(select current_tenant_id())");
      expect(p).not.toMatch(/is_internal\(\)/);
    }
    expect(sql).toContain("revoke delete on service_clarifications from anon, authenticated;");
    expect(sql).toMatch(/after insert or update on service_clarifications/);
    // tenant_id explícito en todo insert (P8).
    for (const ins of sql.match(/insert into \w+ \([^)]*\)/g) ?? []) expect(ins, ins).toContain("tenant_id");
  });

  it("un servicio no lleva stock (trigger) y toda función SECURITY DEFINER fija search_path", () => {
    expect(sql).toMatch(/new\.track_stock := false/);
    expect(sql).toMatch(/before insert or update of is_service, track_stock on products/);
    const fns = sql.split(/create or replace function /i).slice(1);
    for (const f of fns) {
      const head = f.slice(0, f.search(/\$(function)?\$/));
      if (/security definer/i.test(head)) expect(head.toLowerCase()).toMatch(/set search_path/);
    }
  });

  it("FLAG-OPERATIVO: sin feature nueva de plan", () => {
    expect(sql).not.toMatch(/insert into features/);
    expect(sql).toMatch(/catalog_mode in \('productos', 'servicios', 'mixto'\)/);
  });
});
