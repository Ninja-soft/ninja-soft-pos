// =============================================================================
// Edge Function: platform_mp_reconcile (F20-10 · H136 · ADR-131). Spec
// docs/40-cobranza-saas.md §9.5, §17.2 y §17.3.
//
// Conciliación diaria de los cobros de la plataforma con Mercado Pago: lee los
// pagos de la cuenta de NinjaSoft (access token de plataforma,
// platform_secrets 'mercadopago') y los compara con platform_payments con la
// lógica pura de ../_shared/billing/reconcile.ts. Graba la corrida, la foto de
// cada pago de MP, las diferencias y las comisiones con platform_recon_begin /
// platform_recon_finish (service_role). Las acciones sobre las diferencias
// (imputar, dejar a cuenta, registrar reintegro o contracargo) las hace el
// staff en Cobranzas › Conciliación con internal_recon_resolve.
//
// Sólo LEE Mercado Pago (GET /v1/payments/search). Nunca crea, devuelve ni
// modifica pagos.
//
// Sin credenciales cargadas no falla: revisa sólo los duplicados locales y
// deja la corrida "degradada" con un aviso claro.
//
// Entradas:
//   1. Cron (pg_cron + pg_net, platform-mp-reconcile, 04:00 ART): header
//      X-Cron-Secret == platform_secrets('internal_cron').token, body
//      { mode: "cron" }.
//   2. Staff (Conciliar ahora): JWT del usuario + header x-ninja-scope:
//      internal; exige can_manage en internal_my_billing_access. Body
//      { mode: "manual", hours? } (24 a 720; por defecto la ventana de la
//      configuración).
//
// Deploy: verify_jwt=true (el cron manda el anon key como Bearer para pasar el
// gateway; la autenticación real es el X-Cron-Secret o el JWT del usuario).
// =============================================================================
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import {
  parseMpPayment,
  reconcile,
  reconWindow,
  type LocalPayment,
  type MpPayment,
  type SeenRef,
  type SubRef,
} from "../_shared/billing/reconcile.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret, x-ninja-scope",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

type Raw = Record<string, unknown>;
const NO_CREDENTIALS =
  "No hay credenciales de Mercado Pago cargadas en Pagos de plataforma: sólo se revisaron duplicados locales.";
const MAX_PAGES = 20;
const PAGE_SIZE = 100;

