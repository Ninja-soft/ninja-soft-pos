// =============================================================================
// Edge Function: send_quote_email (ADR-123): envía un presupuesto por email a
// uno o varios destinatarios (uno por envío, nadie ve a los demás) con el PDF
// adjunto (el mismo de la vista previa, generado en el cliente con el motor de
// comprobantes ADR-112/119) y un cuerpo con la marca del negocio.
//
// Guard y gating: la RPC quote_email_prepare corre con el JWT del usuario
// (_quote_guard: negocio del JWT, rol no "solo lectura", feature
// `presupuestos` del plan) y valida destinatarios, asunto y tope diario; deja
// un registro 'pending' por destinatario en quote_emails. Después de enviar,
// quote_email_finish (service_role) cierra cada registro, pasa el borrador a
// enviado, audita y deja la bitácora en system_emails (kind 'quote').
//
// Proveedor: el email DEL NEGOCIO si está configurado (tenant_email_smtp:
// Resend o SMTP, desde su propio dominio); si no, la cadena de la plataforma
// (email_providers: Resend con failover) con el nombre del negocio como
// remitente y respuesta (reply-to) al email de contacto del negocio.
//
// Deploy: verify_jwt=true.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { sendWithChain, type SendArgs } from "../_shared/mailer.ts";
import { safeName, sendViaTenant, tenantProviderReady, type TenantEmailCfg } from "../_shared/tenantMailer.ts";
import { buildQuoteEmailHtml } from "../_shared/quoteEmailTemplate.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-ninja-scope",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APP_URL = (Deno.env.get("APP_URL") || "https://pos.soft.ninja").replace(/\/$/, "");

addEventListener("unhandledrejection", (e) => {
  console.error("unhandledrejection:", (e as PromiseRejectionEvent).reason);
  (e as PromiseRejectionEvent).preventDefault();
});
addEventListener("error", (e) => {
  console.error("uncaught error:", (e as ErrorEvent).message);
  (e as ErrorEvent).preventDefault();
});

const ars = (n: number) =>
  new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 2 }).format(n);
const fmtDate = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
};
const pad = (n: number, w: number) => String(n).padStart(w, "0");

