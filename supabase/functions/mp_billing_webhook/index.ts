// =============================================================================
// Edge Function: mp_billing_webhook — notificaciones de las suscripciones
// (preapproval) cobradas con la cuenta de NinjaSoft. Público (sin JWT). No
// confía en el body: consulta el preapproval real en MP con el access_token de
// plataforma y actualiza subscriptions.status. Siempre responde 200.
//
// Además de actualizar el estado:
//   • Pago aprobado (preapproval authorized → active): REANCLA el período vía el
//     RPC reanchor_subscription_period (status=active + período anclado al
//     VENCIMIENTO ANTERIOR, no a now(): si la cuenta venía vencida/suspendida, el
//     cliente NO gana los días del lapso y se mantiene el día del mes de cobro).
//     Registra un billing_record (para que "último pago" del panel del dueño se
//     auto-popule), emite una notificación in-app (pago / reactivación) y encola
//     un email. Idempotente: no duplica el billing_record si ya hay uno que cubre
//     el nuevo período.
//   • Pago fallido/pausado o cancelado (paused/cancelled): emite notificación
//     payment_failed (solo en la transición, para no spamear en reenvíos). El
//     past_due_since (inicio de la gracia de 3 días) lo setea el trigger del lado
//     SQL al pasar a past_due.
//
// internal_notify NO se usa (es staff-gated): se inserta directo en
// notifications. Los emails se encolan en system_emails (kind='system') y los
// envía process_pending_emails (cron, por Resend/failover). El subject+html se
// resuelven de system_email_templates (editable en /internal/emails); si la
// plantilla no existe, cae a emailHtml() inline (defensivo).
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";

// preapproval.status -> subscriptions.status
const SUB_STATUS: Record<string, string> = {
  authorized: "active",
  paused: "past_due",
  cancelled: "cancelled",
  pending: "trial",
};

// Render de {{var}} (mismo contrato que lib/email/templates.ts::renderTemplate).
function renderTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k: string) =>
    k in vars ? vars[k]! : `{{${k}}}`,
  );
}