const num = (v: unknown, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const arr = <T = Raw>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

class MpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function mpErrorMessage(status: number): string {
  if (status === 401) return "El access token de Mercado Pago no es válido o venció.";
  if (status === 403) return "La cuenta de Mercado Pago no permite consultar pagos con este access token.";
  if (status === 429) return "Mercado Pago limitó las consultas: probá de nuevo en unos minutos.";
  if (status >= 500) return `Mercado Pago no respondió bien (error ${status}): se reintenta en la próxima corrida.`;
  return `Mercado Pago rechazó la consulta de pagos (error ${status}).`;
}

/** Lee los pagos actualizados en la ventana (sólo GET). */
async function fetchMpPayments(token: string, from: string, to: string): Promise<{ payments: MpPayment[]; truncated: boolean }> {
  const out: MpPayment[] = [];
  let truncated = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const qs = new URLSearchParams({
      sort: "date_last_updated",
      criteria: "desc",
      range: "date_last_updated",
      begin_date: from,
      end_date: to,
      limit: String(PAGE_SIZE),
      offset: String(page * PAGE_SIZE),
    });
    const res = await fetch(`https://api.mercadopago.com/v1/payments/search?${qs}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new MpError(mpErrorMessage(res.status), res.status);
    const body = (await res.json()) as Raw;
    const results = arr(body.results);
    for (const r of results) {
      const p = parseMpPayment(r);
      if (p) out.push(p);
    }
    const total = num((body.paging as Raw | undefined)?.total, results.length);
    if (results.length < PAGE_SIZE || (page + 1) * PAGE_SIZE >= total) return { payments: out, truncated };
    if (page === MAX_PAGES - 1) truncated = true;
  }
  return { payments: out, truncated };
}

async function run(admin: SupabaseClient, source: "cron" | "manual", hoursAsked: number | null, actor: string | null) {
  const { data: set } = await admin
    .from("platform_billing_settings")
    .select("recon_window_hours, recon_tolerance_cents")
    .eq("id", true)
    .maybeSingle();
  const settings = (set ?? {}) as { recon_window_hours?: number; recon_tolerance_cents?: number };
  const hours = Math.min(Math.max(Math.round(hoursAsked ?? num(settings.recon_window_hours, 72)), 24), 720);
  const tolerance = num(settings.recon_tolerance_cents, 100);
  const win = reconWindow(new Date(), hours);

  const { data: runId, error: beginErr } = await admin.rpc("platform_recon_begin", {
    p_source: source,
    p_from: win.from,
    p_to: win.to,
    p_actor: actor,
  });
  if (beginErr || !runId) {
    if (String(beginErr?.message ?? "").includes("recon_running")) {
      return json({ error: "recon_running", message: "Ya hay una conciliación en curso." }, 409);
    }
    return json({ error: "begin_failed", detail: beginErr?.message ?? null }, 500);
  }

  const finish = async (status: "ok" | "degraded" | "error", message: string, result: unknown) => {
    const { data, error } = await admin.rpc("platform_recon_finish", {
      p_run: runId,
      p_status: status,
      p_message: message,
      p_result: result,
    });
    if (error) throw new Error(error.message);
    return data as Raw;
  };

  try {
    const { data: inputs, error: inErr } = await admin.rpc("platform_recon_inputs", { p_from: win.from, p_to: win.to });
    if (inErr || !inputs) throw new Error(inErr?.message ?? "inputs_failed");
    const inp = inputs as Raw;
    const local = arr<LocalPayment>(inp.payments).map((p) => ({
      ...p,
      amount_cents: num(p.amount_cents),
      fee_cents: p.fee_cents === null || p.fee_cents === undefined ? null : num(p.fee_cents),
      net_cents: p.net_cents === null || p.net_cents === undefined ? null : num(p.net_cents),
      refunded_cents: num(p.refunded_cents),
    }));
    const subscriptions = arr<SubRef>(inp.subscriptions);
    const seen = arr<SeenRef>(inp.seen);

    const { data: sec } = await admin.from("platform_secrets").select("secrets").eq("key", "mercadopago").maybeSingle();
    const token = String(((sec?.secrets ?? {}) as Raw).access_token ?? "").trim();

    if (token.length <= 10) {
      const result = reconcile({ mp: [], local, subscriptions, seen, window: win, toleranceCents: tolerance, mpAvailable: false });
      const saved = await finish("degraded", NO_CREDENTIALS, result);
      return json({
        status: "degraded",
        run_id: runId,
        message: NO_CREDENTIALS,
        mp_count: 0,
        matched: 0,
        diffs_new: num(saved.diffs_new),
        diffs_closed: num(saved.diffs_closed),
        fees_updated: num(saved.fees_updated),
      });
    }

    let mp: MpPayment[];
    let truncated = false;
    try {
      const r = await fetchMpPayments(token, win.from, win.to);
      mp = r.payments;
      truncated = r.truncated;
    } catch (e) {
      const message = e instanceof MpError ? e.message : `No se pudo consultar Mercado Pago: ${String((e as Error)?.message ?? e)}`;
      await finish("error", message, {});
      return json({ status: "error", run_id: runId, message, mp_count: 0, matched: 0, diffs_new: 0, diffs_closed: 0, fees_updated: 0 });
    }

    const result = reconcile({ mp, local, subscriptions, seen, window: win, toleranceCents: tolerance, mpAvailable: true });
    const message =
      `${mp.length} pagos de Mercado Pago en ${hours} h; ${result.matched} cruzados; ${result.diffs.length} diferencias.` +
      (truncated ? ` Se revisaron los primeros ${MAX_PAGES * PAGE_SIZE} pagos: achicá la ventana para ver el resto.` : "");
    const saved = await finish("ok", message, result);
    return json({
      status: "ok",
      run_id: runId,
      message,
      mp_count: mp.length,
      matched: result.matched,
      diffs_new: num(saved.diffs_new),
      diffs_closed: num(saved.diffs_closed),
      fees_updated: num(saved.fees_updated),
    });
  } catch (e) {
    const message = `La conciliación falló: ${String((e as Error)?.message ?? e)}`;
    try {
      await finish("error", message, {});
    } catch {
      // La corrida queda "running" y la próxima la da por caída a los 15 minutos.
    }
    return json({ status: "error", run_id: runId, message, mp_count: 0, matched: 0, diffs_new: 0, diffs_closed: 0, fees_updated: 0 });
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

    let body: Raw = {};
    try {
      body = (await req.json()) as Raw;
    } catch {
      body = {};
    }

    const cronSecret = req.headers.get("X-Cron-Secret") ?? "";
    if (cronSecret) {
      const { data: sec } = await admin.from("platform_secrets").select("secrets").eq("key", "internal_cron").maybeSingle();
      const token = String(((sec?.secrets ?? {}) as Raw).token ?? "");
      if (!token || cronSecret !== token) return json({ error: "forbidden" }, 403);
      return await run(admin, "cron", null, null);
    }

    const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: {
        headers: {
          Authorization: req.headers.get("Authorization") ?? "",
          ...(req.headers.get("x-ninja-scope") === "internal" ? { "x-ninja-scope": "internal" } : {}),
        },
      },
      auth: { persistSession: false },
    });
    const {
      data: { user },
      error: authErr,
    } = await userClient.auth.getUser();
    if (authErr || !user) return json({ error: "unauthorized" }, 401);
    const { data: access, error: accErr } = await userClient.rpc("internal_my_billing_access");
    if (accErr || !(access as Raw | null)?.can_manage) return json({ error: "forbidden" }, 403);

    const hours = body.hours === undefined || body.hours === null ? null : num(body.hours, 72);
    return await run(admin, "manual", hours, user.id);
  } catch (e) {
    return json({ error: "internal", detail: String(e) }, 500);
  }
});
