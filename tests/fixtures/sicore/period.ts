// Retenciones practicadas de un mes (octubre 2026) para los golden files de
// SICORE y ARBA (ADR-079). Mismos números que el recorrido de humo de la
// migración: dos órdenes de pago a "Servicios SA" por locaciones (094), con
// acumulado mensual, más IIBB, IVA y SUSS.
import type { ExportAgent, WithholdingExportRow } from "@/lib/tax/sicore";

export const AGENT: ExportAgent = { name: "Mi Negocio SRL", cuit: "30500000003" };
export const PERIOD = "2026-10-01";

const SUBJECT = { name: "Servicios SA", cuit: "30712345671" };
const base = {
  jurisdiction: null,
  prior_base: 0,
  non_taxable_min: 0,
  taxable_base: 0,
  exemption_pct: 0,
  condition: null,
  sicore_tax_code: null,
  sicore_regime_code: null,
  subject_snapshot: SUBJECT,
} as const;

export const SICORE_ROWS: WithholdingExportRow[] = [
  {
    ...base,
    tax: "ganancias",
    date: "2026-10-05",
    payment_number: 12,
    payment_total: 121000,
    payment_base: 100000,
    non_taxable_min: 67170,
    taxable_base: 32830,
    amount: 656.6,
    condition: "inscripto",
    certificate_number: 1,
    certificate: "GAN-00000001",
    sicore_tax_code: 217,
    sicore_regime_code: "094",
  },
  {
    ...base,
    tax: "ganancias",
    date: "2026-10-20",
    payment_number: 15,
    payment_total: 60500,
    payment_base: 50000,
    prior_base: 100000,
    non_taxable_min: 67170,
    taxable_base: 82830,
    amount: 1000,
    condition: "inscripto",
    certificate_number: 2,
    certificate: "GAN-00000002",
    sicore_tax_code: 217,
    sicore_regime_code: "094",
  },
  {
    ...base,
    tax: "ganancias",
    date: "2026-10-21",
    payment_number: 16,
    payment_total: 10000,
    payment_base: 10000,
    taxable_base: 10000,
    amount: 2800,
    condition: "no_inscripto",
    certificate_number: 3,
    certificate: "GAN-00000003",
    sicore_tax_code: 217,
    sicore_regime_code: "094",
    subject_snapshot: { name: "Fletes Juan Pérez", cuit: "20123456786" },
  },
  {
    ...base,
    tax: "iva",
    date: "2026-10-05",
    payment_number: 12,
    payment_total: 121000,
    payment_base: 21000,
    amount: 10500,
    certificate_number: 1,
    certificate: "IVA-00000001",
    sicore_tax_code: 767,
    sicore_regime_code: "499",
  },
  {
    ...base,
    tax: "suss",
    date: "2026-10-28",
    payment_number: 17,
    payment_total: 1234567.89,
    payment_base: 1020304.05,
    amount: 61218.24,
    exemption_pct: 0,
    certificate_number: 1,
    certificate: "SUSS-00000001",
    sicore_tax_code: 353,
    sicore_regime_code: "755",
  },
];

export const ARBA_ROWS: WithholdingExportRow[] = [
  {
    ...base,
    tax: "iibb",
    jurisdiction: "902",
    date: "2026-10-05",
    payment_number: 12,
    payment_total: 121000,
    payment_base: 100000,
    amount: 1000,
    certificate_number: 1,
    certificate: "IIBB902-00000001",
  },
  {
    ...base,
    tax: "iibb",
    jurisdiction: "902",
    date: "2026-10-20",
    payment_number: 15,
    payment_total: 60500,
    payment_base: 50000,
    amount: 500,
    certificate_number: 2,
    certificate: "IIBB902-00000002",
  },
];
