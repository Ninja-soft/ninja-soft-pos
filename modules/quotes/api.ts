// Presupuestos (ADR-122). Las tablas nuevas todavía no están en
// types/database.ts (no se regeneran): se leen con un cliente suelto y se
// escriben sólo por RPC (quote_save, quote_set_status, quote_share,
// quote_duplicate, quote_delete, quote_link_sale), que validan rol, plan y
// totales en la base.
import { createClient } from "@/lib/supabase/client";
import { getCurrentTenantId } from "@/lib/supabase/currentUser";
import type { Quote, QuoteItem, QuoteStatus } from "@/lib/quotes/logic";

export interface QuoteListRow extends Quote {
  service_types: string[];
  item_count: number;
}

export interface QuoteRevision {
  id: string;
  version: number;
  reason: string | null;
  created_at: string;
  snapshot: { quote: Partial<Quote>; items: QuoteItem[] };
}

export interface QuoteSettings {
  pto_vta: number;
  validity_days: number;
  default_terms: string | null;
  show_signature: boolean;
  /** ADR-123: cada alta nace "sin vencimiento" (precio de referencia). */
  no_expiry_default: boolean;
  /** ADR-123: contacto del negocio impreso en el presupuesto (vacío = el de la marca). */
  contact_email: string | null;
  contact_phone: string | null;
  /** ADR-123: plantilla del email (vacía = la de NinjaSoft). */
  email_subject: string | null;
  email_message: string | null;
}

export const DEFAULT_QUOTE_SETTINGS: QuoteSettings = {
  pto_vta: 1,
  validity_days: 15,
  default_terms: null,
  show_signature: true,
  no_expiry_default: false,
  contact_email: null,
  contact_phone: null,
  email_subject: null,
  email_message: null,
};

/** Un envío por email (uno por destinatario, ADR-123). */
export interface QuoteEmailLog {
  id: string;
  batch_id: string;
  quote_version: number;
  recipient: string;
  subject: string;
  status: "pending" | "sent" | "failed";
  provider: "tenant" | "platform" | null;
  error_message: string | null;
  sent_by_name: string | null;
  created_at: string;
  sent_at: string | null;
}

export interface QuoteEmailResult {
  ok: boolean;
  sent: number;
  failed: number;
  provider: "tenant" | "platform";
  results: { recipient: string; ok: boolean }[];
}

/** Presupuestos por emisor (comisiones, ADR-123). */
export interface QuoteIssuerRow {
  issuer_id: string | null;
  issuer_name: string;
  count: number;
  total: number;
  accepted: number;
  converted: number;
  converted_total: number;
}

export interface QuoteSaveInput {
  id?: string;
  customer_id?: string | null;
  customer_name?: string | null;
  customer_doc?: string | null;
  customer_email?: string | null;
  /** ADR-123: emails del cliente (hasta 10). */
  customer_emails?: string[];
  customer_phone?: string | null;
  customer_address?: string | null;
  /** ADR-123: sin vencimiento (precio de referencia). */
  no_expiry?: boolean;
  valid_until?: string | null;
  validity_days?: number | null;
  terms?: string | null;
  notes?: string | null;
  discount_total?: number;
  store_id?: string | null;
  service_from?: string | null;
  service_to?: string | null;
  show_signature?: boolean;
  reason?: string | null;
}

export interface QuoteSaveResult {
  id: string;
  pto_vta: number;
  number: number;
  version: number;
  status: QuoteStatus;
  total: number;
}

/** Datos públicos (link de aceptación). */
export interface PublicQuote {
  pto_vta: number;
  number: number;
  version: number;
  status: QuoteStatus;
  issue_date: string;
  valid_until: string | null;
  no_expiry?: boolean;
  issued_by_name?: string | null;
  customer_name: string | null;
  customer_doc: string | null;
  customer_address: string | null;
  customer_iva: string | null;
  terms: string | null;
  notes: string | null;
  service_from: string | null;
  service_to: string | null;
  subtotal: number;
  discount_total: number;
  total: number;
  show_signature: boolean;
  accepted_at: string | null;
  accepted_by_name: string | null;
  rejected_at: string | null;
  issuer: {
    name: string;
    trade_name: string | null;
    logo_url: string | null;
    accent: string | null;
    cuit: string | null;
    address: string | null;
    phone: string | null;
    email?: string | null;
    iva_condition: string | null;
  };
  items: QuoteItem[];
}

