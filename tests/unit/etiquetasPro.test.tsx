// =============================================================================
// H24 · ADR-148: etiquetas PRO.
// Tamaños en mm y grilla A4 (salteo, marcas de corte), EAN-13 (verificador y
// barras), documento de impresión (@page exacto, salto por página, sin
// estirar), diseños y su gating, contenido neto y precio por unidad,
// simulador de cuotas, link corto de la ficha, ZPL, contratos de la
// migración y la ficha pública renderizada.
// =============================================================================
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  DEFAULT_MEDIA,
  SHEET_PRESETS,
  THERMAL_PRESETS,
  cellPositions,
  labelsPerPage,
  mediaFromPreset,
  normalizeMedia,
  paginateLabels,
  sheetMedia,
  thermalMedia,
} from "@/lib/labels/media";
import { ean13Bits, ean13CheckDigit, ean13Segments, isValidEan13, toEan13 } from "@/lib/barcode/ean13";
import { resolveCode, minCodeWidthMm } from "@/lib/labels/barcodeSvg";
import { buildLabelDocument, labelMetrics, pageCount, renderLabel } from "@/lib/labels/render";
import { DEFAULT_DESIGN, DESIGN_PRESETS, designNeedsPro, inkOn, normalizeDesign, presetByKey } from "@/lib/labels/designs";
import {
  copiesFor,
  expandCopies,
  formatPrice,
  parseNetContent,
  toLabelItem,
  unitPriceOf,
  type LabelCatalogRow,
  type LabelItem,
} from "@/lib/labels/items";
import { applyPct, bestInstallmentText, installmentAmount, simulatePayments } from "@/lib/labels/paymentSim";
import { productPublicUrl, shortToUuid, uuidToShort } from "@/lib/labels/publicLink";
import { buildZpl, zplText } from "@/lib/labels/zpl";
import { normalizeSheet } from "@/lib/labels/publicSheet";
import { ProductPublicSheet } from "@/components/labels/public/ProductPublicSheet";

const item = (over: Partial<LabelItem> = {}): LabelItem => ({
  key: "p:",
  productId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  variantId: null,
  name: "Aceite de girasol 900 ml",
  variant: null,
  brand: "Natura",
  price: 2450,
  prevPrice: null,
  unitPrice: { value: 2722.22, per: "l" },
  plu: "000123",
  sku: "ACE-900",
  barcode: "7790060023684",
  imageUrl: null,
  qrUrl: null,
  date: "2026-10-15",
  ...over,
});

describe("tamaños en mm", () => {
  it("rollo de 1 columna: la página es exactamente la etiqueta", () => {
    const m = thermalMedia(THERMAL_PRESETS.find((p) => p.key === "t50x25")!);
    expect([m.pageW, m.pageH, m.labelW, m.labelH]).toEqual([50, 25, 50, 25]);
    expect(labelsPerPage(m)).toBe(1);
    expect(cellPositions(m)).toEqual([{ x: 0, y: 0, w: 50, h: 25 }]);
  });

  it("rollo de 3 columnas: ancho = 3 × 30 + 2 separaciones + liner", () => {
    const m = thermalMedia(THERMAL_PRESETS.find((p) => p.key === "t3x30x20")!);
    expect(m.pageW).toBe(3 * 30 + 2 * 2 + 2 * 1);
    expect(m.pageH).toBe(20);
    expect(cellPositions(m).map((c) => c.x)).toEqual([1, 33, 65]);
  });

  it("todos los presets térmicos tienen los tamaños pedidos", () => {
    const sizes = THERMAL_PRESETS.filter((p) => p.cols === 1).map((p) => `${p.labelW}x${p.labelH}`);
    for (const s of ["30x20", "40x25", "50x25", "50x30", "58x40", "60x40", "100x50", "100x150"]) expect(sizes).toContain(s);
  });

  it("normaliza valores fuera de rango sin tamaños negativos", () => {
    const m = normalizeMedia({ ...DEFAULT_MEDIA, labelW: -5, labelH: 9999, cols: 9 });
    expect(m.labelW).toBe(10);
    expect(m.labelH).toBe(300);
    expect(m.cols).toBe(4);
    expect(m.pageH).toBe(m.labelH);
  });
});

