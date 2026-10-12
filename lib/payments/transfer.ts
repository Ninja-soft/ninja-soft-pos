// Cuentas para cobrar por transferencia (ADR-055). Lógica pura: validación de
// CBU / CVU, CUIT y alias, detección de la entidad por el prefijo, resolución
// de qué cuentas ve una sucursal o caja (espejo de _transfer_effective en
// supabase/migrations/20261018400000_transferencias_cuentas.sql) y datos para
// la pantalla de transferencia.

import { isValidCuit } from "@/modules/customers/schemas";
import { isValidAlias, isValidCbu } from "@/lib/purchases/suppliers";
import { bankByBcraCode, bankByCvuPsp, bankBySlug, type BankEntity } from "./banks";

export { isValidAlias, isValidCbu, isValidCuit };

export type TransferAccountType = "caja_ahorro" | "cuenta_corriente" | "cuenta_virtual" | "otra";
export type TransferCurrency = "ARS" | "USD";

export const ACCOUNT_TYPE_LABEL: Record<TransferAccountType, string> = {
  caja_ahorro: "Caja de ahorro",
  cuenta_corriente: "Cuenta corriente",
  cuenta_virtual: "Cuenta virtual (CVU)",
  otra: "Otra",
};

export const CURRENCY_LABEL: Record<TransferCurrency, string> = { ARS: "Pesos", USD: "Dólares" };

export interface TransferAccount {
  id: string;
  bank_slug: string | null;
  bank_name: string;
  custom_logo_path: string | null;
  custom_logo_url: string | null;
  holder_name: string;
  cuit: string | null;
  cbu: string | null;
  alias: string | null;
  account_type: TransferAccountType;
  currency: TransferCurrency;
  note: string | null;
  is_default: boolean;
  is_active: boolean;
  sort: number;
  deleted_at: string | null;
  /** Detección automática (ADR-061). Ausentes en una base sin la migración. */
  auto_detect?: boolean;
  auto_tolerance?: number;
  auto_mode?: TransferAutoMode;
  auto_window_min?: number;
}

export type TransferAutoMode = "notify" | "auto_close";

export interface TransferAutoSettings {
  auto_detect: boolean;
  auto_tolerance: number;
  auto_mode: TransferAutoMode;
  auto_window_min: number;
}

/** Cuenta de Mercado Pago: slug del catálogo o CVU con PSP 0003 (0000003...). */
export function isMpCvuAccount(a: Pick<TransferAccount, "bank_slug" | "cbu">): boolean {
  return a.bank_slug === "mercado-pago" || String(a.cbu ?? "").replace(/\D/g, "").startsWith("0000003");
}

export function autoSettingsOf(a: TransferAccount): TransferAutoSettings {
  return {
    auto_detect: a.auto_detect === true,
    auto_tolerance: Number(a.auto_tolerance ?? 0) || 0,
    auto_mode: a.auto_mode === "auto_close" ? "auto_close" : "notify",
    auto_window_min: Number(a.auto_window_min ?? 30) || 30,
  };
}

export const digitsOnly = (v: string | null | undefined): string => String(v ?? "").replace(/\D/g, "");

/** CVU: los tres primeros dígitos son 000 (cuenta de un proveedor de pagos). */
export function isCvu(v: string | null | undefined): boolean {
  const d = digitsOnly(v);
  return d.length === 22 && d.startsWith("000");
}

/** "CBU" o "CVU" según el número (CBU por defecto mientras se tipea). */
export function cbuLabel(v: string | null | undefined): "CBU" | "CVU" {
  return isCvu(v) ? "CVU" : "CBU";
}

/** Los dos bloques del CBU / CVU (entidad y sucursal; cuenta), para leerlo. */
export function formatCbu(v: string | null | undefined): string {
  const d = digitsOnly(v);
  if (d.length !== 22) return String(v ?? "");
  return `${d.slice(0, 8)} ${d.slice(8)}`;
}

