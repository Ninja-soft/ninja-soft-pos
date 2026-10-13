// @vitest-environment node
// Libro IVA Digital (F18 · H108, ADR-076): formateador de ancho fijo,
// validaciones previas y golden files de un período completo.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FILE_NAMES,
  LibroFormatError,
  RECORD_LENGTH,
  buildCompra,
  buildLibroIva,
  buildVenta,
  codigoOperacion,
  compraCbteLine,
  fmtAmount,
  fmtDate,
  fmtFx,
  fmtNum,
  fmtText,
  normalizeText,
  toCents,
  ventaAlicuotaLine,
  ventaCbteLine,
  zipName,
  type LibroCompraDoc,
  type LibroData,
  type LibroIssue,
  type LibroVentaDoc,
} from "@/lib/tax/libroIva";
import { crc32, createZip, readStoredZip } from "@/lib/utils/zip";
import { PERIOD_FIXTURE } from "../fixtures/libroIva/period";

const GOLDEN_DIR = join(__dirname, "..", "fixtures", "libroIva");

// Diseño de registro oficial (posición inicial 1-based, longitud) para leer
// los registros sin depender del formateador.
const VENTAS_CBTE = {
  fecha: [1, 8], tipo: [9, 3], pv: [12, 5], nro: [17, 20], nroHasta: [37, 20], docCode: [57, 2], docNro: [59, 20],
  nombre: [79, 30], total: [109, 15], noGravado: [124, 15], percNoCat: [139, 15], exento: [154, 15], percNac: [169, 15],
  percIibb: [184, 15], percMuni: [199, 15], internos: [214, 15], moneda: [229, 3], tc: [232, 10], cantAlic: [242, 1],
  codOp: [243, 1], otros: [244, 15], vtoPago: [259, 8],
} as const;
const VENTAS_ALIC = { tipo: [1, 3], pv: [4, 5], nro: [9, 20], neto: [29, 15], alic: [44, 4], iva: [48, 15] } as const;
const COMPRAS_CBTE = {
  fecha: [1, 8], tipo: [9, 3], pv: [12, 5], nro: [17, 20], despacho: [37, 16], docCode: [53, 2], docNro: [55, 20],
  nombre: [75, 30], total: [105, 15], noGravado: [120, 15], exento: [135, 15], percIva: [150, 15], percNac: [165, 15],
  percIibb: [180, 15], percMuni: [195, 15], internos: [210, 15], moneda: [225, 3], tc: [228, 10], cantAlic: [238, 1],
  codOp: [239, 1], credito: [240, 15], otros: [255, 15], cuitCorredor: [270, 11], nombreCorredor: [281, 30], ivaComision: [311, 15],
} as const;
const COMPRAS_ALIC = { tipo: [1, 3], pv: [4, 5], nro: [9, 20], docCode: [29, 2], docNro: [31, 20], neto: [51, 15], alic: [66, 4], iva: [70, 15] } as const;

function parse<T extends Record<string, readonly [number, number]>>(line: string, spec: T): Record<keyof T, string> {
  const out = {} as Record<keyof T, string>;
  for (const k of Object.keys(spec) as Array<keyof T>) {
    const [start, len] = spec[k] as readonly [number, number];
    out[k] = line.slice(start - 1, start - 1 + len);
  }
  return out;
}

const lines = (s: string) => s.split("\r\n").filter(Boolean);
const file = (r: ReturnType<typeof buildLibroIva>, name: string) => r.files.find((f) => f.name === name)!.content;

