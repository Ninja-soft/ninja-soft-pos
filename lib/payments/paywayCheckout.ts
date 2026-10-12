// Lógica pura del checkout propio de Payway (/pagar/[id]): cuotas con su
// interés, detección de marca por BIN, validación de la tarjeta y colores
// legibles a partir del acento del negocio. Sin React, testeable con Vitest.

export type CheckoutPlan = {
  brand: string | null;
  installments: number;
  label: string;
  surcharge_pct: number;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

// ── Cuotas ───────────────────────────────────────────────────────────────────

export type InstallmentQuote = {
  installments: number;
  surchargePct: number;
  /** Total final (base + recargo). Mismo redondeo que el server. */
  total: number;
  /** Valor de cada cuota. */
  perInstallment: number;
  /** Interés en pesos: total final menos el monto base. */
  interest: number;
};

// Igual a finalAmountWithSurcharge de supabase/functions/_shared/payway.ts: el
// total que ve el cliente es exactamente el que cobra el server.
export function quoteInstallments(base: number, plan: Pick<CheckoutPlan, "installments" | "surcharge_pct">): InstallmentQuote {
  const pct = Number(plan.surcharge_pct) || 0;
  const n = Math.max(1, Math.trunc(plan.installments) || 1);
  const total = round2(base * (1 + pct / 100));
  return {
    installments: n,
    surchargePct: pct,
    total,
    perInstallment: round2(total / n),
    interest: round2(total - base),
  };
}

// Cuotas disponibles para una marca: el plan específico de la marca pisa al
// genérico; débito siempre en 1 pago; 1 pago sin recargo si no hay plan.
export function availablePlans(plans: CheckoutPlan[], brand: string, isDebit: boolean): CheckoutPlan[] {
  const list = new Map<number, CheckoutPlan>();
  for (const p of plans) {
    if (isDebit && p.installments > 1) continue;
    if (p.brand && p.brand !== brand) continue;
    const prev = list.get(p.installments);
    if (!prev || (p.brand && !prev.brand)) list.set(p.installments, p);
  }
  if (!list.has(1)) {
    list.set(1, { brand: null, installments: 1, label: "1 pago", surcharge_pct: 0 });
  }
  return [...list.values()].sort((a, b) => a.installments - b.installments);
}

const pctFmt = (n: number) =>
  n.toLocaleString("es-AR", { maximumFractionDigits: 2 });

// Texto de la píldora de interés de cada fila de cuotas.
export function interestLabel(q: InstallmentQuote, money: (n: number) => string): string {
  if (q.interest <= 0) return "Sin interés";
  return `+${pctFmt(q.surchargePct)}% · ${money(q.interest)} de interés`;
}

// ── Tarjeta ──────────────────────────────────────────────────────────────────

// Familia de marca detectada por el BIN (keys de PAYWAY_BRANDS sin la variante
// débito: Visa y Visa Débito comparten BINs, eso lo elige el cliente).
export type CardFamily = "visa" | "master" | "maestro" | "amex" | "diners" | "cabal" | "naranja";

const BIN_RULES: [CardFamily, RegExp][] = [
  // Específicas de Argentina primero: sus BINs caen en rangos de otras marcas.
  ["naranja", /^589562/],
  ["cabal", /^(589657|600691|603522|6042\d{2}|627170)/],
  ["amex", /^3[47]/],
  ["diners", /^(30[0-5]|309|36|38|39)/],
  ["maestro", /^(5018|5020|5038|5612|5893|6304|6759|676[1-3]|6390)/],
  ["master", /^(5[1-5]|222[1-9]|22[3-9]\d|2[3-6]\d{2}|27[01]\d|2720)/],
  ["visa", /^4/],
];

export function detectCardFamily(cardNumber: string): CardFamily | null {
  const d = cardNumber.replace(/\D/g, "");
  if (d.length < 2) return null;
  for (const [family, re] of BIN_RULES) if (re.test(d)) return family;
  return null;
}

// Marca del checkout → familia (visa_debito es Visa).
export const brandFamily = (brand: string): string => (brand === "visa_debito" ? "visa" : brand);

// Marca a seleccionar tras detectar el BIN: si la elegida ya es de esa familia
// (p. ej. Visa Débito con un BIN Visa) se respeta; si no, la de la familia, si
// el comercio la ofrece.
export function brandForDetected(current: string, family: CardFamily | null, offered: string[]): string {
  if (!family || brandFamily(current) === family) return current;
  return offered.includes(family) ? family : current;
}

export function cardNumberMaxLength(family: CardFamily | null): number {
  if (family === "amex") return 15;
  if (family === "diners") return 14;
  return 19;
}

// 4-4-4-4 (Amex 4-6-5, Diners 4-6-4).
export function formatCardNumber(value: string): string {
  const family = detectCardFamily(value);
  const d = value.replace(/\D/g, "").slice(0, cardNumberMaxLength(family));
  if (family === "amex" || family === "diners") {
    return [d.slice(0, 4), d.slice(4, 10), d.slice(10)].filter(Boolean).join(" ");
  }
  return d.replace(/(\d{4})(?=\d)/g, "$1 ");
}

export function luhnValid(cardNumber: string): boolean {
  const d = cardNumber.replace(/\D/g, "");
  if (d.length < 13) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

export function formatExpiry(value: string): string {
  const d = value.replace(/\D/g, "").slice(0, 4);
  return d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d;
}

export type CardFieldErrors = Partial<Record<"number" | "exp" | "cvv" | "holder" | "dni", string>>;

export function validateCard(
  f: { number: string; exp: string; cvv: string; holder: string; dni: string },
  now: Date = new Date(),
): CardFieldErrors {
  const e: CardFieldErrors = {};
  const digits = f.number.replace(/\D/g, "");
  const family = detectCardFamily(digits);
  const min = family === "amex" ? 15 : family === "diners" ? 14 : 16;
  if (digits.length < min || !luhnValid(digits)) e.number = "Revisá el número de la tarjeta.";

  const m = /^(\d{2})\/(\d{2})$/.exec(f.exp.trim());
  if (!m) e.exp = "Usá el formato MM/AA.";
  else {
    const month = Number(m[1]);
    const year = 2000 + Number(m[2]);
    if (month < 1 || month > 12) e.exp = "El mes no es válido.";
    else if (year < now.getFullYear() || (year === now.getFullYear() && month < now.getMonth() + 1)) {
      e.exp = "La tarjeta está vencida.";
    }
  }

  const cvvLen = f.cvv.replace(/\D/g, "").length;
  if (family === "amex" ? cvvLen !== 4 : cvvLen < 3 || cvvLen > 4) {
    e.cvv = family === "amex" ? "Son 4 dígitos (frente)." : "Son 3 dígitos (dorso).";
  }
  if (f.holder.trim().length < 3) e.holder = "Escribí el nombre como figura en la tarjeta.";
  const dniLen = f.dni.replace(/\D/g, "").length;
  if (dniLen < 6 || dniLen > 9) e.dni = "Revisá el DNI.";
  return e;
}

// ── Color de acento legible ──────────────────────────────────────────────────

export const NINJA_FLAME = "#FF4B22";

type RGB = [number, number, number];

export function parseHex(hex: string | null | undefined): RGB | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex ?? "").trim());
  const raw = m?.[1];
  if (!raw) return null;
  const h = raw.length === 3 ? raw.replace(/./g, (c) => c + c) : raw;
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
}

