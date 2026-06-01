// =============================================================================
// Edge Function: mobbex_webhook — recibe notificaciones de Mobbex (público, sin
// JWT). Identifica el intent por ?intent=<id> y actualiza el estado según el
// status.code del pago. Siempre responde 200 para evitar reintentos en loop.
// Códigos Mobbex: 200 = aprobado; 2/3/100/201 = en proceso; resto = rechazado.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";

const PENDING = new Set([1, 2, 3, 100, 201]);
function mapStatus(code: number): string {
  if (code === 200) return "approved";
  if (PENDING.has(code)) return "pending";
  return "rejected";
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

    let body: {
      type?: string;
      data?: {
        payment?: { id?: string; status?: { code?: number | string } };
        checkout?: { reference?: string; uid?: string };
      };
    };
    try {
      body = await req.json();
    } catch {
      return ok();
    }

    const code = Number(body.data?.payment?.status?.code ?? NaN);
    if (!Number.isFinite(code)) return ok();

    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
    const { data: intent } = await admin
      .from("mp_payment_intents")
      .select("id")
      .eq("id", intentId)
      .eq("provider_key", "mobbex")
      .maybeSingle();
    if (!intent) return ok();

    await admin
      .from("mp_payment_intents")
      .update({
        status: mapStatus(code),
        mp_payment_id: body.data?.payment?.id ? String(body.data.payment.id) : null,
      })
      .eq("id", intentId);

    return ok();
  } catch {
    return ok();
  }
});
