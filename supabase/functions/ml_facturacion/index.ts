// =============================================================================
// Edge Function: ml_facturacion: facturación de Mercado Libre con reglas
// (ADR-141). Deploy: verify_jwt = true.
//
// Gating server-side en cada acción: ml_edge_guard_billing (miembro activo,
// dueño o encargado, `mercadolibre` y `mercadolibre_facturacion`) y la cuenta
// tiene que ser del negocio del usuario. La emisión NO pasa por acá: es SQL
// (_ml_invoice_emit) por la cola de ARCA.
//
//   replan {account_id, pack_key}                    relee el carrito en ML (sólo GET)
//                                                    y rearma la factura con las
//                                                    reglas de hoy (padrón, envío,
//                                                    cupón, percepciones)
//   perception_link {plan_id, dry_run?, send_message?}
//                                                    link de pago de Mercado Pago por la
//                                                    percepción (monto del servidor);
//                                                    dry_run = sólo vista previa
//   perception_message {plan_id}                     (re)envía el mensaje al comprador
//
// Nunca cobra: crea una preferencia de pago que el comprador paga si quiere.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { readJsonLimited } from "../_shared/requestGuard.ts";
import { MlApiError } from "../_shared/mercadolibre/client.ts";
import { sendBuyerMessage } from "../_shared/mercadolibre/buyerMessage.ts";
import { fetchPack, planForPack } from "../_shared/mercadolibre/worker.ts";
import { perceptionPreference, perceptionTexts } from "../_shared/mercadolibre/perceptionLink.ts";
import type { PerceptionLine } from "../_shared/mercadolibre/invoicePlan.ts";
import { accountClient, adminClient, cors, json, mlConfig, rpcOf } from "../_shared/mercadolibre/runtime.ts";
import { MP_API, tenantMpCredential } from "../_shared/mpAuth.ts";
import { insertIntentWithScope } from "../_shared/paymentSecrets.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PlanRow {
  id: string;
  account_id: string;
  pack_key: string;
  status: string;
  plan: {
    perception?: { applies?: boolean; total?: number; lines?: PerceptionLine[] };
    receptors?: { billing?: { name?: string } };
  };
  fiscal_document_id: string | null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false },
  });
  const {
    data: { user },
    error: authErr,
  } = await userClient.auth.getUser();
  if (authErr || !user) return json({ error: "unauthorized" }, 401);
  const tenantId = (user.app_metadata as { current_tenant_id?: string } | null)?.current_tenant_id;
  if (!tenantId) return json({ error: "no_tenant" }, 400);

  let b: Record<string, unknown>;
  try {
    b = await readJsonLimited(req, 32 * 1024);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const action = String(b.action ?? "");
  const admin = adminClient();
  const { data: guard, error: gErr } = await admin.rpc("ml_edge_guard_billing", {
    p_tenant: tenantId,
    p_user: user.id,
    p_manage: true,
  });
  if (gErr) return json({ error: "guard_failed" }, 500);
  if (guard) return json({ error: guard }, 403);
  const cfg = await mlConfig(admin);
  if (!cfg.ok) return json({ error: cfg.error, message: cfg.message }, 503);
  const rpc = rpcOf(admin);

  // Plan (si viene) y cuenta, siempre del negocio del usuario.
  let plan: PlanRow | null = null;
  let accountId = String(b.account_id ?? "");
  if (UUID_RE.test(String(b.plan_id ?? ""))) {
    const { data } = await admin
      .from("ml_invoice_plans")
      .select("id, account_id, pack_key, status, plan, fiscal_document_id")
      .eq("id", String(b.plan_id))
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (!data) return json({ error: "plan_not_found" }, 404);
    plan = data as PlanRow;
    accountId = plan.account_id;
  }
  if (!UUID_RE.test(accountId)) return json({ error: "no_account" }, 400);
  const { data: account } = await admin
    .from("ml_accounts")
    .select("id, ml_user_id, status")
    .eq("id", accountId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!account) return json({ error: "no_account" }, 404);
  if (account.status !== "active") return json({ error: "reauth_required" }, 409);
  const client = accountClient(admin, cfg.config, account.id);
  const deps = { rpc, client: () => client };

  const buyerOf = async (pack: string) => {
    const { data } = await admin
      .from("ml_orders")
      .select("ml_order_id, buyer_id")
      .eq("account_id", account.id)
      .eq("pack_key", pack)
      .order("ml_order_id")
      .limit(1)
      .maybeSingle();
    return data as { ml_order_id: number; buyer_id: number | null } | null;
  };

  try {
    switch (action) {
      case "replan": {
        const pack = String(b.pack_key ?? "");
        if (!/^\d{5,22}$/.test(pack)) return json({ error: "invalid_pack" }, 400);
        const first = await buyerOf(pack);
        if (!first) return json({ error: "pack_not_found" }, 404);
        const payload = await fetchPack(deps, account.id, String(first.ml_order_id));
        const next = await planForPack(deps, account.id, payload);
        if (!next) return json({ error: "plan_not_available" }, 409);
        const res = await rpc("ml_invoice_plan_store", { p_account: account.id, p_pack: pack, p_plan: next, p_user: user.id });
        return json({ ok: true, ...(res as Record<string, unknown>), plan: next });
      }

      case "perception_link":
      case "perception_message": {
        if (!plan) return json({ error: "plan_not_found" }, 404);
        if (plan.fiscal_document_id) return json({ error: "already_invoiced" }, 409);
        const perc = plan.plan.perception;
        const amount = Math.round(Number(perc?.total ?? 0) * 100) / 100;
        if (!perc?.applies || !(amount > 0)) return json({ error: "no_perception" }, 409);
        const { data: settings } = await admin
          .from("ml_billing_settings")
          .select("perc_link_days, perc_message")
          .eq("account_id", account.id)
          .maybeSingle();
        const s = (settings ?? {}) as { perc_link_days?: number; perc_message?: string | null };
        const days = Number(s.perc_link_days ?? 3) || 3;
        const buyer = await buyerOf(plan.pack_key);
        const name = String(plan.plan.receptors?.billing?.name ?? "").split(" ")[0] ?? "";

        if (action === "perception_message") {
          const { data: charge } = await admin
            .from("ml_perception_charges")
            .select("id, init_point, status")
            .eq("plan_id", plan.id)
            .eq("status", "link_sent")
            .maybeSingle();
          if (!charge?.init_point) return json({ error: "no_open_link" }, 409);
          const texts = perceptionTexts({ template: s.perc_message, buyer: name, amount, link: charge.init_point, days, lines: perc.lines ?? [], packKey: plan.pack_key });
          try {
            await sendBuyerMessage(client, plan.pack_key, account.ml_user_id, buyer?.buyer_id ?? null, texts);
            await rpc("ml_perception_message_sent", { p_charge: charge.id, p_ok: true });
            return json({ ok: true, sent: true, message: texts.full });
          } catch (e) {
            await rpc("ml_perception_message_sent", { p_charge: charge.id, p_ok: false, p_error: e instanceof Error ? e.message : String(e) });
            return json({ ok: false, sent: false, error: "message_failed", message: texts.full }, 502);
          }
        }

        // Vista previa: monto y mensaje, sin crear nada.
        if (b.dry_run === true) {
          const texts = perceptionTexts({ template: s.perc_message, buyer: name, amount, link: "https://mpago.la/…", days, lines: perc.lines ?? [], packKey: plan.pack_key });
          return json({ ok: true, dry_run: true, amount, days, message: texts.full });
        }

        // Link de pago de Mercado Pago del negocio (feature + credencial).
        const { data: mpAllowed } = await admin.rpc("tenant_has_feature_for", { p_tenant: tenantId, p_key: "mercado_pago" });
        if (mpAllowed !== true) return json({ error: "payment_method_not_allowed" }, 403);
        const cred = await tenantMpCredential(admin, tenantId, null, {});
        if (!cred) return json({ error: "mp_not_connected" }, 409);
        const intentId = crypto.randomUUID();
        const ins = await insertIntentWithScope(
          admin,
          { id: intentId, tenant_id: tenantId, amount, provider_key: "mercadopago", mp_env: cred.env },
          cred.scopeStoreId,
        );
        if (ins.error) return json({ error: "intent_failed" }, 500);
        const body = perceptionPreference({
          amount,
          packKey: plan.pack_key,
          intentId,
          notificationUrl: `${url}/functions/v1/mp_webhook?intent=${intentId}`,
          days,
        });
        const prefRes = await fetch(`${MP_API}/checkout/preferences`, {
          method: "POST",
          headers: { Authorization: `Bearer ${cred.token}`, "Content-Type": "application/json", "X-Idempotency-Key": intentId },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(20_000),
        }).catch(() => null);
        if (!prefRes || !prefRes.ok) {
          await admin.from("mp_payment_intents").update({ status: "rejected" }).eq("id", intentId);
          return json({ error: "mp_error", detail: prefRes ? (await prefRes.text()).slice(0, 300) : "unreachable" }, 502);
        }
        const pref = (await prefRes.json()) as { id: string; init_point?: string; sandbox_init_point?: string };
        // Link completo (nunca acortado).
        const link = cred.env === "test" ? pref.sandbox_init_point || pref.init_point || "" : pref.init_point || pref.sandbox_init_point || "";
        await admin.from("mp_payment_intents").update({ preference_id: pref.id, init_point: link }).eq("id", intentId);
        const texts = perceptionTexts({ template: s.perc_message, buyer: name, amount, link, days, lines: perc.lines ?? [], packKey: plan.pack_key });
        const created = (await rpc("ml_perception_charge_create", {
          p_plan: plan.id,
          p_user: user.id,
          p: { amount, intent_id: intentId, init_point: link, message: texts.full },
        })) as { charge_id: string };
        let sent = false;
        if (b.send_message === true) {
          try {
            await sendBuyerMessage(client, plan.pack_key, account.ml_user_id, buyer?.buyer_id ?? null, texts);
            await rpc("ml_perception_message_sent", { p_charge: created.charge_id, p_ok: true });
            sent = true;
          } catch (e) {
            await rpc("ml_perception_message_sent", {
              p_charge: created.charge_id, p_ok: false, p_error: e instanceof Error ? e.message : String(e),
            });
          }
        }
        return json({ ok: true, charge_id: created.charge_id, init_point: link, amount, message: texts.full, sent, env: cred.env });
      }

      default:
        return json({ error: "unknown_action" }, 400);
    }
  } catch (e) {
    if (e instanceof MlApiError) {
      return json({ error: e.code, message: e.message, causes: e.causes.slice(0, 10) }, e.code === "rate_limited" ? 429 : 502);
    }
    const msg = e instanceof Error ? e.message : String(e);
    console.error(JSON.stringify({ fn: "ml_facturacion", action, error: msg.slice(0, 300) }));
    return json({ error: "server_error", message: msg.slice(0, 200) }, 500);
  }
});
