// =============================================================================
// GET /api/ml/oauth/callback: destino del redirect de Mercado Libre tras el
// OAuth (H87 · ADR-104). Es la Redirect URI EXACTA registrada en DevCenter
// (HTTPS, sin partes variables: el negocio viaja en `state`). Recibe
// ?code&state (o ?error), los manda a la Edge pública ml_oauth_callback (que
// canjea el code con PKCE y el client_secret del lado del servidor) y vuelve a
// Configuración > Integraciones > Mercado Libre con el resultado. Nunca expone
// secretos al navegador.
// =============================================================================
import { NextRequest, NextResponse } from "next/server";
import { appOrigin } from "@/lib/site";

export const dynamic = "force-dynamic";

const STATUS_BY_ERROR: Record<string, string> = {
  ml_account_taken: "taken",
  ml_app_not_configured: "not_configured",
  feature_not_in_plan: "plan",
  operator_user: "operator",
  invalid_state: "expired",
};

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const code = params.get("code");
  const state = params.get("state");
  const mlError = params.get("error");

  const appUrl = appOrigin(req.nextUrl.origin);
  const back = (status: string) =>
    NextResponse.redirect(`${appUrl}/configuracion?seccion=mercadolibre&ml=${encodeURIComponent(status)}`);

  if (mlError) return back("denied");
  if (!code || !state) return back("err");

  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  try {
    const res = await fetch(`${supaUrl}/functions/v1/ml_oauth_callback`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
      },
      body: JSON.stringify({ code, state }),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (res.ok && data.ok) return back("ok");
    return back(STATUS_BY_ERROR[data.error ?? ""] ?? "err");
  } catch {
    return back("err");
  }
}
