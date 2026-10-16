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
//
// Firma (F20-0b · H126): si la plataforma tiene cargada la clave secreta del
// webhook (platform_secrets.mercadopago.webhook_secret), se valida
// `x-signature` (_shared/mpSignature.ts) y una firma inválida, vencida o
// ausente se descarta con 401 y queda en Salud de webhooks. Sin clave cargada
// se mantiene el comportamiento anterior (se re-consulta el recurso en MP).
// Cada notificación queda en webhook_events (withWebhookLog, ADR-070).
//
// ADR-156 (C2): la AUTORIZACIÓN del preapproval NO es un cobro. Antes se
// acreditaba el monto del preapproval al autorizarse y después se volvía a
// acreditar el primer authorized_payment (dos billing_records, dos pagos en la
// cuenta corriente y el período corrido dos meses por un solo débito). Ahora
// la autorización sólo guarda el preapproval y su estado
// (subscriptions.mp_preapproval_status) y busca en MP los cobros ya
// procesados de ese preapproval, que se acreditan con la MISMA clave que su
// notificación (authpay:{id}): un pago nunca entra dos veces. Después de
// acreditar un cobro se recalcula el monto del próximo débito (vuelve al
// normal si este cobró un ajuste, H2).
// =============================================================================
import { readJsonLimited } from "../_shared/requestGuard.ts";
import { withWebhookLog } from "../_shared/webhookLog.ts";
import { verifyMpSignature } from "../_shared/mpSignature.ts";
import { authorizedPaymentKey } from "../_shared/billing/mpAmount.ts";
import { syncPreapprovalAmount } from "../_shared/mpSubscriptionSync.ts";
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

