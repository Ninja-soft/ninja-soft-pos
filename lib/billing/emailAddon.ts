// =============================================================================
// Complemento "Email con dominio NinjaSoft" (ADR-156). La lógica pura vive en
// supabase/functions/_shared/billing/emailAddon.ts (la usan las Edges) y se
// reexporta acá, con los textos de las pantallas del dueño y del staff.
// =============================================================================

export {
  DOMAIN_STATUS_LABEL,
  dnsHostLabel,
  emailLocalPart,
  findDomain,
  isPlausibleResendKey,
  isValidDomain,
  isValidFixedLocal,
  keyHint,
  ninjaEmailErrorMessage,
  overageBlocks,
  parseResendDomain,
  quotaCheck,
  senderAddress,
  usageLevel,
  type DnsRecord,
  type OveragePolicy,
  type QuotaCheck,
  type ResendDomain,
  type SenderMode,
} from "@/supabase/functions/_shared/billing/emailAddon";

export const EMAIL_ADDON_KEY = "email_ninjasoft";

export const OVERAGE_POLICY_LABEL: Record<string, { title: string; desc: string }> = {
  block: {
    title: "Bloquear",
    desc: "Al llegar al cupo los emails dejan de salir hasta el mes siguiente.",
  },
  warn: {
    title: "Avisar",
    desc: "Siguen saliendo, se avisa al dueño y no se cobra el excedente.",
  },
  charge: {
    title: "Cobrar excedente",
    desc: "Siguen saliendo y el excedente se cobra por bloques en el próximo cobro.",
  },
};

/** Cuándo se paga el alta o el cambio de escalón (owner_email_addon_quote.when). */
export type QuoteWhen = "trial" | "next_debit" | "account" | "next_period" | "none";

export interface EmailAddonQuote {
  kind: "new" | "upgrade" | "downgrade" | "same";
  tier: { id: string; label: string; quota: number; price: number };
  old_price: number;
  charge_now_cents: number;
  when: QuoteWhen;
  mode: string;
  cycle: string;
  next_charge_date: string | null;
  cycle_total_after: number;
  next_debit_amount: number | null;
  effective_from: string | null;
}

/**
 * Texto de confirmación del monto para el dueño. `fmt` formatea pesos y
 * `fmtDate` fechas (los pasa la pantalla para usar los mismos formatos).
 */
export function quoteSummary(
  q: EmailAddonQuote,
  fmt: (n: number) => string,
  fmtDate: (d: string | null) => string,
): { headline: string; lines: string[] } {
  const monthly = fmt(q.tier.price);
  const now = fmt(q.charge_now_cents / 100);
  const next = fmtDate(q.next_charge_date);
  const cycleWord = q.cycle === "yearly" ? "cada año" : "cada mes";
  const lines: string[] = [];
  if (q.kind === "downgrade") {
    return {
      headline: `Pasás a ${q.tier.label} desde el ${fmtDate(q.effective_from)}`,
      lines: [
        `Hasta esa fecha seguís con tu escalón actual. No se devuelve lo ya pagado.`,
        `Desde ese cobro pagás ${fmt(q.cycle_total_after)} ${cycleWord} en total.`,
      ],
    };
  }
  if (q.kind === "same") {
    return { headline: `Seguís con ${q.tier.label}`, lines: [] };
  }
  switch (q.when) {
    case "trial":
      lines.push(`Hoy no pagás nada: estás en tu prueba gratis.`);
      lines.push(`Al terminar la prueba, el ${next}, tu cobro pasa a ${fmt(q.cycle_total_after)} ${cycleWord}.`);
      break;
    case "next_debit":
      lines.push(`Hoy no se cobra nada aparte.`);
      lines.push(
        `En tu próximo débito de Mercado Pago, el ${next}, se suman ${now} por los días que quedan de este período: ese débito va a ser de ${fmt(q.next_debit_amount ?? q.cycle_total_after)}.`,
      );
      lines.push(`Desde el siguiente, ${fmt(q.cycle_total_after)} ${cycleWord}.`);
      break;
    case "account":
      lines.push(`Se carga ${now} en tu cuenta corriente por los días que quedan de este período, con vencimiento el ${next}.`);
      lines.push(`Desde el próximo período, ${fmt(q.cycle_total_after)} ${cycleWord}.`);
      break;
    default:
      lines.push(`Se suma a tu próximo cobro: desde el ${next} pagás ${fmt(q.cycle_total_after)} ${cycleWord}.`);
  }
  return {
    headline:
      q.kind === "upgrade"
        ? `Pasás a ${q.tier.label}: ${monthly} por mes`
        : `${q.tier.label}: ${monthly} por mes`,
    lines,
  };
}

export function emailAddonErrorMessage(code: string): string {
  switch (code) {
    case "price_changed":
      return "El precio cambió mientras lo mirabas. Revisalo y confirmá de nuevo.";
    case "subscription_inactive":
      return "Tu suscripción no está activa. Regularizala para sumar complementos.";
    case "subscription_ending":
      return "Tu suscripción tiene la baja programada. Reactivala para sumar complementos.";
    case "addon_not_available":
      return "El email de NinjaSoft todavía no está disponible.";
    case "addon_granted":
      return "Tenés el email de NinjaSoft bonificado. Para cambiar el escalón escribinos.";
    case "tier_not_found":
      return "Ese escalón ya no está disponible. Elegí otro.";
    case "addon_inactive":
      return "El email de NinjaSoft no está activo en tu suscripción.";
    case "forbidden":
      return "Sólo el dueño puede contratar complementos.";
    default:
      return "No se pudo completar. Probá de nuevo.";
  }
}
