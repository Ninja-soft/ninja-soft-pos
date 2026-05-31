"use client";

import { useEffect, useRef } from "react";

// Captura de lectores de código de barras USB / Bluetooth (HID), que se
// comportan como teclado: emiten los caracteres muy rápido y cierran con Enter.
// Heurística: si los caracteres llegan con < gapMs entre sí y termina en Enter,
// se considera un escaneo (y NO tipeo humano). Funciona sin foco en un input.
export function useScanner(
  onScan: (code: string) => void,
  opts: { enabled?: boolean; gapMs?: number; minLength?: number } = {},
) {
  const { enabled = true, gapMs = 50, minLength = 3 } = opts;
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  useEffect(() => {
    if (!enabled) return;
    let buffer = "";
    let last = 0;

    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const now = performance.now();

      if (e.key === "Enter") {
        if (buffer.length >= minLength && now - last < gapMs * 4) {
          const code = buffer;
          buffer = "";
          onScanRef.current(code);
        } else {
          buffer = "";
        }
        return;
      }

      if (e.key.length === 1) {
        // Gap grande => empezó tipeo humano: reiniciamos el buffer.
        if (now - last > gapMs) buffer = "";
        buffer += e.key;
        last = now;
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, gapMs, minLength]);
}
