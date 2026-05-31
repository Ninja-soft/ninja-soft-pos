// =============================================================================
// Edge Function: mp_billing_webhook — notificaciones de las suscripciones
// (preapproval) cobradas con la cuenta de NinjaSoft. Público (sin JWT). No
// confía en el body: consulta el preapproval real en MP con el access_token de
// plataforma y actualiza subscriptions.status. Siempre responde 200.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";

// preapproval.status -> subscriptions.status
const SUB_STATUS: Record<string, string> = {
  authorized: "active",
  paused: "past_due",
  cancelled: "cancelled",
  pending: "trial",
};

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

    let topic =
      reqUrl.searchParams.get("type") || reqUrl.searchParams.get("topic") || "";
    let dataId =
      reqUrl.searchParams.get("data.id") || reqUrl.searchParams.get("id") || "";
    if (req.method === "POST") {
      try {
        const body = (await req.json()) as {
          type?: string;
          topic?: string;
          data?: { id?: string };
        };
        topic = body.type || body.topic || topic;
        dataId = body.data?.id || dataId;
      } catch {
        // sin body JSON; seguimos con query.
      }
    }
    if (!dataId) return ok();

    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

    const { data: plat } = await admin
      .from("platform_secrets")
      .select("secrets")
      .eq("key", "mercadopago")
      .maybeSingle();
    const accessToken = (plat?.secrets as { access_token?: string } | null)
      ?.access_token;
    if (!accessToken) return ok();

    // Solo nos interesan eventos de preapproval (suscripción).
    if (topic && !topic.includes("preapproval")) return ok();

    const r = await fetch(`https://api.mercadopago.com/preapproval/${dataId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!r.ok) return ok();
    const pre = (await r.json()) as {
      id?: string;
      status?: string;
      external_reference?: string;
      auto_recurring?: { frequency?: number; frequency_type?: string };
    };

    const newStatus = SUB_STATUS[pre.status ?? ""] ?? null;
    if (!newStatus) return ok();

    // Match por external_reference (= subscription.id) o por preapproval_id.
    const match = pre.external_reference
      ? { col: "id", val: pre.external_reference }
      : { col: "mp_preapproval_id", val: pre.id ?? dataId };

    const patch: Record<string, unknown> = { mp_preapproval_id: pre.id ?? dataId };
    if (newStatus === "active") {
      const months = pre.auto_recurring?.frequency ?? 1;
      const start = new Date();
      const end = new Date(start);
      end.setMonth(end.getMonth() + months);
      patch.status = "active";
      patch.current_period_start = start.toISOString();
      patch.current_period_end = end.toISOString();
    } else {
      patch.status = newStatus;
    }

    await admin.from("subscriptions").update(patch).eq(match.col, match.val);

    await admin.from("audit_logs").insert({
      tenant_id: null,
      actor_user_id: null,
      entity_type: "subscriptions",
      entity_id: pre.external_reference ?? null,
      action: "subscription_webhook",
      after_data: { preapproval_id: pre.id ?? dataId, mp_status: pre.status, status: patch.status },
    });

    return ok();
  } catch {
    return ok();
  }
});
