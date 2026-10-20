// F24 · H167 (ADR-178): Compras PRO. Lógica pura (import de ARCA, créditos
// aplicados, renglones, padrón del proveedor, lectura con IA) y controles de
// la migración 20270116100000.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ARCA_CBTE,
  arcaAmounts,
  arcaStatus,
  cuitFromTitle,
  inferRate,
  mapArcaHeaders,
  parseArcaGrid,
  parseCbteType,
  parseCsv,
  parseCurrency,
  prepareArcaRows,
  rateHeader,
} from "@/lib/purchases/arcaImport";
import {
  autoApplyCredit,
  openAfterCredits,
  validateCreditApplications,
  type OpenCredit,
} from "@/lib/purchases/credits";
import { lineNet, linesVat, validateLines } from "@/lib/purchases/invoiceLines";
import { padronToSupplier, provinceFromPadron } from "@/lib/purchases/suppliers";
import { ENTRY_TYPE_LABEL, supplierAging } from "@/lib/purchases/aging";
import type { OpenInvoice } from "@/lib/purchases/paymentOrders";
import {
  claudeRequest,
  extractJson,
  geminiRequest,
  validateOcr,
} from "@/supabase/functions/_shared/purchaseInvoiceOcr";
import type { PadronPersona } from "@/lib/customers/padron";

const MIGRATION = "supabase/migrations/20270116100000_h167_compras.sql";
const sql = readFileSync(join(process.cwd(), MIGRATION), "utf8");

// CUIT válidas (dígito verificador correcto).
const CUIT_A = "30500010912";
const CUIT_B = "20123456786";
const MINE = "30712345671";

const CLASSIC_HEADERS = [
  "Fecha",
  "Tipo",
  "Punto de Venta",
  "Número Desde",
  "Número Hasta",
  "Cód. Autorización",
  "Tipo Doc. Emisor",
  "Nro. Doc. Emisor",
  "Denominación Emisor",
  "Tipo Cambio",
  "Moneda",
  "Imp. Neto Gravado",
  "Imp. Neto No Gravado",
  "Imp. Op. Exentas",
  "Otros Tributos",
  "IVA",
  "Imp. Total",
];

function classicGrid(rows: string[][]): string[][] {
  return [[`Mis Comprobantes Recibidos - CUIT ${MINE}`], CLASSIC_HEADERS, ...rows];
}

describe("ARCA: encabezados y tipos", () => {
  it("mapea el diseño clásico con la fila de título arriba", () => {
    const p = parseArcaGrid(
      classicGrid([
        ["01/05/2026", "1 - Factura A", "3", "1234", "1234", "75123456789012", "80", CUIT_A, "Proveedor SA", "1", "$", "1000", "0", "0", "0", "210", "1210"],
      ]),
    );
    expect(p.fatalError).toBeNull();
    expect(p.layout).toBe("clasico");
    expect(p.receptorCuit).toBe(MINE);
    const r = p.rows[0]!;
    expect(r).toMatchObject({
      rowNumber: 3,
      issue_date: "2026-05-01",
      cbte_type: 1,
      kind: "invoice",
      letter: "A",
      point_of_sale: 3,
      number: 1234,
      cae: "75123456789012",
      issuer_cuit: CUIT_A,
      currency: "ARS",
      fx_rate: 1,
      total: 1210,
    });
    expect(r.errors).toEqual([]);
  });

  it("reconoce las columnas por alícuota del diseño nuevo", () => {
    expect(rateHeader("neto gravado iva 21%")).toEqual({ rate: 21, part: "net" });
    expect(rateHeader("iva 10,5%")).toEqual({ rate: 10.5, part: "vat" });
    expect(rateHeader("iva 2 5%")).toEqual({ rate: 2.5, part: "vat" });
    expect(rateHeader("imp total")).toBeNull();
    const cols = mapArcaHeaders([...CLASSIC_HEADERS, "Neto Grav. IVA 21%", "IVA 21%", "Neto Grav. IVA 10,5%", "IVA 10,5%"]);
    expect(cols?.rates).toEqual([
      { rate: 10.5, net: 19, vat: 20 },
      { rate: 21, net: 17, vat: 18 },
    ]);
  });

  it("no acepta un archivo sin las columnas de ARCA", () => {
    expect(parseArcaGrid([["Producto", "Precio"], ["x", "1"]]).fatalError).toMatch(/Mis Comprobantes/);
  });

  it("tipo por código o por texto, incluida la FCE MiPyMEs", () => {
    expect(parseCbteType("11 - Factura C")).toBe(11);
    expect(parseCbteType("Nota de Crédito B")).toBe(8);
    expect(parseCbteType("Factura de Crédito Electrónica MiPyMEs (FCE) A")).toBe(201);
    expect(ARCA_CBTE[203]).toEqual({ kind: "credit_note", letter: "A" });
    expect(parseCurrency("DOL")).toBe("USD");
    expect(parseCurrency("$")).toBe("ARS");
    expect(cuitFromTitle(["CUIT: 30-71234567-1"])).toBe(MINE);
  });

  it("el mapa TS coincide con purchase_arca_cbte de la migración", () => {
    for (const [code, v] of Object.entries(ARCA_CBTE)) {
      expect(sql).toContain(`(${code}, '${v.kind}', '${v.letter}')`);
    }
  });

  it("lee el CSV con ; y comillas", () => {
    expect(parseCsv('"Fecha";"Tipo"\r\n"01/05/2026";"1 - Factura A"\r\n')).toEqual([
      ["Fecha", "Tipo"],
      ["01/05/2026", "1 - Factura A"],
    ]);
  });
});