describe("grilla A4", () => {
  it("3 × 8 sin márgenes laterales: 70 × 37 mm", () => {
    const m = sheetMedia(SHEET_PRESETS.find((p) => p.key === "a4_3x8")!);
    expect(m.labelW).toBe(70);
    expect(m.labelH).toBe(37);
    expect(labelsPerPage(m)).toBe(24);
    const cells = cellPositions(m);
    expect(cells).toHaveLength(24);
    expect(cells[0]).toEqual({ x: 0, y: 0.5, w: 70, h: 37 });
    expect(cells[23]).toEqual({ x: 140, y: 0.5 + 7 * 37, w: 70, h: 37 });
  });

  it("márgenes y separaciones reparten el papel útil y nada se sale de la hoja", () => {
    for (const p of SHEET_PRESETS) {
      const m = sheetMedia(p);
      for (const c of cellPositions(m)) {
        expect(c.x + c.w).toBeLessThanOrEqual(m.pageW + 0.05);
        expect(c.y + c.h).toBeLessThanOrEqual(m.pageH + 0.05);
      }
    }
  });

  it("saltea etiquetas ya usadas sólo en la primera hoja", () => {
    const m = sheetMedia(SHEET_PRESETS.find((p) => p.key === "a4_3x8")!);
    const pages = paginateLabels(Array.from({ length: 30 }, (_, i) => i), m, 5);
    expect(pages).toHaveLength(2);
    expect(pages[0]!.slice(0, 5)).toEqual([null, null, null, null, null]);
    expect(pages[0]![5]).toBe(0);
    expect(pages[1]!.filter((x) => x !== null)).toHaveLength(30 - 19);
    expect(pageCount(30, m, 5)).toBe(2);
  });

  it("el salteo no aplica al rollo", () => {
    const m = thermalMedia(THERMAL_PRESETS[0]!);
    expect(paginateLabels([1, 2], m, 3)).toEqual([[1], [2]]);
  });

  it("los presets se pueden pedir por clave", () => {
    expect(mediaFromPreset("a4_4x10")?.kind).toBe("sheet");
    expect(mediaFromPreset("t60x40")?.labelW).toBe(60);
    expect(mediaFromPreset("nada")).toBeNull();
  });
});

describe("EAN-13", () => {
  it("dígito verificador GS1", () => {
    expect(ean13CheckDigit("779006002368")).toBe(4);
    expect(ean13CheckDigit("400638133393")).toBe(1);
    expect(isValidEan13("4006381333931")).toBe(true);
    expect(isValidEan13("4006381333932")).toBe(false);
  });

  it("completa 12 dígitos y rechaza lo que no es EAN", () => {
    expect(toEan13("400638133393")).toBe("4006381333931");
    expect(toEan13("ABC123")).toBeNull();
    expect(toEan13("4006381333932")).toBeNull();
  });

  it("95 módulos con guardas 101 · 01010 · 101", () => {
    const bits = ean13Bits("4006381333931");
    expect(bits).toHaveLength(95);
    expect(bits.slice(0, 3)).toBe("101");
    expect(bits.slice(45, 50)).toBe("01010");
    expect(bits.slice(92)).toBe("101");
    expect(ean13Segments("4006381333931").reduce((a, s) => a + s.width, 0)).toBe(95);
  });

  it("elige EAN-13 si corresponde y Code 128 si no", () => {
    expect(resolveCode("7790060023684", null)?.symbology).toBe("ean13");
    expect(resolveCode("ABC-1", null)?.symbology).toBe("code128");
    expect(resolveCode(null, "SKU-9")).toEqual({ symbology: "code128", value: "SKU-9" });
    expect(resolveCode("7790060023684", null, "code39")?.symbology).toBe("code39");
    expect(resolveCode(null, null)).toBeNull();
    expect(minCodeWidthMm({ symbology: "ean13", value: "7790060023684" })).toBeCloseTo(28.3, 1);
  });
});