// Errores de la RPC que se devuelven tal cual (el cliente los traduce).
const KNOWN = [
  "feature_not_in_plan",
  "forbidden_read_only",
  "forbidden",
  "no_tenant",
  "quote_not_found",
  "quote_status_invalid",
  "quote_email_invalid",
  "quote_email_subject_required",
  "quote_email_limit",
];

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const userClient = createClient(url, anonKey, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
      auth: { persistSession: false },
    });
    const {
      data: { user },
      error: authErr,
    } = await userClient.auth.getUser();
    if (authErr || !user) return json({ error: "unauthorized" }, 401);

    let b: { quote_id?: string; to?: unknown; subject?: string; message?: string; pdf?: string; pdf_name?: string };
    try {
      b = await req.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    const quoteId = String(b.quote_id ?? "").trim();
    if (!UUID_RE.test(quoteId)) return json({ error: "quote_not_found" }, 400);
    const to = Array.isArray(b.to)
      ? Array.from(new Set(b.to.map((x) => String(x ?? "").trim().toLowerCase()).filter(Boolean)))
      : [];
    if (to.length === 0 || to.length > 10 || to.some((t) => t.length > 160 || !EMAIL_RE.test(t)))
      return json({ error: "quote_email_invalid" }, 400);
    const subject = String(b.subject ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    if (!subject) return json({ error: "quote_email_subject_required" }, 400);
    const message = String(b.message ?? "").trim().slice(0, 4000);
    const pdf = String(b.pdf ?? "").trim();
    if (!pdf || !BASE64_RE.test(pdf)) return json({ error: "invalid_pdf" }, 400);
    if (pdf.length > 6_000_000) return json({ error: "pdf_too_large" }, 413);

    // Guard + gating + registro 'pending' (con el JWT del usuario).
    const { data: prep, error: prepErr } = await userClient.rpc("quote_email_prepare", {
      p_id: quoteId,
      p_to: to,
      p_subject: subject,
      p_message: message || null,
    });
    if (prepErr) {
      const code = KNOWN.find((k) => prepErr.message.includes(k)) ?? "prepare_failed";
      const status = code.startsWith("forbidden") || code === "feature_not_in_plan" || code === "no_tenant" ? 403 : 400;
      return json({ error: code }, status);
    }
    const p = prep as {
      batch_id: string;
      token: string;
      recipients: string[];
      sent_by_name: string | null;
      quote: {
        tenant_id: string;
        pto_vta: number;
        number: number;
        total: number;
        valid_until: string | null;
        created_by_name: string | null;
      };
    };
    const tenantId = p.quote.tenant_id;
    const numberLabel = `${pad(p.quote.pto_vta, 4)}-${pad(p.quote.number, 8)}`;

    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
    const [{ data: cfg }, { data: brand }, { data: tenant }, { data: qs }] = await Promise.all([
      admin.from("tenant_email_smtp").select("*").eq("tenant_id", tenantId).maybeSingle(),
      admin.from("tenant_branding").select("legal_name, logo_url, accent, phone").eq("tenant_id", tenantId).maybeSingle(),
      admin.from("tenants").select("name").eq("id", tenantId).maybeSingle(),
      admin.from("quote_settings").select("contact_email, contact_phone").eq("tenant_id", tenantId).maybeSingle(),
    ]);
    const businessName = safeName(tenant?.name || brand?.legal_name || cfg?.from_name, "Presupuesto");
    const contactEmail = String(qs?.contact_email ?? "").trim();
    const contactPhone = String(qs?.contact_phone ?? "").trim() || String(brand?.phone ?? "").trim();
    const useTenant = tenantProviderReady(cfg as TenantEmailCfg | null);
    const replyTo = contactEmail || (useTenant ? null : String(cfg?.from_email ?? "").trim() || null);

    const html = buildQuoteEmailHtml({
      accent: String(brand?.accent ?? ""),
      logoUrl: String(brand?.logo_url ?? ""),
      businessName,
      numberLabel,
      message,
      totalText: ars(Number(p.quote.total)),
      validityText: p.quote.valid_until
        ? `Válido hasta el ${fmtDate(p.quote.valid_until)}`
        : "Precio de referencia, sujeto a cambios",
      issuedBy: p.quote.created_by_name ?? "",
      link: `${APP_URL}/presupuesto/${p.token}`,
      contactText: [contactPhone ? `Tel. ${contactPhone}` : "", contactEmail].filter(Boolean).join(" · "),
    });
    const pdfName = (String(b.pdf_name ?? "").replace(/[^\w.-]+/g, "-").slice(0, 80) || `presupuesto-${numberLabel}`).replace(
      /(\.pdf)?$/i,
      ".pdf",
    );

    const results: { recipient: string; ok: boolean; error?: string }[] = [];
    for (const r of p.recipients) {
      const args: SendArgs = {
        to: r,
        subject,
        html,
        text: message || subject,
        replyTo,
        fromName: businessName,
        attachments: [{ filename: pdfName, content: pdf, contentType: "application/pdf" }],
      };
      try {
        if (useTenant) {
          await sendViaTenant(cfg as TenantEmailCfg, args);
        } else {
          const res = await sendWithChain(admin, args);
          if (!res.providerUsed) throw new Error(res.noProvider ? "no_provider" : res.lastError || "send_failed");
        }
        results.push({ recipient: r, ok: true });
      } catch (e) {
        results.push({ recipient: r, ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
      }
    }

    const { error: finErr } = await admin.rpc("quote_email_finish", {
      p_batch: p.batch_id,
      p_results: results,
      p_provider: useTenant ? "tenant" : "platform",
    });
    if (finErr) console.error("quote_email_finish:", finErr.message);

    const sent = results.filter((x) => x.ok).length;
    // 200 también si fallaron todos: el cliente muestra el resultado por
    // destinatario (queda registrado en el historial del presupuesto).
    return json({
      ok: sent > 0,
      sent,
      failed: results.length - sent,
      provider: useTenant ? "tenant" : "platform",
      results: results.map(({ recipient, ok }) => ({ recipient, ok })),
      ...(sent === 0 ? { error: "send_failed" } : {}),
    });
  } catch (e) {
    return json({ error: "internal", detail: String(e) }, 500);
  }
});
