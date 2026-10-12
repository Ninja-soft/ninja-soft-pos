// Números de comercio por marca de tarjeta (opcionales), para conciliar los
// cobros con las liquidaciones de cada adquirente. Viven en
// tenant_payment_methods.config.merchant_numbers ({ visa: "12345678", ... })
// por medio de pago; al cobrar "Tarjeta en posnet" el número que corresponde se
// guarda en payments.card_voucher.comercio.

export type MerchantNumbers = Partial<Record<string, string>>;

export interface ProviderMerchantNumbers {
  provider_key: string;
  merchant_numbers?: MerchantNumbers | null;
}

/** Sólo letras y números (sin puntos, guiones ni espacios), hasta 20. */
export function cleanMerchantNumber(raw: string): string {
  return raw.replace(/[^0-9a-z]/gi, "").slice(0, 20);
}

/**
 * Número de comercio para una venta con tarjeta: el del medio del plan elegido
 * o, sin plan de un medio, el único cargado para la marca. Con varios medios
 * que tienen número distinto para la marca no se adivina: null.
 */
export function resolveMerchantNumber(
  providers: ProviderMerchantNumbers[],
  brand: string | null,
  planProvider: string | null,
): string | null {
  if (!brand) return null;
  if (planProvider) {
    const own = providers.find((p) => p.provider_key === planProvider)?.merchant_numbers?.[brand];
    if (own) return own;
  }
  const values = new Set(
    providers.map((p) => p.merchant_numbers?.[brand]).filter((v): v is string => Boolean(v)),
  );
  return values.size === 1 ? [...values][0]! : null;
}
