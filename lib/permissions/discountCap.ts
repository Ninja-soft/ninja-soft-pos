// F24 · H159 (ADR-172): tope de descuento propio de una persona. PURO.

/** "" = sin tope propio (null); 0 a 100 con coma o punto. */
export function parseDiscountCap(raw: string): { ok: true; value: number | null } | { ok: false } {
  const s = String(raw ?? "").trim().replace(",", ".");
  if (s === "") return { ok: true, value: null };
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0 || n > 100) return { ok: false };
  return { ok: true, value: Math.round(n * 100) / 100 };
}

/** Tope efectivo del POS: el menor entre el del rol y el propio. */
export function effectiveDiscountCap(rolePct: number | null | undefined, userPct: number | null | undefined): number {
  return Math.min(rolePct ?? 100, userPct ?? 100);
}
