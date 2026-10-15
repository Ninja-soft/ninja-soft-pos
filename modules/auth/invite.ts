import { createClient } from "@/lib/supabase/client";

// Mensajes amigables para los errores que lanza redeem_invite_code() (SQL).
const INVITE_ERROR_MESSAGES: Record<string, string> = {
  invalid_code: "Código inválido",
  code_expired: "Código vencido",
  code_not_started: "El código todavía no está vigente",
  code_exhausted: "Código agotado",
  code_inactive: "Código inactivo",
  plan_not_found: "El plan del código no está disponible",
  forbidden: "No podés canjear este código",
  code_already_redeemed: "Tu negocio ya usó un código de cuenta corriente",
};

export function inviteErrorMessage(raw: string | null | undefined): string {
  if (!raw) return "No se pudo aplicar el código";
  for (const [key, msg] of Object.entries(INVITE_ERROR_MESSAGES)) {
    if (raw.includes(key)) return msg;
  }
  return "No se pudo aplicar el código";
}

export interface RedeemResult {
  ok: boolean;
  message: string;
  /** Tipo del código canjeado: vitalicio, días de prueba o cuenta corriente. */
  kind?: "lifetime" | "trial_days" | "account";
}

// Canjea un código de invitación para el tenant recién creado. Nunca lanza:
// devuelve ok/false + mensaje para que un código inválido no aborte el alta.
export async function redeemInviteCode(
  code: string,
  tenantId: string,
): Promise<RedeemResult> {
  const trimmed = code.trim();
  if (!trimmed) return { ok: false, message: "" };
  const supabase = createClient();
  const { data, error } = await supabase.rpc("redeem_invite_code", {
    p_code: trimmed,
    p_tenant_id: tenantId,
  });
  if (error) {
    return { ok: false, message: inviteErrorMessage(error.message) };
  }
  const res = (data ?? {}) as RedeemPayload;
  return { ok: true, kind: res.kind, message: redeemMessage(res) };
}

interface RedeemPayload {
  kind?: RedeemResult["kind"];
  trial_days?: number | null;
  due_days?: number | null;
  discount_percent?: number | null;
  ai_included?: boolean | null;
  ai_months?: number | null;
}

/** Mensaje del canje con todo lo que el código aplicó (ADR-120 + ADR-150). */
export function redeemMessage(res: RedeemPayload): string {
  const parts: string[] = [];
  if (res.kind === "account") {
    // Cuenta corriente (F20-8): sin checkout de Mercado Pago; paga por
    // transferencia contra aviso de cobro.
    parts.push(
      res.due_days != null
        ? `pagás por cuenta corriente, con ${res.due_days} días para pagar cada cuota`
        : "pagás por cuenta corriente",
    );
  } else if (res.kind === "lifetime") {
    parts.push("tenés acceso vitalicio");
  } else if (res.kind === "trial_days" && res.trial_days) {
    parts.push(`tenés ${res.trial_days} días de prueba`);
  }
  if (res.discount_percent && res.kind !== "lifetime") {
    parts.push(`${Number(res.discount_percent).toLocaleString("es-AR")} % de descuento`);
  }
  if (res.ai_included) {
    parts.push(
      res.ai_months
        ? `Asistente IA bonificado por ${res.ai_months} ${res.ai_months === 1 ? "mes" : "meses"}`
        : "Asistente IA bonificado",
    );
  }
  return parts.length > 0 ? `Código aplicado: ${parts.join(", ")}` : "Código aplicado";
}
