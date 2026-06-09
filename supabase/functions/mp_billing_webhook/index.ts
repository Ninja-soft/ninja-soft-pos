// =============================================================================
// Edge Function: mp_billing_webhook — notificaciones de las suscripciones de
// Mercado Pago cobradas con la cuenta de NinjaSoft. Público (sin JWT). No confía
// en el body: re-consulta el recurso real en MP con el access_token de
// plataforma y actualiza subscriptions. Siempre responde 200.
//
// MP manda DOS familias de notificaciones de suscripción (verificado contra la
// doc "Subscriptions / Webhooks"):
//
//   1. topic = "subscription_preapproval"  → el CONTRATO de la suscripción
//      (preapproval). Acá llegan las TRANSICIONES DE ESTADO: la autorización
//      INICIAL (pending → authorized), la PAUSA (paused) y la CANCELACIÓN
//      (cancelled). Se consulta GET /preapproval/{data.id}.
//        • authorized (inicial): activa la cuenta + reancla período + registra el
//          primer cobro (vía creditApprovedPayment, idempotente por evento).
//        • paused  → past_due  (el trigger SQL setea past_due_since).
//        • cancelled → cancelled.
//
//   2. topic = "subscription_authorized_payment"  → el COBRO RECURRENTE de cada
//      ciclo. ⚠️ Este topic NO contiene "preapproval", así que el handler viejo
//      lo descartaba y la renovación NUNCA se acreditaba: el preapproval quedaba
//      'authorized' permanente y el dunning suspendía a quien sí pagaba (BUG 1).
//      Ahora se maneja: GET /authorized_payments/{data.id}; se acredita SOLO si
//      status === 'processed' (pago efectivo); se matchea la suscripción por
//      preapproval_id; y se reancla +1 ciclo + se registra el billing_record
//      (vía el MISMO creditApprovedPayment). status 'scheduled'/'recycling'/
//      'rejected' NO acredita (aún no hay plata): se deja rastro y se responde 200.
//
// Idempotencia (BUG 7/8): cada cobro acreditable se "reclama" con
// claim_mp_webhook_event usando un event_key ÚNICO POR EVENTO de pago (el id del
// authorized_payment, o el del pago; para el authorized inicial, el preapproval
// id + marca 'authorized'), NO el preapproval id pelado (que es estable entre
// eventos y colisionaría). Si el claim confirma evento NUEVO, el billing_record
// se inserta SIEMPRE (la unicidad la garantiza el claim): la dedup adicional es
// por receipt_ref del pago / period_end EXACTO, nunca por period_end >= (que
// "tragaba" cobros cuando un período futuro ya cubría la fecha).
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

