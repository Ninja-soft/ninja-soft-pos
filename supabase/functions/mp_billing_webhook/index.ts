// =============================================================================
// Edge Function: mp_billing_webhook — notificaciones de las suscripciones
// (preapproval) cobradas con la cuenta de NinjaSoft. Público (sin JWT). No
// confía en el body: consulta el preapproval real en MP con el access_token de
// plataforma y actualiza subscriptions.status. Siempre responde 200.
//
// Además de actualizar el estado:
//   • Pago aprobado (preapproval authorized → active): registra un billing_record
//     (para que "último pago" del panel del dueño se auto-popule), emite una
//     notificación in-app payment_ok y encola un email payment_ok. Idempotente:
//     no duplica el billing_record si ya hay uno que cubre el nuevo período.
//   • Pago fallido/pausado o cancelado (paused/cancelled): emite notificación
//     payment_failed (solo en la transición, para no spamear en reenvíos).
//
// internal_notify NO se usa (es staff-gated): se inserta directo en
// notifications. Los emails siguen el patrón del motor de dunning
// (system_emails kind='system' + _dunning_email_html, los envía
// process_pending_emails).
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";

// preapproval.status -> subscriptions.status
const SUB_STATUS: Record<string, string> = {
  authorized: "active",
  paused: "past_due",
  cancelled: "cancelled",
  pending: "trial",
};

