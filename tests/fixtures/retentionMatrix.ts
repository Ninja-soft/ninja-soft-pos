// Matriz de retenciones como agente (ADR-079). La usan:
//   · tests/unit/retentions.test.ts (lib/tax/retentions.ts, TypeScript);
//   · tests/integration/rls-retenciones.test.ts (SQL vía tax_retention_preview).
// Mismas entradas, mismo resultado: paridad TS ↔ SQL.
//
// CONCEPTS replica el seed de 20261104200000_retenciones_agente_catalogo
// (RG 830 con montos de la RG 5423/2023, orientativos). Si cambia el seed,
// cambia acá.
import type {
  GananciasCondition,
  RetBaseKind,
  RetConcept,
  RetReason,
  RetTax,
  ScaleBracket,
} from "@/lib/tax/retentions";

export const CONCEPTS: Record<string, RetConcept> = {
  "ganancias:078": {
    tax: "ganancias", code: "078", name: "Enajenación de bienes muebles y bienes de cambio",
    min_non_taxable: 224000, rate_registered: 2, rate_unregistered: 10, uses_scale: false, scale_code: null,
    min_withholding: 240, unregistered_min_applies: false, sicore_tax_code: 217, sicore_regime_code: "078",
  },
  "ganancias:094": {
    tax: "ganancias", code: "094", name: "Locaciones de obra y/o servicios (no en relación de dependencia)",
    min_non_taxable: 67170, rate_registered: 2, rate_unregistered: 28, uses_scale: false, scale_code: null,
    min_withholding: 240, unregistered_min_applies: false, sicore_tax_code: 217, sicore_regime_code: "094",
  },
  "ganancias:116": {
    tax: "ganancias", code: "116", name: "Honorarios de profesiones liberales, oficios, síndicos y similares",
    min_non_taxable: 67170, rate_registered: null, rate_unregistered: 28, uses_scale: true, scale_code: "rg830_anexo8",
    min_withholding: 240, unregistered_min_applies: false, sicore_tax_code: 217, sicore_regime_code: "116",
  },
  "suss:limpieza": {
    tax: "suss", code: "limpieza", name: "Limpieza de inmuebles",
    min_non_taxable: 0, rate_registered: 6, rate_unregistered: 6, uses_scale: false, scale_code: null,
    min_withholding: 400, unregistered_min_applies: false, sicore_tax_code: 353, sicore_regime_code: null,
  },
};

export const SCALE_RG830: ScaleBracket[] = [
  { from: 0, to: 8000, fixed: 0, rate: 5 },
  { from: 8000, to: 16000, fixed: 400, rate: 9 },
  { from: 16000, to: 24000, fixed: 1120, rate: 12 },
  { from: 24000, to: 32000, fixed: 2080, rate: 15 },
  { from: 32000, to: 48000, fixed: 3280, rate: 19 },
  { from: 48000, to: 64000, fixed: 6320, rate: 23 },
  { from: 64000, to: 96000, fixed: 10000, rate: 27 },
  { from: 96000, to: null, fixed: 18640, rate: 31 },
];

export interface CaseRegime {
  key: string;
  tax: RetTax;
  jurisdiction: string | null;
  name: string;
  padron_source: "none" | "arba" | "agip" | "generic";
  default_rate: number | null;
  rates_by_condition: Record<string, number>;
  base_kind: RetBaseKind;
  min_base: number;
  min_amount: number;
  applies_to: string[];
}

export interface RetCase {
  name: string;
  supplier: {
    iva_condition: string;
    cuit: string;
    ganancias_condition: GananciasCondition | null;
    ganancias_concept: string | null;
    suss_code: string | null;
  };
  regimes: CaseRegime[];
  /** Pago imputado a un comprobante (bases en proporción) o, si no hay, `amount`. */
  invoice?: { total: number; net_total: number; vat_total: number; exempt_amount: number; non_taxed_amount: number; alloc: number };
  amount?: number;
  /** Pagos anteriores del mes por el mismo concepto de Ganancias. */
  prior?: { base: number; withheld: number };
  /** Alícuota de retención del padrón por régimen (key). */
  padron?: Record<string, number>;
  exemptions?: { tax: RetTax; jurisdiction: string | null; pct: number }[];
  expect: { key: string; applies: boolean; reason: RetReason; amount: number }[];
  expectTotal: number;
}

