"use client";

// React Query para reservas gastronómicas (F13 · H51). Espeja el patrón de
// modules/delivery/hooks.ts. La agenda se pide por rango de fechas (bajo
// consumo). Al sentar/cancelar/cambiar estado se invalida la agenda y, además,
// el listado de mesas (sentar abre una mesa → cambia su estado en /salon).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  reservationsApi,
  type CreateReservationInput,
  type ReservationStatus,
} from "./reservations";

// Agenda de reservas en un rango [from, to). El caller arma el rango (hoy /
// próximos días). includeClosed trae también canceladas / no_show.
export function useReservations(params: {
  from: string;
  to: string;
  includeClosed?: boolean;
}) {
  return useQuery({
    queryKey: [
      "dining",
      "reservations",
      params.from,
      params.to,
      params.includeClosed ? "all" : "open",
    ],
    queryFn: () => reservationsApi.list(params),
    // Agenda operativa: refrescá cada ~30s para ver altas/cambios de otro cajero.
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useReservationMutations() {
  const qc = useQueryClient();
  // Tras cualquier cambio refrescá la agenda. Sentar también toca las mesas y los
  // totales del salón → invalidá esas keys.
  const inv = () =>
    qc.invalidateQueries({ queryKey: ["dining", "reservations"] });
  const invSeated = () => {
    inv();
    qc.invalidateQueries({ queryKey: ["dining", "tables"] });
    qc.invalidateQueries({ queryKey: ["dining", "open-totals"] });
  };
  return {
    create: useMutation({
      mutationFn: (i: CreateReservationInput) => reservationsApi.create(i),
      onSuccess: invSeated, // crear puede marcar la mesa 'reservada'
    }),
    setStatus: useMutation({
      mutationFn: (v: { id: string; status: ReservationStatus }) =>
        reservationsApi.setStatus(v.id, v.status),
      onSuccess: invSeated, // cancelar/no_show puede liberar una mesa reservada
    }),
    cancel: useMutation({
      mutationFn: (v: { id: string; reason?: string | null }) =>
        reservationsApi.cancel(v.id, v.reason),
      onSuccess: invSeated,
    }),
    seat: useMutation({
      mutationFn: (v: { id: string; tableId: string | null }) =>
        reservationsApi.seat(v.id, v.tableId),
      onSuccess: invSeated,
    }),
  };
}
