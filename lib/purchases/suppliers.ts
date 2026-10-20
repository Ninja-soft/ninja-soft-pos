// lib/purchases/suppliers.ts
//
// Catálogos y validaciones de proveedores (F18 · H101, ADR-050). PURO.

import { isValidCuit } from "@/modules/customers/schemas";
import type { PadronPersona } from "@/lib/customers/padron";

export { isValidCuit };

export type SupplierIvaCondition =
  | "responsable_inscripto"
  | "monotributo"
  | "exento"
  | "no_responsable"
  | "consumidor_final"
  | "no_alcanzado"
  | "exterior";

export const SUPPLIER_IVA_LABEL: Record<SupplierIvaCondition, string> = {
  responsable_inscripto: "Responsable inscripto",
  monotributo: "Monotributista",
  exento: "Exento",
  no_responsable: "No responsable",
  consumidor_final: "Consumidor final",
  no_alcanzado: "No alcanzado",
  exterior: "Proveedor del exterior",
};

export const CURRENCIES = ["ARS", "USD", "EUR", "BRL", "CNY", "UYU", "CLP"] as const;

export const CURRENCY_LABEL: Record<string, string> = {
  ARS: "Pesos (ARS)",
  USD: "Dólares (USD)",
  EUR: "Euros (EUR)",
  BRL: "Reales (BRL)",
  CNY: "Yuanes (CNY)",
  UYU: "Pesos uruguayos (UYU)",
  CLP: "Pesos chilenos (CLP)",
};

export const PROVINCES = [
  "Buenos Aires",
  "CABA",
  "Catamarca",
  "Chaco",
  "Chubut",
  "Córdoba",
  "Corrientes",
  "Entre Ríos",
  "Formosa",
  "Jujuy",
  "La Pampa",
  "La Rioja",
  "Mendoza",
  "Misiones",
  "Neuquén",
  "Río Negro",
  "Salta",
  "San Juan",
  "San Luis",
  "Santa Cruz",
  "Santa Fe",
  "Santiago del Estero",
  "Tierra del Fuego",
  "Tucumán",
] as const;

export function normalizeCuit(v: string | null | undefined): string {
  return String(v ?? "").replace(/\D/g, "");
}

/** 20123456786 → 20-12345678-6 */
export function formatCuit(v: string | null | undefined): string {
  const d = normalizeCuit(v);
  if (d.length !== 11) return String(v ?? "");
  return `${d.slice(0, 2)}-${d.slice(2, 10)}-${d.slice(10)}`;
}

function cbuBlockOk(digits: string, weights: number[]): boolean {
  let sum = 0;
  for (let i = 0; i < weights.length; i++) sum += Number(digits[i]) * weights[i]!;
  const check = (10 - (sum % 10)) % 10;
  return check === Number(digits[weights.length]);
}

/**
 * CBU / CVU de 22 dígitos con sus dos dígitos verificadores (bloque de banco y
 * sucursal; bloque de cuenta).
 */
export function isValidCbu(v: string | null | undefined): boolean {
  const d = String(v ?? "").replace(/\D/g, "");
  if (d.length !== 22) return false;
  return (
    cbuBlockOk(d.slice(0, 8), [7, 1, 3, 9, 7, 1, 3]) &&
    cbuBlockOk(d.slice(8), [3, 9, 7, 1, 3, 9, 7, 1, 3, 9, 7, 1, 3])
  );
}

/** Alias CBU: 6 a 20 caracteres, letras, números, punto y guion. */
export function isValidAlias(v: string | null | undefined): boolean {
  return /^[A-Za-z0-9.-]{6,20}$/.test(String(v ?? "").trim());
}

/** Teléfono a link de WhatsApp (asume Argentina si no tiene código de país). */
export function whatsappLink(phone: string | null | undefined, text: string): string | null {
  let d = String(phone ?? "").replace(/\D/g, "");
  if (d.length < 8) return null;
  if (d.startsWith("0")) d = d.slice(1);
  if (!d.startsWith("54")) d = `54${d}`;
  return `https://wa.me/${d}?text=${encodeURIComponent(text)}`;
}

/** Código de provincia de ARCA (0 = CABA, 1 = Buenos Aires...) → nombre de PROVINCES. */
const ARCA_PROVINCE: Record<number, (typeof PROVINCES)[number]> = {
  0: "CABA",
  1: "Buenos Aires",
  2: "Catamarca",
  3: "Córdoba",
  4: "Corrientes",
  5: "Entre Ríos",
  6: "Jujuy",
  7: "Mendoza",
  8: "La Rioja",
  9: "Salta",
  10: "San Juan",
  11: "San Luis",
  12: "Santa Fe",
  13: "Santiago del Estero",
  14: "Tucumán",
  16: "Chaco",
  17: "Chubut",
  18: "Formosa",
  19: "Misiones",
  20: "Neuquén",
  21: "La Pampa",
  22: "Río Negro",
  23: "Santa Cruz",
  24: "Tierra del Fuego",
};

const plain = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();

/** Provincia del padrón → una de PROVINCES (o null). */
export function provinceFromPadron(id: number | null | undefined, name: string | null | undefined): string | null {
  if (id != null && ARCA_PROVINCE[id]) return ARCA_PROVINCE[id]!;
  const n = plain(String(name ?? ""));
  if (!n) return null;
  if (n.includes("capital federal") || n.includes("ciudad autonoma") || n === "caba") return "CABA";
  return PROVINCES.find((p) => plain(p) === n) ?? null;
}

export interface SupplierFromPadron {
  name: string;
  iva_condition: SupplierIvaCondition;
  address: string | null;
  city: string | null;
  province: string | null;
}

/** Datos del padrón de ARCA para el alta del proveedor (H167). */
export function padronToSupplier(p: PadronPersona): SupplierFromPadron {
  const d = p.domicilio_partes ?? null;
  return {
    name: p.razon_social,
    iva_condition: p.iva_condition,
    address: d?.direccion?.trim() || p.domicilio || null,
    city: d?.localidad?.trim() || null,
    province: provinceFromPadron(d?.id_provincia ?? null, d?.provincia ?? p.provincia),
  };
}