describe("documento de impresión (el bug de la tira de página completa)", () => {
  it("rollo: @page del tamaño de la etiqueta, sin márgenes, una página por fila", () => {
    const media = thermalMedia(THERMAL_PRESETS.find((p) => p.key === "t50x25")!);
    const html = buildLabelDocument({ items: [item(), item(), item()], design: DEFAULT_DESIGN, media, mode: "print" });
    expect(html).toContain("@page{size:50mm 25mm;margin:0}");
    expect(html.match(/class="sheet"/g)).toHaveLength(3);
    expect(html).toContain(".sheet{break-after:page;page-break-after:always}");
    expect(html).toContain('style="width:50mm;height:25mm"');
    // Nada de la hoja vieja: ni fixed/inset ni grilla que se estire al alto de la página.
    expect(html).not.toMatch(/position:fixed|inset:0|ticket-print|min-height:100/);
  });

  it("A4: una hoja por página con la grilla posicionada en mm", () => {
    const media = sheetMedia(SHEET_PRESETS.find((p) => p.key === "a4_3x8")!);
    const html = buildLabelDocument({ items: Array.from({ length: 25 }, () => item()), design: DEFAULT_DESIGN, media, mode: "print" });
    expect(html).toContain("@page{size:210mm 297mm;margin:0}");
    expect(html.match(/class="sheet"/g)).toHaveLength(2);
    expect(html).toContain('class="cell" style="left:70mm;top:0.5mm;width:70mm;height:37mm"');
  });

  it("marcas de corte sólo en hojas con la opción", () => {
    const media = { ...sheetMedia(SHEET_PRESETS.find((p) => p.key === "a4_cut_3x6")!), cutMarks: true };
    const html = buildLabelDocument({ items: [item()], design: DEFAULT_DESIGN, media, mode: "print" });
    expect(html).toContain('class="cut"');
    expect(html).toContain('class="cut-box"');
  });

  it("cada etiqueta es una caja fija del tamaño de la celda", () => {
    const html = renderLabel(item(), DEFAULT_DESIGN, 40, 25);
    expect(html).toMatch(/^<div class="lb lay-gondola" style="width:40mm;height:25mm;/);
    expect(html).toContain("PLU 000123");
    expect(html).toContain('aria-label="EAN-13 7790060023684"');
  });

  it("si los datos no entran, achica en vez de desbordar", () => {
    const d = { ...DEFAULT_DESIGN, show: { ...DEFAULT_DESIGN.show, brand: true, sku: true, date: true, prevPrice: true }, footer: "Precio final" };
    const small = renderLabel(item({ prevPrice: 3000 }), d, 30, 20);
    const big = renderLabel(item({ prevPrice: 3000 }), d, 100, 50);
    const fs = (h: string) => Number(/class="pr" style="font-size:([\d.]+)mm"/.exec(h)![1]);
    expect(fs(small)).toBeLessThan(labelMetrics(30, 20, d).priceFs);
    expect(fs(big)).toBeGreaterThan(fs(small));
  });

  it("vista previa con zoom y sin @page", () => {
    const html = buildLabelDocument({ items: [item()], design: DEFAULT_DESIGN, media: DEFAULT_MEDIA, mode: "preview", zoom: 2 });
    expect(html).toContain("zoom:2");
    expect(html).not.toContain("@page");
  });

  it("QR a la ficha y escape de HTML", () => {
    const d = { ...DEFAULT_DESIGN, show: { ...DEFAULT_DESIGN.show, qr: true } };
    const html = renderLabel(item({ name: "<script>x</script>", qrUrl: "https://pos.soft.ninja/p/x/AAAAAAAAAAAAAAAAAAAAAA" }), d, 60, 40);
    expect(html).toContain('class="qr"');
    expect(html).not.toContain("<script>");
  });
});

describe("diseños", () => {
  it("hay ocho modelos y cada uno se normaliza a sí mismo", () => {
    expect(DESIGN_PRESETS.map((p) => p.key)).toEqual(["gondola", "precio_grande", "oferta", "minimal", "logo", "foto", "solo_codigo", "colgante"]);
    for (const p of DESIGN_PRESETS) expect(normalizeDesign(p.design)).toEqual(p.design);
  });

  it("todos los modelos dibujan sin romper en todos los tamaños", () => {
    for (const p of DESIGN_PRESETS) {
      for (const t of THERMAL_PRESETS) {
        const html = renderLabel(item({ prevPrice: 3000, qrUrl: "https://x.y/p/a/AAAAAAAAAAAAAAAAAAAAAA" }), { ...p.design, show: { ...p.design.show, qr: true } }, t.labelW, t.labelH, {
          businessName: "Mi negocio",
          logoUrl: "https://x.y/logo.png",
        });
        expect(html.startsWith(`<div class="lb lay-${p.design.layout}"`)).toBe(true);
      }
    }
  });

  it("básico sin tocar es gratis; personalizar, modelos PRO o QR piden el plan", () => {
    expect(designNeedsPro(presetByKey("gondola")!.design)).toBe(false);
    expect(designNeedsPro(presetByKey("minimal")!.design)).toBe(false);
    expect(designNeedsPro(presetByKey("oferta")!.design)).toBe(true);
    expect(designNeedsPro({ ...DEFAULT_DESIGN, priceScale: 1.3 })).toBe(true);
    expect(designNeedsPro({ ...DEFAULT_DESIGN, show: { ...DEFAULT_DESIGN.show, qr: true } })).toBe(true);
  });

  it("acota lo que viene de una plantilla guardada", () => {
    const d = normalizeDesign({ layout: "oferta", priceScale: 9, accent: "rojo", font: "comic", show: { qr: "si", price: false } });
    expect(d.layout).toBe("oferta");
    expect(d.priceScale).toBe(1.6);
    expect(d.accent).toBe("#E11D2E");
    expect(d.font).toBe("sans");
    expect(d.show.price).toBe(false);
    expect(d.show.qr).toBe(false);
  });

  it("texto legible sobre la banda", () => {
    expect(inkOn("#E11D2E")).toBe("#fff");
    expect(inkOn("#F5B800")).toBe("#000");
  });
});

describe("cantidades, contenido neto y precio por unidad", () => {
  it("una, igual al stock (redondeo arriba) o fija", () => {
    expect(copiesFor("one", 0, 5)).toBe(1);
    expect(copiesFor("stock", 3.2, 5)).toBe(4);
    expect(copiesFor("stock", 0, 5)).toBe(0);
    expect(copiesFor("stock", null, 5)).toBe(0);
    expect(copiesFor("fixed", 99, 7)).toBe(7);
  });

  it("expande copias con tope", () => {
    const r = expandCopies([{ item: "a", copies: 2 }, { item: "b", copies: 3 }], 4);
    expect(r).toEqual({ items: ["a", "a", "b", "b"], truncated: true });
  });

  it("lee el contenido del nombre", () => {
    expect(parseNetContent("Aceite 900 ml")).toEqual({ qty: 900, unit: "ml" });
    expect(parseNetContent("Gaseosa 2,25 L")).toEqual({ qty: 2.25, unit: "l" });
    expect(parseNetContent("Yerba 1kg")).toEqual({ qty: 1, unit: "kg" });
    expect(parseNetContent("Galletitas 3 x 100 g")).toEqual({ qty: 300, unit: "g" });
    expect(unitPriceOf(4590, { qty: 1, unit: "kg" })).toBeNull();
    expect(parseNetContent("Remera talle M")).toBeNull();
  });

  it("precio por kg / litro (Ley de Góndolas)", () => {
    expect(unitPriceOf(2450, { qty: 900, unit: "ml" })).toEqual({ value: 2722.22, per: "l" });
    expect(unitPriceOf(1500, { qty: 500, unit: "g" })).toEqual({ value: 3000, per: "kg" });
    expect(unitPriceOf(8000, { qty: 1, unit: "kg" }, "kg")).toBeNull();
    expect(unitPriceOf(100, null)).toBeNull();
  });

  it("arma la etiqueta con contenido de la ficha o del nombre", () => {
    const row: LabelCatalogRow = {
      product_id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      variant_id: null,
      name: "Detergente 750 ml",
      variant_label: null,
      brand: null,
      category: null,
      sku: null,
      barcode: null,
      plu: null,
      unit: "un",
      price: 1000,
      image_url: null,
      net_content: null,
      net_content_unit: null,
      stock: 3,
    };
    expect(toLabelItem(row, { price: 1500 }).unitPrice).toEqual({ value: 2000, per: "l" });
    expect(toLabelItem({ ...row, net_content: 1.5, net_content_unit: "l" }, { price: 1500 }).unitPrice).toEqual({ value: 1000, per: "l" });
    expect(toLabelItem(row, { price: 1500, prevPrice: 1200 }).prevPrice).toBeNull();
    expect(toLabelItem(row, { price: 1500, prevPrice: 1800 }).prevPrice).toBe(1800);
  });

  it("formato de precio argentino", () => {
    expect(formatPrice(1234.5)).toBe("$ 1.234,50");
    expect(formatPrice(1234)).toBe("$ 1.234");
    expect(formatPrice(1234.5, "never")).toBe("$ 1.235");
  });
});

describe("simulador de cuotas", () => {
  const methods = [
    { key: "cash", name: "Efectivo", kind: "manual", surcharge_pct: -10 },
    { key: "transfer", name: "Transferencia", kind: "manual", surcharge_pct: 0 },
    { key: "payway", name: "Payway", kind: "gateway", surcharge_pct: 0 },
  ];
  const plans = [
    { label: "1 pago", base: "credito", brand: "visa", installments: 1, surcharge_pct: 0, provider_key: "payway" },
    { label: "3 cuotas sin interés", base: "credito", brand: "visa", installments: 3, surcharge_pct: 0, provider_key: "payway" },
    { label: "12 cuotas", base: "credito", brand: "visa", installments: 12, surcharge_pct: 35, provider_key: "payway" },
    { label: "12 cuotas", base: "credito", brand: "visa", installments: 12, surcharge_pct: 35, provider_key: "getnet" },
    { label: "Débito", base: "debito", brand: null, installments: 1, surcharge_pct: 0, provider_key: "payway" },
  ];

  it("recargo y descuento como en la caja, cuota = total ÷ cuotas", () => {
    expect(applyPct(10000, 35)).toBe(13500);
    expect(applyPct(10000, -10)).toBe(9000);
    expect(installmentAmount(13500, 12)).toBe(1125);
    expect(installmentAmount(100, 3)).toBe(33.33);
  });

  it("agrupa medios y planes, sin duplicados y ordenado por cuotas", () => {
    const g = simulatePayments(10000, methods, plans);
    expect(g.map((x) => x.key)).toEqual(["methods", "credito", "debito"]);
    expect(g[0]!.rows.map((r) => [r.label, r.total])).toEqual([
      ["Efectivo", 9000],
      ["Transferencia", 10000],
    ]);
    const credit = g[1]!.rows;
    expect(credit.map((r) => r.installments)).toEqual([1, 3, 12]);
    expect(credit[2]).toMatchObject({ total: 13500, perInstallment: 1125, detail: "Visa" });
  });

  it("texto de la mejor opción", () => {
    const g = simulatePayments(10000, methods, plans);
    expect(bestInstallmentText(g, (n) => `$${n}`)).toBe("Hasta 12 cuotas de $1125");
    expect(bestInstallmentText(simulatePayments(9000, [], plans.slice(0, 2)), (n) => `$${n}`)).toBe("Hasta 3 cuotas de $3000 sin interés");
    expect(simulatePayments(0, methods, plans)).toEqual([]);
  });
});

describe("link de la ficha pública", () => {
  it("UUID ↔ código de 22 caracteres", () => {
    const id = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
    const code = uuidToShort(id);
    expect(code).toHaveLength(22);
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(shortToUuid(code)).toBe(id);
  });

  it("rechaza códigos inválidos", () => {
    expect(shortToUuid("corto")).toBeNull();
    expect(shortToUuid("A".repeat(21) + "!")).toBeNull();
    expect(shortToUuid("A".repeat(21) + "B")).toBeNull(); // bits sobrantes
  });

  it("arma la URL con el slug", () => {
    expect(productPublicUrl("https://pos.soft.ninja/", "mi tienda", "3f2504e0-4f89-41d3-9a0c-0305e82c3301")).toBe(
      `https://pos.soft.ninja/p/mi%20tienda/${uuidToShort("3f2504e0-4f89-41d3-9a0c-0305e82c3301")}`,
    );
  });
});

describe("ZPL", () => {
  it("una orden por fila del rollo con ancho y largo en puntos", () => {
    const media = thermalMedia(THERMAL_PRESETS.find((p) => p.key === "t2x40x25")!);
    const z = buildZpl([item(), item(), item()], DEFAULT_DESIGN, media, 203);
    expect(z.match(/\^XA/g)).toHaveLength(2);
    expect(z).toContain(`^PW${Math.round(media.pageW * 8)}`);
    expect(z).toContain("^LL200");
    expect(z).toContain("^BEN");
    expect(z).toContain("^FD779006002368^FS");
  });

  it("texto sin acentos ni comandos", () => {
    expect(zplText("Café ^XZ ~ñandú")).toBe("Cafe  XZ  nandu");
  });
});

describe("migración", () => {
  const sql = readFileSync(join(process.cwd(), "supabase/migrations/20261216100000_etiquetas_pro.sql"), "utf8");

  it("feature OPTIONAL marcada por plan", () => {
    expect(sql).toMatch(/'etiquetas_pro',[\s\S]*'catalogo', false/);
    expect(sql).toContain("p.key in ('pro', 'business', 'enterprise')");
  });

  it("plantillas con RLS por tenant, gating server-side, auditoría y sin is_internal", () => {
    expect(sql).toContain("alter table label_templates enable row level security");
    expect(sql).toContain("tenant_has_feature_for((select current_tenant_id()), 'etiquetas_pro')");
    expect(sql).toContain("(select has_capability('products.edit'))");
    expect(sql).toContain("execute function write_audit_log()");
    expect(sql).not.toMatch(/is_internal\(\)/);
    expect(sql).not.toMatch(/for delete/i);
  });

  it("ficha pública: anon, security definer, gateada por plan y por negocio", () => {
    expect(sql).toMatch(/function public\.public_product_sheet\(p_slug text, p_product uuid\)[\s\S]*security definer/);
    expect(sql).toContain("tenant_has_feature_for(t.id, 'etiquetas_pro')");
    expect(sql).toContain("p.tenant_id = v_t.id");
    expect(sql).toContain("grant execute on function public.public_product_sheet(text, uuid) to anon, authenticated");
    expect(sql).toContain("_catalog_ordering(v_t.id)");
  });

  it("catálogo para etiquetar: sólo el negocio del usuario y no para anon", () => {
    expect(sql).toContain("p.tenant_id = v_tenant");
    expect(sql).toContain("has_capability('products.view')");
    expect(sql).toMatch(/revoke all on function label_catalog\([^)]*\) from public, anon/);
  });
});

