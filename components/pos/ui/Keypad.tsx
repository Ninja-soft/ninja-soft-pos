"use client";

import { Delete } from "lucide-react";
import { cn } from "@/lib/utils/cn";

// Teclado numérico táctil (Caja rápida y montos del cobro). Emite teclas
// sueltas; quien lo usa decide qué hacer (PLU, cantidad, monto recibido).
export type KeypadKey = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "00" | "," | "back";

const ROWS: KeypadKey[][] = [
  ["7", "8", "9"],
  ["4", "5", "6"],
  ["1", "2", "3"],
];

export function Keypad({
  onKey,
  lastKey = "00",
  compact,
  className,
}: {
  onKey: (k: KeypadKey) => void;
  lastKey?: "00" | ",";
  compact?: boolean;
  className?: string;
}) {
  const btn = cn(
    "grid place-items-center rounded-2xl bg-fg-6 font-price font-bold text-foreground transition hover:bg-fg-10 active:scale-95 active:bg-foreground active:text-background",
    compact ? "h-11 text-lg" : "h-14 text-xl",
  );
  return (
    <div className={cn("grid grid-cols-3 gap-2", className)} role="group" aria-label="Teclado numérico">
      {ROWS.flat().map((k) => (
        <button key={k} type="button" className={btn} onClick={() => onKey(k)}>
          {k}
        </button>
      ))}
      <button type="button" className={btn} onClick={() => onKey(lastKey)}>
        {lastKey}
      </button>
      <button type="button" className={btn} onClick={() => onKey("0")}>
        0
      </button>
      <button type="button" className={btn} onClick={() => onKey("back")} aria-label="Borrar">
        <Delete size={20} />
      </button>
    </div>
  );
}

/** Aplica una tecla a un texto numérico (máximo 2 decimales con coma). */
export function applyKey(value: string, k: KeypadKey): string {
  if (k === "back") return value.slice(0, -1);
  if (k === ",") return value.includes(",") ? value : `${value || "0"},`;
  const next = value === "0" ? k : value + k;
  const dec = next.split(",")[1];
  if (dec && dec.length > 2) return value;
  return next.length > 12 ? value : next;
}

/** "1.234,5" → 1234.5 · "1234.5" → 1234.5 (con coma, el punto es de miles). */
export function keypadNumber(value: string): number {
  const v = value.includes(",") ? value.replace(/\./g, "").replace(",", ".") : value;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