const ALL = ["responsable_inscripto", "monotributo", "exento"];
const GAN: CaseRegime = {
  key: "gan", tax: "ganancias", jurisdiction: null, name: "Ganancias RG 830", padron_source: "none",
  default_rate: null, rates_by_condition: {}, base_kind: "net", min_base: 0, min_amount: 0, applies_to: ALL,
};
const IIBB_ARBA: CaseRegime = {
  key: "iibb902", tax: "iibb", jurisdiction: "902", name: "IIBB ARBA", padron_source: "arba",
  default_rate: null, rates_by_condition: {}, base_kind: "net", min_base: 0, min_amount: 0, applies_to: ALL,
};
const IIBB_CABA: CaseRegime = {
  key: "iibb901", tax: "iibb", jurisdiction: "901", name: "IIBB CABA", padron_source: "none",
  default_rate: 0.5, rates_by_condition: {}, base_kind: "net", min_base: 0, min_amount: 600, applies_to: ALL,
};
const IVA_50: CaseRegime = {
  key: "iva", tax: "iva", jurisdiction: null, name: "IVA RG 2854", padron_source: "none",
  default_rate: 50, rates_by_condition: {}, base_kind: "vat", min_base: 0, min_amount: 0,
  applies_to: ["responsable_inscripto"],
};
const SUSS: CaseRegime = {
  key: "suss", tax: "suss", jurisdiction: null, name: "SUSS", padron_source: "none",
  default_rate: null, rates_by_condition: {}, base_kind: "net", min_base: 0, min_amount: 0,
  applies_to: ["responsable_inscripto"],
};

const RI = (concept: string | null, cond: GananciasCondition | null = "inscripto", suss: string | null = null) => ({
  iva_condition: "responsable_inscripto", cuit: "30712345671", ganancias_condition: cond,
  ganancias_concept: concept, suss_code: suss,
});

