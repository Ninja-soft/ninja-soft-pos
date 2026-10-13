// Clasificación de impuestos descontados por procesadores y bancos
// (ADR-095). La usan tests/unit/suffered.test.ts (classifyTaxText) y
// tests/integration/rls-iibb.test.ts (SQL _tax_suffered_classify): paridad
// TS ↔ SQL. Datos planos para leerla también desde el humo de PGlite.
import type { TaxClassification } from "@/lib/tax/suffered";

export interface SufferedCase {
  text: string;
  defaultJurisdiction: string | null;
  defaultRegime: "general" | "procesador";
  expect: TaxClassification;
}

export const SUFFERED_CASES: SufferedCase[] = [
  {
    "text": "Retención de Ingresos Brutos", "defaultJurisdiction": "902", "defaultRegime": "procesador",
    "expect": { "skip": false, "tax": "iibb", "kind": "retencion", "regime": "procesador", "jurisdiction": "902", "needs_review": true },
  },
  {
    "text": "tax_withholding_iibb-sirtac Córdoba", "defaultJurisdiction": null, "defaultRegime": "procesador",
    "expect": { "skip": false, "tax": "iibb", "kind": "retencion", "regime": "sirtac", "jurisdiction": "904", "needs_review": false },
  },
  {
    "text": "IVA sobre la comisión", "defaultJurisdiction": "902", "defaultRegime": "procesador",
    "expect": { "skip": true, "tax": "iva", "kind": "retencion", "regime": "procesador", "jurisdiction": null, "needs_review": false },
  },
  {
    "text": "Impuesto a los débitos y créditos", "defaultJurisdiction": null, "defaultRegime": "procesador",
    "expect": { "skip": false, "tax": "debitos_creditos", "kind": "pago_a_cuenta", "regime": "procesador", "jurisdiction": null, "needs_review": false },
  },
  {
    "text": "Ley 25.413 crédito", "defaultJurisdiction": null, "defaultRegime": "general",
    "expect": { "skip": false, "tax": "debitos_creditos", "kind": "pago_a_cuenta", "regime": "general", "jurisdiction": null, "needs_review": false },
  },
  {
    "text": "Percepción IIBB CABA", "defaultJurisdiction": "902", "defaultRegime": "procesador",
    "expect": { "skip": false, "tax": "iibb", "kind": "percepcion", "regime": "procesador", "jurisdiction": "901", "needs_review": false },
  },
  {
    "text": "Retención IIBB Ciudad de Buenos Aires", "defaultJurisdiction": null, "defaultRegime": "procesador",
    "expect": { "skip": false, "tax": "iibb", "kind": "retencion", "regime": "procesador", "jurisdiction": "901", "needs_review": false },
  },
  {
    "text": "ARBA retención", "defaultJurisdiction": null, "defaultRegime": "procesador",
    "expect": { "skip": false, "tax": "iibb", "kind": "retencion", "regime": "procesador", "jurisdiction": "902", "needs_review": false },
  },
  {
    "text": "Retención de Ganancias", "defaultJurisdiction": "902", "defaultRegime": "procesador",
    "expect": { "skip": false, "tax": "ganancias", "kind": "retencion", "regime": "procesador", "jurisdiction": null, "needs_review": false },
  },
  {
    "text": "Percepción IVA RG 2408", "defaultJurisdiction": null, "defaultRegime": "general",
    "expect": { "skip": false, "tax": "iva", "kind": "percepcion", "regime": "general", "jurisdiction": null, "needs_review": false },
  },
  {
    "text": "SIRCREB 921", "defaultJurisdiction": null, "defaultRegime": "general",
    "expect": { "skip": false, "tax": "iibb", "kind": "retencion", "regime": "sircreb", "jurisdiction": "921", "needs_review": false },
  },
  {
    "text": "Ret. IIBB Santiago del Estero", "defaultJurisdiction": null, "defaultRegime": "procesador",
    "expect": { "skip": false, "tax": "iibb", "kind": "retencion", "regime": "procesador", "jurisdiction": "922", "needs_review": false },
  },
  {
    "text": "sircreb", "defaultJurisdiction": null, "defaultRegime": "general",
    "expect": { "skip": false, "tax": "iibb", "kind": "retencion", "regime": "sircreb", "jurisdiction": null, "needs_review": true },
  },
  {
    "text": "Seguridad social", "defaultJurisdiction": null, "defaultRegime": "general",
    "expect": { "skip": false, "tax": "suss", "kind": "retencion", "regime": "general", "jurisdiction": null, "needs_review": false },
  },
  {
    "text": "Impuesto (algo raro)", "defaultJurisdiction": "902", "defaultRegime": "procesador",
    "expect": { "skip": false, "tax": "otro", "kind": "retencion", "regime": "procesador", "jurisdiction": null, "needs_review": true },
  },
];
