"use client";

import { useEffect, useLayoutEffect, useState } from "react";
import {
  LAST_BUSINESS_EVENT,
  LAST_BUSINESS_KEY,
  readRememberedBusiness,
  type RememberedBusiness,
} from "@/lib/auth/rememberedBusiness";

const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * Negocio recordado en este dispositivo (ver lib/auth/rememberedBusiness.ts).
 * `ready` es false en el server y hasta el primer efecto del cliente: mientras
 * tanto no se sabe qué panel mostrar (el server no ve localStorage).
 */
export function useRememberedBusiness(): { ready: boolean; business: RememberedBusiness | null } {
  const [state, setState] = useState<{ ready: boolean; business: RememberedBusiness | null }>({
    ready: false,
    business: null,
  });
  useIsoLayoutEffect(() => {
    const read = () => setState({ ready: true, business: readRememberedBusiness() });
    read();
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === LAST_BUSINESS_KEY) read();
    };
    window.addEventListener(LAST_BUSINESS_EVENT, read);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(LAST_BUSINESS_EVENT, read);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return state;
}
