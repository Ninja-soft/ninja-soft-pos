"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/types/database";

// Cliente Supabase para el navegador (anon key, respeta RLS).
// Nunca usar service_role aquí. Ver docs/05-security.md §2.
export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