describe("ARCA: importes y estados", () => {
  const base = parseArcaGrid(
    classicGrid([
      ["01/05/2026", "1 - Factura A", "3", "10", "10", "", "80", CUIT_A, "Prov A", "1", "PES", "1000", "0", "0", "30", "210", "1240"],
      ["02/05/2026", "11 - Factura C", "1", "5", "5", "", "80", CUIT_B, "Mono", "1", "PES", "0", "0", "0", "0", "0", "500"],
      ["03/05/2026", "1 - Factura A", "3", "11", "11", "", "80", CUIT_A, "Prov A", "1", "PES", "2000", "0", "0", "0", "315", "2315"],
      ["01/05/2026", "1 - Factura A", "3", "10", "10", "", "80", CUIT_A, "Prov A", "1", "PES", "1000", "0", "0", "30", "210", "1240"],
    ]),
  );

  it("A con IVA total: infiere la alícuota; otros tributos aparte", () => {
    const a = arcaAmounts(base.rows[0]!);
    expect(a.errors).toEqual([]);
    expect(a.amounts).toMatchObject({
      vat_lines: [{ rate: 21, net: 1000, vat: 210 }],
      other_taxes: [{ kind: "otro", amount: 30 }],
      total: 1240,
    });
    expect(inferRate(1000, 105)).toBe(10.5);
  });

  it("C va con el importe entero como neto sin IVA", () => {
    expect(arcaAmounts(base.rows[1]!).amounts?.vat_lines).toEqual([{ rate: 0, net: 500, vat: 0 }]);
  });

  it("IVA de varias alícuotas sin desglose: error de la fila", () => {
    // 2000 de neto con 315 de IVA (1000 al 21 % + 1000 al 10,5 %).
    expect(arcaAmounts(base.rows[2]!).errors[0]).toMatch(/una sola alícuota/);
  });

  it("duplicado en el archivo, CUIT ajena y estados con la respuesta del servidor", () => {
    const prepared = prepareArcaRows(base, "30-99999999-9");
    expect(prepared[3]!.errors).toContain("Está repetido en el archivo.");
    // El título trae la CUIT de otro negocio: todas son ajenas.
    expect(prepared[0]!.foreign).toBe(true);
    const mine = prepareArcaRows(base, MINE);
    expect(mine[0]!.foreign).toBe(false);
    expect(arcaStatus(mine[0]!, { action: "create", message: null })).toBe("nuevo");
    expect(arcaStatus(mine[1]!, { action: "create", message: "supplier_new" })).toBe("proveedor_a_crear");
    expect(arcaStatus(mine[0]!, { action: "skip", message: "duplicate" })).toBe("duplicado");
    expect(arcaStatus(mine[2]!, undefined)).toBe("error");
    expect(arcaStatus(prepared[0]!, { action: "create", message: null })).toBe("receptor_distinto");
    expect(mine[0]!.payload).toMatchObject({ _row: 3, cbte_type: 1, issuer_cuit: CUIT_A, point_of_sale: 3, number: 10 });
  });

  it("el total que supera la suma queda como otros tributos sin detalle (con aviso)", () => {
    const p = parseArcaGrid(
      classicGrid([["01/05/2026", "1 - Factura A", "3", "12", "12", "", "80", CUIT_A, "P", "1", "PES", "1000", "0", "0", "0", "210", "1260"]]),
    );
    const a = arcaAmounts(p.rows[0]!);
    expect(a.amounts?.other_taxes).toEqual([{ kind: "otro", description: "Percepciones u otros sin detalle (ARCA)", amount: 50 }]);
    expect(a.warnings).toHaveLength(1);
  });

  it("rango de comprobantes y CUIT inválida son errores", () => {
    const p = parseArcaGrid(
      classicGrid([["01/05/2026", "6 - Factura B", "3", "12", "15", "", "80", "20123456780", "P", "1", "PES", "0", "0", "0", "0", "0", "100"]]),
    );
    expect(p.rows[0]!.errors.join(" ")).toMatch(/rango/);
    expect(p.rows[0]!.errors.join(" ")).toMatch(/CUIT/);
  });
});

