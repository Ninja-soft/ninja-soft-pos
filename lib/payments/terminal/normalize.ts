// Normalización del resultado de una terminal integrada (ADR-053): marca de
// la tarjeta a las claves de lib/pos/cardBrands, cupón para
// payments.card_voucher y mensaje de rechazo para el cajero.

import { CARD_BRANDS } from "@/lib/pos/cardBrands";
import type { CardType, TerminalResult } from "./types";

const BRAND_ALIASES: [RegExp, string][] = [
  [/^(visa|vi|vs|visa\s*(electron|debito|débito|credito|crédito))\b/i, "visa"],
  [/^(master|mastercard|mc|master\s*card)\b/i, "master"],
  [/^(maestro|mae)\b/i, "maestro"],
  [/^(amex|american\s*express|ax)\b/i, "amex"],
  [/^cabal\b/i, "cabal"],
  [/^(naranja|naranja\s*x|tarjeta\s*naranja)\b/i, "naranja"],
  [/^(diners|diners\s*club|dc)\b/i, "diners"],
];

/** "VISA DEBITO" → "visa"; null si no se reconoce (queda como "Otra"). */
export function normalizeCardBrand(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  for (const [re, key] of BRAND_ALIASES) if (re.test(s)) return key;
  const lower = s.toLowerCase();
  return CARD_BRANDS.find((b) => b.key === lower || b.label.toLowerCase() === lower)?.key ?? null;
}

/** Débito / crédito a partir de la leyenda de la marca, si la trae. */
export function cardTypeFromBrand(raw: string | null | undefined): CardType | null {
  const s = (raw ?? "").toLowerCase();
  if (/d[eé]bito|debit|electron|maestro/.test(s)) return "debit";
  if (/cr[eé]dito|credit|amex|american|naranja|diners/.test(s)) return "credit";
  return null;
}

/** Últimos 4 de un PAN enmascarado ("************1234", "1234", "XXXX1234"). */
export function last4Of(raw: string | null | undefined): string | null {
  const d = (raw ?? "").replace(/\D/g, "");
  return d.length >= 4 ? d.slice(-4) : null;
}

const trimOrNull = (v: string | null | undefined) => {
  const s = (v ?? "").trim();
  return s ? s : null;
};

/** Ceros a la izquierda fuera ("000123" → "123"), salvo que sea todo cero. */
export function stripZeros(v: string | null | undefined): string | null {
  const s = trimOrNull(v);
  if (!s) return null;
  const t = s.replace(/^0+(?=\d)/, "");
  return t;
}

/** Limpia un resultado crudo de un adaptador (tipos, espacios, ceros, marca). */
export function normalizeResult(r: TerminalResult): TerminalResult {
  const brand = trimOrNull(r.cardBrand);
  const inst = r.installments != null && Number.isFinite(r.installments) && r.installments > 0 ? Math.trunc(r.installments) : null;
  return {
    ...r,
    authCode: trimOrNull(r.authCode),
    lote: stripZeros(r.lote),
    cupon: stripZeros(r.cupon),
    cardBrand: brand,
    cardType: r.cardType ?? cardTypeFromBrand(brand) ?? (inst && inst > 1 ? "credit" : null),
    last4: last4Of(r.last4),
    installments: inst,
    merchantNumber: trimOrNull(r.merchantNumber)?.replace(/[^0-9A-Za-z]/g, "").slice(0, 20) || null,
    terminalNumber: trimOrNull(r.terminalNumber),
    responseCode: trimOrNull(r.responseCode),
    message: trimOrNull(r.message),
  };
}

/** payments.card_voucher de un cobro aprobado por la terminal. */
export interface TerminalCardVoucher {
  lote: string;
  cupon: string;
  autorizacion: string;
  marca?: string;
  ultimos4?: string;
  cuotas?: number;
  comercio?: string;
  /** Adquirente (payment_providers.key de la marca: payway, fiserv, getnet). Mismo campo que la tarjeta en posnet. */
  adquirente?: string;
  /** Marca de origen: el cupón lo informó la terminal (no se cargó a mano). */
  origen: "terminal";
  /** terminal_transactions.id (lo valida el trigger de payments). */
  terminal_tx?: string;
}

export function toCardVoucher(
  r: TerminalResult,
  opts: { terminalTxId?: string | null; fallbackMerchant?: string | null; acquirer?: string | null } = {},
): TerminalCardVoucher {
  const n = normalizeResult(r);
  const key = normalizeCardBrand(n.cardBrand);
  const label = key ? (CARD_BRANDS.find((b) => b.key === key)?.label ?? null) : n.cardBrand;
  const comercio = n.merchantNumber ?? opts.fallbackMerchant ?? null;
  return {
    lote: n.lote ?? "",
    cupon: n.cupon ?? "",
    autorizacion: n.authCode ?? "",
    ...(label ? { marca: label } : {}),
    ...(n.last4 ? { ultimos4: n.last4 } : {}),
    ...(n.installments ? { cuotas: n.installments } : {}),
    ...(comercio ? { comercio } : {}),
    ...(opts.acquirer ? { adquirente: opts.acquirer } : {}),
    origen: "terminal",
    ...(opts.terminalTxId ? { terminal_tx: opts.terminalTxId } : {}),
  };
}

/**
 * Motivo legible del rechazo. Usa el texto de la terminal si lo trae; si no,
 * un genérico (los códigos de respuesta de cada autorizador se suman cuando
 * estén en la especificación del adquirente).
 */
export function declineMessage(r: Pick<TerminalResult, "message" | "responseCode">): string {
  const m = (r.message ?? "").trim();
  if (m) return m.charAt(0).toUpperCase() + m.slice(1).toLowerCase();
  return r.responseCode ? `Rechazada por el emisor (código ${r.responseCode})` : "Rechazada por el emisor";
}
