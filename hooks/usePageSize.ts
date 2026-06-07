"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";

// Rango permitido para el tamaño de página (espejo del CHECK de la DB y del
// control de Configuración → Operación del POS).
export const PAGE_SIZE_MIN = 10;
export const PAGE_SIZE_MAX = 100;
export const PAGE_SIZE_DEFAULT = 20;

export function clampPageSize(v: number | null | undefined): number {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n) || n <= 0) return PAGE_SIZE_DEFAULT;
  return Math.min(PAGE_SIZE_MAX, Math.max(PAGE_SIZE_MIN, n));
}

// Tamaño de página configurado por el tenant (pos_settings.page_size). La RLS
// acota la fila al tenant actual; si no hay settings, cae al default. El valor
// se cachea (staleTime largo) porque cambia rara vez. page_size aún no vive en
// los tipos generados: se castea la fila.
export function usePageSize(): number {
  const { data } = useQuery({
    queryKey: ["pos", "page-size"],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<number> => {
      const supabase = createClient();
      // select("*") incluye page_size (aún no tipado): se castea la fila.
      const { data } = await supabase
        .from("pos_settings")
        .select("*")
        .maybeSingle();
      const ps = (data as unknown as { page_size?: number } | null)?.page_size;
      return clampPageSize(ps);
    },
  });
  return clampPageSize(data);
}