/** 20123456786 → 20-12345678-6 */
export function formatCuit(v: string | null | undefined): string {
  const d = digitsOnly(v);
  if (d.length !== 11) return String(v ?? "");
  return `${d.slice(0, 2)}-${d.slice(2, 10)}-${d.slice(10)}`;
}

/**
 * Entidad que emite el CBU / CVU, por su prefijo: los 3 primeros dígitos del
 * CBU son el código de entidad del BCRA; en un CVU (000) los 4 siguientes son
 * el proveedor de servicios de pago. null si no está en el catálogo.
 */
export function detectEntity(v: string | null | undefined): BankEntity | null {
  const d = digitsOnly(v);
  if (d.length < 3) return null;
  if (d.startsWith("000")) return d.length >= 7 ? bankByCvuPsp(d.slice(3, 7)) : null;
  return bankByBcraCode(d.slice(0, 3));
}

// ── Formulario ───────────────────────────────────────────────────────────────

export interface TransferAccountInput {
  bank_slug: string | null;
  bank_name: string;
  holder_name: string;
  cuit: string;
  cbu: string;
  alias: string;
  account_type: TransferAccountType;
  currency: TransferCurrency;
  note: string;
}

export type TransferAccountErrors = Partial<Record<keyof TransferAccountInput, string>>;

export function validateTransferAccount(v: TransferAccountInput): TransferAccountErrors {
  const e: TransferAccountErrors = {};
  if (!v.bank_slug && !v.bank_name.trim()) e.bank_name = "Elegí el banco o billetera, o escribí su nombre.";
  if (v.bank_name.trim().length > 80) e.bank_name = "Hasta 80 caracteres.";
  if (!v.holder_name.trim()) e.holder_name = "Cargá el titular de la cuenta.";
  else if (v.holder_name.trim().length > 120) e.holder_name = "Hasta 120 caracteres.";
  const cuit = digitsOnly(v.cuit);
  if (cuit && !isValidCuit(cuit)) e.cuit = "El CUIT no es válido (revisá el dígito verificador).";
  const cbu = digitsOnly(v.cbu);
  if (v.cbu.trim() && !isValidCbu(cbu)) {
    e.cbu = cbu.length !== 22 ? "Tiene que tener 22 dígitos." : `El ${cbuLabel(cbu)} no es válido (revisá los dígitos).`;
  }
  const alias = v.alias.trim();
  if (alias && !isValidAlias(alias)) e.alias = "De 6 a 20 caracteres: letras, números, punto y guion.";
  if (!cbu && !alias) e.cbu = "Cargá el CBU / CVU o el alias.";
  if (v.note.trim().length > 200) e.note = "Hasta 200 caracteres.";
  return e;
}

/** Fila lista para guardar (normalizada; el servidor vuelve a validar). */
export function toAccountRow(v: TransferAccountInput) {
  const bank = bankBySlug(v.bank_slug);
  return {
    bank_slug: bank?.slug ?? null,
    bank_name: (bank?.name ?? v.bank_name).trim(),
    holder_name: v.holder_name.trim(),
    cuit: digitsOnly(v.cuit) || null,
    cbu: digitsOnly(v.cbu) || null,
    alias: v.alias.trim() || null,
    account_type: v.account_type,
    currency: v.currency,
    note: v.note.trim() || null,
  };
}

// ── Resolución por sucursal / caja ───────────────────────────────────────────

/** Valor efectivo del medio 'transfer' (resolveEffective de lib/config). */
export interface TransferEffective {
  transfer_show_screen?: unknown;
  transfer_require_reference?: unknown;
  transfer_accounts?: unknown;
  transfer_default_account?: unknown;
}