// Cuerpo HTML del aviso con el diseño de los emails de NinjaPos (espeja
// _dunning_email_html del lado SQL). FALLBACK: solo se usa si la plantilla de
// system_email_templates no estuviera. El template lo genera
// scripts/gen-email-templates-sql.ts desde lib/email/layout.ts
// (fallbackLayoutTemplate): no editarlo a mano.
// <fallback-layout>
const FALLBACK_LAYOUT =
  "<!doctype html><html lang=\"es\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"color-scheme\" content=\"light only\"><meta name=\"supported-color-schemes\" content=\"light\"><title>NinjaPos</title></head><body style=\"margin:0;padding:0;background:#f3f2f8;-webkit-font-smoothing:antialiased\"><div style=\"display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all\">@@BODY@@</div><table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" bgcolor=\"#f3f2f8\" style=\"background:#f3f2f8\"><tr><td align=\"center\" style=\"padding:28px 12px 40px\"><table role=\"presentation\" width=\"560\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"max-width:560px;width:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif\"><tr><td align=\"center\" bgcolor=\"#09051C\" style=\"background:#09051C;background-image:radial-gradient(120% 90% at 50% 0%,#3a1708 0%,#09051C 60%);border-radius:20px 20px 0 0;padding:40px 40px 36px;text-align:center\"><a href=\"https://pos.soft.ninja\" target=\"_blank\" style=\"text-decoration:none\"><img src=\"https://tgaromemhaixgdsdlxiq.supabase.co/storage/v1/object/public/brand/ninja-isotipo-flame.png\" alt=\"\" width=\"40\" height=\"52\" style=\"display:block;margin:0 auto 16px;width:40px;height:52px;border:0\" /><img src=\"https://res.cloudinary.com/dl6yhrcx0/image/upload/f_png,h_120/Ninja_POS_Light_glckmm\" alt=\"NinjaPOS\" height=\"34\" style=\"display:block;margin:0 auto;height:34px;border:0\" /></a></td></tr><tr><td align=\"center\" bgcolor=\"#ffffff\" style=\"background:#ffffff;padding:40px 40px 0;text-align:center\"><table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" align=\"center\" style=\"margin:0 auto 22px\"><tr><td width=\"72\" height=\"72\" align=\"center\" valign=\"middle\" bgcolor=\"#fff1ea\" style=\"width:72px;height:72px;border-radius:50%;background:#fff1ea;font-size:32px;line-height:72px;text-align:center\">🔔</td></tr></table><p style=\"margin:0 0 8px;font-size:12px;line-height:16px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:#ff5a1f\">@@EYEBROW@@</p><h1 style=\"margin:0 0 12px;font-size:28px;line-height:1.2;font-weight:800;letter-spacing:-0.4px;color:#09051C\">@@TITLE@@</h1><p style=\"margin:0 auto;max-width:420px;font-size:16px;line-height:1.6;color:#6b7280\">@@BODY@@</p></td></tr><tr><td align=\"center\" bgcolor=\"#ffffff\" style=\"background:#ffffff;padding:32px 40px 44px;text-align:center;border-radius:0 0 20px 20px\"><table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" align=\"center\"><tr><td align=\"center\" bgcolor=\"#ff5a1f\" style=\"border-radius:999px;background:#ff5a1f;background-image:linear-gradient(135deg,#ff4b22,#ff8a1f)\"><a href=\"https://pos.soft.ninja/login\" target=\"_blank\" style=\"display:inline-block;padding:16px 36px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:700;line-height:20px;color:#ffffff;text-decoration:none;border-radius:999px\">Ir a NinjaPos</a></td></tr></table></td></tr><tr><td style=\"padding:16px 0 0\"><table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" bgcolor=\"#ffffff\" style=\"background:#ffffff;border-radius:20px\"><tr><td align=\"center\" style=\"padding:32px 32px 28px;text-align:center\"><img src=\"https://res.cloudinary.com/dl6yhrcx0/image/upload/f_png,h_120/Ninja_POS_Dark_majzi0\" alt=\"NinjaPOS\" height=\"26\" style=\"display:block;margin:0 auto 10px;height:26px;border:0\" /><p style=\"margin:0 0 20px;font-size:13px;line-height:1.5;color:#6b7280\">Vendé, cobrá y controlá tu negocio desde una sola pantalla.</p><table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" align=\"center\"><tr><td style=\"padding:0 8px 0 0;font-size:12px;line-height:18px;color:#9ca3af\">Un producto de</td><td><a href=\"https://soft.ninja\" target=\"_blank\" style=\"text-decoration:none\"><img src=\"https://res.cloudinary.com/dl6yhrcx0/image/upload/f_png,h_120/Ninja_Soft_Dark_h9aklw\" alt=\"Ninja Soft\" height=\"18\" style=\"display:block;height:18px;border:0\" /></a></td></tr></table><table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\"><tr><td style=\"padding:24px 0 18px\"><div style=\"height:1px;line-height:1px;font-size:1px;background:#f0eff5\">&nbsp;</div></td></tr></table><p style=\"margin:0 0 14px;font-size:13px;line-height:1.6\"><a href=\"https://pos.soft.ninja/login\" target=\"_blank\" style=\"color:#09051C;text-decoration:none;font-weight:600\">pos.soft.ninja</a> &nbsp;&middot;&nbsp; <a href=\"https://soft.ninja\" target=\"_blank\" style=\"color:#09051C;text-decoration:none;font-weight:600\">soft.ninja</a> &nbsp;&middot;&nbsp; <a href=\"https://www.instagram.com/ninjasoft.latam/\" target=\"_blank\" style=\"color:#09051C;text-decoration:none;font-weight:600\">Instagram</a></p><p style=\"margin:0 0 6px;font-size:12px;line-height:1.6;color:#9ca3af\">Urquiza 3164 &middot; Rosario, Santa Fe, Argentina</p><p style=\"margin:0;font-size:11px;line-height:1.6;color:#b0b3ba\">Recibiste este email porque tenés una cuenta en NinjaPos.</p></td></tr></table></td></tr></table></td></tr></table></body></html>";
