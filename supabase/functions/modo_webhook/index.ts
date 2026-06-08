// =============================================================================
// Edge Function: modo_webhook — recibe notificaciones de MODO (público, sin
// JWT: lo llama MODO). Identifica el intent por ?intent=<id> y actualiza el
// estado de mp_payment_intents según el status del pago. Siempre responde 200
// para evitar reintentos en loop. Espeja mobbex_webhook. verify_jwt = false.
//
// ⚠️ API DE MODO — ESTRUCTURA A VALIDAR CONTRA LA DOC/CREDENCIALES REALES ⚠️
// El nombre de los campos del body (status / estado / payment id) y los valores
// de estado de MODO (APPROVED/REJECTED/PENDING/…) deben confirmarse contra la
// doc oficial de MODO. El mapeo de estados de abajo cubre los nombres más
// probables (en inglés y español) de forma defensiva, pero hay que verificarlo.
// Mejora futura (como hace mp_webhook): no confiar en el body y reconsultar la
// intención contra la API de MODO con un token del comercio. Por ahora se actúa
// sobre el body (como mobbex_webhook) y se valida que el evento referencie ESTE
// intent (antifraude por external_intention_id).
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";

// ⚠️ VALIDAR MODO — set de valores de estado de MODO → estado interno.
// Se normaliza a minúsculas y se contemplan variantes EN/ES.
function mapStatus(raw: string): string {
  const s = (raw ?? "").toString().trim().toLowerCase();
  if (["approved", "accredited", "aprobado", "acreditado", "success", "paid"].includes(s))
    return "approved";
  if (["rejected", "rechazado", "failed", "error", "declined"].includes(s))
    return "rejected";
  if (["cancelled", "canceled", "cancelado", "expired", "expirado"].includes(s))
    return s.startsWith("exp") ? "expired" : "cancelled";
  // pending / processing / created / in_process / etc.
  return "pending";
}

Deno.serve(async (req: Request) => {
  const ok = () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const reqUrl = new URL(req.url);
    const intentId = reqUrl.searchParams.get("intent");
    if (!intentId || req.method !== "POST") return ok();

    // ⚠️ VALIDAR MODO — forma del body de la notificación. Se leen los nombres de
    // campo más probables para el estado, el id del pago de MODO y la referencia
    // externa del comercio (que seteamos como external_intention_id = intent.id).
    let body: {
      status?: string;
      state?: string;
      estado?: string;
      payment_id?: string;
      id?: string;
      external_intention_id?: string;
      data?: {
        status?: string;
        state?: string;
        payment_id?: string;
        id?: string;
        external_intention_id?: string;
      };
    };
    try {
      body = await req.json();
    } catch {
      return ok();
    }

    const d = body.data ?? body;
    const rawStatus = d.status ?? d.state ?? (body as { estado?: string }).estado ?? "";
    if (!rawStatus) return ok();

    // Antifraude: si MODO envía la referencia externa, tiene que ser ESTE intent.
    const extRef = d.external_intention_id ?? body.external_intention_id;
    if (extRef && extRef !== intentId) return ok();

    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
    const { data: intent } = await admin
      .from("mp_payment_intents")
      .select("id")
      .eq("id", intentId)
      .eq("provider_key", "modo")
      .maybeSingle();
    if (!intent) return ok();

    const modoPaymentId = d.payment_id ?? d.id ?? body.payment_id ?? body.id ?? null;

    await admin
      .from("mp_payment_intents")
      .update({
        status: mapStatus(rawStatus),
        mp_payment_id: modoPaymentId ? String(modoPaymentId) : null,
      })
      .eq("id", intentId);

    return ok();
  } catch {
    return ok();
  }
});
