// Detalle de cobros de una venta (ADR-061): lógica pura de la pestaña "Cobros"
// del detalle de la venta. Etiquetas de medio y proveedor, datos del cupón,
// ids del procesador y línea de tiempo del cobro. Sin React ni Supabase.

export type SalePaymentRow = {
  id: string;
  method: string;
  amount: number;
  reference: string | null;
  created_at: string;
  card_voucher: Record<string, unknown> | null;
  reconciled_at: string | null;
};

export type PaymentIntentRow = {
  id: string;
  provider_key: string;
  status: string;
  amount: number;
  mp_payment_id: string | null;
  mp_order_id: string | null;
  preference_id: string | null;
  point_device_id: string | null;
  payment_terminal_id: string | null;
  created_at: string;
  updated_at: string;
  secret_store_id: string | null;
};

export type DetailField = { key: string; label: string; value: string; mono?: boolean; copy?: boolean };
export type TimelineStep = { at: string; label: string; tone?: "success" | "warning" | "danger" | "neutral" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isIntentRef = (ref: string | null | undefined): ref is string => !!ref && UUID_RE.test(ref);

const METHOD_LABEL: Record<string, string> = {
  cash: "Efectivo",
  debit: "Débito",
  credit: "Crédito",
  transfer: "Transferencia",
  qr: "QR o billetera",
  account: "Cuenta corriente",
  store_credit: "Saldo a favor",
  directo: "Directo",
  ualabis: "Ualá Bis",
  sena: "Seña del turno",
  plataforma: "App de delivery",
  cheque: "Cheque",
  echeq: "E-cheq",
  cash_usd: "Efectivo en dólares",
  other: "Otro medio",
};

export function methodLabel(method: string): string {
  return METHOD_LABEL[method] ?? method;
}

const PROVIDER_LABEL: Record<string, string> = {
  mercadopago: "Mercado Pago",
  mercadopago_point: "Mercado Pago Point",
  payway: "Payway",
  payway_point: "Payway Point",
  nave: "Nave",
  nave_point: "Nave Point",
  getnet: "Getnet",
  getnet_point: "Getnet Point",
  fiserv: "Fiserv",
  fiserv_point: "Clover",
  gocuotas: "GO Cuotas",
  directo: "Directo",
  ualabis: "Ualá Bis",
  viumi: "Viumi",
  talo: "Talo",
  modo: "MODO",
  mobbex: "Mobbex",
  pagos360: "Pagos360",
};

export function providerName(key: string | null | undefined): string | null {
  if (!key) return null;
  return PROVIDER_LABEL[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

/** Medios que nunca pasan por un procesador: sólo se muestra lo del POS. */
export function isLocalOnly(method: string): boolean {
  return ["cash", "transfer", "account", "store_credit", "other", "cheque", "echeq", "cash_usd"].includes(method);
}

const vstr = (v: Record<string, unknown> | null, k: string): string | null => {
  const x = v?.[k];
  if (typeof x === "string" && x.trim()) return x.trim();
  if (typeof x === "number" && Number.isFinite(x)) return String(x);
  return null;
};

/** Proveedor del cobro: el del intent o, si es tarjeta en posnet, el adquirente del cupón. */
export function paymentProviderKey(p: SalePaymentRow, intent: PaymentIntentRow | null): string | null {
  if (intent) return intent.provider_key;
  if (p.method === "directo") return "directo";
  if (p.method === "ualabis") return "ualabis";
  return vstr(p.card_voucher, "adquirente");
}

export function voucherInfo(p: SalePaymentRow): {
  brand: string | null;
  last4: string | null;
  cuotas: number | null;
} {
  const cuotas = Number(vstr(p.card_voucher, "cuotas"));
  return {
    brand: vstr(p.card_voucher, "marca"),
    last4: vstr(p.card_voucher, "ultimos4"),
    cuotas: Number.isFinite(cuotas) && cuotas > 0 ? cuotas : null,
  };
}

/** Campos del cobro (cupón, comercio, terminal e ids), en orden de lectura. */
export function paymentFields(
  p: SalePaymentRow,
  intent: PaymentIntentRow | null,
  terminalName: string | null,
): DetailField[] {
  const out: DetailField[] = [];
  const add = (key: string, label: string, value: string | null, extra: Partial<DetailField> = {}) => {
    if (value) out.push({ key, label, value, ...extra });
  };
  const v = voucherInfo(p);
  add("cuotas", "Cuotas", v.cuotas ? (v.cuotas === 1 ? "1 pago" : `${v.cuotas} cuotas`) : null);
  add("autorizacion", "Autorización", vstr(p.card_voucher, "autorizacion"), { mono: true });
  add("cupon", "Cupón", vstr(p.card_voucher, "cupon"), { mono: true });
  add("lote", "Lote", vstr(p.card_voucher, "lote"), { mono: true });
  add("comercio", "N° de comercio", vstr(p.card_voucher, "comercio"), { mono: true });
  const acq = vstr(p.card_voucher, "adquirente");
  add("adquirente", "Adquirente", acq ? providerName(acq) : null);
  add("terminal", "Terminal", terminalName ?? (intent?.point_device_id ? intent.point_device_id : null));
  if (intent) {
    add("provider_payment", "Id de pago", intent.mp_payment_id, { mono: true, copy: true });
    add("provider_order", "Id de orden", intent.mp_order_id ?? intent.preference_id, { mono: true, copy: true });
    add("intent", "Id del cobro en NinjaPos", intent.id, { mono: true, copy: true });
  } else if (p.reference && p.method !== "account") {
    add("reference", "Referencia", p.reference, { mono: true, copy: true });
  }
  return out;
}

const INTENT_STATUS: Record<string, { label: string; tone: TimelineStep["tone"] }> = {
  pending: { label: "Esperando el pago", tone: "warning" },
  approved: { label: "Pago aprobado", tone: "success" },
  rejected: { label: "Pago rechazado", tone: "danger" },
  cancelled: { label: "Cobro cancelado", tone: "danger" },
  expired: { label: "Cobro vencido", tone: "danger" },
};

/**
 * Línea de tiempo del cobro: intent creado → resultado → venta registrada →
 * conciliado, más los hitos del procesador (aprobación, devoluciones,
 * acreditación) si se consultaron. Ordenada y sin repetidos.
 */
export function paymentTimeline(
  p: SalePaymentRow,
  intent: PaymentIntentRow | null,
  saleCreatedAt: string,
  processor: { at: string; label: string }[] = [],
): TimelineStep[] {
  const steps: TimelineStep[] = [];
  if (intent) {
    steps.push({ at: intent.created_at, label: "Cobro iniciado", tone: "neutral" });
    const st = INTENT_STATUS[intent.status];
    if (st && intent.status !== "pending") steps.push({ at: intent.updated_at, label: st.label, tone: st.tone });
  }
  steps.push({ at: saleCreatedAt, label: "Venta registrada", tone: "success" });
  for (const e of processor) {
    if (/creado|aprobado/i.test(e.label) && intent) continue; // ya lo cuenta el intent
    steps.push({
      at: e.at,
      label: `${e.label} (procesador)`,
      tone: /acreditado/i.test(e.label) ? "success" : /prevista/i.test(e.label) ? "warning" : "neutral",
    });
  }
  if (p.reconciled_at) steps.push({ at: p.reconciled_at, label: "Conciliado", tone: "success" });
  const seen = new Set<string>();
  return steps
    .filter((s) => s.at && !Number.isNaN(Date.parse(s.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .filter((s) => {
      const k = `${s.label}|${s.at}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

/** ¿Hay algo que todavía puede cambiar? (para sondear). */
export function needsLivePolling(intents: PaymentIntentRow[], released: (boolean | null)[]): boolean {
  return intents.some((i) => i.status === "pending") || released.some((r) => r === false);
}

export const PROVIDER_ERROR_COPY: Record<string, string> = {
  not_connected: "Conectá {p} para ver los datos de este cobro.",
  no_external_id: "{p} todavía no informó el id del pago.",
  not_found: "{p} no encontró este pago con la credencial actual.",
  provider_auth_failed: "{p} rechazó la credencial guardada.",
  provider_error: "{p} no respondió. Probá de nuevo en un rato.",
};

export function providerErrorMessage(code: string | null | undefined, provider: string | null): string {
  const p = provider ?? "El procesador";
  const fallback = provider ? "No pudimos consultar a {p}." : "No pudimos consultar al procesador.";
  return (PROVIDER_ERROR_COPY[code ?? ""] ?? fallback).replace("{p}", p);
}
