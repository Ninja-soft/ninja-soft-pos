// =============================================================================
// GET /api/mp/oauth/callback — destino del redirect de Mercado Pago tras el
// OAuth. Recibe ?code&state, los manda a la Edge Function mp_oauth_callback
// (que hace el intercambio con el client_secret server-side) y redirige al
// panel de Configuración con el resultado. Nunca expone secretos al browser.
// =============================================================================
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const code = params.get("code");
  const state = params.get("state");
  const mpError = params.get("error");

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? req.nextUrl.origin;
  const back = (status: string) =>
    NextResponse.redirect(`${appUrl}/configuracion?mp=${status}`);

  // El usuario rechazó el permiso en MP, o faltan parámetros.
  if (mpError) return back("denied");
  if (!code || !state) return back("err");

  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  try {
    const res = await fetch(`${supaUrl}/functions/v1/mp_oauth_callback`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
      },
      body: JSON.stringify({ code, state }),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean };
    return back(res.ok && data.ok ? "ok" : "err");
  } catch {
    return back("err");
  }
}