// Tipos mínimos de los recursos de MP que leemos.
type Preapproval = {
  id?: string;
  status?: string;
  external_reference?: string;
  auto_recurring?: {
    frequency?: number;
    frequency_type?: string;
    transaction_amount?: number;
  };
};
type AuthorizedPayment = {
  id?: string | number;
  status?: string; // scheduled | processed | recycling | rejected
  preapproval_id?: string;
  transaction_amount?: number;
  currency_id?: string;
  date_created?: string;
  debit_date?: string;
  payment?: { id?: string | number; status?: string; status_detail?: string } | null;
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
    // action de MP (p. ej. "payment.created", "subscription_authorized_payment.created").
    // La idempotencia NO usa el id de notificación: usa el id del recurso de pago
    // (authorized_payment / payment), que es único por evento de cobro (BUG 7).
    let action = reqUrl.searchParams.get("action") || "";
    if (req.method === "POST") {
      try {
        const body = (await req.json()) as {
          id?: string | number;
          type?: string;
          topic?: string;
          action?: string;
          data?: { id?: string };
        };
        topic = body.type || body.topic || topic;
        action = body.action || action;
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

    // ¿Es el cobro recurrente (authorized_payment)? MP lo manda con
    // type/topic="subscription_authorized_payment" (o action equivalente). Este
    // topic NO contiene "preapproval", por eso antes se descartaba (BUG 1).
    const isAuthorizedPayment =
      topic === "subscription_authorized_payment" ||
      topic === "authorized_payment" ||
      action.startsWith("subscription_authorized_payment") ||
      action.startsWith("authorized_payment");

    // ===========================================================================
    // RAMA 2 — COBRO RECURRENTE (subscription_authorized_payment).
    // GET /authorized_payments/{data.id}; acreditar SOLO si status==='processed'.
    // ===========================================================================
    if (isAuthorizedPayment) {
      const ar = await fetch(
        `https://api.mercadopago.com/authorized_payments/${dataId}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (!ar.ok) return ok();
      const ap = (await ar.json()) as AuthorizedPayment;

      const preapprovalId = (ap.preapproval_id ?? "").trim();
      if (!preapprovalId) return ok();

      // Matcheamos la suscripción por el preapproval del cobro.
      const { data: sub } = await admin
        .from("subscriptions")
        .select(
          "id, tenant_id, status, current_period_end, billing_cycle, plans(name, monthly_price_ars, yearly_price_ars), tenants(name)",
        )
        .eq("mp_preapproval_id", preapprovalId)
        .maybeSingle();

      if (!sub) {
        await admin.from("audit_logs").insert({
          tenant_id: null,
          actor_user_id: null,
          entity_type: "subscriptions",
          entity_id: null,
          action: "subscription_webhook",
          after_data: {
            kind: "authorized_payment",
            authorized_payment_id: String(ap.id ?? dataId),
            preapproval_id: preapprovalId,
            ap_status: ap.status,
            matched: false,
          },
        });
        return ok();
      }

      // Solo 'processed' = plata efectivamente cobrada. scheduled/recycling/
      // rejected NO acreditan (aún no hay pago): dejamos rastro y 200.
      if (ap.status !== "processed") {
        await admin.from("audit_logs").insert({
          tenant_id: sub.tenant_id as string,
          actor_user_id: null,
          entity_type: "subscriptions",
          entity_id: sub.id,
          action: "subscription_webhook",
          after_data: {
            kind: "authorized_payment",
            authorized_payment_id: String(ap.id ?? dataId),
            preapproval_id: preapprovalId,
            ap_status: ap.status,
            accredited: false,
          },
        });
        return ok();
      }

      const months = monthsFor(sub.billing_cycle as string | null);
      // event_key ÚNICO por evento de cobro: el id del authorized_payment (o el
      // id del pago si vino). NUNCA el preapproval id pelado (estable entre
      // ciclos → colisión que mataría los cobros siguientes).
      const eventId = String(ap.payment?.id ?? ap.id ?? dataId);
      const eventKey = `authpay:${eventId}`;
      const amount = Number(
        ap.transaction_amount ??
          amountFromPlan(sub.billing_cycle as string | null, sub.plans as PlanRel),
      );

      await creditApprovedPayment(admin, {
        sub,
        preapprovalId,
        eventKey,
        topic: topic || "subscription_authorized_payment",
        months,
        amount,
        receiptRef: eventId,
        mpStatus: ap.status,
        kind: "authorized_payment",
      });
      return ok();
    }

    // ===========================================================================
    // RAMA 1 — CONTRATO (subscription_preapproval): transiciones de estado.
    // Solo nos interesan eventos de preapproval (incluye subscription_preapproval
    // y, defensivamente, cualquier topic que contenga "preapproval"). El topic
    // _plan no matchea una suscripción y cae a "no encontrada" → 200 inocuo.
    // ===========================================================================
    if (topic && !topic.includes("preapproval")) return ok();

    const r = await fetch(`https://api.mercadopago.com/preapproval/${dataId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!r.ok) return ok();
    const pre = (await r.json()) as Preapproval;

    const newStatus = SUB_STATUS[pre.status ?? ""] ?? null;
    if (!newStatus) return ok();

    // Match por external_reference (= subscription.id) o por preapproval_id.
    const match = pre.external_reference
      ? { col: "id", val: pre.external_reference }
      : { col: "mp_preapproval_id", val: pre.id ?? dataId };

    const { data: sub } = await admin
      .from("subscriptions")
      .select(
        "id, tenant_id, status, current_period_end, billing_cycle, plans(name, monthly_price_ars, yearly_price_ars), tenants(name)",
      )
      .eq(match.col, match.val)
      .maybeSingle();
    if (!sub) {
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

    if (newStatus === "active") {
      // Autorización INICIAL del preapproval (alta / reactivación al pagar la
      // primera cuota desde el checkout). Las RENOVACIONES ya no llegan por acá
      // sino por authorized_payment, pero este evento sigue siendo el que activa
      // la cuenta la primera vez. Acreditamos con el MISMO helper idempotente.
      // event_key marcado como 'authorized' del preapproval: es estable para
      // ESTE evento de autorización (MP no reemite "authorized" en cada ciclo),
      // y distinto de los authpay:* de las renovaciones.
      const eventKey = `preapproval_authorized:${pre.id ?? dataId}`;
      const months = monthsFor(sub.billing_cycle as string | null);
      const amount = Number(
        pre.auto_recurring?.transaction_amount ??
          amountFromPlan(sub.billing_cycle as string | null, sub.plans as PlanRel),
      );
      // Aseguramos el preapproval_id antes de acreditar (el match pudo ser por
      // external_reference y la fila aún no tener el id guardado).
      await admin
        .from("subscriptions")
        .update({ mp_preapproval_id: pre.id ?? dataId })
        .eq("id", sub.id);

      await creditApprovedPayment(admin, {
        sub,
        preapprovalId: pre.id ?? dataId,
        eventKey,
        topic: topic || "subscription_preapproval",
        months,
        amount,
        receiptRef: pre.id ?? dataId,
        mpStatus: pre.status ?? "authorized",
        kind: "preapproval_authorized",
      });
      return ok();
    }

    // paused/cancelled/pending → solo status (+ preapproval_id). El trigger SQL
    // setea past_due_since al pasar a past_due.
    await admin
      .from("subscriptions")
      .update({ status: newStatus, mp_preapproval_id: pre.id ?? dataId })
      .eq("id", sub.id);

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
      },
    });

    // Pago FALLIDO / suscripción pausada o cancelada. Solo avisamos en la
    // transición (prevStatus distinto) para no spamear en reenvíos del webhook.
    if (
      (newStatus === "past_due" || newStatus === "cancelled") &&
      prevStatus !== newStatus
    ) {
      await notifyDunning(admin, {
        sub,
        tenantId,
        newStatus,
        mpStatus: pre.status ?? null,
      });
    }

    return ok();
  } catch {
    return ok();
  }
});

