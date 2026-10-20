// Lectura de facturas de compra con IA (F24 · H167, ADR-178). PURO (sin Deno
// ni red): el prompt, el pedido a Claude o Gemini y la validación estricta del
// JSON que devuelve el modelo. Lo usa la Edge purchase_invoice_ocr y lo testea
// vitest (tests/unit/purchaseInvoiceOcr.test.ts).
//
// Nunca graba: el resultado precarga el formulario del comprobante y una
// persona lo revisa. Todo lo que no valida queda en null con un aviso.

export const OCR_MIME = ["application/pdf", "image/jpeg", "image/png", "image/webp"] as const;
export type OcrMime = (typeof OCR_MIME)[number];

const RATES = [0, 2.5, 5, 10.5, 21, 27];
const LETTERS = ["A", "B", "C", "M", "E"];
const KINDS = ["invoice", "debit_note", "credit_note"];
const TAX_KINDS = [
  "percepcion_iva",
  "percepcion_iibb",
  "percepcion_ganancias",
  "percepcion_municipal",
  "impuesto_interno",
  "otro",
];

export const OCR_PROMPT = `Sos un asistente contable argentino. Leé el comprobante de compra adjunto (factura, nota de débito o nota de crédito de un proveedor) y devolvé SOLO un objeto JSON, sin texto antes ni después, con esta forma:
{
  "supplier_cuit": "CUIT del EMISOR (11 dígitos, sin guiones) o null",
  "supplier_name": "razón social del emisor o null",
  "kind": "invoice" | "debit_note" | "credit_note",
  "letter": "A" | "B" | "C" | "M" | "E",
  "point_of_sale": número o null,
  "number": número o null,
  "issue_date": "AAAA-MM-DD" o null,
  "due_date": "AAAA-MM-DD" (vencimiento del pago) o null,
  "cae": "14 dígitos" o null,
  "cae_due": "AAAA-MM-DD" (vencimiento del CAE) o null,
  "currency": "ARS" | "USD" | "EUR",
  "vat_lines": [{"rate": 21 | 10.5 | 27 | 5 | 2.5 | 0, "net": número, "vat": número}],
  "exempt_amount": número,
  "non_taxed_amount": número,
  "other_taxes": [{"kind": "percepcion_iva" | "percepcion_iibb" | "percepcion_ganancias" | "percepcion_municipal" | "impuesto_interno" | "otro", "description": "texto", "jurisdiction": "provincia o null", "amount": número}],
  "total": número,
  "items": [{"description": "texto", "qty": número, "unit_price": número sin IVA, "vat_rate": número}]
}
Reglas: importes con punto decimal y sin separador de miles. La CUIT del emisor es la del proveedor, NO la del comprador. En comprobantes B y C el IVA no se discrimina: poné todo el importe gravado en una sola línea con rate 0 y vat 0. Si un dato no se ve con claridad, poné null; no inventes. "items" es opcional (lista vacía si no hay detalle).`;

export interface OcrVatLine {
  rate: number;
  net: number;
  vat: number;
}

export interface OcrOtherTax {
  kind: string;
  description: string | null;
  jurisdiction: string | null;
  amount: number;
}

export interface OcrItem {
  description: string;
  qty: number;
  unit_price: number;
  vat_rate: number;
}

export interface OcrInvoice {
  supplier_cuit: string | null;
  supplier_name: string | null;
  kind: "invoice" | "debit_note" | "credit_note";
  letter: string | null;
  point_of_sale: number | null;
  number: number | null;
  issue_date: string | null;
  due_date: string | null;
  cae: string | null;
  cae_due: string | null;
  currency: string;
  vat_lines: OcrVatLine[];
  exempt_amount: number;
  non_taxed_amount: number;
  other_taxes: OcrOtherTax[];
  total: number | null;
  items: OcrItem[];
}

export type OcrParse = { ok: true; data: OcrInvoice; warnings: string[] } | { ok: false; error: string };

