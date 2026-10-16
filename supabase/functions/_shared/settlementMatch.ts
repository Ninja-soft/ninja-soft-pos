// =============================================================================
// _shared/settlementMatch.ts: motor de conciliación de procesadores (ADR-061).
//
// Cruza líneas de liquidación (settlement_lines: API de Mercado Pago, archivo
// de Payway o CSV de cualquier adquirente) con los cobros del POS.
//
// Orden de pasadas (la primera que encuentra pareja gana):
//   1. provider_id: id de pago del procesador = intent.mp_payment_id o
//      payments.reference; id de orden = intent.mp_order_id / preference_id;
//      external_reference = id del intent (MP Orders y Payway lo guardan así).
//   2. voucher: n° de comercio (si los dos lo tienen) + lote + cupón.
//   3. authorization: autorización + últimos 4 (si los dos los tienen) con la
//      fecha dentro de la tolerancia.
//   4. amount_date: monto y día, sólo si la pareja es única de los dos lados
//      y no contradice últimos 4 ni comercio (coincidencia débil, se avisa).
//
// Montos efectivos: línea = bruto - devuelto; POS = monto del cobro (0 si la
// venta está anulada). Distinto (más allá de la tolerancia) → amount_diff.
// Un intent aprobado sin venta que coincide queda como missing_in_pos con
// intent_id, para "Crear venta" desde la conciliación.
//
// Líneas con match_method = 'manual' o match_status = 'ignored' no se tocan.
//
// Archivo PURO y SIN imports (Deno, Vitest y front).
// =============================================================================

export type MatchStatus = "matched" | "amount_diff" | "missing_in_pos" | "ignored";
export type MatchMethod = "provider_id" | "voucher" | "authorization" | "amount_date" | "manual";

export interface MatchLine {
  id: string;
  provider_key: string;
  external_id: string | null;
  order_id: string | null;
  external_reference: string | null;
  operation_at: string;
  gross: number;
  refunded?: number | null;
  status?: string | null;
  lote?: string | null;
  cupon?: string | null;
  autorizacion?: string | null;
  comercio?: string | null;
  last4?: string | null;
  /** Estado guardado (para respetar manual / ignorado). */
  match_status?: MatchStatus | null;
  match_method?: MatchMethod | null;
  payment_id?: string | null;
  intent_id?: string | null;
  diff_amount?: number | null;
}

export interface PosCandidate {
  /** null = intent aprobado sin venta (cobro sin venta del lado del POS). */
  payment_id: string | null;
  sale_id: string | null;
  intent_id: string | null;
  provider_key: string | null;
  amount: number;
  created_at: string;
  provider_payment_id?: string | null;
  provider_order_id?: string | null;
  lote?: string | null;
  cupon?: string | null;
  autorizacion?: string | null;
  comercio?: string | null;
  last4?: string | null;
  sale_voided?: boolean;
}

export interface MatchOptions {
  /** Diferencia de monto tolerada (pesos). */
  amountTolerance?: number;
  /** Días de tolerancia de fecha para autorización y monto. */
  dateToleranceDays?: number;
  /** Zona horaria para el "mismo día" (minutos respecto de UTC; AR = -180). */
  tzOffsetMinutes?: number;
}

export interface LineMatch {
  line_id: string;
  match_status: MatchStatus;
  match_method: MatchMethod | null;
  payment_id: string | null;
  intent_id: string | null;
  sale_id: string | null;
  diff_amount: number;
}

export interface MatchResult {
  lines: LineMatch[];
  /** Cobros del POS sin línea de liquidación ("Venta sin cobro"). */
  unmatchedPayments: PosCandidate[];
}

const DAY_MS = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Normaliza lote / cupón / comercio / autorización para comparar. */
export function normRef(v: string | null | undefined): string | null {
  if (v == null) return null;
  const s = String(v).trim().toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (!s) return null;
  // Sin ceros a la izquierda en los numéricos (00123 = 123).
  return /^\d+$/.test(s) ? s.replace(/^0+(?=\d)/, "") : s;
}

const norm4 = (v: string | null | undefined): string | null => {
  const s = (v ?? "").replace(/\D/g, "");
  return s.length >= 4 ? s.slice(-4) : null;
};