describe("ficha pública (componente)", () => {
  const sheet = normalizeSheet({
    tenant: { name: "Almacén Lucas", slug: "almacen-lucas" },
    branding: { logo_url: null, accent: "#FF4B22", legal_name: null, trade_name: "Almacén Lucas", phone: "341 555-0000", address: "San Martín 100" },
    product: {
      id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      name: "Aceite de girasol 900 ml",
      description: "Primera prensada en frío.",
      brand: "Natura",
      category: "Almacén",
      unit: "un",
      price: "10000",
      net_content: null,
      net_content_unit: null,
      images: ["https://x.y/a.jpg", "javascript:alert(1)"],
      variants: null,
    },
    payments: {
      methods: [{ key: "cash", name: "Efectivo", kind: "manual", surcharge_pct: -10 }],
      plans: [{ label: "12 cuotas", base: "credito", brand: "visa", installments: 12, surcharge_pct: 35, provider_key: "payway" }],
    },
    catalog: { enabled: true, ordering: false },
  })!;

  it("normaliza y filtra URLs que no son http", () => {
    expect(sheet.product.price).toBe(10000);
    expect(sheet.product.images).toEqual(["https://x.y/a.jpg"]);
  });

  it("muestra precio, precio por litro, simulador y no ofrece comprar sin carrito", () => {
    render(<ProductPublicSheet sheet={sheet} business="Almacén Lucas" palette={{ accent: "#FF4B22", accentInk: "#fff", accentText: "#B32A0B" }} />);
    expect(screen.getByRole("heading", { name: "Aceite de girasol 900 ml" })).toBeTruthy();
    expect(screen.getByText(/x l$/)).toBeTruthy();
    expect(screen.getByText(/Hasta 12 cuotas de/)).toBeTruthy();
    expect(screen.queryByText(/Pedirlo desde el catálogo/)).toBeNull();
    expect(screen.getByText("Ver más productos")).toBeTruthy();
    expect(screen.getByText("Efectivo")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Tarjeta de crédito" }));
    expect(screen.getByText(/12 x/)).toBeTruthy();
  });
});