function cuitOk(d: string): boolean {
  if (!/^\d{11}$/.test(d)) return false;
  const w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let s = 0;
  for (let i = 0; i < 10; i++) s += Number(d[i]) * w[i]!;
  let c = 11 - (s % 11);
  if (c === 11) c = 0;
  if (c === 10) c = 9;
  return c === Number(d[10]);
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function money(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? r2(Math.abs(v)) : null;
  let s = String(v).replace(/[^\d.,-]/g, "");
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? r2(Math.abs(n)) : null;
}

function int(v: unknown, max: number): number | null {
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/\D/g, ""));
  return Number.isInteger(n) && n >= 1 && n <= max ? n : null;
}

function day(v: unknown): string | null {
  const s = String(v ?? "").trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  let y: number, mo: number, d: number;
  if (m) {
    y = +m[1]!;
    mo = +m[2]!;
    d = +m[3]!;
  } else {
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    if (!m) return null;
    d = +m[1]!;
    mo = +m[2]!;
    y = +m[3]!;
  }
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  if (y < 2000 || y > 2100) return null;
  return dt.toISOString().slice(0, 10);
}

/** Saca el JSON de la respuesta del modelo (tolera ```json ... ```). */
export function extractJson(text: string): unknown {
  const t = String(text ?? "").trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  const body = fenced ? fenced[1]! : t;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no_json");
  return JSON.parse(body.slice(start, end + 1));
}

/** Validación estricta: tipos, rangos, CUIT con dígito verificador. */
export function validateOcr(raw: unknown): OcrParse {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "invalid_shape" };
  const o = raw as Record<string, unknown>;
  const warnings: string[] = [];

  let cuit = String(o.supplier_cuit ?? "").replace(/\D/g, "") || null;
  if (cuit && !cuitOk(cuit)) {
    warnings.push("La CUIT leída no es válida: revisala.");
    cuit = null;
  }
  const kind = KINDS.includes(String(o.kind)) ? (String(o.kind) as OcrInvoice["kind"]) : "invoice";
  let letter = String(o.letter ?? "").trim().toUpperCase() || null;
  if (letter && !LETTERS.includes(letter)) letter = null;
  if (!letter) warnings.push("No se pudo leer la letra del comprobante.");

  const vatLines: OcrVatLine[] = [];
  if (Array.isArray(o.vat_lines)) {
    for (const l of o.vat_lines.slice(0, 10)) {
      const x = (l ?? {}) as Record<string, unknown>;
      const rate = Number(x.rate);
      const net = money(x.net) ?? 0;
      const vat = money(x.vat) ?? 0;
      if (!RATES.includes(rate)) {
        warnings.push(`Alícuota de IVA no válida (${String(x.rate)}): se omitió.`);
        continue;
      }
      if (net > 0 || vat > 0) vatLines.push({ rate, net, vat });
    }
  }
  const others: OcrOtherTax[] = [];
  if (Array.isArray(o.other_taxes)) {
    for (const t of o.other_taxes.slice(0, 15)) {
      const x = (t ?? {}) as Record<string, unknown>;
      const amount = money(x.amount) ?? 0;
      if (!(amount > 0)) continue;
      others.push({
        kind: TAX_KINDS.includes(String(x.kind)) ? String(x.kind) : "otro",
        description: x.description ? String(x.description).slice(0, 120) : null,
        jurisdiction: x.jurisdiction ? String(x.jurisdiction).slice(0, 60) : null,
        amount,
      });
    }
  }
  const items: OcrItem[] = [];
  if (Array.isArray(o.items)) {
    for (const it of o.items.slice(0, 200)) {
      const x = (it ?? {}) as Record<string, unknown>;
      const description = String(x.description ?? "").trim().slice(0, 200);
      const qty = Number(x.qty);
      const unit = money(x.unit_price);
      if (!description || !(qty > 0) || unit == null) continue;
      const vr = Number(x.vat_rate);
      items.push({ description, qty, unit_price: unit, vat_rate: RATES.includes(vr) ? vr : 21 });
    }
  }
  const caeDigits = String(o.cae ?? "").replace(/\D/g, "");
  const currency = ["ARS", "USD", "EUR"].includes(String(o.currency ?? "").toUpperCase())
    ? String(o.currency).toUpperCase()
    : "ARS";
  const total = money(o.total);
  if (total == null || !(total > 0)) warnings.push("No se pudo leer el total.");

  const data: OcrInvoice = {
    supplier_cuit: cuit,
    supplier_name: o.supplier_name ? String(o.supplier_name).trim().slice(0, 200) : null,
    kind,
    letter,
    point_of_sale: int(o.point_of_sale, 99999),
    number: int(o.number, 99_999_999),
    issue_date: day(o.issue_date),
    due_date: day(o.due_date),
    cae: caeDigits.length === 14 ? caeDigits : null,
    cae_due: day(o.cae_due),
    currency,
    vat_lines: vatLines,
    exempt_amount: money(o.exempt_amount) ?? 0,
    non_taxed_amount: money(o.non_taxed_amount) ?? 0,
    other_taxes: others,
    total: total && total > 0 ? total : null,
    items,
  };
  if (data.total != null) {
    const sum = r2(
      data.vat_lines.reduce((t, l) => t + l.net + l.vat, 0) +
        data.exempt_amount +
        data.non_taxed_amount +
        data.other_taxes.reduce((t, x) => t + x.amount, 0),
    );
    if (Math.abs(sum - data.total) > 0.01) warnings.push("Los importes leídos no suman el total: revisalos.");
  }
  if (!data.issue_date) warnings.push("No se pudo leer la fecha.");
  if (data.point_of_sale == null || data.number == null) warnings.push("No se pudo leer el número del comprobante.");
  return { ok: true, data, warnings };
}