type Res = { data: unknown; error: { message: string } | null };
interface LooseQuery extends PromiseLike<Res> {
  eq: (c: string, v: unknown) => LooseQuery;
  is: (c: string, v: null) => LooseQuery;
  order: (c: string, o?: { ascending?: boolean }) => LooseQuery;
  limit: (n: number) => LooseQuery;
  maybeSingle: () => PromiseLike<Res>;
}
interface Loose {
  from: (t: string) => {
    select: (c: string) => LooseQuery;
    upsert: (v: unknown, o?: { onConflict?: string }) => PromiseLike<Res>;
  };
  rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<Res>;
}
const loose = () => createClient() as unknown as Loose;

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await loose().rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

const num = (v: unknown) => Number(v ?? 0);

function normQuote(r: Record<string, unknown>): Quote {
  return {
    ...(r as unknown as Quote),
    customer_emails: Array.isArray(r.customer_emails) ? (r.customer_emails as string[]) : [],
    subtotal: num(r.subtotal),
    discount_total: num(r.discount_total),
    total: num(r.total),
  };
}

function normItem(r: Record<string, unknown>): QuoteItem {
  return {
    ...(r as unknown as QuoteItem),
    quantity: num(r.quantity),
    unit_price: num(r.unit_price),
    discount: num(r.discount),
    subtotal: num(r.subtotal),
  };
}

