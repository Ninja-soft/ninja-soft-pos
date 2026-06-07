"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";

export type AuthProvider = "google" | "email";

// Proveedor de identidad con el que se creó/usa la cuenta autenticada.
// Lo leemos de app_metadata.provider (Supabase). Si la cuenta vino por
// Google, la contraseña la gestiona Google: no se puede cambiar acá.
export function useAuthProvider() {
  return useQuery<AuthProvider | null>({
    queryKey: ["auth-provider"],
    queryFn: async (): Promise<AuthProvider | null> => {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return null;

      // Fuente primaria: app_metadata.provider.
      const provider = user.app_metadata?.provider;
      if (provider === "google") return "google";
      if (provider === "email") return "email";

      // Respaldo: providers[] o identities[] pueden incluir "google" aunque
      // provider primario sea otro valor.
      const providers = user.app_metadata?.providers;
      if (Array.isArray(providers) && providers.includes("google")) {
        return "google";
      }
      const identities = user.identities;
      if (
        Array.isArray(identities) &&
        identities.some((i) => i.provider === "google")
      ) {
        return "google";
      }

      return "email";
    },
    staleTime: 5 * 60 * 1000,
  });
}