describe("Créditos aplicados a facturas", () => {
  const docs: OpenInvoice[] = [
    { invoice_id: "f1", label: "FC 1", issue_date: "2026-04-01", due_date: "2026-04-30", amount_ars: 1000, open_ars: 1000 },
    { invoice_id: "f2", label: "FC 2", issue_date: "2026-05-01", due_date: "2026-05-30", amount_ars: 800, open_ars: 800 },
  ];
  const nc: OpenCredit = {
    source_type: "credit_note",
    source_id: "nc1",
    label: "NC A 00003-00000001",
    doc_date: "2026-05-02",
    amount_ars: 1200,
    applied_ars: 0,
    available_ars: 1200,
  };

  it("aplica por vencimiento, por partes", () => {
    expect(autoApplyCredit(nc, docs)).toEqual([
      { source_type: "credit_note", source_id: "nc1", invoice_id: "f1", amount: 1000 },
      { source_type: "credit_note", source_id: "nc1", invoice_id: "f2", amount: 200 },
    ]);
    expect(openAfterCredits(docs, autoApplyCredit(nc, docs, 300)).map((d) => d.open_ars)).toEqual([700, 800]);
  });

  it("no deja aplicar más que el crédito ni que el saldo", () => {
    expect(
      validateCreditApplications(
        [{ source_type: "credit_note", source_id: "nc1", invoice_id: "f2", amount: 900 }],
        [nc],
        docs,
      ),
    ).toEqual(["Aplicaste más que el saldo de un comprobante."]);
    expect(
      validateCreditApplications(
        [
          { source_type: "credit_note", source_id: "nc1", invoice_id: "f1", amount: 1000 },
          { source_type: "credit_note", source_id: "nc1", invoice_id: "f2", amount: 300 },
        ],
        [nc],
        docs,
      ),
    ).toEqual(["Aplicaste más que el saldo disponible de un crédito."]);
  });

  it("en el aging una NC aplicada baja la factura elegida (no la más vieja)", () => {
    const entries = [
      { doc_id: "f1", entry_type: "invoice" as const, doc_label: "FC 1", doc_date: "2026-04-01", due_date: "2026-04-30", amount_ars: 1000 },
      { doc_id: "f2", entry_type: "invoice" as const, doc_label: "FC 2", doc_date: "2026-05-01", due_date: "2026-05-30", amount_ars: 800 },
      { doc_id: "nc1", entry_type: "credit_note" as const, doc_label: "NC", doc_date: "2026-05-02", due_date: "2026-05-02", amount_ars: -800 },
    ];
    const r = supplierAging(entries, "2026-06-15", [{ invoice_id: "f2", amount: 800 }]);
    expect(r.open.map((d) => [d.doc_id, d.open])).toEqual([["f1", 1000]]);
  });

  it("saldo inicial y ajuste tienen etiqueta en la cuenta", () => {
    expect(ENTRY_TYPE_LABEL.opening).toBe("Saldo inicial");
    expect(ENTRY_TYPE_LABEL.adjustment).toBe("Ajuste");
  });
});

