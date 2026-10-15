"use client";

import { useQuery, type QueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { getCurrentUser } from "@/lib/supabase/currentUser";
import { activeTenantIdOf, fetchMyMembership } from "@/lib/tenant/myMembership";

// Perfil que muestra el pie del menú: nombre y foto de MI membresía en el
// NEGOCIO ACTIVO (lo mismo que se edita en "Mi perfil" y en Equipo). Si la
// membresía todavía no tiene nombre, cae al nombre de la cuenta (users).
export interface MyMembershipProfile {
  tenantId: string | null;
  displayName: string | null;
  avatar: string | null;
}

export const MY_MEMBERSHIP_PROFILE_KEY = "my-membership-profile";

export function useMyMembershipProfile() {
  return useQuery({
    queryKey: [MY_MEMBERSHIP_PROFILE_KEY],
    queryFn: async (): Promise<MyMembershipProfile | null> => {
      const user = await getCurrentUser();
      if (!user) return null;
      const supabase = createClient();
      const [mem, acc] = await Promise.all([
        fetchMyMembership<{
          display_name: string | null;
          avatar: string | null;
        }>(supabase, user, "display_name, avatar"),
        supabase
          .from("users")
          .select("full_name")
          .eq("id", user.id)
          .maybeSingle(),
      ]);
      const accountName =
        (acc.data as { full_name?: string | null } | null)?.full_name ?? null;
      const metaName = (
        user.user_metadata as { full_name?: unknown } | undefined
      )?.full_name;
      return {
        tenantId: activeTenantIdOf(user),
        displayName:
          mem?.display_name?.trim() ||
          accountName?.trim() ||
          (typeof metaName === "string" ? metaName.trim() : "") ||
          null,
        avatar: mem?.avatar ?? null,
      };
    },
  });
}

/** Refresca el pie del menú (POS e interno) después de guardar un perfil. */
export function invalidateMyProfile(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: [MY_MEMBERSHIP_PROFILE_KEY] });
  qc.invalidateQueries({ queryKey: ["internal-shell-profile"] });
}