const toHex = (c: RGB) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

function luminance([r, g, b]: RGB): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(parseHex(a) ?? [0, 0, 0]);
  const lb = luminance(parseHex(b) ?? [0, 0, 0]);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// Oscurece el color (mezcla con negro) hasta lograr el contraste pedido
// contra `against`. Sirve para texto de acento sobre blanco/tinte y para el
// fondo del botón con texto blanco.
export function darkenForContrast(hex: string, against = "#ffffff", min = 4.5): string {
  const base = parseHex(hex) ?? parseHex(NINJA_FLAME)!;
  for (let k = 0; k <= 1.0001; k += 0.04) {
    const c = base.map((v) => v * (1 - k)) as RGB;
    if (contrastRatio(toHex(c), against) >= min) return toHex(c);
  }
  return "#000000";
}

// Mezcla con blanco (tinte opaco): 0.1 = 10% del acento.
export function tint(hex: string, amount: number): string {
  const c = parseHex(hex) ?? parseHex(NINJA_FLAME)!;
  return toHex(c.map((v) => 255 - (255 - v) * amount) as RGB);
}

export type AccentPalette = {
  /** Acento tal cual lo eligió el negocio (decoración). */
  base: string;
  /** Fondo del botón principal: texto blanco con contraste AA. */
  solid: string;
  /** Texto de acento sobre el tinte suave (AA). */
  text: string;
  /** Tinte suave (fila elegida, píldoras). */
  soft: string;
  /** Tinte un poco más fuerte (píldora sobre fila elegida). */
  softer: string;
};

export function accentPalette(accent: string | null | undefined): AccentPalette {
  const base = parseHex(accent) ? toHex(parseHex(accent)!) : NINJA_FLAME.toLowerCase();
  const soft = tint(base, 0.08);
  const softer = tint(base, 0.16);
  return {
    base,
    solid: darkenForContrast(base, "#ffffff", 4.5),
    text: darkenForContrast(base, softer, 4.5),
    soft,
    softer,
  };
}