describe("campos de ancho fijo", () => {
  it("importes en centavos sin separador, con ceros a la izquierda", () => {
    expect(fmtAmount(123456)).toBe("000000000123456");
    expect(fmtAmount(0)).toBe("000000000000000");
    expect(fmtAmount(1)).toBe("000000000000001");
    expect(fmtAmount(999999999999999)).toBe("999999999999999");
  });

  it("importe negativo con signo en la primera posición", () => {
    expect(fmtAmount(-123456)).toBe("-00000000123456");
    expect(fmtAmount(-123456)).toHaveLength(15);
  });

  it("un importe que no entra o no es entero se rechaza", () => {
    expect(() => fmtAmount(1_000_000_000_000_000)).toThrow(LibroFormatError);
    expect(() => fmtAmount(1.5)).toThrow(LibroFormatError);
  });

  it("redondeo de pesos a centavos (mitad hacia arriba, sin ruido de coma flotante)", () => {
    expect(toCents(1.005)).toBe(101);
    expect(toCents("1234.56")).toBe(123456);
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents(2.675)).toBe(268);
    expect(toCents(-1.005)).toBe(-101);
    expect(toCents(null)).toBe(0);
    expect(toCents(-0.001)).toBe(0);
  });

  it("numéricos, fechas y tipo de cambio", () => {
    expect(fmtNum(12, 5)).toBe("00012");
    expect(fmtNum("0030712345671", 20)).toBe("00000000030712345671");
    expect(() => fmtNum(123456, 5)).toThrow(LibroFormatError);
    expect(() => fmtNum("12-3", 5)).toThrow(LibroFormatError);
    expect(fmtDate("2026-10-05")).toBe("20261005");
    expect(fmtDate("2026-10-05T23:10:00-03:00")).toBe("20261005");
    expect(fmtDate(null)).toBe("00000000");
    expect(fmtFx(1)).toBe("0001000000");
    expect(fmtFx(1000.5)).toBe("1000500000");
    expect(() => fmtFx(0)).toThrow(LibroFormatError);
  });

  it("textos en mayúsculas, sin acentos, recortados y con espacios", () => {
    expect(normalizeText("Peña Ñandú & Cía. · Güemes")).toBe("PENA NANDU & CIA. GUEMES");
    expect(fmtText("José Pérez", 10)).toBe("JOSE PEREZ");
    expect(fmtText("Ab", 5)).toBe("AB   ");
    expect(fmtText("Distribuidora Peña & Cía. S.R.L. del Norte", 30)).toHaveLength(30);
    expect(fmtText(null, 3)).toBe("   ");
  });

  it("código de operación", () => {
    expect(codigoOperacion([{ code: 5, neto: 100, iva: 21 }], 0)).toBe("0");
    expect(codigoOperacion([{ code: 3, neto: 0, iva: 0 }], 500)).toBe("E");
    expect(codigoOperacion([{ code: 3, neto: 0, iva: 0 }], 0)).toBe("N");
  });
});