// =============================================================================
// Helpers
// =============================================================================
type PlanRel =
  | { name?: string; monthly_price_ars?: number; yearly_price_ars?: number }
  | { name?: string; monthly_price_ars?: number; yearly_price_ars?: number }[]
  | null;
// deno-lint-ignore no-explicit-any
type SubRow = Record<string, any>;
// Cliente admin de supabase-js. Tipado laxo a propósito: las tablas/RPC de este
// proyecto no tienen tipos generados acá (es una edge fn standalone).
// deno-lint-ignore no-explicit-any
type Admin = ReturnType<typeof createClient>;

function planOf(rel: PlanRel): {
  name?: string;
  monthly_price_ars?: number;
  yearly_price_ars?: number;
} {
  return (Array.isArray(rel) ? rel[0] : rel) ?? {};
}
function monthsFor(cycle: string | null): number {
  return cycle === "yearly" ? 12 : 1;
}
function amountFromPlan(cycle: string | null, rel: PlanRel): number {
  const plan = planOf(rel);
  return Number(
    (cycle === "yearly" ? plan.yearly_price_ars : plan.monthly_price_ars) ?? 0,
  );
}

// Email del owner activo del tenant (para los avisos).
async function ownerEmail(admin: Admin, tenantId: string): Promise<string | null> {
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

// Encola un email del sistema resolviendo subject+html de system_email_templates
// (override de staff o default sembrado). Best-effort.
async function enqueueEmail(
  admin: Admin,
  tenantId: string,
  key: string,
  vars: Record<string, string>,
  fallbackSubject: string,
  fallbackHtml: string,
): Promise<void> {
  const recipient = (await ownerEmail(admin, tenantId))?.trim().toLowerCase();
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

// ---------------------------------------------------------------------------
// creditApprovedPayment — acredita un cobro aprobado (autorización inicial o
// renovación recurrente). UN SOLO camino para ambos, con idempotencia por
// evento. Reancla el período, registra el billing_record y avisa.
//
// Idempotencia (BUG 7/8):
//   • claim_mp_webhook_event(eventKey) inserta-si-no-existe atómico. Si el evento
//     ya fue procesado (reenvío de MP), NO reanclamos ni registramos → 200.
//   • eventKey DEBE ser único por evento de pago (id del authorized_payment / del
//     pago), NO el preapproval id pelado. Lo arma el caller.
//   • Si el claim confirma evento NUEVO, el billing_record se inserta SIEMPRE: la
//     unicidad la garantiza el claim. La dedup extra es defensiva y por
//     receipt_ref EXACTO o period_end EXACTO (no por >=, que tragaba cobros).
// ---------------------------------------------------------------------------
async function creditApprovedPayment(
  admin: Admin,
  args: {
    sub: SubRow;
    preapprovalId: string;
    eventKey: string;
    topic: string;
    months: number;
    amount: number;
    receiptRef: string;
    mpStatus: string;
    kind: "authorized_payment" | "preapproval_authorized";
  },
): Promise<void> {
  const { sub, preapprovalId, eventKey, topic, months, amount, receiptRef, mpStatus, kind } =
    args;
  const tenantId = sub.tenant_id as string;
  const prevStatus = sub.status as string;
  const plan = planOf(sub.plans as PlanRel);
  const tenantName = (sub.tenants as { name?: string } | null)?.name ?? "";

  // 1) Claim del evento (idempotencia dura por evento de pago).
  const { data: claimed, error: claimErr } = await admin.rpc(
    "claim_mp_webhook_event",
    {
      p_event_key: eventKey,
      p_topic: topic || null,
      p_preapproval_id: preapprovalId,
      p_tenant_id: tenantId,
      p_mp_status: mpStatus ?? null,
    },
  );
  if (claimErr) {
    // Si el claim falla (DB), NO reanclamos para no arriesgar doble avance del
    // período: el cobro se reflejará en el próximo evento o en el panel.
    console.error("[mp_billing_webhook] claim_failed", claimErr);
    return;
  }
  if (claimed !== true) {
    // Reenvío de un evento ya procesado: aseguramos el preapproval_id y 200.
    await admin
      .from("subscriptions")
      .update({ mp_preapproval_id: preapprovalId })
      .eq("id", sub.id);
    await admin.from("audit_logs").insert({
      tenant_id: tenantId,
      actor_user_id: null,
      entity_type: "subscriptions",
      entity_id: sub.id,
      action: "subscription_webhook_duplicate",
      after_data: {
        kind,
        preapproval_id: preapprovalId,
        event_key: eventKey,
        skipped: "already_processed",
      },
    });
    return;
  }

  // 2) Reancla el período (status=active + período anclado al VENCIMIENTO
  // ANTERIOR, no a now(): si venía vencida, no gana los días del lapso).
  let newPeriodStart: Date | null = null;
  let newPeriodEnd: Date | null = null;
  let becameCancelled = false;

  const { error: reErr } = await admin.rpc("reanchor_subscription_period", {
    p_subscription_id: sub.id,
    p_months: months,
  });
  if (reErr) {
    // Si el RPC falla, no dejamos la suscripción a medias: active + período
    // conservador (now → now+months) para no bloquear a quien sí pagó.
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
    // El RPC aplicó estado + período. Re-leemos para el billing_record/copy.
    // OJO (BUG 4): si la baja estaba programada y el período venció, reanchor
    // pasó la sub a 'cancelled' (no reactivó): no hay cobro que registrar.
    const { data: fresh } = await admin
      .from("subscriptions")
      .select("status, current_period_start, current_period_end")
      .eq("id", sub.id)
      .maybeSingle();
    if ((fresh?.status as string | undefined) === "cancelled") {
      becameCancelled = true;
    } else {
      newPeriodStart = fresh?.current_period_start
        ? new Date(fresh.current_period_start as string)
        : null;
      newPeriodEnd = fresh?.current_period_end
        ? new Date(fresh.current_period_end as string)
        : null;
    }
  }

  const isReactivation =
    !becameCancelled && (prevStatus === "past_due" || prevStatus === "suspended");

  await admin.from("audit_logs").insert({
    tenant_id: tenantId,
    actor_user_id: null,
    entity_type: "subscriptions",
    entity_id: sub.id,
    action: "subscription_webhook",
    after_data: {
      kind,
      preapproval_id: preapprovalId,
      event_key: eventKey,
      mp_status: mpStatus,
      status: becameCancelled ? "cancelled" : "active",
      prev_status: prevStatus,
      reactivation: isReactivation,
      anchored_to_previous_due: !becameCancelled,
      cancelled_on_reanchor: becameCancelled,
    },
  });

  if (becameCancelled || !newPeriodEnd) return; // baja efectiva: no acreditar.

  // 3) Registra el cobro. El claim YA garantiza un solo billing_record por
  // evento; la dedup de acá es defensiva (mismo receipt_ref o period_end EXACTO)
  // para no duplicar si un evento previo de OTRO topic ya lo registró.
  const periodEndDate = newPeriodEnd.toISOString().slice(0, 10);
  const periodStartDate = (newPeriodStart ?? new Date()).toISOString().slice(0, 10);

  const { data: existing } = await admin
    .from("billing_records")
    .select("id")
    .eq("tenant_id", tenantId)
    .or(`receipt_ref.eq.${receiptRef},period_end.eq.${periodEndDate}`)
    .limit(1)
    .maybeSingle();

  if (!existing && amount > 0) {
    await admin.from("billing_records").insert({
      tenant_id: tenantId,
      amount,
      currency: "ARS",
      medium: "mp",
      period_start: periodStartDate,
      period_end: periodEndDate,
      receipt_ref: receiptRef,
      notes: `${
        isReactivation ? "Reactivación" : "Cobro automático"
      } Mercado Pago • Plan ${plan.name ?? ""}`.trim(),
    });

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
        source: kind === "authorized_payment" ? "mp_authorized_payment" : "mp_webhook",
        receipt_ref: receiptRef,
        reactivation: isReactivation,
      },
    });
  }

  // 4) Avisos al dueño (in-app + email). Idempotentes a nivel evento (ya
  // claimeamos), así que no spamean en reenvíos.
  const endLabel = new Date(periodEndDate).toLocaleDateString("es-AR");
  const montoLabel =
    amount > 0 ? `$ ${amount.toLocaleString("es-AR")}` : "tu suscripción";

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

  // Email: primera activación de plan pago (trial → active) usa
  // subscription_activated; renovación/reactivación usa payment_ok.
  const isFirstActivation = prevStatus === "trial";
  if (isFirstActivation) {
    await enqueueEmail(
      admin,
      tenantId,
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
      admin,
      tenantId,
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
}

// ---------------------------------------------------------------------------
// notifyDunning — aviso de cobro fallido / cancelación (solo en la transición).
// ---------------------------------------------------------------------------
async function notifyDunning(
  admin: Admin,
  args: {
    sub: SubRow;
    tenantId: string;
    newStatus: string;
    mpStatus: string | null;
  },
): Promise<void> {
  const { sub, tenantId, newStatus, mpStatus } = args;
  const tenantName = (sub.tenants as { name?: string } | null)?.name ?? "";
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

  if (cancelled) {
    await enqueueEmail(
      admin,
      tenantId,
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
      admin,
      tenantId,
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
    after_data: { mp_status: mpStatus, status: newStatus },
  });
}
