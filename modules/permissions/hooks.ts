"use client";

import { useQuery } from "@tanstack/react-query";
import { permissionsApi } from "./api";

/** Capacidades efectivas del usuario en el negocio activo (ADR-138). */
export function useMyCapabilities(enabled = true) {
  return useQuery({
    queryKey: ["permissions", "mine"],
    queryFn: () => permissionsApi.mine(),
    enabled,
    staleTime: 60_000,
    retry: 1,
  });
}
