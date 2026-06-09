// =============================================================================
// Edge Function: modo_webhook — recibe notificaciones de MODO (público, sin
// JWT: lo llama MODO). Identifica el intent por ?intent=<id>. verify_jwt = false.
//
// ANTIFRAUDE — alineado con mp_webhook/mobbex_webhook: NO se acredita sobre la
// sola palabra del body. Defensa en capas:
//   1. (obligatorio) el evento DEBE referenciar ESTE intent: la referencia
//      externa del comercio (external_intention_id, que seteamos = intent.id en
//      modo_create_qr) tiene que estar presente y matchear el intentId del
//      query. Antes era opcional (`if (extRef && ...)`); ahora es mandatorio.
//   2. (cuando es posible) re-consulta a la API de MODO con un token del
//      comercio (client_credentials, las mismas credenciales que usó el
//      checkout) la intención por su id, y se valida estado + monto contra lo
//      esperado (mp_payment_intents.amount, tolerancia de centavos).
//   3. si la re-consulta NO es posible (sin credenciales / endpoint no
//      configurado / respuesta ilegible) se aplica un estado conservador: SÓLO
//      se propagan estados NO-acreditantes (pending/rejected/cancelled/expired);
//      un "approved" del body NUNCA acredita por sí solo → queda pending + log.
//
// ⚠️ LIMITACIÓN DOCUMENTADA — API DE MODO ⚠️
// MODO no publica abiertamente el contrato de su API de e-commerce/QR para
// comercios (ver modo_create_qr). Por eso, a diferencia de MP/Mobbex, la
// re-consulta de MODO es "best-effort": base URL, paths, headers, nombres de
// campos y códigos de estado están marcados "VALIDAR MODO" y deben confirmarse
// contra la doc/credenciales reales. Mientras eso no esté confirmado, la
// verificación de MODO es PARCIAL y este webhook, por diseño, NO acredita un
// pago que no pueda verificar de forma independiente (monto incluido). El
// estado "approved" sólo se setea si la re-consulta lo confirma con el monto
// correcto; de lo contrario el intent permanece pending.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";

// ⚠️ VALIDAR MODO — base URLs / endpoints (mismos overrides que modo_create_qr).
const MODO_API_BASE =
  Deno.env.get("MODO_API_BASE") ?? "https://merchants.preprod.playdigital.com.ar";
const MODO_TOKEN_URL =
  Deno.env.get("MODO_TOKEN_URL") ?? `${MODO_API_BASE}/merchants/v2/auth/token`;
const MODO_INTENT_URL =
  Deno.env.get("MODO_INTENT_URL") ??
  `${MODO_API_BASE}/merchants/v2/payment-intentions`;

const AMOUNT_TOLERANCE = 0.01;

// ⚠️ VALIDAR MODO — valores de estado de MODO → estado interno.
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