// </fallback-layout>
function emailHtml(title: string, body: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return FALLBACK_LAYOUT.split("@@EYEBROW@@").join("NinjaPos")
    .split("@@TITLE@@").join(esc(title))
    .split("@@BODY@@").join(esc(body));
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

Deno.serve(withWebhookLog("mercadopago_billing", "mp_billing_webhook", async (req: Request, wh) => {
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
    const queryDataId = reqUrl.searchParams.get("data.id") || "";
    let dataId = queryDataId || reqUrl.searchParams.get("id") || "";
    // action de MP (p. ej. "payment.created", "subscription_authorized_payment.created").
    // La idempotencia NO usa el id de notificación: usa el id del recurso de pago
    // (authorized_payment / payment), que es único por evento de cobro (BUG 7).
    let action = reqUrl.searchParams.get("action") || "";
    if (req.method === "POST") {
      try {
        const body = (await readJsonLimited(req)) as {
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
    wh.ref(dataId);

    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

    const { data: plat } = await admin
      .from("platform_secrets")
      .select("secrets")
      .eq("key", "mercadopago")
      .maybeSingle();
    const platSecrets = (plat?.secrets ?? null) as
      | { access_token?: string; webhook_secret?: string }
      | null;
    const accessToken = platSecrets?.access_token;

    // Firma: sólo si hay clave cargada (no rompe integraciones sin clave).
    const webhookSecret = (platSecrets?.webhook_secret ?? "").trim();
    if (webhookSecret) {
      const sig = await verifyMpSignature({
        secret: webhookSecret,
        signature: req.headers.get("x-signature"),
        requestId: req.headers.get("x-request-id"),
        dataId: queryDataId || dataId,
      });
      if (sig !== "valid") {
        wh.fail(`invalid_signature:${sig}`);
        return new Response(JSON.stringify({ error: "invalid_signature" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

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
      const eventKey = authorizedPaymentKey(ap) ?? `authpay:${dataId}`;
      const eventId = eventKey.slice("authpay:".length);
      const amount = Number(
        ap.transaction_amount ??
          amountFromPlan(sub.billing_cycle as string | null, sub.plans as PlanRel),
      );

      wh.tenant(sub.tenant_id as string);
      wh.done();
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
    wh.tenant(tenantId);
    wh.done();

    // F20-8 (ADR-120): si el negocio dejó Mercado Pago (cuenta corriente,
    // manual o exento) o este preapproval ya no es el vigente (se canceló al
    // cambiar de modalidad o al re-generar el checkout), su pausa o
    // cancelación NO toca la suscripción: si no, cancelar el débito al pasar a
    // cuenta corriente daría de baja al negocio. Con un pase pendiente a MP,
    // sólo la autorización se aplica. Sin la migración (RPC inexistente) se
    // sigue como antes.
    const { data: applies, error: appliesErr } = await admin.rpc(
      "platform_mp_preapproval_applies",
      {
        p_subscription: sub.id,
        p_preapproval: pre.id ?? dataId,
        p_mp_status: pre.status ?? "",
      },
    );
    if (!appliesErr && applies === false) {
      await admin.from("audit_logs").insert({
        tenant_id: tenantId,
        actor_user_id: null,
        entity_type: "subscriptions",
        entity_id: sub.id,
        action: "subscription_webhook_ignored",
        after_data: {
          preapproval_id: pre.id ?? dataId,
          mp_status: pre.status,
          reason: "not_current_billing_mode",
        },
      });
      return ok();
    }

    if (newStatus === "active") {
      // Autorización del preapproval (alta, pase a MP, reactivación). NO es un
      // cobro: guardamos el preapproval y su estado; la plata entra por
      // subscription_authorized_payment (rama 2) o por la búsqueda de abajo.
      const preId = pre.id ?? dataId;
      const { data: prevRow } = await admin
        .from("subscriptions")
        .select("mp_preapproval_status")
        .eq("id", sub.id)
        .maybeSingle();
      const firstAuthorization = (prevRow as { mp_preapproval_status?: string | null } | null)?.mp_preapproval_status !== "authorized";
      await admin
        .from("subscriptions")
        .update({ mp_preapproval_id: preId, mp_preapproval_status: "authorized" })
        .eq("id", sub.id);
      await admin.from("audit_logs").insert({
        tenant_id: tenantId,
        actor_user_id: null,
        entity_type: "subscriptions",
        entity_id: sub.id,
        action: "subscription_preapproval_authorized",
        after_data: {
          preapproval_id: preId,
          amount: pre.auto_recurring?.transaction_amount ?? null,
          prev_status: prevStatus,
          first: firstAuthorization,
        },
      });
      if (firstAuthorization) {
        await admin.from("notifications").insert({
          target_tenant_id: tenantId,
          target_role: "owner",
          type: "billing",
          severity: "success",
          title: "Autorizaste el débito automático",
          body:
            prevStatus === "trial"
              ? "Listo. Mercado Pago te va a cobrar recién cuando termine tu prueba gratis. Te avisamos cuando se acredite."
              : "Listo. Te avisamos apenas Mercado Pago acredite el cobro.",
          requires_ack: false,
        });
      }

      // Cobros ya procesados de este preapproval (p. ej. el primero, si MP lo
      // procesó antes de avisar la autorización). Misma clave que la rama 2.
      try {
        const sr = await fetch(
          `https://api.mercadopago.com/authorized_payments/search?preapproval_id=${encodeURIComponent(preId)}`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        );
        if (sr.ok) {
          const found = (await sr.json()) as { results?: AuthorizedPayment[] };
          for (const ap of found.results ?? []) {
            if (ap.status !== "processed") continue;
            const eventKey = authorizedPaymentKey(ap);
            if (!eventKey) continue;
            const { data: fresh } = await admin
              .from("subscriptions")
              .select(
                "id, tenant_id, status, current_period_end, billing_cycle, plans(name, monthly_price_ars, yearly_price_ars), tenants(name)",
              )
              .eq("id", sub.id)
              .maybeSingle();
            await creditApprovedPayment(admin, {
              sub: fresh ?? sub,
              preapprovalId: preId,
              eventKey,
              topic: "subscription_authorized_payment",
              months: monthsFor(sub.billing_cycle as string | null),
              amount: Number(ap.transaction_amount ?? 0),
              receiptRef: eventKey.slice("authpay:".length),
              mpStatus: ap.status,
              kind: "authorized_payment",
            });
          }
        }
      } catch (e) {
        console.error("[mp_billing_webhook] authorized_payments_search_failed", String(e).slice(0, 200));
      }
      return ok();
    }

    // ADR-156 (H5): 'pending' es un checkout creado y todavía sin autorizar.
    // Antes pasaba la suscripción a 'trial' (un negocio activo o en mora que
    // volvía a generar el checkout quedaba "en prueba" y salía de la mora).
    // Ahora sólo se guarda el estado del preapproval.
    if (pre.status === "pending") {
      await admin
        .from("subscriptions")
        .update({ mp_preapproval_id: pre.id ?? dataId, mp_preapproval_status: "pending" })
        .eq("id", sub.id);
      await admin.from("audit_logs").insert({
        tenant_id: tenantId,
        actor_user_id: null,
        entity_type: "subscriptions",
        entity_id: sub.id,
        action: "subscription_webhook",
        after_data: { preapproval_id: pre.id ?? dataId, mp_status: "pending", status: prevStatus, unchanged: true },
      });
      return ok();
    }

    // paused/cancelled → status (+ preapproval_id). El trigger SQL
    // setea past_due_since al pasar a past_due.
    await admin
      .from("subscriptions")
      .update({ status: newStatus, mp_preapproval_id: pre.id ?? dataId, mp_preapproval_status: pre.status ?? null })
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
  } catch (e) {
    wh.fail(e);
    return ok();
  }
}));

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

  // ADR-156 (H2): con el cobro acreditado, el monto del próximo débito vuelve
  // a ser el del período (si este débito cobró un ajuste) o toma los cambios
  // de precio que rigen desde el período nuevo. Best-effort: el cron diario
  // lo reintenta.
  try {
    await syncPreapprovalAmount(admin, tenantId, { actorId: null, via: "webhook" });
  } catch (e) {
    console.error("[mp_billing_webhook] amount_resync_failed", String(e).slice(0, 200));
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
        : "Recibimos tu pago. ¡Gracias!",
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
      "Hubo un problema con tu cobro: tenés 3 días",
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
