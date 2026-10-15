// =============================================================================
// Edge Function: ml_gestor: métricas y posventa del gestor de Mercado Libre
// (H141 · ADR-132, parte B). Deploy: verify_jwt = true.
//
// Gating server-side en cada acción: ml_edge_guard_gestor (miembro activo,
// rol, `mercadolibre` y `mercadolibre_gestor`) y la cuenta tiene que ser del
// negocio del usuario. Lecturas: cualquier rol operativo. Escrituras con
// plata o que cambian el caso (mediación, devolución, reintegro): dueño o
// encargado.
//
//   reputation_refresh {account_id}                 foto de reputación ahora
//   claims_sync {account_id}                        reclamos abiertos y cerrados recientes
//   claim_detail {claim_row_id}                     detalle + mensajes + retorno + ofertas
//   claim_message {claim_row_id, receiver, message, attachments[]}
//   claim_open_dispute {claim_row_id}               pedir la mediación de ML
//   claim_allow_return {claim_row_id}               aceptar la devolución
//   claim_partial_refund {claim_row_id, percentage, expected_amount}
//   pack_messages {account_id, pack_key}            mensajes postventa (sin marcar leídos)
//   pack_message_send {account_id, pack_key, text}  responder un mensaje postventa
//
// Candados de toda escritura sobre un reclamo (criterio de ANDESMAR):
//   1. se vuelve a leer el reclamo y la acción tiene que estar en
//      available_actions del vendedor en ese momento;
//   2. auditoría ANTES de escribir (intento) y DESPUÉS (resultado);
//   3. reintegro: sólo un porcentaje de las ofertas de ML y con el monto que
//      vio el usuario (si cambió, se frena);
//   4. 0/408/429/5xx = resultado incierto: no se reintenta solo.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { readJsonLimited } from "../_shared/requestGuard.ts";
import { MlApiError } from "../_shared/mercadolibre/client.ts";
import {
  ATTACH_LIMITS,
  attachmentProblem,
  canDo,
  isUncertain,
  normalizeMessages,
  plainText,
  type ClaimWrite,
  type MlClaim,
  type MlClaimDetail,
  type MlClaimMessage,
  type MlReturn,
} from "../_shared/mercadolibre/claims.ts";
import { reconcileClaims, refreshClaim, takeReputation } from "../_shared/mercadolibre/gestorWorker.ts";
import { accountClient, adminClient, cors, json, mlConfig, rpcOf } from "../_shared/mercadolibre/runtime.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MANAGE = new Set(["claim_open_dispute", "claim_allow_return", "claim_partial_refund", "claims_sync"]);
const WRITES = new Set(["claim_message", "claim_open_dispute", "claim_allow_return", "claim_partial_refund", "pack_message_send"]);

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
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
    // Hasta 3 adjuntos de 5 MB (8 MB entre todos) en base64.
    b = await readJsonLimited(req, 12 * 1024 * 1024);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const action = String(b.action ?? "");
  const admin = adminClient();
  const { data: guard, error: gErr } = await admin.rpc("ml_edge_guard_gestor", {
    p_tenant: tenantId,
    p_user: user.id,
    p_manage: MANAGE.has(action),
  });
  if (gErr) return json({ error: "guard_failed" }, 500);
  if (guard) return json({ error: guard }, 403);
  const cfg = await mlConfig(admin);
  if (!cfg.ok) return json({ error: cfg.error, message: cfg.message }, 503);
  const rpc = rpcOf(admin);

  // Reclamo (por fila del espejo) o cuenta.
  let claimRow: { id: string; account_id: string; claim_id: number; pack_key: string | null; resource_id: number | null } | null = null;
  let accountId = String(b.account_id ?? "");
  if (UUID_RE.test(String(b.claim_row_id ?? ""))) {
    const { data } = await admin
      .from("ml_claims")
      .select("id, account_id, claim_id, pack_key, resource_id")
      .eq("id", String(b.claim_row_id))
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (!data) return json({ error: "claim_not_found" }, 404);
    claimRow = data;
    accountId = data.account_id;
  }
  if (!UUID_RE.test(accountId)) return json({ error: "no_account" }, 400);
  const { data: account } = await admin
    .from("ml_accounts")
    .select("id, ml_user_id, status, nickname")
    .eq("id", accountId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!account) return json({ error: "no_account" }, 404);
  if (account.status !== "active") return json({ error: "reauth_required" }, 409);
  const client = accountClient(admin, cfg.config, account.id);
  const deps = { rpc, client: () => client };
  const claimPath = (suffix = "") => `/post-purchase/v1/claims/${claimRow!.claim_id}${suffix}`;

  /** Relee el reclamo y exige la acción disponible ahora. */
  const assertAction = async (w: ClaimWrite) => {
    const fresh = await client.get<MlClaim>(claimPath());
    if (!canDo(fresh, w)) throw new MlApiError("bad_request", "action_not_available", 409, false);
    return fresh;
  };
  const audit = (act: string, data: Record<string, unknown>) =>
    rpc("ml_claim_audit", { p_account: account.id, p_user: user.id, p_claim: claimRow?.id ?? null, p_action: act, p_data: data });

  /** Escritura en ML con resultado auditado; incierto si no se sabe si llegó. */
  const write = async (act: string, data: Record<string, unknown>, fn: () => Promise<unknown>) => {
    await audit(`${act}_requested`, data);
    try {
      const res = await fn();
      await audit(act, { ...data, result: "ok" });
      return json({ ok: true, result: res ?? null });
    } catch (e) {
      const status = e instanceof MlApiError ? e.status : 0;
      const uncertain = !(e instanceof MlApiError) || isUncertain(status);
      await audit(`${act}_failed`, { ...data, result: uncertain ? "uncertain" : "rejected", status, error: String(e instanceof Error ? e.message : e).slice(0, 300) });
      if (uncertain) return json({ ok: false, error: "uncertain", message: "No sabemos si Mercado Libre recibió la acción." }, 502);
      throw e;
    }
  };

  try {
    if (WRITES.has(action) && action !== "pack_message_send" && !claimRow) return json({ error: "claim_not_found" }, 404);
    switch (action) {
      case "reputation_refresh": {
        const { data: set } = await admin.from("ml_gestor_settings").select("thresholds").eq("account_id", account.id).maybeSingle();
        const r = await takeReputation(deps, account.id, account.ml_user_id, (set?.thresholds ?? null) as Record<string, number> | null);
        return json({ ok: r.saved, snapshot: r.snap, alerts: r.alerts });
      }
      case "claims_sync": {
        const r = await reconcileClaims(deps, account.id, { budgetMs: 40_000 });
        return json({ ok: true, ...r });
      }
      case "claim_detail": {
        if (!claimRow) return json({ error: "claim_not_found" }, 404);
        await refreshClaim(deps, account.id, String(claimRow.claim_id));
        const [claim, detail, messages, returns] = await Promise.all([
          client.get<MlClaim>(claimPath()).catch(() => null),
          client.get<MlClaimDetail>(claimPath("/detail")).catch(() => null),
          client.get<MlClaimMessage[]>(claimPath("/messages")).catch(() => [] as MlClaimMessage[]),
          client.get<MlReturn | MlReturn[]>(`/post-purchase/v2/claims/${claimRow.claim_id}/returns`).catch(() => null),
        ]);
        let offers: Array<{ percentage: number; amount: number }> = [];
        let currency: string | null = null;
        if (claim && canDo(claim, "partial_refund")) {
          const o = await client
            .get<{ available_offers?: Array<{ percentage: number; amount: number }>; currency_id?: string }>(claimPath("/partial-refund/available-offers"))
            .catch(() => null);
          offers = (o?.available_offers ?? []).filter((x) => x.percentage > 0 && x.percentage < 100);
          currency = o?.currency_id ?? null;
        }
        return json({
          claim,
          detail: detail ? { ...detail, description: plainText(detail.description ?? "") } : null,
          messages: normalizeMessages(Array.isArray(messages) ? messages : []),
          return: Array.isArray(returns) ? (returns[0] ?? null) : returns,
          offers,
          currency,
          can: claim
            ? {
                message_complainant: canDo(claim, "message_complainant"),
                message_mediator: canDo(claim, "message_mediator"),
                open_dispute: canDo(claim, "open_dispute"),
                allow_return: canDo(claim, "allow_return"),
                partial_refund: canDo(claim, "partial_refund"),
              }
            : null,
        });
      }
      case "claim_message": {
        const receiver = b.receiver === "mediator" ? "mediator" : "complainant";
        const message = String(b.message ?? "").trim();
        if (message.length < 2 || message.length > 2000) return json({ error: "invalid_text" }, 400);
        const files = (Array.isArray(b.attachments) ? b.attachments : []).slice(0, ATTACH_LIMITS.max + 1) as Array<{ name?: string; type?: string; base64?: string }>;
        const decoded = files.map((f) => ({ name: String(f.name ?? "adjunto").slice(0, 80), type: String(f.type ?? ""), bytes: b64ToBytes(String(f.base64 ?? "")) }));
        const problem = attachmentProblem(decoded.map((f) => ({ type: f.type, size: f.bytes.length })));
        if (problem) return json({ error: "invalid_attachments", message: problem }, 400);
        await assertAction(receiver === "mediator" ? "message_mediator" : "message_complainant");
        return await write("ml_claim_message_sent", { claim_id: claimRow!.claim_id, receiver, length: message.length, attachments: decoded.length }, async () => {
          const names: string[] = [];
          for (const f of decoded) {
            const form = new FormData();
            form.append("file", new Blob([new Uint8Array(f.bytes)], { type: f.type }), f.name);
            const up = await client.request<{ file_name?: string }>("POST", claimPath("/attachments"), { multipart: form });
            if (up.data?.file_name) names.push(up.data.file_name);
          }
          await client.post(claimPath("/actions/send-message"), { receiver_role: receiver, message, attachments: names });
          await refreshClaim(deps, account.id, String(claimRow!.claim_id)).catch(() => undefined);
          return { attachments: names.length };
        });
      }
      case "claim_open_dispute": {
        await assertAction("open_dispute");
        return await write("ml_claim_dispute_opened", { claim_id: claimRow!.claim_id }, async () => {
          // [confirmar] ruta exacta con un reclamo real (ANDESMAR no la automatizó).
          await client.post(claimPath("/actions/open-dispute"), {});
          await refreshClaim(deps, account.id, String(claimRow!.claim_id)).catch(() => undefined);
          return null;
        });
      }
      case "claim_allow_return": {
        await assertAction("allow_return");
        return await write("ml_claim_return_allowed", { claim_id: claimRow!.claim_id }, async () => {
          await client.post(claimPath("/expected-resolutions/allow-return"));
          await refreshClaim(deps, account.id, String(claimRow!.claim_id)).catch(() => undefined);
          return null;
        });
      }
      case "claim_partial_refund": {
        const pct = Number(b.percentage);
        const expected = Number(b.expected_amount);
        if (!(pct > 0 && pct < 100) || !(expected > 0)) return json({ error: "invalid_input" }, 400);
        await assertAction("partial_refund");
        const o = await client.get<{ available_offers?: Array<{ percentage: number; amount: number }> }>(claimPath("/partial-refund/available-offers"));
        const offer = (o.available_offers ?? []).find((x) => Number(x.percentage) === pct);
        if (!offer) return json({ error: "action_not_available", message: "Ese porcentaje ya no está entre las ofertas de Mercado Libre." }, 409);
        if (Math.abs(Number(offer.amount) - expected) > 0.01) {
          return json({ error: "amount_changed", amount: offer.amount }, 409);
        }
        return await write("ml_claim_partial_refund", { claim_id: claimRow!.claim_id, percentage: pct, amount: offer.amount }, async () => {
          await client.post(claimPath("/expected-resolutions/partial-refund"), { percentage: pct });
          await refreshClaim(deps, account.id, String(claimRow!.claim_id)).catch(() => undefined);
          return { amount: offer.amount };
        });
      }
      case "pack_messages": {
        const pack = String(b.pack_key ?? "");
        if (!/^\d{5,22}$/.test(pack)) return json({ error: "invalid_pack" }, 400);
        // mark_as_read=false es obligatorio: si no, ML marca la conversación como leída.
        const r = await client.get<{ messages?: Array<{ from?: { user_id?: number }; text?: string; message_date?: { created?: string }; date_created?: string }> }>(
          `/messages/packs/${pack}/sellers/${account.ml_user_id}`,
          { tag: "post_sale", mark_as_read: "false", limit: 50 },
        );
        const msgs = (r.messages ?? [])
          .map((m) => ({
            mine: String(m.from?.user_id ?? "") === String(account.ml_user_id),
            text: plainText(m.text ?? ""),
            date: m.message_date?.created ?? m.date_created ?? null,
          }))
          .sort((x, y) => Date.parse(x.date ?? "") - Date.parse(y.date ?? ""));
        return json({ messages: msgs });
      }
      case "pack_message_send": {
        const pack = String(b.pack_key ?? "");
        const text = String(b.text ?? "").trim();
        if (!/^\d{5,22}$/.test(pack)) return json({ error: "invalid_pack" }, 400);
        if (text.length < 2 || text.length > 3500) return json({ error: "invalid_text" }, 400);
        const { data: order } = await admin
          .from("ml_orders")
          .select("buyer_id")
          .eq("account_id", account.id)
          .eq("pack_key", pack)
          .not("buyer_id", "is", null)
          .limit(1)
          .maybeSingle();
        if (!order?.buyer_id) return json({ error: "no_buyer" }, 404);
        return await write("ml_claim_pack_message_sent", { pack_key: pack, length: text.length }, async () => {
          await client.post(`/messages/packs/${pack}/sellers/${account.ml_user_id}?tag=post_sale`, {
            from: { user_id: account.ml_user_id },
            to: { user_id: order.buyer_id },
            text,
          });
          return null;
        });
      }
      default:
        return json({ error: "unknown_action" }, 400);
    }
  } catch (e) {
    if (e instanceof MlApiError) {
      if (e.message === "action_not_available") return json({ error: "action_not_available" }, 409);
      return json({ error: e.code, message: e.message, causes: e.causes.slice(0, 10) }, e.code === "rate_limited" ? 429 : 502);
    }
    console.error(JSON.stringify({ fn: "ml_gestor", action, error: String(e instanceof Error ? e.message : e) }));
    return json({ error: "server_error" }, 500);
  }
});
