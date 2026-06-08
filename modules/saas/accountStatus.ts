"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";

// =============================================================================
// Estado de la CUENTA (suscripción) del tenant activo, para gatear el acceso a
// la app del cliente. Lo setea el motor de dunning (otro dominio): escribe el
// mismo `status` en `tenants` y en `subscriptions`. Acá leemos `tenants.status`
// porque su RLS lo expone a TODO miembro activo (owner, encargado, cajero,
// lector) — `my_subscription()` en cambio es owner-only y dejaría sin gatear a
// los cajeros de un tenant suspendido.
//
// Contrato de estados (ver migración del dunning):
//   trial / active   → uso normal.
//   past_due         → usable, pero con AVISO (el pago falló; hay días de gracia
//                      antes de la suspensión).
//   suspended        → BLOQUEADA (pasó la gracia sin pagar). Reactivar pagando.
//   cancelled        → sin acceso.
// =============================================================================

export type AccountStatus =
  | "trial"
  | "active"
  | "past_due"
  | "suspended"
  | "cancelled"
  | "unknown";

// Días de gracia que el motor de dunning espera en `past_due` antes de suspender.
// `platform_settings.grace_days` es staff-only (no legible por el cliente), así
// que para el contador del banner usamos esta constante de display. Si el motor
// cambia su gracia, ajustá este número (solo afecta el texto del aviso, nunca el
// bloqueo: el bloqueo reacciona al status real `suspended`).
export const PAST_DUE_GRACE_DAYS = 3;

export interface AccountStatusInfo {
  status: AccountStatus;
  // Bloqueante: la app del POS no debe usarse.
  isSuspended: boolean;
  // Aviso no bloqueante: el pago falló pero todavía hay gracia.
  isPastDue: boolean;
  // Sin acceso (cuenta cancelada).
  isCancelled: boolean;
  // Días restantes estimados para regularizar antes de la suspensión (>= 0) o
  // null si no se puede estimar. Solo informativo (ver PAST_DUE_GRACE_DAYS).
  pastDueDaysLeft: number | null;
}

// Normaliza variantes de escritura del status a nuestro enum.
function normalizeStatus(raw: string | null | undefined): AccountStatus {
  switch ((raw ?? "").toLowerCase()) {
    case "trial":
    case "trialing":
      return "trial";
    case "active":
      return "active";
    case "past_due":
    case "pastdue":
      return "past_due";
    case "suspended":
      return "suspended";
    case "cancelled":
    case "canceled":
      return "cancelled";
    default:
      return "unknown";
  }
}

// Días restantes (>= 0) hasta `iso`; null si no hay fecha.
function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)));
}

// Lee el status (+ fin de período) del tenant activo del usuario. Role-agnostic.
// Refetch en foco/intervalo: si el dunning suspende la cuenta mientras la pestaña
// está abierta, el bloqueo aparece sin recargar (y al pagar, se libera al pasar
// el webhook a active).
export function useAccountStatus() {
  return useQuery<AccountStatusInfo>({
    queryKey: ["account-status"],
    queryFn: async (): Promise<AccountStatusInfo> => {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        return {
          status: "unknown",
          isSuspended: false,
          isPastDue: false,
          isCancelled: false,
          pastDueDaysLeft: null,
        };
      }
      const { data: mem } = await supabase
        .from("tenant_users")
        .select("tenant_id")
        .eq("user_id", user.id)
        .eq("status", "active")
        .limit(1)
        .maybeSingle();
      if (!mem) {
        return {
          status: "unknown",
          isSuspended: false,
          isPastDue: false,
          isCancelled: false,
          pastDueDaysLeft: null,
        };
      }
      const { data: t } = await supabase
        .from("tenants")
        .select("status, trial_ends_at")
        .eq("id", mem.tenant_id)
        .maybeSingle();

      const status = normalizeStatus(t?.status);

      // Estimación informativa de días para regularizar: la gracia corre desde
      // que venció el período; sin acceso al instante exacto del flip, partimos
      // del fin de trial/período si está disponible. Solo para el texto del aviso.
      let pastDueDaysLeft: number | null = null;
      if (status === "past_due") {
        const baseDays = daysUntil(
          (t as { trial_ends_at?: string | null } | null)?.trial_ends_at,
        );
        pastDueDaysLeft = baseDays != null ? baseDays : PAST_DUE_GRACE_DAYS;
      }

      return {
        status,
        isSuspended: status === "suspended",
        isPastDue: status === "past_due",
        isCancelled: status === "cancelled",
        pastDueDaysLeft,
      };
    },
    // El status cambia rara vez; refrescamos en foco y cada 5 min por si el
    // dunning actúa con la pestaña abierta.
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    refetchInterval: 5 * 60_000,
  });
}
