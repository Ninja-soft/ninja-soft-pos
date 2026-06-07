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
  const { error } = await supabase.rpc("redeem_invite_code", {
    p_code: trimmed,
    p_tenant_id: tenantId,
  });
  if (error) {
    return { ok: false, message: inviteErrorMessage(error.message) };
  }
  return { ok: true, message: "Código aplicado" };
}
