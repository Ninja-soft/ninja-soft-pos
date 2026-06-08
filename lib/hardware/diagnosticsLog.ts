"use client";

import { useCallback, useEffect, useState } from "react";

// =============================================================================
// Centro de diagnóstico de hardware (F10 · H26) — log local de pruebas
// -----------------------------------------------------------------------------
// Registra en localStorage el resultado de cada prueba guiada de hardware (qué
// se probó, cuándo, resultado y detalle/error). Es 100% local al equipo: sirve
// para que el dueño/soporte vea el historial y lo incluya en el export de
// diagnóstico. NO viaja a Supabase ni lleva datos sensibles.
// =============================================================================

const STORAGE_KEY = "ninja-hardware-diagnostics-log";
const MAX_ENTRIES = 100;

// Periférico/área que se probó.
export type HardwareArea =
  | "printer"
  | "scanner"
  | "customer_display"
  | "cash_drawer"
  | "scale"
  | "environment";

export type DiagResult = "ok" | "warn" | "error" | "info";

export interface DiagEntry {
  id: string;
  area: HardwareArea;
  // Acción concreta (ej. "Imprimir ticket de prueba").
  action: string;
  result: DiagResult;
  // Detalle legible (qué pasó / por qué). Nunca datos sensibles.
  detail: string;
  at: number; // epoch ms
}

export const AREA_LABELS: Record<HardwareArea, string> = {
  printer: "Impresora",
  scanner: "Escáner",
  customer_display: "Pantalla del cliente",
  cash_drawer: "Cajón de dinero",
  scale: "Balanza",
  environment: "Entorno",
};

export const RESULT_LABELS: Record<DiagResult, string> = {
  ok: "OK",
  warn: "Advertencia",
  error: "Error",
  info: "Info",
};

function read(): DiagEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as DiagEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function write(entries: DiagEntry[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch {
    /* almacenamiento lleno/bloqueado: el log es best-effort */
  }
}

function makeId(): string {
  try {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
      return crypto.randomUUID();
    }
  } catch {
    /* fallthrough */
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// Lee el log directamente (sin React) — útil para el export.
export function readDiagnosticsLog(): DiagEntry[] {
  return read();
}

// Hook reactivo: devuelve el log + helpers para registrar y limpiar. Mantiene
// las pestañas en sync vía el evento `storage`.
export function useDiagnosticsLog() {
  const [entries, setEntries] = useState<DiagEntry[]>([]);

  useEffect(() => {
    setEntries(read());
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setEntries(read());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const log = useCallback(
    (area: HardwareArea, action: string, result: DiagResult, detail: string) => {
      const entry: DiagEntry = {
        id: makeId(),
        area,
        action,
        result,
        detail,
        at: Date.now(),
      };
      setEntries((prev) => {
        const next = [entry, ...prev].slice(0, MAX_ENTRIES);
        write(next);
        return next;
      });
      return entry;
    },
    [],
  );

  const clear = useCallback(() => {
    setEntries([]);
    write([]);
  }, []);

  return { entries, log, clear };
}
