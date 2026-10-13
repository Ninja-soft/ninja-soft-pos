// Matriz de la liquidación de IIBB (ADR-095). La usan:
//   · tests/unit/iibb.test.ts (computeIibb, lib/tax/iibb.ts);
//   · tests/integration/rls-iibb.test.ts (SQL vía _iibb_math, service role).
// Mismas entradas, mismo resultado: paridad TS ↔ SQL. Escrita como datos
// planos (claves entre comillas) para poder leerla también desde el humo de
// PGlite.
import type { IibbInput } from "@/lib/tax/iibb";

export interface IibbCase {
  name: string;
  input: IibbInput;
  expect: {
    taxes: number[];
    bases: number[];
    minimum: boolean[];
    base_total: number;
    determined: number;
    deductions_total: number;
    available: number;
    used: number;
    to_pay: number;
    credit_next: number;
  };
}

const NO_DED = { "retencion": 0, "percepcion": 0, "sircreb": 0, "sirtac": 0 };

export const IIBB_CASES: IibbCase[] = [
  {
    "name": "local, una actividad, sin deducciones",
    "input": { "activities": [{ "key": "a", "base_raw": 100000, "rate": 3.5, "min_tax": 0 }], "coefficient": null, "deductions": NO_DED, "previous_credit": 0 },
    "expect": { "taxes": [3500], "bases": [100000], "minimum": [false], "base_total": 100000, "determined": 3500, "deductions_total": 0, "available": 0, "used": 0, "to_pay": 3500, "credit_next": 0 },
  },
  {
    "name": "redondeo a centavos, mitad hacia arriba",
    "input": {
      "activities": [
        { "key": "a", "base_raw": 0.1, "rate": 5, "min_tax": 0 },
        { "key": "b", "base_raw": 10.1, "rate": 4.95, "min_tax": 0 },
        { "key": "c", "base_raw": 123.45, "rate": 3, "min_tax": 0 },
      ],
      "coefficient": null, "deductions": NO_DED, "previous_credit": 0,
    },
    "expect": { "taxes": [0.01, 0.5, 3.7], "bases": [0.1, 10.1, 123.45], "minimum": [false, false, false], "base_total": 133.65, "determined": 4.21, "deductions_total": 0, "available": 0, "used": 0, "to_pay": 4.21, "credit_next": 0 },
  },
  {
    "name": "impuesto mínimo de la actividad",
    "input": { "activities": [{ "key": "a", "base_raw": 1000, "rate": 3, "min_tax": 50 }], "coefficient": null, "deductions": NO_DED, "previous_credit": 0 },
    "expect": { "taxes": [50], "bases": [1000], "minimum": [true], "base_total": 1000, "determined": 50, "deductions_total": 0, "available": 0, "used": 0, "to_pay": 50, "credit_next": 0 },
  },
  {
    "name": "base negativa (más devoluciones que ventas) no resta impuesto",
    "input": {
      "activities": [
        { "key": "a", "base_raw": -500, "rate": 3, "min_tax": 0 },
        { "key": "b", "base_raw": 1000, "rate": 3, "min_tax": 0 },
      ],
      "coefficient": null, "deductions": NO_DED, "previous_credit": 0,
    },
    "expect": { "taxes": [0, 30], "bases": [-500, 1000], "minimum": [false, false], "base_total": 500, "determined": 30, "deductions_total": 0, "available": 0, "used": 0, "to_pay": 30, "credit_next": 0 },
  },
  {
    "name": "deducciones y saldo anterior superan el impuesto: saldo a favor",
    "input": {
      "activities": [{ "key": "a", "base_raw": 10000, "rate": 3, "min_tax": 0 }],
      "coefficient": null,
      "deductions": { "retencion": 100, "percepcion": 150.55, "sircreb": 80, "sirtac": 0 },
      "previous_credit": 20,
    },
    "expect": { "taxes": [300], "bases": [10000], "minimum": [false], "base_total": 10000, "determined": 300, "deductions_total": 330.55, "available": 350.55, "used": 300, "to_pay": 0, "credit_next": 50.55 },
  },
  {
    "name": "saldo anterior y SIRTAC cubren una parte",
    "input": {
      "activities": [{ "key": "a", "base_raw": 20000, "rate": 3.5, "min_tax": 0 }],
      "coefficient": null,
      "deductions": { "retencion": 50, "percepcion": 0, "sircreb": 0, "sirtac": 25.25 },
      "previous_credit": 100,
    },
    "expect": { "taxes": [700], "bases": [20000], "minimum": [false], "base_total": 20000, "determined": 700, "deductions_total": 75.25, "available": 175.25, "used": 175.25, "to_pay": 524.75, "credit_next": 0 },
  },
  {
    "name": "Convenio Multilateral: base × coeficiente redondeada",
    "input": {
      "activities": [
        { "key": "a", "base_raw": 1234567.89, "rate": 3.5, "min_tax": 0 },
        { "key": "b", "base_raw": 1000, "rate": 4, "min_tax": 0 },
      ],
      "coefficient": 0.354321, "deductions": NO_DED, "previous_credit": 0,
    },
    "expect": { "taxes": [15310.17, 14.17], "bases": [437433.33, 354.32], "minimum": [false, false], "base_total": 437787.65, "determined": 15324.34, "deductions_total": 0, "available": 0, "used": 0, "to_pay": 15324.34, "credit_next": 0 },
  },
  {
    "name": "Convenio Multilateral sin coeficiente (cero) con mínimo",
    "input": { "activities": [{ "key": "a", "base_raw": 5000, "rate": 3, "min_tax": 12.5 }], "coefficient": 0, "deductions": { "retencion": 0, "percepcion": 4.99, "sircreb": 0, "sirtac": 0 }, "previous_credit": 0 },
    "expect": { "taxes": [12.5], "bases": [0], "minimum": [true], "base_total": 0, "determined": 12.5, "deductions_total": 4.99, "available": 4.99, "used": 4.99, "to_pay": 7.51, "credit_next": 0 },
  },
];