// ── Pedido al proveedor de IA ────────────────────────────────────────────

/** Modelo de Claude por defecto para leer comprobantes (ai_config.ocr_model lo cambia). */
export const DEFAULT_CLAUDE_OCR_MODEL = "claude-opus-5-5";

/** Modelos que aceptan effort y el fallback del servidor ante un rechazo. */
export function claudeSupportsEffort(model: string): boolean {
  return /^claude-(opus-5|sonnet-5-5|fable-5)/.test(model);
}

/** Encabezados extra del pedido a Claude según el modelo. */
export function claudeHeaders(model: string): Record<string, string> {
  return claudeSupportsEffort(model) ? { "anthropic-beta": "server-side-fallback-2026-07-01" } : {};
}

/** Cuerpo para la API de Mensajes de Claude (PDF como document, foto como image). */
export function claudeRequest(model: string, mime: OcrMime, base64: string) {
  const block =
    mime === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: mime, data: base64 } }
      : { type: "image", source: { type: "base64", media_type: mime, data: base64 } };
  return {
    model,
    max_tokens: 16000,
    // Extracción simple: effort bajo; ante un rechazo, el servidor reintenta
    // con el modelo de respaldo que corresponda.
    ...(claudeSupportsEffort(model) ? { output_config: { effort: "low" }, fallbacks: "default" } : {}),
    messages: [{ role: "user", content: [block, { type: "text", text: OCR_PROMPT }] }],
  };
}

/** Texto de la respuesta de Claude (bloques text) y tokens usados. */
export function claudeText(body: unknown): { text: string; tokens: number; refused: boolean } {
  const b = (body ?? {}) as {
    content?: Array<{ type?: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
    stop_reason?: string;
  };
  const text = (b.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
  const tokens = (Number(b.usage?.input_tokens) || 0) + (Number(b.usage?.output_tokens) || 0);
  return { text, tokens, refused: b.stop_reason === "refusal" };
}

export function geminiRequest(mime: OcrMime, base64: string) {
  return {
    contents: [{ role: "user", parts: [{ inline_data: { mime_type: mime, data: base64 } }, { text: OCR_PROMPT }] }],
    generationConfig: { responseMimeType: "application/json", temperature: 0 },
  };
}

export function geminiText(body: unknown): { text: string; tokens: number } {
  const b = (body ?? {}) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: { totalTokenCount?: number };
  };
  const text = (b.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
  return { text, tokens: Number(b.usageMetadata?.totalTokenCount) || 0 };
}
