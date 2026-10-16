// Resumen legible de un código de invitación (tabla del panel interno y
// mensaje al canjearlo). Puro, testeable. ADR-120 + ADR-154.

export interface InviteCodeTerms {
  kind: "lifetime" | "trial_days" | "account";
  trial_days: number | null;
  due_days: number | null;
  discount_percent: number | null;
  discount_months: number | null;
  billing_cycle: "monthly" | "yearly" | null;
  ai_included?: boolean | null;
  ai_months?: number | null;
}

function months(n: number): string {
  return `${n} ${n === 1 ? "mes" : "meses"}`;
}

export function inviteCodeParts(c: InviteCodeTerms): string[] {
  const parts: string[] = [];
  if (c.kind === "lifetime") parts.push("Vitalicio");
  else if (c.kind === "trial_days")
    parts.push(`Prueba de ${c.trial_days ?? 0} días`);
  else parts.push(`Cuenta corriente, paga a ${c.due_days ?? 0} días`);

  if (c.kind !== "lifetime" && c.discount_percent) {
    const pct = Number(c.discount_percent).toLocaleString("es-AR");
    const span = c.discount_months ? ` por ${months(c.discount_months)}` : "";
    const from = c.kind === "trial_days" ? " después de la prueba" : "";
    parts.push(`${pct} % de descuento${span}${from}`);
  }
  if (c.kind === "account" && c.billing_cycle === "yearly") parts.push("anual");
  if (c.ai_included) {
    parts.push(
      c.ai_months
        ? `Asistente IA bonificado por ${months(c.ai_months)}`
        : "Asistente IA bonificado para siempre",
    );
  }
  return parts;
}

export function inviteCodeSummary(c: InviteCodeTerms): string {
  return inviteCodeParts(c).join(" · ");
}