// ⚠️ VALIDAR MODO — extrae estado/monto/referencia de la respuesta de la
// re-consulta de la intención, probando los nombres de campo más probables.
type ModoView = { status: string; amount: number | null; extRef: string };
function readModo(obj: Record<string, unknown> | undefined): ModoView {
  const o = obj ?? {};
  const status =
    (o.status as string) ??
    (o.state as string) ??
    (o.estado as string) ??
    "";
  const amountRaw =
    o.amount ?? o.price ?? o.total ?? o.paid_amount ?? o.transaction_amount ?? null;
  const amount =
    amountRaw == null || amountRaw === "" ? null : Number(amountRaw);
  const extRef =
    (o.external_intention_id as string) ??
    (o.external_reference as string) ??
    (o.reference as string) ??
    "";
  return { status, amount: Number.isFinite(amount as number) ? (amount as number) : null, extRef };
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

    // ⚠️ VALIDAR MODO — forma del body de la notificación.
    let body: {
      status?: string;
      state?: string;
      estado?: string;
      payment_id?: string;
      id?: string;
      payment_intention_id?: string;
      external_intention_id?: string;
      data?: {
        status?: string;
        state?: string;
        payment_id?: string;
        id?: string;
        payment_intention_id?: string;
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

    // Antifraude #1 (OBLIGATORIO): el evento tiene que referenciar ESTE intent.
    // Antes era opcional; ahora, si no viene o no matchea, no procesamos.
    const extRef = d.external_intention_id ?? body.external_intention_id;
    if (!extRef || extRef !== intentId) {
      console.error("[modo_webhook] missing_or_mismatched_external_ref, ignoring", {
        intentId,
        extRef: extRef ?? null,
      });
      return ok();
    }

    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
    const { data: intent } = await admin
      .from("mp_payment_intents")
      .select("id, tenant_id, amount, status, preference_id")
      .eq("id", intentId)
      .eq("provider_key", "modo")
      .maybeSingle();
    if (!intent) return ok();
    if (intent.status === "approved") return ok(); // idempotencia barata.

    const modoPaymentId =
      d.payment_id ?? d.id ?? body.payment_id ?? body.id ?? null;
    const modoIntentId =
      intent.preference_id ??
      d.payment_intention_id ??
      body.payment_intention_id ??
      null;

    // ── Re-consulta a MODO (best-effort, ver limitación documentada). ────────
    // Intentamos verificar de forma independiente estado + monto. Si lo
    // logramos, ESA es la fuente de verdad. Si no, caemos a un manejo
    // conservador que NUNCA acredita desde el body.
    let verified: ModoView | null = null;
    const { data: secretRow } = await admin
      .from("payment_secrets")
      .select("secrets")
      .eq("tenant_id", intent.tenant_id)
      .eq("provider_key", "modo")
      .maybeSingle();
    const sec = (secretRow?.secrets ?? {}) as {
      client_id?: string;
      client_secret?: string;
    };

    if (sec.client_id && sec.client_secret && modoIntentId) {
      try {
        // Paso 1: token client_credentials (igual que modo_create_qr).
        const tokRes = await fetch(MODO_TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            client_id: sec.client_id,
            client_secret: sec.client_secret,
            grant_type: "client_credentials",
          }),
        });
        if (tokRes.ok) {
          const tok = (await tokRes.json()) as { access_token?: string; token?: string };
          const accessToken = tok.access_token ?? tok.token ?? "";
          if (accessToken) {
            // Paso 2: GET de la intención por su id de MODO.
            const qRes = await fetch(
              `${MODO_INTENT_URL}/${encodeURIComponent(String(modoIntentId))}`,
              {
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  Accept: "application/json",
                },
              },
            );
            if (qRes.ok) {
              const raw = (await qRes.json()) as Record<string, unknown>;
              const inner =
                (raw.data as Record<string, unknown> | undefined) ??
                (raw.payment_intention as Record<string, unknown> | undefined) ??
                raw;
              verified = readModo(inner);
            } else {
              console.error("[modo_webhook] reconsult_http_error", {
                intentId,
                status: qRes.status,
              });
            }
          }
        } else {
          console.error("[modo_webhook] reconsult_auth_error", {
            intentId,
            status: tokRes.status,
          });
        }
      } catch (e) {
        console.error("[modo_webhook] reconsult_unreachable", {
          intentId,
          detail: String(e).slice(0, 200),
        });
      }
    }

    let finalStatus: string;
    if (verified) {
      // Fuente de verdad: la re-consulta. Validamos referencia (si MODO la
      // devuelve), estado y monto.
      if (verified.extRef && verified.extRef !== intentId) {
        console.error("[modo_webhook] reconsult_reference_mismatch, leaving pending", {
          intentId,
          extRef: verified.extRef,
        });
        return ok();
      }
      finalStatus = mapStatus(verified.status || rawStatus);
      if (finalStatus === "approved") {
        const paid = verified.amount;
        const expected = Number(intent.amount);
        if (paid == null || Math.abs(paid - expected) > AMOUNT_TOLERANCE) {
          console.error(
            "[modo_webhook] reconsult_amount_mismatch, leaving pending (NOT crediting)",
            { intentId, paid, expected },
          );
          return ok();
        }
      }
    } else {
      // Sin verificación independiente: manejo conservador. NUNCA acreditamos.
      // Sólo dejamos avanzar estados no-acreditantes (rechazo/cancelación/
      // expiración) para reflejar finales negativos; un "approved" del body se
      // ignora y el intent queda pending hasta poder verificar.
      const mapped = mapStatus(rawStatus);
      if (mapped === "approved") {
        console.error(
          "[modo_webhook] unverifiable_approved_body, leaving pending (NOT crediting)",
          { intentId },
        );
        return ok();
      }
      finalStatus = mapped; // pending / rejected / cancelled / expired
    }

    await admin
      .from("mp_payment_intents")
      .update({
        status: finalStatus,
        mp_payment_id: modoPaymentId ? String(modoPaymentId) : intent.preference_id,
      })
      .eq("id", intentId)
      .neq("status", "approved");

    return ok();
  } catch (e) {
    console.error("[modo_webhook] unexpected", String(e).slice(0, 200));
    return ok();
  }
});
