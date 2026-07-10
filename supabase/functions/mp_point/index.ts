// =============================================================================
// Edge Function: mp_point — cobro presencial con lectores Mercado Point
// (F8 · H15 resto). Reutiliza la conexión Mercado Pago del tenant
// (payment_secrets provider_key='mercadopago'; OAuth con refresh o token
// manual): NO pide credenciales nuevas.
//
// Actions (body.action):
//   * devices            → lista los lectores Point de la cuenta MP del tenant
//                          (id, modelo, operating_mode).
//   * pdv    {device_id} → pone el lector en modo PDV (necesario para poder
//                          empujarle cobros por API).
//   * create {device_id, amount, title?}
//                        → crea mp_payment_intents (provider_key
//                          'mercadopago_point') + el payment intent EN el
//                          dispositivo. preference_id guarda el id del intent
//                          de la Point API; point_device_id, el lector.
//   * status {intent_id} → sondea la Point API y sincroniza el intent local:
//                          FINISHED → approved (+ mp_payment_id + card_type
//                          debit/credit desde /v1/payments); CANCELED/ERROR/
//                          ABANDONED → cancelled. El POS registra la venta
//                          recién con approved (patrón conservador: nunca se
//                          acredita sin confirmación de la API).
//   * cancel {intent_id} → cancela en el dispositivo (si sigue abierto) y
//                          marca el intent local como cancelled.
//
// Gating real de plan: tenant_has_feature_for(tenant,'mercadopago_point') en
// create (la UI nunca es la única barrera). devices/pdv sólo exigen membresía
// owner/manager (configuración), status/cancel membresía activa.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { ...cors, "Content-Type": "application/json" },
  });

const MP = "https://api.mercadopago.com";

type Admin = ReturnType<typeof createClient>;

