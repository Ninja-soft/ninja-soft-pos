// Constantes compartidas de planes de pago por marca (H27).

export const BRAND_OPTIONS = [
  { value: "visa", label: "Visa" },
  { value: "master", label: "Mastercard" },
  { value: "maestro", label: "Maestro" },
  { value: "cabal", label: "Cabal" },
  { value: "amex", label: "Amex" },
  { value: "naranja", label: "Naranja X" },
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

// Los logos de las marcas viven en lib/payments/logos (cardLogo).

// Etiqueta legible de un plan (para el campo label).
export function planLabel(base: string, brand: string | null, installments: number): string {
  const b = BASE_LABEL[base] ?? base;
  const brandTxt = brand ? ` ${BRAND_LABEL[brand] ?? brand}` : "";
  const cuotas = installments > 1 ? ` ${installments} cuotas` : base === "credito" ? " 1 pago" : "";
  return `${b}${brandTxt}${cuotas}`.trim();
}

// Resumen de los planes activos por medio (provider_key): cantidad y marcas
// con al menos un plan, en el orden de BRAND_OPTIONS. Lo usa la fila del canal
// en Configuración (botón "Planes de cuotas").
export type PlanSummary = { count: number; brands: string[] };

export function summarizePlans(
  plans: { provider_key: string | null; brand: string | null }[],
): Record<string, PlanSummary> {
  const out: Record<string, PlanSummary> = {};
  for (const p of plans) {
    if (!p.provider_key) continue;
    const s = (out[p.provider_key] ??= { count: 0, brands: [] });
    s.count += 1;
    if (p.brand && !s.brands.includes(p.brand)) s.brands.push(p.brand);
  }
  const order = (b: string) => {
    const i = (ALL_BRANDS as readonly string[]).indexOf(b);
    return i === -1 ? ALL_BRANDS.length : i;
  };
  for (const s of Object.values(out)) s.brands.sort((a, b) => order(a) - order(b));
  return out;
}