describe("Renglones de la factura", () => {
  it("neto e IVA por alícuota", () => {
    const lines = [
      { kind: "item" as const, product_id: "p", qty: 3, unit_cost: 100, vat_rate: 21 },
      { kind: "expense" as const, description: "Flete", net: 50, vat_rate: 21 },
      { kind: "expense" as const, description: "Libros", net: 40, vat_rate: 0 },
    ];
    expect(lineNet(lines[0]!)).toBe(300);
    expect(linesVat(lines)).toEqual([
      { rate: 21, net: 350, vat: 73.5 },
      { rate: 0, net: 40, vat: 0 },
    ]);
  });

  it("artículos exigen sucursal y sólo van en el alta; no superan el neto", () => {
    const item = [{ kind: "item" as const, product_id: "p", qty: 1, unit_cost: 100, vat_rate: 21 }];
    expect(validateLines(item, { invoiceNet: 100, hasStore: false, editing: false })).toEqual([
      "Elegí la sucursal que recibe la mercadería.",
    ]);
    expect(validateLines(item, { invoiceNet: 100, hasStore: true, editing: true })).toContain(
      "Los artículos con recepción se cargan sólo en el alta del comprobante.",
    );
    expect(validateLines(item, { invoiceNet: 50, hasStore: true, editing: false })).toEqual([
      "Los renglones suman más que el neto del comprobante.",
    ]);
  });
});

describe("Padrón de ARCA en el alta del proveedor", () => {
  it("vuelca razón social, condición, domicilio y provincia", () => {
    const persona = {
      cuit: CUIT_A,
      tipo_persona: "JURIDICA",
      razon_social: "DISTRIBUIDORA SA",
      estado_clave: "ACTIVO",
      activa: true,
      domicilio: "AV SIEMPRE VIVA 123",
      provincia: "CORDOBA",
      iva_condition: "responsable_inscripto",
      iva_source: "regimen_general",
      impuestos: [30],
      monotributo_categoria: null,
      avisos: [],
      domicilio_partes: { direccion: "AV SIEMPRE VIVA 123", localidad: "CORDOBA", provincia: "CORDOBA", cod_postal: "5000", id_provincia: 3 },
    } satisfies PadronPersona;
    expect(padronToSupplier(persona)).toEqual({
      name: "DISTRIBUIDORA SA",
      iva_condition: "responsable_inscripto",
      address: "AV SIEMPRE VIVA 123",
      city: "CORDOBA",
      province: "Córdoba",
    });
    expect(provinceFromPadron(null, "CIUDAD AUTONOMA BUENOS AIRES")).toBe("CABA");
    expect(provinceFromPadron(null, "ENTRE RIOS")).toBe("Entre Ríos");
  });
});