export interface TransferConfig {
  /** Mostrar la pantalla de transferencia al cobrar (con al menos una cuenta). */
  showScreen: boolean;
  requireReference: boolean;
  accounts: TransferAccount[];
  defaultAccountId: string | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

function liveSorted(accounts: TransferAccount[]): TransferAccount[] {
  return accounts
    .filter((a) => !a.deleted_at && a.is_active)
    .sort((a, b) => Number(b.is_default) - Number(a.is_default) || a.sort - b.sort);
}

/**
 * Cuentas que ve la sucursal o caja. Sin transferencia_multicuenta sólo vale
 * la cuenta por defecto y no se aplican las elecciones por sucursal.
 */
export function resolveTransferConfig(
  accounts: TransferAccount[],
  eff: TransferEffective,
  multiAccount: boolean,
): TransferConfig {
  const vis = isObj(eff.transfer_accounts) ? eff.transfer_accounts : {};
  let list = liveSorted(accounts);
  if (multiAccount) list = list.filter((a) => vis[a.id] !== false);
  else list = list.slice(0, 1);
  const want = multiAccount && typeof eff.transfer_default_account === "string" ? eff.transfer_default_account : null;
  const def = (want && list.find((a) => a.id === want)) || list[0] || null;
  return {
    showScreen: eff.transfer_show_screen !== false,
    requireReference: eff.transfer_require_reference === true,
    accounts: def ? [def, ...list.filter((a) => a.id !== def.id)] : list,
    defaultAccountId: def?.id ?? null,
  };
}

// ── Logos ────────────────────────────────────────────────────────────────────

/** Iniciales para el monograma de una cuenta sin logo. */
const STOP = new Set(["banco", "billetera", "de", "del", "la", "las", "los", "el", "y"]);

export function initialsOf(name: string): string {
  const all = name.split(/\s+/).filter(Boolean);
  const words = all.filter((w) => !STOP.has(w.toLowerCase()));
  if (words.length === 0) words.push(...all);
  const out = words.length >= 2 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? name).slice(0, 2);
  return out.toUpperCase();
}

// ── Pantalla de transferencia ────────────────────────────────────────────────

/** Snapshot de la cuenta para la pantalla del cliente (sin ids internos). */
export interface TransferDisplayData {
  bankName: string;
  bankSlug: string | null;
  logoUrl: string | null;
  holderName: string;
  cuit: string | null;
  cbu: string | null;
  cbuLabel: "CBU" | "CVU";
  alias: string | null;
  currency: TransferCurrency;
  note: string | null;
}

export function displayDataOf(a: TransferAccount): TransferDisplayData {
  return {
    bankName: a.bank_name,
    bankSlug: a.bank_slug,
    logoUrl: a.bank_slug ? null : a.custom_logo_url,
    holderName: a.holder_name,
    cuit: a.cuit,
    cbu: a.cbu,
    cbuLabel: cbuLabel(a.cbu),
    alias: a.alias,
    currency: a.currency,
    note: a.note,
  };
}

/** Mensaje amable para los errores del servidor. */
export function transferErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (msg.includes("transferencia_multicuenta")) return "Tener más de una cuenta (o elegirlas por sucursal) requiere un plan superior.";
  if (msg.includes("feature_not_in_plan")) return "Tu plan no incluye cobros por transferencia.";
  if (msg.includes("transfer_accounts_cbu_key")) return "Ya tenés una cuenta con ese CBU / CVU.";
  if (msg.includes("transfer_accounts_alias_key")) return "Ya tenés una cuenta con ese alias.";
  if (msg.includes("cbu_or_alias")) return "Cargá el CBU / CVU o el alias.";
  if (msg.includes("cbu_is_valid") || msg.includes("transfer_accounts_cbu_check")) return "El CBU / CVU no es válido.";
  if (msg.includes("cuit")) return "El CUIT no es válido.";
  if (msg.includes("alias")) return "El alias no es válido.";
  if (msg.includes("invalid_logo_path")) return "El logo no se pudo asociar a la cuenta.";
  if (msg.includes("forbidden") || msg.includes("row-level security")) return "No tenés permiso para editar las cuentas.";
  if (msg.includes("transfer_reference_required")) return "Cargá el número de operación de la transferencia.";
  if (msg.includes("transfer_account_not_available")) return "Esa cuenta no está disponible en esta caja.";
  return "No se pudo guardar la cuenta.";
}
