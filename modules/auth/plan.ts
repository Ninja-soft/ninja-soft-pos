import { createClient } from "@/lib/supabase/client";

// Aplica el plan elegido en el registro al tenant recién creado.
//
// `create_tenant` (Edge) crea la suscripción con el plan `start` en trial 14d.
// Si el usuario eligió otro plan con trial, reusamos el RPC ya existente
// `request_plan_change(p_plan_key)` (owner-only, security definer, auditado):
// intercambia el plan_id de la suscripción manteniendo el período/trial vigente.
// Como todos los planes con trial son de 14 días, el trial que dejó
// `create_tenant` sigue siendo correcto.
//
// Nunca lanza: si el cambio falla, el alta no se aborta (el tenant queda con el
// plan start en trial, recuperable desde el panel). Devuelve ok/false + mensaje.

const PLAN_ERROR_MESSAGES: Record<string, string> = {
  forbidden: "No tenés permiso para elegir el plan",
  invalid_plan: "Plan inválido",
  plan_not_found: "El plan elegido no está disponible",
  subscription_not_found: "No encontramos tu suscripción",
};

function planErrorMessage(raw: string | null | undefined): string {
  if (!raw) return "No se pudo aplicar el plan";
  for (const [key, msg] of Object.entries(PLAN_ERROR_MESSAGES)) {
    if (raw.includes(key)) return msg;
  }
  return "No se pudo aplicar el plan";
}

export interface ApplyPlanResult {
  ok: boolean;
  message: string;
}

export async function applySignupPlan(
  planKey: string,
): Promise<ApplyPlanResult> {
  const key = planKey.trim();
  if (!key) return { ok: false, message: "" };
  const supabase = createClient();
  const { error } = await supabase.rpc("request_plan_change", {
    p_plan_key: key,
  });
  if (error) {
    return { ok: false, message: planErrorMessage(error.message) };
  }
  return { ok: true, message: "Plan aplicado" };
}
