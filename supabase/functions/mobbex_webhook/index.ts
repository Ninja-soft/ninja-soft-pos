// =============================================================================
// Edge Function: mobbex_webhook — recibe notificaciones de Mobbex (público, sin
// JWT). Identifica el intent por ?intent=<id>.
//
// ANTIFRAUDE (espeja mp_webhook): NO confía en el body. Con las credenciales
// Mobbex del tenant (payment_secrets, las mismas que usó mobbex_create_qr)
// re-consulta la operación REAL a la API de Mobbex y sólo entonces decide el
// estado. Valida, antes de marcar `approved`:
//   1. que la operación exista en Mobbex,
//   2. que su `reference` == el intentId del query (la referencia que mandamos),
//   3. que el estado real (status.code) sea aprobado (200),
//   4. que el monto pagado (total) == mp_payment_intents.amount (tol. centavos).
// Si no se puede verificar (sin credenciales / endpoint caído / respuesta
// ilegible / monto distinto / referencia que no matchea) NO se acredita: el
// intent queda en pending (o rejected si Mobbex devolvió rechazo claro) y se
// loguea. Nunca se acciona sólo sobre el body. Siempre responde 200 para que
// Mobbex no reintente en loop.
//
// Códigos Mobbex: 200 = aprobado; 1/2/3/100/201 = en proceso; resto = rechazado.
// Doc consulta de operaciones: https://mobbex.dev/consulta-de-operaciones-y-childs
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";

const PENDING = new Set([1, 2, 3, 100, 201]);
function mapStatus(code: number): string {
  if (code === 200) return "approved";
  if (PENDING.has(code)) return "pending";
  return "rejected";
}

// Tolerancia de centavos al comparar el monto pagado contra el esperado.
const AMOUNT_TOLERANCE = 0.01;

// Extrae { code, total, reference } de la respuesta de Mobbex de forma
// defensiva: el wrapping exacto puede variar (data.transaction.payment,
// data.payment, o data directo). Devolvemos lo primero que encontremos.
type MobbexPayment = {
  status?: { code?: number | string };
  total?: number | string;
  reference?: string;
  checkout?: { reference?: string };
};
function pickPayment(data: unknown): MobbexPayment | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const candidates: unknown[] = [
    (d.transaction as Record<string, unknown> | undefined)?.payment,
    d.payment,
    d, // por si la operación viene "plana".
  ];
  for (const c of candidates) {
    if (c && typeof c === "object") {
      const p = c as MobbexPayment;
      if (p.status !== undefined || p.total !== undefined || p.reference !== undefined) {
        return p;
      }
    }
  }
  return null;
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

    // El body sólo se usa como PISTA (id de la operación a re-consultar). El
    // estado y el monto se toman SIEMPRE de la re-consulta a Mobbex.
    let body: {
      type?: string;
      data?: {
        payment?: { id?: string; uid?: string };
        id?: string;
        uid?: string;
      };
    };
    try {
      body = await req.json();
    } catch {
      return ok();
    }

    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

    // Intent + tenant + monto esperado.
    const { data: intent } = await admin
      .from("mp_payment_intents")
      .select("id, tenant_id, amount, status, preference_id")
      .eq("id", intentId)
      .eq("provider_key", "mobbex")
      .maybeSingle();
    if (!intent) return ok();
    if (intent.status === "approved") return ok(); // idempotencia barata.

    // Credenciales Mobbex del tenant (las mismas que usó el checkout).
    const { data: secretRow } = await admin
      .from("payment_secrets")
      .select("secrets")
      .eq("tenant_id", intent.tenant_id)
      .eq("provider_key", "mobbex")
      .maybeSingle();
    const sec = (secretRow?.secrets ?? {}) as { api_key?: string; access_token?: string };
    if (!sec.api_key || !sec.access_token) {
      // Sin credenciales no podemos verificar nada → NO acreditamos.
      console.error("[mobbex_webhook] no_credentials, leaving pending", { intentId });
      return ok();
    }

    // Identificador para re-consultar la operación: preferimos el id/uid de
    // Mobbex (del checkout o del body); si no hay, usamos la referencia
    // (intentId) con la nomenclatura `ref\<reference>` de Mobbex.
    const opId =
      intent.preference_id ||
      body.data?.payment?.id ||
      body.data?.payment?.uid ||
      body.data?.id ||
      body.data?.uid ||
      "";
    const lookupPath = opId
      ? encodeURIComponent(String(opId))
      : `ref%5C${encodeURIComponent(intentId)}`; // ref\<reference>

    let payRes: Response;
    try {
      payRes = await fetch(`https://api.mobbex.com/p/operations/${lookupPath}`, {
        headers: {
          "x-api-key": sec.api_key,
          "x-access-token": sec.access_token,
          Accept: "application/json",
        },
      });
    } catch (e) {
      console.error("[mobbex_webhook] lookup_unreachable, leaving pending", {
        intentId,
        detail: String(e).slice(0, 200),
      });
      return ok();
    }
    if (!payRes.ok) {
      console.error("[mobbex_webhook] lookup_http_error, leaving pending", {
        intentId,
        status: payRes.status,
      });
      return ok();
    }

    let out: { result?: boolean; data?: unknown };
    try {
      out = (await payRes.json()) as { result?: boolean; data?: unknown };
    } catch {
      console.error("[mobbex_webhook] lookup_unparseable, leaving pending", { intentId });
      return ok();
    }

    const payment = pickPayment(out.data);
    if (!payment) {
      console.error("[mobbex_webhook] payment_not_found_in_response, leaving pending", {
        intentId,
      });
      return ok();
    }

    // Antifraude #1: la operación tiene que referenciar ESTE intent.
    const reference = payment.reference ?? payment.checkout?.reference ?? "";
    if (reference !== intentId) {
      console.error("[mobbex_webhook] reference_mismatch, leaving pending", {
        intentId,
        reference,
      });
      return ok();
    }

    const code = Number(payment.status?.code ?? NaN);
    if (!Number.isFinite(code)) {
      console.error("[mobbex_webhook] no_status_code, leaving pending", { intentId });
      return ok();
    }
    const mapped = mapStatus(code);

    // Antifraude #2: para acreditar, el monto pagado tiene que coincidir con el
    // esperado (tolerancia de centavos). Mobbex `total` viene en unidades de la
    // moneda (ARS con decimales), igual que el `total` que enviamos al crear el
    // checkout.
    if (mapped === "approved") {
      const paid = Number(payment.total ?? NaN);
      const expected = Number(intent.amount);
      if (!Number.isFinite(paid) || Math.abs(paid - expected) > AMOUNT_TOLERANCE) {
        console.error("[mobbex_webhook] amount_mismatch, leaving pending (NOT crediting)", {
          intentId,
          paid,
          expected,
        });
        return ok(); // monto no verificable / distinto → NO acreditamos.
      }
    }

    await admin
      .from("mp_payment_intents")
      .update({
        status: mapped,
        mp_payment_id: opId ? String(opId) : intent.preference_id,
      })
      .eq("id", intentId)
      .neq("status", "approved"); // no pisar una acreditación previa.

    return ok();
  } catch (e) {
    console.error("[mobbex_webhook] unexpected", String(e).slice(0, 200));
    return ok();
  }
});
