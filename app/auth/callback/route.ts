import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { safeNextPath } from "@/lib/auth/redirect";

// Vuelta del OAuth (Google). Canjea el código PKCE del lado servidor y escribe
// las cookies de sesión ANTES de entrar a una ruta protegida; si no, el
// middleware ve "sin sesión" y rebota al login (bug "Google a veces no entra").
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");
  const next = safeNextPath(searchParams.get("next"));

  if (code) {
    const supabase = createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(next, origin));
  }

  const login = new URL("/login", origin);
  login.searchParams.set("error", "oauth");
  return NextResponse.redirect(login);
}