describe("ventas", () => {
  const byId = (id: string) => PERIOD_FIXTURE.ventas.find((v) => v.id === id)!;

  it("consumidor final: documento 99 en ceros y nombre por defecto", () => {
    const issues: LibroIssue[] = [];
    const v = buildVenta(byId("v1"), issues)!;
    const r = parse(ventaCbteLine(v), VENTAS_CBTE);
    expect(issues).toEqual([]);
    expect(r.docCode).toBe("99");
    expect(r.docNro).toBe("0".repeat(20));
    expect(r.nombre.trim()).toBe("CONSUMIDOR FINAL");
    expect(r.total).toBe("000000000012100");
    expect(r.cantAlic).toBe("1");
    expect(r.codOp).toBe("0");
    expect(r.vtoPago).toBe("00000000");
    expect(parse(ventaAlicuotaLine(v, v.alicuotas[0]!), VENTAS_ALIC)).toMatchObject({
      neto: "000000000010000",
      alic: "0005",
      iva: "000000000002100",
    });
  });

  it("CUIT, varias alícuotas, exento, no gravado, internos y percepciones en su campo", () => {
    const issues: LibroIssue[] = [];
    const v = buildVenta(byId("v2"), issues)!;
    const r = parse(ventaCbteLine(v), VENTAS_CBTE);
    expect(r).toMatchObject({
      fecha: "20261007",
      tipo: "001",
      pv: "00003",
      nro: "00000000000000000045",
      nroHasta: "00000000000000000045",
      docCode: "80",
      docNro: "00000000030712345671",
      total: "000000000156834",
      noGravado: "000000000003000",
      percNoCat: "000000000000000",
      exento: "000000000005000",
      percNac: "000000000003000",
      percIibb: "000000000001234",
      percMuni: "000000000000000",
      internos: "000000000001500",
      moneda: "PES",
      tc: "0001000000",
      cantAlic: "2",
      codOp: "0",
      otros: "000000000000000",
    });
    expect(r.nombre).toBe("DISTRIBUIDORA PENA & CIA. S.R.");
    expect(v.alicuotas.map((a) => a.code)).toEqual([4, 5]);
  });

  it("nota de crédito: importes en positivo y proporcionales que cierran exacto", () => {
    const issues: LibroIssue[] = [];
    const v = buildVenta(byId("v3"), issues)!;
    expect(issues).toEqual([]);
    const r = parse(ventaCbteLine(v), VENTAS_CBTE);
    expect(r.tipo).toBe("003");
    expect(r.total).toBe("000000000078417");
    const parts =
      v.alicuotas.reduce((t, a) => t + a.neto + a.iva, 0) + v.noGravado + v.exento + v.percNac + v.percIibb + v.internos;
    expect(parts).toBe(78417);
    for (const a of v.alicuotas) expect(a.neto).toBeGreaterThan(0);
    expect(ventaCbteLine(v)).not.toContain("-");
  });

  it("DNI y servicios con fecha de vencimiento de pago", () => {
    const v = buildVenta(byId("v4"), [])!;
    const r = parse(ventaCbteLine(v), VENTAS_CBTE);
    expect(r.docCode).toBe("96");
    expect(r.docNro).toBe("00000000000030123456");
    expect(r.nombre.trim()).toBe("JOSE PEREZ");
    expect(r.vtoPago).toBe("20261010");
  });

  it("sólo exento: alícuota 0 % en cero y código de operación E", () => {
    const v = buildVenta(byId("v5"), [])!;
    const r = parse(ventaCbteLine(v), VENTAS_CBTE);
    expect(r.exento).toBe("000000000050000");
    expect(r.cantAlic).toBe("1");
    expect(r.codOp).toBe("E");
    expect(v.alicuotas).toEqual([{ code: 3, neto: 0, iva: 0 }]);
  });

  it("factura A sin CUIT del cliente", () => {
    const issues: LibroIssue[] = [];
    const v = buildVenta({ ...byId("v2"), doc_tipo: 96, doc_nro: "30123456" }, issues);
    expect(v).toBeNull();
    expect(issues.map((i) => i.code)).toContain("venta_sin_cuit");
  });

  it("CUIT con dígito verificador inválido", () => {
    const issues: LibroIssue[] = [];
    expect(buildVenta({ ...byId("v2"), doc_nro: "30712345672" }, issues)).toBeNull();
    expect(issues[0]!.code).toBe("cuit_invalido");
  });

  it("alícuota que ARCA no acepta", () => {
    const issues: LibroIssue[] = [];
    const d: LibroVentaDoc = {
      ...byId("v1"),
      tax_lines: [{ kind: "iva", tax: "iva", rate_code: null, rate: 19, base: 100, amount: 21, arca_id: 7 }],
    };
    expect(buildVenta(d, issues)).toBeNull();
    expect(issues.map((i) => i.code)).toContain("alicuota_invalida");
  });

  it("totales que no cierran con lo autorizado", () => {
    const issues: LibroIssue[] = [];
    expect(buildVenta({ ...byId("v1"), imp_total: 120 }, issues)).toBeNull();
    expect(issues[0]!.code).toBe("total_distinto_arca");
    const issues2: LibroIssue[] = [];
    // El desglose suma 121 pero la venta dice 130: no cierra.
    expect(buildVenta({ ...byId("v1"), sale: { total: 130 }, imp_total: 130 }, issues2)).toBeNull();
    expect(issues2[0]!.code).toBe("totales_no_cierran");
  });
});

