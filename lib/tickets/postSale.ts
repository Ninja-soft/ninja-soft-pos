// Ticket después de cobrar (ADR-072 · ADR-109). PURO: decide qué muestra la
// ventana del ticket según el comprobante fiscal de la venta y qué hace el
// auto-imprimir. No cambia la emisión ni el CAE: sólo lee `fiscal_documents`
// (cola, reintentos y contingencia CAEA los maneja el worker).

/** Lo que hace falta del comprobante fiscal (fila de `fiscal_documents`). */
export interface PostSaleDocLike {
  status: string;
  emission_type?: "CAE" | "CAEA" | null;
  cae?: string | null;
  cbte_nro?: number | null;
  last_error_code?: string | null;
  last_error_msg?: string | null;
  next_attempt_at?: string | null;
}

/** Después de esto sin CAE ni error, la autorización se considera lenta. */
export const AUTHORIZING_SLOW_MS = 20_000;

/** Errores del worker que no son una falla de ARCA (sólo se reprogramó). */
const SOFT_ERRORS = new Set(["presupuesto"]);

export type PostSalePhase =
  /** Todavía cargan la venta o sus comprobantes. */
  | { kind: "loading" }
  /** Se puede mostrar el comprobante: no fiscal, con CAE o con CAEA. */
  | { kind: "ready"; fiscal: "none" | "cae" | "caea" }
  /** En la cola o pidiendo el CAE, sin errores todavía. */
  | { kind: "authorizing"; slow: boolean }
  /** ARCA falló de forma transitoria: el worker reintenta solo. */
  | { kind: "retrying"; errorCode: string | null; errorMsg: string | null; nextAttemptAt: string | null }
  /** Rechazado por ARCA o falta algo del negocio: necesita una persona. */
  | { kind: "failed"; status: "rechazado" | "requiere_accion"; errorCode: string | null; errorMsg: string | null };

export function postSalePhase(input: {
  saleLoaded: boolean;
  /** La consulta de comprobantes terminó (con datos o con error). */
  docsSettled: boolean;
  doc: PostSaleDocLike | null | undefined;
  /** Tiempo desde que se abrió la ventana. */
  elapsedMs: number;
}): PostSalePhase {
  const { saleLoaded, docsSettled, doc, elapsedMs } = input;
  if (!saleLoaded || !docsSettled) return { kind: "loading" };
  // Sin comprobante fiscal (o anulado antes de facturar): ticket no fiscal.
  if (!doc || doc.status === "cancelado") return { kind: "ready", fiscal: "none" };

  if (doc.status === "aprobado" && doc.cae && doc.cbte_nro != null) {
    return { kind: "ready", fiscal: doc.emission_type === "CAEA" ? "caea" : "cae" };
  }
  if (doc.status === "rechazado" || doc.status === "requiere_accion") {
    return {
      kind: "failed",
      status: doc.status,
      errorCode: doc.last_error_code ?? null,
      errorMsg: doc.last_error_msg ?? null,
    };
  }
  const code = doc.last_error_code ?? null;
  if ((doc.status === "pendiente" || doc.status === "enviando") && code && !SOFT_ERRORS.has(code.toLowerCase())) {
    return {
      kind: "retrying",
      errorCode: code,
      errorMsg: doc.last_error_msg ?? null,
      nextAttemptAt: doc.next_attempt_at ?? null,
    };
  }
  return { kind: "authorizing", slow: elapsedMs >= AUTHORIZING_SLOW_MS };
}

/** ¿Se muestra el comprobante? Listo, o el usuario pidió el provisorio. */
export function previewVisible(phase: PostSalePhase, provisional: boolean): boolean {
  return phase.kind === "ready" || (provisional && phase.kind !== "loading");
}

export type SilentStep = "wait" | "print" | "show";

/**
 * Auto-imprimir sin ventana ("Imprimir ticket al cobrar"): espera mientras
 * carga o se autoriza; imprime cuando el comprobante está listo (con CAE si es
 * fiscal); abre la ventana si ARCA falla, tarda demasiado o la impresión falló.
 */
export function silentStep(phase: PostSalePhase, opts: { printFailed?: boolean } = {}): SilentStep {
  if (opts.printFailed) return "show";
  if (phase.kind === "loading") return "wait";
  if (phase.kind === "authorizing") return phase.slow ? "show" : "wait";
  if (phase.kind === "ready") return "print";
  return "show";
}
