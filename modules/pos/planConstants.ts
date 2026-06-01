// Constantes compartidas de planes de pago por marca (H27).

export const BRAND_OPTIONS = [
  { value: "visa", label: "Visa" },
  { value: "master", label: "Mastercard" },
  { value: "maestro", label: "Maestro" },
  { value: "cabal", label: "Cabal" },
  { value: "amex", label: "Amex" },
  { value: "naranja", label: "Naranja" },
  { value: "diners", label: "Diners" },
] as const;

export const ALL_BRANDS = BRAND_OPTIONS.map((b) => b.value);
export const BRAND_LABEL: Record<string, string> = Object.fromEntries(
  BRAND_OPTIONS.map((b) => [b.value, b.label]),
);

export const BASE_LABEL: Record<string, string> = {
  efectivo: "Efectivo",
  transferencia: "Transferencia",
  debito: "Débito",
  credito: "Crédito",
  qr: "QR",
  otro: "Otro",
};

export const DEFAULT_INSTALLMENTS = [1, 3, 6, 12];

// Marcas que existen en débito (las de crédito son todas).
export const DEBIT_BRANDS = new Set(["visa", "master", "maestro", "cabal"]);

// Logo de la marca según base (débito/crédito). null si no hay archivo.
export function brandLogo(brand: string | null, base: string): string | null {
  if (!brand) return null;
  const isDebit = base === "debito";
  const map: Record<string, { credito?: string; debito?: string }> = {
    visa: { credito: "visa_credito", debito: "visa_debito" },
    master: { credito: "martercard_credito", debito: "mastercard_debito" },
    maestro: { debito: "maestro_debito" },
    cabal: { credito: "cabal_credito", debito: "cabal_debito" },
    amex: { credito: "amex_credito" },
    naranja: { credito: "naranja_credito" },
    diners: { credito: "dinners_credito" },
  };
  const m = map[brand];
  if (!m) return null;
  const file = (isDebit ? m.debito : m.credito) ?? m.credito ?? m.debito;
  return file ? `/img/medios_de_pago/cards/${file}.svg` : null;
}

// Etiqueta legible de un plan (para el campo label).
export function planLabel(base: string, brand: string | null, installments: number): string {
  const b = BASE_LABEL[base] ?? base;
  const brandTxt = brand ? ` ${BRAND_LABEL[brand] ?? brand}` : "";
  const cuotas = installments > 1 ? ` ${installments} cuotas` : base === "credito" ? " 1 pago" : "";
  return `${b}${brandTxt}${cuotas}`.trim();
}
