"use client";

import { useEffect, useState } from "react";

// Devuelve `value` con un retraso de `delay` ms. Útil para búsquedas que pegan
// al server: evita una request por tecla. El valor inicial se entrega de una.
export function useDebouncedValue<T>(value: T, delay = 350): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}