// Cuerpo HTML branded mínimo (espeja _dunning_email_html del lado SQL). Solo
// estilos inline para máxima compatibilidad con clientes de correo.
function emailHtml(title: string, body: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return (
    '<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:480px;margin:0 auto;background:#111827;border-radius:14px;overflow:hidden">' +
    '<div style="padding:28px 24px 20px;text-align:center">' +
    '<img src="https://ninja-soft-pos.vercel.app/brand/ninjapos-logo-dark-mode.webp" alt="NinjaPos" style="max-height:24px;display:inline-block" />' +
    '<div style="color:#ffffff;font-size:17px;font-weight:bold;margin-top:12px">' +
    esc(title) +
    "</div>" +
    '<div style="height:3px;width:48px;background:#f97316;border-radius:99px;margin:16px auto 0"></div>' +
    "</div>" +
    '<div style="padding:8px 28px 28px;color:#e5e7eb;line-height:1.6">' +
    '<p style="margin:0 0 14px;font-size:15px">' +
    esc(body) +
    "</p></div>" +
    '<div style="background:#09051C;padding:18px 12px;text-align:center">' +
    '<img src="https://ninja-soft-pos.vercel.app/brand/ninjapos-logo-dark-mode.webp" alt="NinjaPos" style="max-height:20px;display:inline-block" />' +
    '<div style="color:#9ca3af;font-size:11px;margin-top:8px">Enviado con NinjaPos</div>' +
    "</div></div>"
  );
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
      auto_recurring?: {
        frequency?: number;
        frequency_type?: string;
        transaction_amount?: number;
      };
    };

    const newStatus = SUB_STATUS[pre.status ?? ""] ?? null;
    if (!newStatus) return ok();

    // Match por external_reference (= subscription.id) o por preapproval_id.
    const match = pre.external_reference
      ? { col: "id", val: pre.external_reference }
      : { col: "mp_preapproval_id", val: pre.id ?? dataId };

    // Estado ACTUAL de la suscripción (antes de actualizar) + datos para los
    // avisos. Sirve para detectar la transición y para no duplicar el cobro.
    const { data: sub } = await admin
      .from("subscriptions")
      .select(
        "id, tenant_id, status, current_period_end, billing_cycle, plans(name, monthly_price_ars, yearly_price_ars)",
      )
      .eq(match.col, match.val)
      .maybeSingle();
    if (!sub) {
      // No encontramos la suscripción: igual dejamos rastro y respondemos 200.
      await admin.from("audit_logs").insert({
        tenant_id: null,
        actor_user_id: null,
        entity_type: "subscriptions",
        entity_id: pre.external_reference ?? null,
        action: "subscription_webhook",
        after_data: {
          preapproval_id: pre.id ?? dataId,
          mp_status: pre.status,
          matched: false,
        },
      });
      return ok();
    }

    const tenantId = sub.tenant_id as string;
    const prevStatus = sub.status as string;
    const plan = (sub.plans ?? {}) as {
      name?: string;
      monthly_price_ars?: number;
      yearly_price_ars?: number;
    };
    const yearly = sub.billing_cycle === "yearly";

    // Monto: el del preapproval si vino, si no el del plan (mensual/anual).
    const amount = Number(
      pre.auto_recurring?.transaction_amount ??
        (yearly ? plan.yearly_price_ars : plan.monthly_price_ars) ??
        0,
    );

    // Email del owner para los avisos (insert directo en notifications/emails).
    async function ownerEmail(): Promise<string | null> {
      const { data: ownerRow } = await admin
        .from("tenant_users")
        .select("users(email)")
        .eq("tenant_id", tenantId)
        .eq("role", "owner")
        .eq("status", "active")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      return (ownerRow?.users as { email?: string } | null)?.email ?? null;
    }

    const patch: Record<string, unknown> = { mp_preapproval_id: pre.id ?? dataId };
    let newPeriodEnd: Date | null = null;
    if (newStatus === "active") {
      const months = pre.auto_recurring?.frequency ?? (yearly ? 12 : 1);
      const start = new Date();
      const end = new Date(start);
      end.setMonth(end.getMonth() + months);
      newPeriodEnd = end;
      patch.status = "active";
      patch.current_period_start = start.toISOString();
      patch.current_period_end = end.toISOString();
    } else {
      patch.status = newStatus;
    }

    await admin.from("subscriptions").update(patch).eq("id", sub.id);

    await admin.from("audit_logs").insert({
      tenant_id: tenantId,
      actor_user_id: null,
      entity_type: "subscriptions",
      entity_id: sub.id,
      action: "subscription_webhook",
      after_data: {
        preapproval_id: pre.id ?? dataId,
        mp_status: pre.status,
        status: patch.status,
        prev_status: prevStatus,
      },
    });

    // ===========================================================================
    // Pago APROBADO (preapproval authorized → active).
    // ===========================================================================
    if (newStatus === "active" && newPeriodEnd) {
      const periodEndDate = newPeriodEnd.toISOString().slice(0, 10); // date
      const periodStartDate = new Date().toISOString().slice(0, 10);

      // Idempotencia del cobro: solo registramos si NO hay ya un billing_record
      // que cubra este período (mismo criterio que el motor de dunning).
      const { data: covering } = await admin
        .from("billing_records")
        .select("id")
        .eq("tenant_id", tenantId)
        .gte("period_end", periodEndDate)
        .limit(1)
        .maybeSingle();

      if (!covering && amount > 0) {
        await admin.from("billing_records").insert({
          tenant_id: tenantId,
          amount,
          currency: "ARS",
          medium: "mp",
          period_start: periodStartDate,
          period_end: periodEndDate,
          receipt_ref: pre.id ?? dataId,
          notes: `Cobro automático Mercado Pago • Plan ${plan.name ?? ""}`.trim(),
        });

        const email = await ownerEmail();

        // Notificación in-app (insert directo: internal_notify es staff-gated).
        await admin.from("notifications").insert({
          target_tenant_id: tenantId,
          target_role: "owner",
          type: "billing",
          severity: "success",
          title: "Recibimos tu pago",
          body: `Acreditamos el pago de tu suscripción${
            amount > 0 ? ` por $${amount.toLocaleString("es-AR")}` : ""
          }. ¡Gracias!`,
          requires_ack: false,
        });

        // Email payment_ok.
        if (email) {
          await admin.from("system_emails").insert({
            tenant_id: tenantId,
            recipient: email,
            subject: "Recibimos tu pago — gracias",
            kind: "system",
            status: "pending",
            html_content: emailHtml(
              "Recibimos tu pago",
              `Acreditamos el pago de tu suscripción de NinjaPos${
                amount > 0 ? ` por $${amount.toLocaleString("es-AR")}` : ""
              }. Tu plan ${plan.name ?? ""} sigue activo hasta el ${new Date(
                periodEndDate,
              ).toLocaleDateString("es-AR")}. ¡Gracias por elegirnos!`,
            ),
          });
        }

        await admin.from("audit_logs").insert({
          tenant_id: tenantId,
          actor_user_id: null,
          entity_type: "billing_records",
          entity_id: sub.id,
          action: "payment_recorded",
          after_data: { amount, period_end: periodEndDate, source: "mp_webhook" },
        });
      }
    }

    // ===========================================================================
    // Pago FALLIDO / suscripción pausada o cancelada. Solo avisamos en la
    // transición (prevStatus distinto) para no spamear en reenvíos del webhook.
    // ===========================================================================
    if (
      (newStatus === "past_due" || newStatus === "cancelled") &&
      prevStatus !== newStatus
    ) {
      const email = await ownerEmail();
      const cancelled = newStatus === "cancelled";

      await admin.from("notifications").insert({
        target_tenant_id: tenantId,
        target_role: "owner",
        type: "billing",
        severity: cancelled ? "critical" : "warning",
        title: cancelled
          ? "Tu suscripción se canceló"
          : "Hubo un problema con tu cobro",
        body: cancelled
          ? "Mercado Pago canceló la suscripción. Reactivala desde tu panel para no perder acceso."
          : "No pudimos confirmar el pago de tu suscripción. Revisá tu medio de pago en Mercado Pago.",
        requires_ack: false,
      });

      if (email) {
        await admin.from("system_emails").insert({
          tenant_id: tenantId,
          recipient: email,
          subject: "Hubo un problema con tu cobro",
          kind: "system",
          status: "pending",
          html_content: emailHtml(
            "Hubo un problema con tu cobro",
            cancelled
              ? "Mercado Pago canceló tu suscripción de NinjaPos. Para seguir usando el sistema, reactivala desde tu panel. Si ya regularizaste, escribinos."
              : "No pudimos confirmar el pago de tu suscripción de NinjaPos. Para no perder acceso, revisá tu medio de pago en Mercado Pago. Si ya pagaste, podés ignorar este aviso.",
          ),
        });
      }

      await admin.from("audit_logs").insert({
        tenant_id: tenantId,
        actor_user_id: null,
        entity_type: "subscriptions",
        entity_id: sub.id,
        action: "payment_failed_notified",
        after_data: { mp_status: pre.status, status: newStatus },
      });
    }

    return ok();
  } catch {
    return ok();
  }
});