describe("Lectura de facturas con IA", () => {
  it("valida estricto y avisa lo que no cierra", () => {
    const r = validateOcr(
      extractJson(
        '```json\n{"supplier_cuit":"30-50001091-2","supplier_name":"Prov","kind":"invoice","letter":"a","point_of_sale":"0003","number":1234,"issue_date":"15/05/2026","cae":"75123456789012","vat_lines":[{"rate":21,"net":"1.000,00","vat":210},{"rate":19,"net":1,"vat":1}],"other_taxes":[{"kind":"percepcion_iibb","amount":30}],"total":1240,"items":[{"description":"Yerba","qty":10,"unit_price":100,"vat_rate":21}]}\n```',
      ),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toMatchObject({
      supplier_cuit: CUIT_A,
      letter: "A",
      point_of_sale: 3,
      number: 1234,
      issue_date: "2026-05-15",
      cae: "75123456789012",
      vat_lines: [{ rate: 21, net: 1000, vat: 210 }],
      other_taxes: [{ kind: "percepcion_iibb", amount: 30 }],
      total: 1240,
    });
    expect(r.data.items).toHaveLength(1);
    expect(r.warnings.join(" ")).toMatch(/Alícuota de IVA no válida/);
  });

  it("CUIT con dígito mal y total que no suma quedan como aviso", () => {
    const r = validateOcr({ supplier_cuit: "30500010913", letter: "B", vat_lines: [{ rate: 0, net: 100, vat: 0 }], total: 150 });
    expect(r.ok && r.data.supplier_cuit).toBe(null);
    expect(r.ok && r.warnings.join(" ")).toMatch(/CUIT leída no es válida.*no suman/s);
    expect(validateOcr("texto").ok).toBe(false);
    expect(() => extractJson("sin json")).toThrow();
  });

  it("PDF va como document y la foto como image", () => {
    const pdf = claudeRequest("claude-opus-5-5", "application/pdf", "AAA") as { messages: Array<{ content: Array<{ type: string }> }> };
    expect(pdf.messages[0]!.content[0]!.type).toBe("document");
    const img = claudeRequest("claude-haiku-4-5", "image/jpeg", "AAA") as Record<string, unknown>;
    expect((img.messages as Array<{ content: Array<{ type: string }> }>)[0]!.content[0]!.type).toBe("image");
    expect(img.output_config).toBeUndefined();
    expect(geminiRequest("image/png", "AAA").contents[0]!.parts[0]).toEqual({ inline_data: { mime_type: "image/png", data: "AAA" } });
  });
});

describe("Migración H167", () => {
  it("tablas nuevas con RLS por negocio (initplan) y sin is_internal suelto", () => {
    for (const t of [
      "supplier_invoice_lines",
      "purchase_invoice_inbox",
      "supplier_credit_applications",
      "supplier_account_adjustments",
    ]) {
      expect(sql).toContain(`alter table public.${t} enable row level security;`);
      expect(sql).toMatch(new RegExp(`create policy ${t}_select on public\\.${t} for select to authenticated\\s+using \\(\\(tenant_id = \\(select current_tenant_id\\(\\)\\)\\) or \\(select internal_scope\\(\\)\\)\\);`));
      expect(sql).toContain(`revoke insert, update, delete on public.${t} from authenticated;`);
    }
    expect(sql).not.toMatch(/is_internal\(\)/);
  });

  it("las RPC de escritura exigen plan, rol y capacidad", () => {
    for (const fn of [
      "supplier_invoice_save_full",
      "purchase_arca_import",
      "purchase_inbox_add",
      "purchase_inbox_set_status",
      "supplier_credit_apply",
      "supplier_credit_unapply",
      "supplier_adjustment_create",
      "supplier_adjustment_void",
    ]) {
      const body = sql.slice(sql.indexOf(`function public.${fn}(`));
      expect(body.slice(0, 1500), fn).toContain("_purchase_write_assert()");
    }
  });

  it("la orden de pago aplica créditos antes de imputar y usa el saldo con créditos", () => {
    const op = sql.slice(sql.indexOf("function public.supplier_payment_order_create"));
    expect(op.indexOf("_supplier_credit_apply")).toBeGreaterThan(0);
    expect(op.indexOf("_supplier_credit_apply")).toBeLessThan(op.indexOf("-- Imputación."));
    expect(op).toContain("v_open := supplier_doc_open_ars(v_inv.id);");
    // Copia de la definición viva: retenciones como agente intactas.
    expect(op).toContain("_tax_retention_compute(");
  });

  it("el guard de H158 cuenta los créditos aplicados y el import respeta la letra", () => {
    const g = sql.slice(sql.indexOf("function public.trg_supplier_invoice_paid_guard"));
    expect(g.slice(0, 1200)).toContain("supplier_credit_applications");
    const imp = sql.slice(sql.indexOf("function public.purchase_arca_import"));
    expect(imp).toContain("supplier_invoice_letters(v_sup.iva_condition, v_buyer)");
    expect(imp).toContain("raise exception 'dry_run_ok'");
  });
});
