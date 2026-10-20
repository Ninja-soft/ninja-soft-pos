// Precalentado de las Edge de cobro (ADR-048, "QR más rápido"). Cuando se abre
// la hoja de cobro con medios QR / link, se manda un OPTIONS (el preflight CORS
// que todas responden con "ok", sin tocar la base) para que la instancia esté
// caliente cuando el cajero toque "Generar QR". Una vez cada 4 minutos por
// función; nunca falla ni bloquea.

const WARM_EVERY_MS = 4 * 60_000;
const lastWarm = new Map<string, number>();

/** Edge que crea el cobro de cada proveedor QR / link. */
export const QR_EDGE_BY_PROVIDER: Record<string, string[]> = {
  mercadopago: ["mp_qr", "mp_create_qr"],
  mobbex: ["mobbex_create_qr"],
  modo: ["modo_create_qr"],
  pagos360: ["pagos360"],
  payway: ["payway"],
  getnet: ["getnet"],
  nave: ["nave"],
  gocuotas: ["gocuotas"],
  directo: ["directo"],
  ualabis: ["ualabis"],
  talo: ["talo"],
};

export function edgesToWarm(providers: (string | null | undefined)[], now = Date.now()): string[] {
  const out = new Set<string>();
  for (const p of providers) {
    for (const fn of QR_EDGE_BY_PROVIDER[p ?? ""] ?? []) {
      if (now - (lastWarm.get(fn) ?? 0) >= WARM_EVERY_MS) out.add(fn);
    }
  }
  return [...out];
}

export function warmEdgeFunctions(providers: (string | null | undefined)[]): void {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base || typeof fetch !== "function") return;
  const now = Date.now();
  for (const fn of edgesToWarm(providers, now)) {
    lastWarm.set(fn, now);
    void fetch(`${base}/functions/v1/${fn}`, { method: "OPTIONS", keepalive: true }).catch(() => {});
  }
}