export function dayKey(iso: string, tzOffsetMinutes = -180): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return new Date(t + tzOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

export function lineEffectiveAmount(l: Pick<MatchLine, "gross" | "refunded">): number {
  return round2(Number(l.gross) - Number(l.refunded ?? 0));
}

export function posEffectiveAmount(c: Pick<PosCandidate, "amount" | "sale_voided">): number {
  return c.sale_voided ? 0 : round2(Number(c.amount));
}

const conflict = (a: string | null, b: string | null) => a != null && b != null && a !== b;

export function matchSettlement(
  lines: MatchLine[],
  candidates: PosCandidate[],
  opts: MatchOptions = {},
): MatchResult {
  const tol = opts.amountTolerance ?? 0.01;
  const dateTol = (opts.dateToleranceDays ?? 1) * DAY_MS;
  const tz = opts.tzOffsetMinutes ?? -180;

  const used = new Set<PosCandidate>();
  const out = new Map<string, LineMatch>();
  const keyOf = (c: PosCandidate) => c.payment_id ?? `intent:${c.intent_id ?? ""}`;
  const byKey = new Map<string, PosCandidate>();
  for (const c of candidates) byKey.set(keyOf(c), c);

  // Líneas fijadas por el usuario: se respetan y consumen su cobro.
  const pending: MatchLine[] = [];
  for (const l of lines) {
    if (l.match_status === "ignored" || l.match_method === "manual") {
      const c = l.payment_id ? byKey.get(l.payment_id) : l.intent_id ? byKey.get(`intent:${l.intent_id}`) : undefined;
      if (c) used.add(c);
      out.set(l.id, {
        line_id: l.id,
        match_status: l.match_status ?? "matched",
        match_method: l.match_method ?? null,
        payment_id: l.payment_id ?? null,
        intent_id: l.intent_id ?? null,
        sale_id: c?.sale_id ?? null,
        diff_amount: c ? round2(lineEffectiveAmount(l) - posEffectiveAmount(c)) : 0,
      });
      continue;
    }
    pending.push(l);
  }

  // Un cobro con venta gana sobre el intent huérfano del mismo pago.
  const prefer = (list: PosCandidate[]) =>
    list.filter((c) => !used.has(c)).sort((a, b) => Number(b.payment_id != null) - Number(a.payment_id != null))[0];

  const assign = (l: MatchLine, c: PosCandidate, method: MatchMethod) => {
    used.add(c);
    if (c.payment_id == null) {
      out.set(l.id, {
        line_id: l.id,
        match_status: "missing_in_pos",
        match_method: method,
        payment_id: null,
        intent_id: c.intent_id,
        sale_id: null,
        diff_amount: lineEffectiveAmount(l),
      });
      return;
    }
    const diff = round2(lineEffectiveAmount(l) - posEffectiveAmount(c));
    out.set(l.id, {
      line_id: l.id,
      match_status: Math.abs(diff) > tol ? "amount_diff" : "matched",
      match_method: method,
      payment_id: c.payment_id,
      intent_id: c.intent_id,
      sale_id: c.sale_id,
      diff_amount: diff,
    });
  };

  // Pasada 1: ids del procesador.
  const byPayId = new Map<string, PosCandidate[]>();
  const byOrderId = new Map<string, PosCandidate[]>();
  const byIntent = new Map<string, PosCandidate[]>();
  const push = (m: Map<string, PosCandidate[]>, k: string | null | undefined, c: PosCandidate) => {
    if (!k) return;
    const key = String(k).trim();
    if (!key) return;
    m.set(key, [...(m.get(key) ?? []), c]);
  };
  for (const c of candidates) {
    push(byPayId, c.provider_payment_id, c);
    push(byOrderId, c.provider_order_id, c);
    push(byIntent, c.intent_id, c);
  }
  let rest: MatchLine[] = [];
  for (const l of pending) {
    const hit =
      (l.external_id && prefer(byPayId.get(l.external_id) ?? [])) ||
      (l.order_id && prefer(byOrderId.get(l.order_id) ?? [])) ||
      (l.external_reference && prefer(byIntent.get(l.external_reference) ?? []));
    if (hit) assign(l, hit, "provider_id");
    else rest.push(l);
  }

  // Pasada 2: comercio + lote + cupón.
  const free = () => candidates.filter((c) => !used.has(c) && c.payment_id != null);
  let next: MatchLine[] = [];
  for (const l of rest) {
    const lote = normRef(l.lote);
    const cupon = normRef(l.cupon);
    if (!lote || !cupon) {
      next.push(l);
      continue;
    }
    const com = normRef(l.comercio);
    const hits = free().filter(
      (c) => normRef(c.lote) === lote && normRef(c.cupon) === cupon && !conflict(com, normRef(c.comercio)),
    );
    if (hits.length === 1) assign(l, hits[0]!, "voucher");
    else next.push(l);
  }
  rest = next;

  // Pasada 3: autorización (+ últimos 4) con fecha cercana.
  next = [];
  for (const l of rest) {
    const auth = normRef(l.autorizacion);
    if (!auth) {
      next.push(l);
      continue;
    }
    const t = Date.parse(l.operation_at);
    const l4 = norm4(l.last4);
    const hits = free().filter(
      (c) =>
        normRef(c.autorizacion) === auth &&
        !conflict(l4, norm4(c.last4)) &&
        Math.abs(Date.parse(c.created_at) - t) <= dateTol,
    );
    if (hits.length === 1) assign(l, hits[0]!, "authorization");
    else next.push(l);
  }
  rest = next;

  // Pasada 4: monto + día, pareja única de los dos lados. Sólo cobros del POS
  // sin ids del procesador (un cobro con id ya tuvo su oportunidad exacta).
  const weak = (c: PosCandidate) => !c.provider_payment_id && !c.provider_order_id;
  const pairs = new Map<MatchLine, PosCandidate[]>();
  for (const l of rest) {
    const amt = lineEffectiveAmount(l);
    const day = dayKey(l.operation_at, tz);
    const l4 = norm4(l.last4);
    const com = normRef(l.comercio);
    pairs.set(
      l,
      free().filter(
        (c) =>
          weak(c) &&
          Math.abs(posEffectiveAmount(c) - amt) <= tol &&
          dayKey(c.created_at, tz) === day &&
          !conflict(l4, norm4(c.last4)) &&
          !conflict(com, normRef(c.comercio)),
      ),
    );
  }
  const claims = new Map<PosCandidate, number>();
  for (const list of pairs.values()) for (const c of list) claims.set(c, (claims.get(c) ?? 0) + 1);
  for (const [l, list] of pairs) {
    const c = list.length === 1 ? list[0]! : null;
    if (c && claims.get(c) === 1 && !used.has(c)) assign(l, c, "amount_date");
    else
      out.set(l.id, {
        line_id: l.id,
        match_status: "missing_in_pos",
        match_method: null,
        payment_id: null,
        intent_id: null,
        sale_id: null,
        diff_amount: lineEffectiveAmount(l),
      });
  }

  return {
    lines: lines.map((l) => out.get(l.id)!).filter(Boolean),
    unmatchedPayments: candidates.filter((c) => c.payment_id != null && !used.has(c)),
  };
}

/** ¿Cambió el resultado respecto de lo guardado? (para escribir sólo lo necesario). */
export function matchChanged(prev: MatchLine, m: LineMatch): boolean {
  return (
    (prev.match_status ?? null) !== m.match_status ||
    (prev.match_method ?? null) !== m.match_method ||
    (prev.payment_id ?? null) !== m.payment_id ||
    (prev.intent_id ?? null) !== m.intent_id ||
    Math.abs(Number(prev.diff_amount ?? 0) - m.diff_amount) > 0.004
  );
}

// ── Candidatos por archivo (T21, ADR-162) ───────────────────────────────────

export interface FileCandidateRule {
  /** Medios del POS que puede liquidar el proveedor. */
  methods: string[];
  /** Adquirente que tiene que decir el cupón (null = cualquiera o ninguno). */
  adquirente: string | null;
  /** true: el cupón TIENE que decir ese adquirente (QR interoperable de MODO). */
  strict: boolean;
}

/**
 * Qué cobros del POS puede liquidar un proveedor que llega por archivo. Las
 * tarjetas (Payway, Getnet, Fiserv, Nave, otro adquirente) cruzan sólo con
 * débito y crédito cuyo cupón no diga otro adquirente; Ualá Bis, MODO,
 * Transferencias y Directo cruzan sólo con su propio medio, así una línea de
 * Ualá nunca se empareja con un cobro con tarjeta por monto y día.
 * null = el proveedor no concilia por archivo contra cobros sueltos
 * (Mercado Pago por API, GO Cuotas por intents).
 */
export function fileCandidateRule(provider: string): FileCandidateRule | null {
  switch (provider) {
    case "mercadopago":
    case "gocuotas":
      return null;
    case "ualabis":
      return { methods: ["ualabis"], adquirente: null, strict: false };
    case "modo":
      return { methods: ["qr", "debit", "credit"], adquirente: "modo", strict: true };
    case "transfer":
      return { methods: ["transfer"], adquirente: null, strict: false };
    case "directo":
      return { methods: ["directo"], adquirente: null, strict: false };
    case "otro":
      return { methods: ["debit", "credit"], adquirente: null, strict: false };
    default:
      return { methods: ["debit", "credit"], adquirente: provider, strict: false };
  }
}

/** ¿Este cobro del POS puede ser de ese proveedor? (medio y adquirente del cupón). */
export function fileCandidateAllowed(rule: FileCandidateRule, method: string, adquirente: string | null): boolean {
  if (!rule.methods.includes(method)) return false;
  const acq = adquirente ? adquirente.trim().toLowerCase() : null;
  if (rule.strict) return acq === rule.adquirente;
  if (rule.adquirente && acq && acq !== rule.adquirente) return false;
  return true;
}