describe("compras", () => {
  const byId = (id: string) => PERIOD_FIXTURE.compras.find((c) => c.id === id)!;

  it("factura A con tres alícuotas, percepciones, internos y crédito fiscal", () => {
    const c = buildCompra(byId("c1"), [])!;
    const line = compraCbteLine(c);
    expect(line).toHaveLength(RECORD_LENGTH.comprasCbte);
    expect(parse(line, COMPRAS_CBTE)).toMatchObject({
      fecha: "20261003",
      tipo: "001",
      pv: "00002",
      nro: "00000000000000001234",
      despacho: " ".repeat(16),
      docCode: "80",
      docNro: "00000000030712345671",
      nombre: "MAYORISTA GUEMES S.A.         ",
      total: "000000000165100",
      noGravado: "000000000000500",
      exento: "000000000001000",
      percIva: "000000000003000",
      percNac: "000000000000000",
      percIibb: "000000000002050",
      percMuni: "000000000000300",
      internos: "000000000000700",
      moneda: "PES",
      tc: "0001000000",
      cantAlic: "3",
      codOp: "0",
      credito: "000000000027450",
      otros: "000000000000100",
      cuitCorredor: "00000000000",
      nombreCorredor: " ".repeat(30),
      ivaComision: "000000000000000",
    });
  });

  it("factura C de un monotributista: no gravado, alícuota 0 % en cero, sin crédito", () => {
    const c = buildCompra(byId("c2"), [])!;
    const r = parse(compraCbteLine(c), COMPRAS_CBTE);
    expect(r.tipo).toBe("011");
    expect(r.noGravado).toBe("000000000050000");
    expect(r.credito).toBe("000000000000000");
    expect(r.cantAlic).toBe("1");
    expect(r.codOp).toBe("N");
    expect(c.alicuotas).toEqual([{ code: 3, neto: 0, iva: 0 }]);
  });

  it("nota de crédito del proveedor en positivo", () => {
    const c = buildCompra(byId("c3"), [])!;
    const r = parse(compraCbteLine(c), COMPRAS_CBTE);
    expect(r.tipo).toBe("003");
    expect(r.total).toBe("000000000012100");
  });

  it("moneda extranjera: se informa en pesos al tipo de cambio cargado, con aviso", () => {
    const issues: LibroIssue[] = [];
    const c = buildCompra(byId("c4"), issues)!;
    expect(issues.map((i) => i.code)).toEqual(["compra_moneda_extranjera"]);
    const r = parse(compraCbteLine(c), COMPRAS_CBTE);
    expect(r.total).toBe("000000001210605");
    expect(c.alicuotas[0]).toEqual({ code: 5, neto: 1000500, iva: 210105 });
  });

  it("problemas: sin CUIT, alícuota inválida, IVA que no corresponde, totales, exterior", () => {
    const base = byId("c1");
    const run = (d: LibroCompraDoc) => {
      const issues: LibroIssue[] = [];
      const r = buildCompra(d, issues);
      return { r, codes: issues.map((i) => i.code), issues };
    };
    const sinCuit = run({ ...base, supplier: { ...base.supplier, cuit: null } });
    expect(sinCuit.r).toBeNull();
    expect(sinCuit.codes).toContain("compra_sin_cuit");
    expect(sinCuit.issues[0]!.message).toMatch(/no tiene CUIT/);

    expect(run({ ...base, vat_lines: [{ rate: 19, net: 1000, vat: 190 }], total: 1266 }).codes).toContain("alicuota_invalida");
    expect(run({ ...base, vat_lines: [{ rate: 21, net: 1000, vat: 100 }], total: 1166.5 }).codes).toContain("iva_no_corresponde");
    expect(run({ ...base, total: 1650 }).codes).toContain("totales_no_cierran");
    const ext = run({ ...base, letter: "E" });
    expect(ext.r).toBeNull();
    expect(ext.issues[0]).toMatchObject({ level: "warning", code: "compra_importacion" });
  });
});

