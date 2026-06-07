"use client";

import { useEffect, useRef } from "react";

// Información de un escaneo completo, expuesta por onRaw para diagnóstico.
export interface ScanInfo {
  raw: string; // lo capturado tal cual (antes de limpiar prefijo/sufijo)
  code: string; // el código ya limpio (prefijo/sufijo removidos)
  length: number; // largo del código limpio
  durationMs: number; // tiempo entre el primer y último caracter
  avgGapMs: number; // gap promedio entre caracteres
  format: string; // formato inferido (EAN-13, etc.)
  duplicate: boolean; // true si se ignoró por anti-duplicado
}

export interface UseScannerOpts {
  enabled?: boolean;
  gapMs?: number;
  minLength?: number;
  prefix?: string;
  suffix?: string;
  beep?: boolean;
  dupMs?: number;
  onRaw?: (info: ScanInfo) => void;
}

// Infiere el formato del código a partir de su contenido. Heurística simple,
// suficiente para el diagnóstico del lector.
export function inferFormat(code: string): string {
  if (/^https?:\/\//i.test(code)) return "URL/QR";
  if (/^\d+$/.test(code)) {
    if (code.length === 13) return "EAN-13";
    if (code.length === 8) return "EAN-8";
    if (code.length === 12) return "UPC-A";
    return "Numérico";
  }
  return "Alfanumérico (Code 39/128)";
}

// AudioContext perezoso compartido para el beep de feedback.
let audioCtx: AudioContext | null = null;
function beepNow() {
  try {
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return;
    if (!audioCtx) audioCtx = new Ctor();
    if (audioCtx.state === "suspended") void audioCtx.resume();
    const ctx = audioCtx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.value = 0.05;
    osc.connect(gain);
    gain.connect(ctx.destination);
    const now = ctx.currentTime;
    osc.start(now);
    osc.stop(now + 0.08);
  } catch {
    // Audio bloqueado o no disponible: silencioso.
  }
}

// Captura de lectores de código de barras USB / Bluetooth (HID), que se
// comportan como teclado: emiten los caracteres muy rápido y cierran con Enter.
// Heurística: si los caracteres llegan con < gapMs entre sí y termina en Enter,
// se considera un escaneo (y NO tipeo humano). Funciona sin foco en un input.
export function useScanner(
  onScan: (code: string) => void,
  opts: UseScannerOpts = {},
) {
  const {
    enabled = true,
    gapMs = 50,
    minLength = 3,
    prefix = "",
    suffix = "",
    beep = false,
    dupMs = 1500,
    onRaw,
  } = opts;

  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;
  const onRawRef = useRef(onRaw);
  onRawRef.current = onRaw;

  useEffect(() => {
    if (!enabled) return;
    let buffer = "";
    let last = 0;
    let firstTs = 0;
    let count = 0; // caracteres acumulados
    let lastCode = "";
    let lastAccepted = 0;

    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const now = performance.now();

      if (e.key === "Enter") {
        if (buffer.length >= minLength && now - last < gapMs * 4) {
          const raw = buffer;
          buffer = "";

          // Limpieza de prefijo/sufijo configurados por el tenant.
          let code = raw;
          if (prefix && code.startsWith(prefix)) code = code.slice(prefix.length);
          if (suffix && code.endsWith(suffix))
            code = code.slice(0, code.length - suffix.length);

          const durationMs = count > 0 ? now - firstTs : 0;
          const avgGapMs = count > 1 ? durationMs / (count - 1) : 0;

          // Anti-duplicado: mismo código dentro de la ventana → ignorado.
          const duplicate =
            dupMs > 0 && code === lastCode && now - lastAccepted < dupMs;

          const info: ScanInfo = {
            raw,
            code,
            length: code.length,
            durationMs,
            avgGapMs,
            format: inferFormat(code),
            duplicate,
          };

          if (onRawRef.current) onRawRef.current(info);

          if (!duplicate) {
            lastCode = code;
            lastAccepted = now;
            if (beep) beepNow();
            onScanRef.current(code);
          }
        } else {
          buffer = "";
        }
        count = 0;
        return;
      }

      if (e.key.length === 1) {
        // Gap grande => empezó tipeo humano: reiniciamos el buffer.
        if (now - last > gapMs) {
          buffer = "";
          count = 0;
        }
        if (count === 0) firstTs = now;
        buffer += e.key;
        count += 1;
        last = now;
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, gapMs, minLength, prefix, suffix, beep, dupMs]);
}