export const RET_CASES: RetCase[] = [
  {
    name: "Ganancias inscripto, primer pago del mes sobre el mínimo",
    supplier: RI("094"), regimes: [GAN], amount: 100000,
    expect: [{ key: "gan", applies: true, reason: "applied", amount: 656.6 }], expectTotal: 656.6,
  },
  {
    name: "Ganancias por debajo del mínimo no sujeto",
    supplier: RI("094"), regimes: [GAN], amount: 50000,
    expect: [{ key: "gan", applies: false, reason: "below_non_taxable", amount: 0 }], expectTotal: 0,
  },
  {
    name: "Ganancias acumula pagos del mes que no retuvieron",
    supplier: RI("094"), regimes: [GAN], amount: 30000, prior: { base: 50000, withheld: 0 },
    expect: [{ key: "gan", applies: true, reason: "applied", amount: 256.6 }], expectTotal: 256.6,
  },
  {
    name: "Ganancias descuenta lo ya retenido en el mes",
    supplier: RI("094"), regimes: [GAN], amount: 20000, prior: { base: 100000, withheld: 656.6 },
    expect: [{ key: "gan", applies: true, reason: "applied", amount: 400 }], expectTotal: 400,
  },
  {
    name: "Ganancias por debajo del mínimo de retención queda acumulada",
    supplier: RI("094"), regimes: [GAN], amount: 75000,
    expect: [{ key: "gan", applies: false, reason: "below_min_withholding", amount: 0 }], expectTotal: 0,
  },
  {
    name: "Ganancias no inscripto: sin mínimo no sujeto y alícuota mayor",
    supplier: RI("094", "no_inscripto"), regimes: [GAN], amount: 10000,
    expect: [{ key: "gan", applies: true, reason: "applied", amount: 2800 }], expectTotal: 2800,
  },
  {
    name: "Ganancias honorarios de inscripto por escala",
    supplier: RI("116"), regimes: [GAN], amount: 100000,
    expect: [{ key: "gan", applies: true, reason: "applied", amount: 3437.7 }], expectTotal: 3437.7,
  },
  {
    name: "Ganancias honorarios de no inscripto al 28 %",
    supplier: RI("116", "no_inscripto"), regimes: [GAN], amount: 1000,
    expect: [{ key: "gan", applies: true, reason: "applied", amount: 280 }], expectTotal: 280,
  },
  {
    name: "Ganancias monotributista no retiene",
    supplier: { ...RI("094"), iva_condition: "monotributo" }, regimes: [GAN], amount: 500000,
    expect: [{ key: "gan", applies: false, reason: "monotributo", amount: 0 }], expectTotal: 0,
  },
  {
    name: "Ganancias con certificado de exclusión total",
    supplier: RI("094"), regimes: [GAN], amount: 100000,
    exemptions: [{ tax: "ganancias", jurisdiction: null, pct: 100 }],
    expect: [{ key: "gan", applies: false, reason: "exempt", amount: 0 }], expectTotal: 0,
  },
  {
    name: "Ganancias con exclusión parcial del 50 %",
    supplier: RI("094"), regimes: [GAN], amount: 100000,
    exemptions: [{ tax: "ganancias", jurisdiction: null, pct: 50 }],
    expect: [{ key: "gan", applies: true, reason: "applied", amount: 328.3 }], expectTotal: 328.3,
  },
  {
    name: "Ganancias sin concepto elegido",
    supplier: RI(null), regimes: [GAN], amount: 100000,
    expect: [{ key: "gan", applies: false, reason: "no_concept", amount: 0 }], expectTotal: 0,
  },
  {
    name: "Ganancias exento según la ficha",
    supplier: RI("094", "exento"), regimes: [GAN], amount: 100000,
    expect: [{ key: "gan", applies: false, reason: "gan_not_subject", amount: 0 }], expectTotal: 0,
  },
  {
    name: "Redondeo: medio centavo hacia arriba",
    supplier: RI("094"), regimes: [GAN], amount: 100000.25,
    expect: [{ key: "gan", applies: true, reason: "applied", amount: 656.61 }], expectTotal: 656.61,
  },
  {
    name: "Ganancias bienes de cambio sobre lo imputado sin IVA",
    supplier: RI("078"), regimes: [GAN],
    invoice: { total: 363000, net_total: 300000, vat_total: 63000, exempt_amount: 0, non_taxed_amount: 0, alloc: 363000 },
    expect: [{ key: "gan", applies: true, reason: "applied", amount: 1520 }], expectTotal: 1520,
  },
  {
    name: "IIBB ARBA con alícuota del padrón",
    supplier: RI(null), regimes: [IIBB_ARBA], amount: 100000, padron: { iibb902: 1.75 },
    expect: [{ key: "iibb902", applies: true, reason: "applied", amount: 1750 }], expectTotal: 1750,
  },
  {
    name: "IIBB ARBA sin padrón ni alícuota general",
    supplier: RI(null), regimes: [IIBB_ARBA], amount: 100000,
    expect: [{ key: "iibb902", applies: false, reason: "no_rate", amount: 0 }], expectTotal: 0,
  },
  {
    name: "IIBB CABA por debajo del importe mínimo",
    supplier: RI(null), regimes: [IIBB_CABA], amount: 100000,
    expect: [{ key: "iibb901", applies: false, reason: "below_min_amount", amount: 0 }], expectTotal: 0,
  },
  {
    name: "IVA: 50 % del IVA facturado",
    supplier: RI(null), regimes: [IVA_50],
    invoice: { total: 121000, net_total: 100000, vat_total: 21000, exempt_amount: 0, non_taxed_amount: 0, alloc: 121000 },
    expect: [{ key: "iva", applies: true, reason: "applied", amount: 10500 }], expectTotal: 10500,
  },
  {
    name: "IVA no alcanza a monotributistas",
    supplier: { ...RI(null), iva_condition: "monotributo" }, regimes: [IVA_50], amount: 50000,
    expect: [{ key: "iva", applies: false, reason: "condition_not_reached", amount: 0 }], expectTotal: 0,
  },
  {
    name: "SUSS limpieza al 6 %",
    supplier: RI(null, "inscripto", "limpieza"), regimes: [SUSS], amount: 100000,
    expect: [{ key: "suss", applies: true, reason: "applied", amount: 6000 }], expectTotal: 6000,
  },
  {
    name: "SUSS sin actividad alcanzada",
    supplier: RI(null), regimes: [SUSS], amount: 100000,
    expect: [{ key: "suss", applies: false, reason: "suss_not_applicable", amount: 0 }], expectTotal: 0,
  },
  {
    name: "Pago parcial a factura A con Ganancias, IVA e IIBB",
    supplier: RI("078"), regimes: [GAN, IVA_50, IIBB_ARBA], padron: { iibb902: 2.5 },
    invoice: { total: 605000, net_total: 500000, vat_total: 105000, exempt_amount: 0, non_taxed_amount: 0, alloc: 302500 },
    expect: [
      { key: "gan", applies: true, reason: "applied", amount: 520 },
      { key: "iva", applies: true, reason: "applied", amount: 26250 },
      { key: "iibb902", applies: true, reason: "applied", amount: 6250 },
    ],
    expectTotal: 33020,
  },
];