export const quotesApi = {
  list: async (): Promise<QuoteListRow[]> => {
    const { data, error } = await loose()
      .from("quotes")
      .select("*, quote_items(service_type_name, deleted_at)")
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);
    return ((data ?? []) as Record<string, unknown>[]).map((r) => {
      const items = ((r.quote_items ?? []) as { service_type_name: string | null; deleted_at: string | null }[]).filter(
        (i) => !i.deleted_at,
      );
      const { quote_items: _omit, ...rest } = r;
      void _omit;
      return {
        ...normQuote(rest),
        service_types: Array.from(new Set(items.map((i) => i.service_type_name).filter((x): x is string => Boolean(x)))),
        item_count: items.length,
      };
    });
  },

  get: async (id: string): Promise<(Quote & { items: QuoteItem[] }) | null> => {
    const sb = loose();
    const [{ data: q, error }, { data: items, error: iErr }] = await Promise.all([
      sb.from("quotes").select("*").eq("id", id).maybeSingle(),
      sb.from("quote_items").select("*").eq("quote_id", id).is("deleted_at", null).order("sort"),
    ]);
    if (error) throw new Error(error.message);
    if (iErr) throw new Error(iErr.message);
    if (!q) return null;
    return { ...normQuote(q as Record<string, unknown>), items: ((items ?? []) as Record<string, unknown>[]).map(normItem) };
  },

  revisions: async (id: string): Promise<QuoteRevision[]> => {
    const { data, error } = await loose()
      .from("quote_revisions")
      .select("id, version, reason, created_at, snapshot")
      .eq("quote_id", id)
      .order("version", { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []) as QuoteRevision[];
  },

  save: (quote: QuoteSaveInput, items: Record<string, unknown>[]) =>
    rpc<QuoteSaveResult>("quote_save", { p_quote: quote, p_items: items }),

  setStatus: (id: string, status: "sent" | "accepted" | "rejected", reason?: string | null) =>
    rpc<{ id: string; status: QuoteStatus }>("quote_set_status", { p_id: id, p_status: status, p_reason: reason ?? null }),

  share: (id: string) => rpc<{ id: string; token: string }>("quote_share", { p_id: id }),

  duplicate: (id: string) => rpc<{ id: string; pto_vta: number; number: number }>("quote_duplicate", { p_id: id }),

  remove: (id: string) => rpc<{ id: string }>("quote_delete", { p_id: id }),

  linkSale: (id: string, saleId: string) =>
    rpc<{ id: string; status: QuoteStatus }>("quote_link_sale", { p_id: id, p_sale_id: saleId }),

  settings: async (): Promise<QuoteSettings> => {
    const { data } = await loose()
      .from("quote_settings")
      .select(
        "pto_vta, validity_days, default_terms, show_signature, no_expiry_default, contact_email, contact_phone, email_subject, email_message",
      )
      .maybeSingle();
    return { ...DEFAULT_QUOTE_SETTINGS, ...((data ?? {}) as Partial<QuoteSettings>) };
  },

  /** Email y WhatsApp de la ficha del cliente (destinatarios por defecto). */
  customerContact: async (id: string): Promise<{ email: string | null; phone: string | null } | null> => {
    const { data, error } = await loose().from("customers").select("email, phone").eq("id", id).maybeSingle();
    if (error) throw new Error(error.message);
    return (data ?? null) as { email: string | null; phone: string | null } | null;
  },

  /** Envíos por email del presupuesto (historial). */
  emails: async (id: string): Promise<QuoteEmailLog[]> => {
    const { data, error } = await loose()
      .from("quote_emails")
      .select("id, batch_id, quote_version, recipient, subject, status, provider, error_message, sent_by_name, created_at, sent_at")
      .eq("quote_id", id)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    return (data ?? []) as QuoteEmailLog[];
  },

  /**
   * Envía el presupuesto por email (Edge send_quote_email): el PDF sale del
   * mismo nodo que la vista previa. Lanza Error con el código (quoteErrorMessage
   * lo traduce).
   */
  sendEmail: async (v: {
    quoteId: string;
    to: string[];
    subject: string;
    message: string;
    node: HTMLElement;
    pdfName: string;
  }): Promise<QuoteEmailResult> => {
    const { exportInvoicePdfBase64 } = await import("@/lib/invoices/exportPdf");
    const pdf = await exportInvoicePdfBase64(v.node);
    const { data, error } = await createClient().functions.invoke("send_quote_email", {
      body: { quote_id: v.quoteId, to: v.to, subject: v.subject, message: v.message, pdf, pdf_name: v.pdfName },
    });
    const res = (data ?? null) as (QuoteEmailResult & { error?: string }) | null;
    if (error || !res) {
      let code: string | null = res?.error ?? null;
      const ctx = (error as { context?: Response } | null)?.context;
      if (!code && ctx && typeof ctx.json === "function") {
        try {
          code = ((await ctx.json()) as { error?: string }).error ?? null;
        } catch {
          /* cuerpo no JSON */
        }
      }
      throw new Error(code ?? error?.message ?? "send_failed");
    }
    return res;
  },

  issuerReport: async (fromISO: string, toISO: string): Promise<QuoteIssuerRow[]> => {
    const data = await rpc<QuoteIssuerRow[] | null>("quote_issuer_report", { p_from: fromISO, p_to: toISO });
    return (data ?? []).map((r) => ({
      ...r,
      count: num(r.count),
      total: num(r.total),
      accepted: num(r.accepted),
      converted: num(r.converted),
      converted_total: num(r.converted_total),
    }));
  },

  saveSettings: async (s: QuoteSettings): Promise<void> => {
    const tenantId = await getCurrentTenantId();
    if (!tenantId) throw new Error("no_tenant");
    const { error } = await loose()
      .from("quote_settings")
      .upsert(
        {
          tenant_id: tenantId,
          pto_vta: Math.max(1, Math.min(99999, Math.trunc(s.pto_vta))),
          validity_days: Math.max(1, Math.min(365, Math.trunc(s.validity_days))),
          default_terms: s.default_terms?.trim() ? s.default_terms.trim().slice(0, 2000) : null,
          show_signature: s.show_signature,
          no_expiry_default: s.no_expiry_default,
          contact_email: s.contact_email?.trim() ? s.contact_email.trim().toLowerCase().slice(0, 160) : null,
          contact_phone: s.contact_phone?.trim() ? s.contact_phone.trim().slice(0, 40) : null,
          email_subject: s.email_subject?.trim() ? s.email_subject.trim().slice(0, 200) : null,
          email_message: s.email_message?.trim() ? s.email_message.trim().slice(0, 4000) : null,
        },
        { onConflict: "tenant_id" },
      );
    if (error) throw new Error(error.message);
  },

  publicGet: async (token: string): Promise<PublicQuote | null> => {
    const { data, error } = await loose().rpc("quote_public_get", { p_token: token });
    if (error) throw new Error(error.message);
    if (!data) return null;
    const d = data as Record<string, unknown>;
    return {
      ...(d as unknown as PublicQuote),
      subtotal: num(d.subtotal),
      discount_total: num(d.discount_total),
      total: num(d.total),
      items: ((d.items ?? []) as Record<string, unknown>[]).map(normItem),
    };
  },

  publicRespond: (token: string, accept: boolean, name: string, comment?: string) =>
    rpc<{ status: QuoteStatus }>("quote_public_respond", {
      p_token: token,
      p_accept: accept,
      p_name: name,
      p_comment: comment ?? null,
    }),
};
