// =============================================================================
// Monto del débito automático de Mercado Pago y reglas de addons (ADR-156).
// La lógica pura vive en supabase/functions/_shared/billing/mpAmount.ts (la
// usan las Edges de cobro) y se reexporta acá para las pantallas y los tests.
// =============================================================================

export {
  addonBillable,
  addonPriceOn,
  addonUsable,
  authorizedPaymentKey,
  debitStartDate,
  expectedAmount,
  needsAmountSync,
  type AddonPriceInput,
} from "@/supabase/functions/_shared/billing/mpAmount";