// Access token MP del tenant con refresh OAuth si está por vencer (mismo
// comportamiento que mp_create_qr; los tokens manuales se usan tal cual).
async function tenantMpToken(
  admin: Admin,
  tenantId: string,
): Promise<string | null> {
  const { data: secretRow } = await admin
    .from("payment_secrets")
    .select("secrets")
    .eq("tenant_id", tenantId)
    .eq("provider_key", "mercadopago")
    .maybeSingle();
  const sec = (secretRow?.secrets ?? {}) as {
    access_token?: string;
    refresh_token?: string | null;
    expires_at?: string | null;
    via?: string;
  };
  let accessToken = sec.access_token ?? null;
  if (!accessToken) return null;

  const aboutToExpire =
    sec.expires_at && Date.parse(sec.expires_at) - Date.now() < 5 * 60 * 1000;
  if (sec.via === "oauth" && sec.refresh_token && aboutToExpire) {
    const { data: plat } = await admin
      .from("platform_secrets")
      .select("secrets")
      .eq("key", "mercadopago")
      .maybeSingle();
    const ps = (plat?.secrets ?? {}) as {
      client_id?: string;
      client_secret?: string;
    };
    if (ps.client_id && ps.client_secret) {
      const r = await fetch(`${MP}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          client_id: ps.client_id,
          client_secret: ps.client_secret,
          grant_type: "refresh_token",
          refresh_token: sec.refresh_token,
        }),
      });
      if (r.ok) {
        const t = (await r.json()) as {
          access_token?: string;
          refresh_token?: string;
          expires_in?: number;
        };
        if (t.access_token) {
          accessToken = t.access_token;
          await admin
            .from("payment_secrets")
            .update({
              secrets: {
                ...sec,
                access_token: t.access_token,
                refresh_token: t.refresh_token ?? sec.refresh_token,
                expires_at: t.expires_in
                  ? new Date(Date.now() + t.expires_in * 1000).toISOString()
                  : sec.expires_at,
              },
            })
            .eq("tenant_id", tenantId)
            .eq("provider_key", "mercadopago");
        }
      }
    }
  }
  return accessToken;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false },
  });
  const {
    data: { user },
    error,
  } = await userClient.auth.getUser();
  if (error || !user) return json({ error: "unauthorized" }, 401);
  const tenantId = (user.app_metadata as { current_tenant_id?: string } | null)
    ?.current_tenant_id;
  if (!tenantId) return json({ error: "no_tenant" }, 400);

  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const action = String(b.action ?? "");

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // Miembro activo del tenant (rol para las actions de configuración).
  const { data: mem } = await admin
    .from("tenant_users")
    .select("role")
    .eq("tenant_id", tenantId)
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (!mem) return json({ error: "forbidden" }, 403);
  const canManage = mem.role === "owner" || mem.role === "manager";

  const accessToken = await tenantMpToken(admin, tenantId);
  if (!accessToken) return json({ error: "not_connected" }, 400);
  const mpHeaders = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };

  // ── devices: lista los lectores Point de la cuenta ──────────────────────────
  if (action === "devices") {
    if (!canManage) return json({ error: "forbidden" }, 403);
    const r = await fetch(`${MP}/point/integration-api/devices?limit=50`, {
      headers: mpHeaders,
    });
    if (!r.ok) {
      return json(
        { error: "mp_error", detail: (await r.text()).slice(0, 300) },
        502,
      );
    }
    const body = (await r.json()) as {
      devices?: { id: string; operating_mode?: string; pos_id?: number }[];
    };
    return json({
      devices: (body.devices ?? []).map((d) => ({
        id: d.id,
        operating_mode: d.operating_mode ?? "UNKNOWN",
      })),
    });
  }

  // ── pdv: pone un lector en modo PDV (acepta cobros por API) ─────────────────
  if (action === "pdv") {
    if (!canManage) return json({ error: "forbidden" }, 403);
    const deviceId = String(b.device_id ?? "");
    if (!deviceId) return json({ error: "invalid_device" }, 400);
    const r = await fetch(`${MP}/point/integration-api/devices/${deviceId}`, {
      method: "PATCH",
      headers: mpHeaders,
      body: JSON.stringify({ operating_mode: "PDV" }),
    });
    if (!r.ok) {
      return json(
        { error: "mp_error", detail: (await r.text()).slice(0, 300) },
        502,
      );
    }
    return json({ ok: true });
  }

  // ── create: intent local + payment intent EN el dispositivo ─────────────────
  if (action === "create") {
    // Gating de plan (enforcement real; la UI nunca es la única barrera).
    const { data: allowed } = await admin.rpc("tenant_has_feature_for", {
      p_tenant: tenantId,
      p_key: "mercadopago_point",
    });
    if (allowed !== true) return json({ error: "payment_method_not_allowed" }, 403);

    const deviceId = String(b.device_id ?? "");
    const amount = Number(b.amount);
    if (!deviceId) return json({ error: "invalid_device" }, 400);
    if (!Number.isFinite(amount) || amount <= 0) {
      return json({ error: "invalid_amount" }, 400);
    }

    const { data: intent, error: intErr } = await admin
      .from("mp_payment_intents")
      .insert({
        tenant_id: tenantId,
        amount,
        provider_key: "mercadopago_point",
        point_device_id: deviceId,
      })
      .select("id")
      .single();
    if (intErr || !intent) return json({ error: "intent_failed" }, 500);

    // Point API: el monto viaja como entero en centavos (ARS).
    const r = await fetch(
      `${MP}/point/integration-api/devices/${deviceId}/payment-intents`,
      {
        method: "POST",
        headers: mpHeaders,
        body: JSON.stringify({
          amount: Math.round(amount * 100),
          additional_info: {
            external_reference: intent.id,
            print_on_terminal: true,
          },
        }),
      },
    );
    if (!r.ok) {
      const detail = await r.text();
      await admin
        .from("mp_payment_intents")
        .update({ status: "rejected" })
        .eq("id", intent.id);
      // 409 típico: el lector no está en modo PDV o tiene un cobro abierto.
      return json({ error: "mp_error", detail: detail.slice(0, 300) }, 502);
    }
    const pi = (await r.json()) as { id: string };
    await admin
      .from("mp_payment_intents")
      .update({ preference_id: pi.id })
      .eq("id", intent.id);
    return json({ intent_id: intent.id, point_intent_id: pi.id });
  }

  // ── status / cancel: sobre un intent local Point del tenant ─────────────────
  const intentId = String(b.intent_id ?? "");
  if (!intentId) return json({ error: "invalid_intent" }, 400);
  const { data: row } = await admin
    .from("mp_payment_intents")
    .select("id, status, amount, preference_id, point_device_id, mp_payment_id")
    .eq("id", intentId)
    .eq("tenant_id", tenantId)
    .eq("provider_key", "mercadopago_point")
    .maybeSingle();
  if (!row) return json({ error: "intent_not_found" }, 404);

  if (action === "status") {
    // Ya resuelto: devolver el estado local (idempotente).
    if (row.status !== "pending") {
      return json({
        status: row.status,
        mp_payment_id: row.mp_payment_id,
        card_type: null,
      });
    }
    const r = await fetch(
      `${MP}/point/integration-api/payment-intents/${row.preference_id}`,
      { headers: mpHeaders },
    );
    if (!r.ok) {
      return json(
        { error: "mp_error", detail: (await r.text()).slice(0, 300) },
        502,
      );
    }
    const pi = (await r.json()) as {
      state?: string;
      payment?: { id?: number | string };
    };
    const state = String(pi.state ?? "").toUpperCase();

    if (state === "FINISHED" && pi.payment?.id) {
      // Verificación independiente del pago antes de acreditar (patrón
      // conservador): monto y estado desde /v1/payments.
      const payRes = await fetch(`${MP}/v1/payments/${pi.payment.id}`, {
        headers: mpHeaders,
      });
      if (!payRes.ok) {
        return json(
          { error: "mp_error", detail: (await payRes.text()).slice(0, 300) },
          502,
        );
      }
      const pay = (await payRes.json()) as {
        status?: string;
        transaction_amount?: number;
        payment_method?: { type?: string };
        payment_type_id?: string;
      };
      const approved = pay.status === "approved";
      const amountOk =
        Math.abs(Number(pay.transaction_amount ?? 0) - Number(row.amount)) < 0.01;
      if (approved && amountOk) {
        await admin
          .from("mp_payment_intents")
          .update({ status: "approved", mp_payment_id: String(pi.payment.id) })
          .eq("id", row.id);
        const type = pay.payment_type_id ?? pay.payment_method?.type ?? "";
        return json({
          status: "approved",
          mp_payment_id: String(pi.payment.id),
          card_type: type === "debit_card" ? "debit" : "credit",
        });
      }
      // FINISHED pero no aprobado o monto distinto → NO se acredita.
      await admin
        .from("mp_payment_intents")
        .update({ status: "rejected", mp_payment_id: String(pi.payment.id) })
        .eq("id", row.id);
      return json({ status: "rejected", mp_payment_id: String(pi.payment.id), card_type: null });
    }

    if (["CANCELED", "CANCELLED", "ERROR", "ABANDONED", "EXPIRED"].includes(state)) {
      await admin
        .from("mp_payment_intents")
        .update({ status: "cancelled" })
        .eq("id", row.id);
      return json({ status: "cancelled", mp_payment_id: null, card_type: null });
    }

    // OPEN / ON_TERMINAL / PROCESSING → sigue pendiente.
    return json({ status: "pending", mp_payment_id: null, card_type: null, state });
  }

  if (action === "cancel") {
    if (row.status === "pending" && row.point_device_id && row.preference_id) {
      // Best-effort: si el lector ya lo procesó, el DELETE falla y el estado
      // real lo resuelve el próximo `status`.
      await fetch(
        `${MP}/point/integration-api/devices/${row.point_device_id}/payment-intents/${row.preference_id}`,
        { method: "DELETE", headers: mpHeaders },
      ).catch(() => null);
      await admin
        .from("mp_payment_intents")
        .update({ status: "cancelled" })
        .eq("id", row.id);
    }
    return json({ ok: true });
  }

  return json({ error: "invalid_action" }, 400);
});
