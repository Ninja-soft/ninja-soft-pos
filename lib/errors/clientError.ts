// Errores del front (F1.5 · ADR-098): mensaje humano para las pantallas de
// error y reporte liviano a /api/client-error (queda en los logs de Vercel como
// `event: "client_error"`). Sin dependencias: Sentry sigue en la Fase 4.

export type ClientErrorKind = "update" | "network" | "unknown";

export interface HumanError {
  kind: ClientErrorKind;
  title: string;
  description: string;
}

const UPDATE_RE = /ChunkLoadError|Loading (CSS )?chunk [\w-]+ failed|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i;
const NETWORK_RE = /Failed to fetch|NetworkError|Load failed|Network request failed|ERR_INTERNET_DISCONNECTED|fetch failed/i;

export function classifyError(error: unknown): ClientErrorKind {
  const e = error as { name?: string; message?: string } | null;
  const text = `${e?.name ?? ""} ${e?.message ?? ""}`;
  if (UPDATE_RE.test(text)) return "update";
  if (NETWORK_RE.test(text)) return "network";
  return "unknown";
}

export function humanError(error: unknown): HumanError {
  const kind = classifyError(error);
  if (kind === "update") {
    return {
      kind,
      title: "Hay una versión nueva de NinjaSoft",
      description: "Recargá la página para seguir. Lo que ya está guardado no se pierde.",
    };
  }
  if (kind === "network") {
    return {
      kind,
      title: "No hay conexión con NinjaSoft",
      description: "Revisá internet y probá de nuevo. Si estabas cobrando, fijate en Ventas si la venta entró antes de repetirla.",
    };
  }
  return {
    kind,
    title: "Algo salió mal en esta pantalla",
    description: "Ya nos llegó el aviso. Probá de nuevo; si sigue pasando, escribinos a soporte con el código de abajo.",
  };
}

// ---------------------------------------------------------------------------
// Reporte
// ---------------------------------------------------------------------------
export const CLIENT_ERROR_ENDPOINT = "/api/client-error";
export const MAX_REPORT_BYTES = 8 * 1024;

export interface ClientErrorReport {
  boundary: string;
  kind: ClientErrorKind;
  name: string;
  message: string;
  digest: string | null;
  path: string;
  stack: string | null;
  release: string | null;
}

/** Saca de un texto lo que no debe ir a los logs: emails, JWT, tokens largos y CUIT/DNI. */
export function redact(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[jwt]")
    .replace(/\b(?:sbp|sk|pk|rk)_[A-Za-z0-9_-]{16,}\b/g, "[token]")
    .replace(/\b\d{2}-?\d{8}-?\d\b/g, "[cuit]")
    .replace(/\b\d{7,8}\b/g, "[doc]");
}

/** Sólo el pathname: la query puede traer token_hash, códigos o intents. */
export function safePath(href: string): string {
  try {
    return new URL(href, "https://x.invalid").pathname.slice(0, 200);
  } catch {
    return "";
  }
}

export function buildReport(input: {
  error: unknown;
  boundary: string;
  href: string;
  release?: string | null;
}): ClientErrorReport {
  const e = (input.error ?? {}) as { name?: unknown; message?: unknown; stack?: unknown; digest?: unknown };
  const str = (v: unknown, max: number) => (typeof v === "string" ? redact(v).slice(0, max) : "");
  return {
    boundary: input.boundary.slice(0, 40),
    kind: classifyError(input.error),
    name: str(e.name, 80) || "Error",
    message: str(e.message, 500),
    digest: typeof e.digest === "string" ? e.digest.slice(0, 64) : null,
    path: safePath(input.href),
    stack: str(e.stack, 2000) || null,
    release: input.release ? input.release.slice(0, 40) : null,
  };
}

// Un mismo error se reporta una vez por carga de página, y como mucho 5 en total
// (un render que falla en loop no inunda los logs).
const sent = new Set<string>();
const MAX_PER_PAGE = 5;

export function reportClientError(report: ClientErrorReport): boolean {
  if (typeof window === "undefined") return false;
  const key = `${report.boundary}|${report.name}|${report.message}|${report.path}`;
  if (sent.has(key) || sent.size >= MAX_PER_PAGE) return false;
  sent.add(key);
  let body = JSON.stringify(report);
  if (body.length > MAX_REPORT_BYTES) body = JSON.stringify({ ...report, stack: null });
  try {
    const blob = new Blob([body], { type: "application/json" });
    if (typeof navigator !== "undefined" && navigator.sendBeacon?.(CLIENT_ERROR_ENDPOINT, blob)) return true;
    void fetch(CLIENT_ERROR_ENDPOINT, {
      method: "POST",
      body,
      keepalive: true,
      headers: { "Content-Type": "application/json" },
    }).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

/** Para tests. */
export function __resetReportedErrors() {
  sent.clear();
}
