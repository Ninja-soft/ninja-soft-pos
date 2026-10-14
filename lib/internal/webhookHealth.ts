// Salud de webhooks (ADR-070): normaliza el resultado de la RPC
// webhook_health para el panel interno. Puro, sin Supabase (testeable).

export const WEBHOOK_PROVIDERS = [
  { key: "mercadopago", label: "Mercado Pago (link)", fn: "mp_webhook" },
  { key: "mercadopago_orders", label: "Mercado Pago (QR y Point)", fn: "mp_orders_webhook" },
  // Suscripciones que cobra NinjaSoft (F20-0b): incluye firmas inválidas.
  { key: "mercadopago_billing", label: "Mercado Pago (suscripciones NinjaSoft)", fn: "mp_billing_webhook" },
  { key: "getnet", label: "Getnet", fn: "getnet_webhook" },
  { key: "payway", label: "Payway", fn: "payway_webhook" },
  { key: "nave", label: "Nave", fn: "nave_webhook" },
  { key: "gocuotas", label: "GO Cuotas", fn: "gocuotas_webhook" },
  { key: "directo", label: "Directo", fn: "directo_webhook" },
  { key: "clover", label: "Fiserv / Clover", fn: "clover_webhook" },
  { key: "modo", label: "MODO", fn: "modo_webhook" },
  { key: "mobbex", label: "Mobbex", fn: "mobbex_webhook" },
] as const;

export type WebhookHealthLevel = "ok" | "warn" | "error" | "idle";

export interface WebhookHealthRow {
  provider: string;
  label: string;
  functionName: string;
  total: number;
  ok: number;
  errors: number;
  ignored: number;
  lastEventAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  avgDurationMs: number | null;
  level: WebhookHealthLevel;
}

type RawRow = {
  provider?: unknown;
  total?: unknown;
  ok_count?: unknown;
  error_count?: unknown;
  ignored_count?: unknown;
  last_event_at?: unknown;
  last_error_at?: unknown;
  last_error?: unknown;
  last_error_function?: unknown;
  avg_duration_ms?: unknown;
};

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** error: más de la mitad falló o el último evento fue un error; warn: algún error. */
export function healthLevel(r: {
  total: number;
  errors: number;
  lastEventAt: string | null;
  lastErrorAt: string | null;
}): WebhookHealthLevel {
  if (r.total === 0) return "idle";
  if (r.errors === 0) return "ok";
  if (r.errors * 2 > r.total) return "error";
  if (r.lastErrorAt && r.lastEventAt && r.lastErrorAt >= r.lastEventAt) return "error";
  return "warn";
}

const LEVEL_ORDER: Record<WebhookHealthLevel, number> = { error: 0, warn: 1, ok: 2, idle: 3 };

/**
 * Une el resumen con la lista de proveedores conocidos (los que no tuvieron
 * eventos aparecen "sin eventos") y ordena: primero lo que falla.
 */
export function buildWebhookHealth(raw: unknown): WebhookHealthRow[] {
  const rows = (Array.isArray(raw) ? raw : []) as RawRow[];
  const byKey = new Map<string, RawRow>();
  for (const r of rows) {
    const k = str(r.provider);
    if (k) byKey.set(k, r);
  }
  const known = new Set<string>(WEBHOOK_PROVIDERS.map((p) => p.key));
  const list: { key: string; label: string; fn: string }[] = [
    ...WEBHOOK_PROVIDERS,
    ...[...byKey.keys()].filter((k) => !known.has(k)).map((k) => ({ key: k, label: k, fn: "" })),
  ];
  const out = list.map((p) => {
    const r = byKey.get(p.key) ?? {};
    const base = {
      provider: p.key,
      label: p.label,
      functionName: str(r.last_error_function) ?? p.fn,
      total: num(r.total),
      ok: num(r.ok_count),
      errors: num(r.error_count),
      ignored: num(r.ignored_count),
      lastEventAt: str(r.last_event_at),
      lastErrorAt: str(r.last_error_at),
      lastError: str(r.last_error),
      avgDurationMs: r.avg_duration_ms == null ? null : num(r.avg_duration_ms),
    };
    return { ...base, level: healthLevel(base) };
  });
  return out.sort(
    (a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || a.label.localeCompare(b.label, "es"),
  );
}
