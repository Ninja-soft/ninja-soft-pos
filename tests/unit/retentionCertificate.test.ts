// Certificado de retención (F18 · H106, ADR-079): contenido del PDF armado
// desde la retención registrada (foto del agente y del sujeto al pagar).
import { describe, expect, it } from "vitest";
import { certificateContent, formatCuit, type CertificateRow } from "@/lib/tax/retentionCertificate";

const ROW: CertificateRow = {
  id: "w1",
  tax: "ganancias",
  jurisdiction: null,
  date: "2026-10-20",
  payment_number: 15,
  payment_total: 60500,
  concept_code: "094",
  concept_name: "Locaciones de obra y/o servicios (no en relación de dependencia)",
  condition: "inscripto",
  payment_base: 50000,
  prior_base: 100000,
  accumulated_base: 150000,
  non_taxable_min: 67170,
  taxable_base: 82830,
  month_total: 1656.6,
  prior_withheld: 656.6,
  rate: 2,
  rate_source: "registered",
  exemption_pct: 0,
  amount: 1000,
  certificate: "GAN-00000002",
  sicore_regime_code: "094",
  status: "issued",
  agent_snapshot: { name: "Mi Negocio SRL", cuit: "30500000003", address: "Av. Siempre Viva 742", agent_number: "AG-1" },
  subject_snapshot: { name: "Servicios SA", cuit: "30712345671", address: "Calle 1", city: "La Plata", iva_condition: "responsable_inscripto" },
};

const flat = (c: ReturnType<typeof certificateContent>) =>
  Object.fromEntries(c.sections.flatMap((s) => s.rows.map(([k, v]) => [`${s.title}:${k}`, v])));

describe("certificado de retención", () => {
  it("datos del agente, del sujeto, la operación y el cálculo con acumulado", () => {
    const c = certificateContent(ROW);
    expect(c.title).toBe("Certificado de retención");
    expect(c.subtitle).toBe("Impuesto a las Ganancias");
    expect(c.number).toBe("GAN-00000002");
    expect(c.date).toBe("20/10/2026");
    expect(c.voided).toBe(false);
    const f = flat(c);
    expect(f["Agente de retención:CUIT"]).toBe("30-50000000-3");
    expect(f["Agente de retención:N° de agente"]).toBe("AG-1");
    expect(f["Sujeto retenido:CUIT"]).toBe("30-71234567-1");
    expect(f["Sujeto retenido:Domicilio"]).toBe("Calle 1, La Plata");
    expect(f["Sujeto retenido:Condición"]).toContain("Inscripto en Ganancias");
    expect(f["Operación:Comprobante"]).toBe("Orden de pago OP-000015");
    expect(f["Operación:Régimen"]).toContain("094 · Locaciones");
    expect(f["Cálculo:Mínimo no sujeto a retención"]).toMatch(/67\.170,00/);
    expect(f["Cálculo:Alícuota"]).toBe("2 %");
    expect(f["Cálculo:Retenido antes en el mes"]).toMatch(/656,60/);
    expect(c.amount).toMatch(/1\.000,00/);
    expect(c.amountWords).toBe("Son pesos mil con 00/100.");
  });

  it("escala, IIBB por jurisdicción, exclusión y anulado", () => {
    const scale = flat(certificateContent({ ...ROW, rate: null, rate_source: "scale" }));
    expect(scale["Cálculo:Alícuota"]).toBe("Escala RG 830 Anexo VIII");
    const iibb = certificateContent({
      ...ROW,
      tax: "iibb",
      jurisdiction: "902",
      concept_code: null,
      concept_name: null,
      rate: 1.75,
      exemption_pct: 50,
      status: "voided",
      agent_snapshot: { ...ROW.agent_snapshot, iibb_number: "902-123" },
    });
    const f = flat(iibb);
    expect(iibb.subtitle).toBe("Impuesto sobre los Ingresos Brutos");
    expect(iibb.voided).toBe(true);
    expect(f["Operación:Régimen"]).toBe("Ingresos Brutos Buenos Aires");
    expect(f["Agente de retención:N° de Ingresos Brutos"]).toBe("902-123");
    expect(f["Cálculo:Exclusión (certificado)"]).toBe("50 %");
    expect(f["Cálculo:Alícuota"]).toBe("1,75 %");
  });

  it("sin guiones largos en el texto (brand)", () => {
    const all = JSON.stringify(certificateContent(ROW));
    expect(all).not.toContain("—");
    expect(formatCuit(null)).toBe("Sin CUIT");
  });
});