describe("libro completo", () => {
  const result = buildLibroIva(PERIOD_FIXTURE);

  it("todos los registros tienen el largo del diseño", () => {
    for (const l of lines(file(result, FILE_NAMES.ventasCbte))) expect(l).toHaveLength(RECORD_LENGTH.ventasCbte);
    for (const l of lines(file(result, FILE_NAMES.ventasAlicuotas))) expect(l).toHaveLength(RECORD_LENGTH.ventasAlicuotas);
    for (const l of lines(file(result, FILE_NAMES.comprasCbte))) expect(l).toHaveLength(RECORD_LENGTH.comprasCbte);
    for (const l of lines(file(result, FILE_NAMES.comprasAlicuotas))) expect(l).toHaveLength(RECORD_LENGTH.comprasAlicuotas);
  });

  it("cantidad de alícuotas del comprobante = registros en el archivo de alícuotas", () => {
    const alic = lines(file(result, FILE_NAMES.ventasAlicuotas)).map((l) => parse(l, VENTAS_ALIC));
    for (const l of lines(file(result, FILE_NAMES.ventasCbte))) {
      const c = parse(l, VENTAS_CBTE);
      const n = alic.filter((a) => a.tipo === c.tipo && a.pv === c.pv && a.nro === c.nro).length;
      expect(String(n)).toBe(c.cantAlic);
    }
  });

  it("archivos en ASCII con CRLF y ordenados por fecha", () => {
    for (const f of result.files) {
      expect(f.content).toMatch(/^[\x20-\x7E\r\n]*$/);
      expect(f.content.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    }
    const fechas = lines(file(result, FILE_NAMES.ventasCbte)).map((l) => l.slice(0, 8));
    expect([...fechas].sort()).toEqual(fechas);
  });

  it("resumen: las notas de crédito restan y sólo hay avisos", () => {
    expect(result.summary.errors).toBe(0);
    expect(result.issues.map((i) => i.code).sort()).toEqual(["caea_sin_informar", "compra_moneda_extranjera"]);
    expect(result.summary.ventas.count).toBe(6);
    expect(result.summary.ventas.total).toBe(12100 + 156834 - 78417 + 110500 + 50000 + 1);
    expect(result.summary.compras.credito).toBe(27450 - 2100 + 210105);
  });

  it("golden files", () => {
    const update = process.env.UPDATE_GOLDEN === "1";
    if (update && !existsSync(GOLDEN_DIR)) mkdirSync(GOLDEN_DIR, { recursive: true });
    for (const f of result.files) {
      const path = join(GOLDEN_DIR, f.name);
      if (update) writeFileSync(path, f.content, "latin1");
      expect(f.content).toBe(readFileSync(path, "latin1"));
    }
  });

  it("bloquea: comprobantes sin CAE en el mes y negocio sin CUIT", () => {
    const data: LibroData = {
      ...PERIOD_FIXTURE,
      emitter: { cuit: null, iva_condition: "monotributo" },
      pending: [
        { id: "p1", origin: "sale", cbte_tipo: 6, pto_vta: 3, cbte_nro: null, status: "requiere_accion", error_code: "receptor_sin_cuit", sale_number: 140, date: "2026-10-30" },
      ],
    };
    const r = buildLibroIva(data);
    const codes = r.issues.map((i) => `${i.level}:${i.code}`);
    expect(codes).toContain("error:pendientes_cae");
    expect(codes).toContain("error:emisor_sin_cuit");
    expect(codes).toContain("warning:emisor_no_ri");
    expect(r.issues.find((i) => i.code === "pendientes_cae")!.message).toMatch(/1 comprobante del mes sin CAE \(venta 140\)/);
  });

  it("período vacío, en curso y facturas sólo de prueba", () => {
    const r = buildLibroIva({ ...PERIOD_FIXTURE, today: "2026-10-20", ventas: [], compras: [], homologacion_count: 4 });
    expect(r.summary.errors).toBe(0);
    expect(r.issues.map((i) => i.code).sort()).toEqual(["periodo_en_curso", "periodo_vacio", "solo_homologacion"]);
    expect(file(r, FILE_NAMES.ventasCbte)).toBe("");
  });

  it("nombre del zip", () => {
    expect(zipName("30-50000000-3", "2026-10")).toBe("libro-iva-digital-30500000003-202610.zip");
    expect(zipName(null, "2026-10")).toBe("libro-iva-digital-sin-cuit-202610.zip");
  });
});

describe("zip", () => {
  it("CRC-32 estándar", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("ida y vuelta con los archivos del libro", () => {
    const result = buildLibroIva(PERIOD_FIXTURE);
    const zip = createZip(
      result.files.map((f) => ({ name: f.name, data: f.content })),
      new Date(2026, 10, 3, 10, 0, 0),
    );
    expect([zip[0], zip[1], zip[2], zip[3]]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const back = readStoredZip(zip);
    expect([...back.keys()]).toEqual(result.files.map((f) => f.name));
    for (const f of result.files) expect(new TextDecoder("latin1").decode(back.get(f.name))).toBe(f.content);
  });
});
