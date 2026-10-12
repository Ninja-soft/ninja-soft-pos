// Máquina de estados del cobro con terminal integrada (ADR-053).
//
//   idle → connecting → waiting → approved
//                              ↘ declined   (la terminal respondió que no)
//                              ↘ timeout    (sin respuesta: estado INCIERTO)
//                              ↘ cancelled  (el cajero canceló antes de la respuesta)
//                              ↘ error      (no se pudo hablar con la terminal)
//   declined / timeout / cancelled / error → (retry) → connecting
//
// `timeout` es incierto a propósito: la terminal pudo haber cobrado y no
// llegó la respuesta. La UI lo dice y ofrece revisar la terminal o cargar el
// cupón a mano antes de reintentar (reintentar puede cobrar dos veces).

import { normalizeResult, declineMessage } from "./normalize";
import {
  TerminalError,
  isTerminalError,
  type SaleRequest,
  type TerminalAdapter,
  type TerminalResult,
} from "./types";

export type ChargePhase = "idle" | "connecting" | "waiting" | "approved" | "declined" | "timeout" | "cancelled" | "error";

export interface ChargeState {
  phase: ChargePhase;
  attempt: number;
  /** Leyenda intermedia de la terminal ("Pase la tarjeta"). */
  prompt: string | null;
  result: TerminalResult | null;
  /** Mensaje para el cajero en rechazo / error / timeout. */
  message: string | null;
  errorCode: string | null;
}

export type ChargeEvent =
  | { type: "start" }
  | { type: "connected" }
  | { type: "prompt"; message: string }
  | { type: "result"; result: TerminalResult }
  | { type: "timeout" }
  | { type: "cancel" }
  | { type: "error"; code: string; message: string }
  | { type: "retry" }
  | { type: "reset" };

export const INITIAL_CHARGE: ChargeState = {
  phase: "idle",
  attempt: 0,
  prompt: null,
  result: null,
  message: null,
  errorCode: null,
};

const FINAL: ChargePhase[] = ["approved", "declined", "timeout", "cancelled", "error"];
export const isFinal = (p: ChargePhase) => FINAL.includes(p);
export const isBusy = (p: ChargePhase) => p === "connecting" || p === "waiting";

export function chargeReducer(s: ChargeState, e: ChargeEvent): ChargeState {
  switch (e.type) {
    case "start":
      if (s.phase !== "idle") return s;
      return { ...INITIAL_CHARGE, phase: "connecting", attempt: 1 };
    case "retry":
      // Nunca se reintenta un cobro aprobado.
      if (!isFinal(s.phase) || s.phase === "approved") return s;
      return { ...INITIAL_CHARGE, phase: "connecting", attempt: s.attempt + 1 };
    case "connected":
      return s.phase === "connecting" ? { ...s, phase: "waiting" } : s;
    case "prompt":
      return isBusy(s.phase) ? { ...s, prompt: e.message } : s;
    case "result": {
      // Una respuesta que llega tarde (después de cancelar o de timeout) se
      // respeta si es una aprobación: la plata ya se cobró.
      if (s.phase === "approved") return s;
      if (!isBusy(s.phase) && !(e.result.approved && (s.phase === "cancelled" || s.phase === "timeout"))) return s;
      const r = normalizeResult(e.result);
      return r.approved
        ? { ...s, phase: "approved", prompt: null, result: r, message: null, errorCode: null }
        : { ...s, phase: "declined", prompt: null, result: r, message: declineMessage(r), errorCode: r.responseCode };
    }
    case "timeout":
      return isBusy(s.phase)
        ? {
            ...s,
            phase: "timeout",
            prompt: null,
            message: "La terminal no respondió. Revisá en la terminal si el cobro salió antes de reintentar.",
            errorCode: "timeout",
          }
        : s;
    case "cancel":
      return isBusy(s.phase)
        ? { ...s, phase: "cancelled", prompt: null, message: "Cobro cancelado", errorCode: "cancelled" }
        : s;
    case "error":
      return isBusy(s.phase)
        ? { ...s, phase: "error", prompt: null, message: e.message, errorCode: e.code }
        : s;
    case "reset":
      return INITIAL_CHARGE;
  }
}

export interface RunSaleOptions {
  /** Tiempo máximo esperando la respuesta (incluye que el cliente pase la tarjeta). */
  timeoutMs?: number;
  signal?: AbortSignal;
  dispatch: (e: ChargeEvent) => void;
}

/**
 * Corre una venta contra el adaptador y despacha los eventos de la máquina.
 * Resuelve con el resultado (aprobado o rechazado) o null si terminó en
 * timeout / cancelación / error (el estado ya quedó despachado).
 */
export async function runSale(adapter: TerminalAdapter, req: SaleRequest, o: RunSaleOptions): Promise<TerminalResult | null> {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(new TerminalError("cancelled"));
  if (o.signal?.aborted) onAbort();
  o.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(new TerminalError("timeout")), o.timeoutMs ?? 120_000);
  try {
    await adapter.connect({ signal: ctrl.signal });
    o.dispatch({ type: "connected" });
    const r = await adapter.sale(req, {
      signal: ctrl.signal,
      onEvent: (ev) => ev.type === "prompt" && o.dispatch({ type: "prompt", message: ev.message }),
    });
    o.dispatch({ type: "result", result: r });
    return r;
  } catch (e) {
    const reason = ctrl.signal.aborted ? ctrl.signal.reason : null;
    if (isTerminalError(reason, "timeout") || isTerminalError(e, "timeout")) o.dispatch({ type: "timeout" });
    else if (isTerminalError(reason, "cancelled") || isTerminalError(e, "cancelled")) o.dispatch({ type: "cancel" });
    else
      o.dispatch({
        type: "error",
        code: isTerminalError(e) ? e.code : "unknown",
        message: e instanceof Error ? e.message : "No se pudo hablar con la terminal",
      });
    return null;
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener("abort", onAbort);
  }
}

/** Texto del estado para la pantalla del cobro. */
export function phaseLabel(s: ChargeState): string {
  switch (s.phase) {
    case "idle":
      return "Listo para enviar";
    case "connecting":
      return "Conectando con la terminal";
    case "waiting":
      return s.prompt ?? "Esperando la tarjeta en la terminal";
    case "approved":
      return "Aprobado";
    case "declined":
      return s.message ?? "Rechazada";
    case "timeout":
      return "Sin respuesta de la terminal";
    case "cancelled":
      return "Cobro cancelado";
    case "error":
      return s.message ?? "No se pudo hablar con la terminal";
  }
}