// Cuerpo HTML branded mínimo (espeja _dunning_email_html del lado SQL). Solo
// estilos inline para máxima compatibilidad con clientes de correo. FALLBACK:
// solo se usa si la plantilla de system_email_templates no estuviera.
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
        "id, tenant_id, status, current_period_end, billing_cycle, plans(name, monthly_price_ars, yearly_price_ars), tenants(name)",
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
    const tenantName = (sub.tenants as { name?: string } | null)?.name ?? "";
    const yearly = sub.billing_cycle === "yearly";

    // Encola un email del sistema resolviendo subject+html de
    // system_email_templates (override de staff o default sembrado). Si la
    // plantilla no existe, usa el (subject, html) de fallback. Best-effort.
    async function enqueueEmail(
      key: string,
      vars: Record<string, string>,
      fallbackSubject: string,
      fallbackHtml: string,
    ): Promise<void> {
      const recipient = (await ownerEmail())?.trim().toLowerCase();
      if (!recipient) return;
      let subject = fallbackSubject;
      let html = fallbackHtml;
      const { data: tpl } = await admin
        .from("system_email_templates")
        .select("subject, html")
        .eq("key", key)
        .maybeSingle();
      if (tpl?.subject && tpl?.html) {
        subject = renderTemplate(tpl.subject as string, vars);
        html = renderTemplate(tpl.html as string, vars);
      }
      await admin.from("system_emails").insert({
        tenant_id: tenantId,
        recipient,
        subject,
        kind: "system",
        status: "pending",
        html_content: html,
      });
    }

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

    // ¿La cuenta venía vencida/bloqueada? Entonces este pago es una REACTIVACIÓN
    // (no una renovación normal): el copy y la auditoría lo reflejan.
    const isReactivation =
      newStatus === "active" &&
      (prevStatus === "past_due" || prevStatus === "suspended");

    const months = pre.auto_recurring?.frequency ?? (yearly ? 12 : 1);

    let newPeriodEnd: Date | null = null;
    let newPeriodStart: Date | null = null;

    if (newStatus === "active") {
      // El preapproval_id se actualiza directo; el ESTADO y el PERÍODO los aplica
      // el RPC reanchor_subscription_period, que ancla el nuevo período al
      // VENCIMIENTO ANTERIOR (no a now()): si la cuenta venía vencida, el cliente
      // no gana los días del lapso y se mantiene el día del mes de cobro.
      await admin
        .from("subscriptions")
        .update({ mp_preapproval_id: pre.id ?? dataId })
        .eq("id", sub.id);

      const { error: reErr } = await admin.rpc("reanchor_subscription_period", {
        p_subscription_id: sub.id,
        p_months: months,
      });
      if (reErr) {
        // Si el RPC falla, no dejamos la suscripción a medias: marcamos active y
        // un período conservador (now → now+months) para no bloquear al cliente
        // que sí pagó. Se loguea para visibilidad.
        console.error("[mp_billing_webhook] reanchor_failed", reErr);
        const start = new Date();
        const end = new Date(start);
        end.setMonth(end.getMonth() + months);
        await admin
          .from("subscriptions")
          .update({
            status: "active",
            current_period_start: start.toISOString(),
            current_period_end: end.toISOString(),
          })
          .eq("id", sub.id);
        newPeriodStart = start;
        newPeriodEnd = end;
      } else {
        // El RPC ya dejó status=active + período reanclado. Re-leemos el período
        // efectivo para el billing_record y el copy.
        const { data: fresh } = await admin
          .from("subscriptions")
          .select("current_period_start, current_period_end")
          .eq("id", sub.id)
          .maybeSingle();
        newPeriodStart = fresh?.current_period_start
          ? new Date(fresh.current_period_start as string)
          : null;
        newPeriodEnd = fresh?.current_period_end
          ? new Date(fresh.current_period_end as string)
          : null;
      }
    } else {
      // paused/cancelled/pending → solo status (+ preapproval_id). El trigger SQL
      // setea past_due_since al pasar a past_due.
      await admin
        .from("subscriptions")
        .update({ status: newStatus, mp_preapproval_id: pre.id ?? dataId })
        .eq("id", sub.id);
    }

    await admin.from("audit_logs").insert({
      tenant_id: tenantId,
      actor_user_id: null,
      entity_type: "subscriptions",
      entity_id: sub.id,
      action: "subscription_webhook",
      after_data: {
        preapproval_id: pre.id ?? dataId,
        mp_status: pre.status,
        status: newStatus,
        prev_status: prevStatus,
        reactivation: isReactivation,
        anchored_to_previous_due: newStatus === "active",
      },
    });

    // ===========================================================================
    // Pago APROBADO (preapproval authorized → active).
    // ===========================================================================
    if (newStatus === "active" && newPeriodEnd) {
      const periodEndDate = newPeriodEnd.toISOString().slice(0, 10); // date
      // period_start del cobro = inicio REANCLADO (= vencimiento anterior), no
      // now(). Refleja a qué período corresponde el pago.
      const periodStartDate = (newPeriodStart ?? new Date())
        .toISOString()
        .slice(0, 10);

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
          notes: `${
            isReactivation ? "Reactivación" : "Cobro automático"
          } Mercado Pago • Plan ${plan.name ?? ""}`.trim(),
        });

        const endLabel = new Date(periodEndDate).toLocaleDateString("es-AR");
        const montoLabel =
          amount > 0 ? `$ ${amount.toLocaleString("es-AR")}` : "tu suscripción";

        // Notificación in-app (insert directo: internal_notify es staff-gated).
        // Si fue reactivación, el copy lo dice (la cuenta estaba bloqueada).
        await admin.from("notifications").insert({
          target_tenant_id: tenantId,
          target_role: "owner",
          type: "billing",
          severity: "success",
          title: isReactivation ? "Reactivamos tu cuenta" : "Recibimos tu pago",
          body: isReactivation
            ? `Recibimos tu pago${
                amount > 0 ? ` de $${amount.toLocaleString("es-AR")}` : ""
              } y reactivamos tu cuenta. Tu período va hasta el ${endLabel}.`
            : `Acreditamos el pago de tu suscripción${
                amount > 0 ? ` por $${amount.toLocaleString("es-AR")}` : ""
              }. ¡Gracias!`,
          requires_ack: false,
        });

        // Email: primera activación de plan pago (trial → active) usa la
        // plantilla subscription_activated; renovación/reactivación usa payment_ok.
        // Ambas resuelven de system_email_templates (fallback inline).
        const isFirstActivation = prevStatus === "trial" && newStatus === "active";
        if (isFirstActivation) {
          await enqueueEmail(
            "subscription_activated",
            { negocio: tenantName, plan: plan.name ?? "", vence: endLabel },
            "Tu suscripción de NinjaPos está activa",
            emailHtml(
              "Tu suscripción está activa",
              `¡Gracias por sumarte! Tu plan ${
                plan.name ?? ""
              } ya está activo para ${tenantName}. Tu próxima renovación es el ${endLabel}. El cobro es automático por Mercado Pago.`,
            ),
          );
        } else {
          await enqueueEmail(
            "payment_ok",
            { negocio: tenantName, monto: montoLabel, vence: endLabel },
            isReactivation
              ? "Reactivamos tu cuenta de NinjaPos"
              : "Recibimos tu pago — gracias",
            emailHtml(
              isReactivation ? "Reactivamos tu cuenta" : "Recibimos tu pago",
              isReactivation
                ? `Recibimos tu pago${
                    amount > 0 ? ` de $${amount.toLocaleString("es-AR")}` : ""
                  } y reactivamos tu cuenta de NinjaPos. Tu plan ${
                    plan.name ?? ""
                  } queda activo hasta el ${endLabel}. El período se reanudó desde tu vencimiento anterior. ¡Gracias!`
                : `Acreditamos el pago de tu suscripción de NinjaPos${
                    amount > 0 ? ` por $${amount.toLocaleString("es-AR")}` : ""
                  }. Tu plan ${
                    plan.name ?? ""
                  } sigue activo hasta el ${endLabel}. ¡Gracias por elegirnos!`,
            ),
          );
        }

        await admin.from("audit_logs").insert({
          tenant_id: tenantId,
          actor_user_id: null,
          entity_type: "billing_records",
          entity_id: sub.id,
          action: "payment_recorded",
          after_data: {
            amount,
            period_start: periodStartDate,
            period_end: periodEndDate,
            source: "mp_webhook",
            reactivation: isReactivation,
          },
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
          : "No pudimos confirmar el pago de tu suscripción. Tenés 3 días para regularizarlo; después tu cuenta se bloquea. Revisá tu medio de pago en Mercado Pago.",
        requires_ack: false,
      });

      // Email: cancelación → subscription_cancelled; cobro fallido → payment_failed.
      // Resuelven de system_email_templates (fallback inline).
      if (cancelled) {
        await enqueueEmail(
          "subscription_cancelled",
          {
            negocio: tenantName,
            vence: sub.current_period_end
              ? new Date(sub.current_period_end as string).toLocaleDateString("es-AR")
              : "",
          },
          "Tu suscripción se canceló",
          emailHtml(
            "Tu suscripción se canceló",
            "Mercado Pago canceló tu suscripción de NinjaPos. Para seguir usando el sistema, reactivala desde tu panel. Si ya regularizaste, escribinos.",
          ),
        );
      } else {
        await enqueueEmail(
          "payment_failed",
          { negocio: tenantName },
          "Hubo un problema con tu cobro — tenés 3 días",
          emailHtml(
            "Hubo un problema con tu cobro",
            "No pudimos confirmar el pago de tu suscripción de NinjaPos. Tenés 3 días para regularizarlo desde Mercado Pago; pasado ese plazo tu cuenta se bloquea hasta que pagues. Si ya pagaste, podés ignorar este aviso.",
          ),
        );
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
