"use client";

import { useRef } from "react";
import { reconcile } from "@/lib/pos/bootCache";

/**
 * Devuelve la referencia anterior mientras el valor sea estructuralmente
 * igual: un dato que llega del servidor idéntico al que ya se pintaba no
 * dispara re-renders ni efectos aguas abajo.
 */
export function useReconciled<T>(value: T): T {
  const ref = useRef(value);
  const next = reconcile(ref.current, value);
  ref.current = next;
  return next;
}
