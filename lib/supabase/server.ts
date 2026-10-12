import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "@/types/database";

type CookieToSet = { name: string; value: string; options: CookieOptions };

// Cliente Supabase para Server Components / Route Handlers.
// Usa cookies de la request (anon key + sesión del usuario). RLS aplicada.
// `scope: "internal"` sólo desde app/internal: habilita el acceso cruzado del
// staff interno en RLS (internal_scope(), ADR-052).
export function createClient(opts: { scope?: "internal" } = {}) {
  const cookieStore = cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      ...(opts.scope === "internal" ? { global: { headers: { "x-ninja-scope": "internal" } } } : {}),
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Llamado desde un Server Component: el refresh de sesión lo
            // maneja el middleware. Seguro ignorar.
          }
        },
      },
    },
  );
}
