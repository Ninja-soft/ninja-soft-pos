"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  professionalsApi,
  appointmentsApi,
  type ProfessionalInput,
  type AppointmentInput,
  type AppointmentStatus,
} from "./api";

// ── Profesionales ─────────────────────────────────────────────────────────────

export function useProfessionals(activeOnly = false) {
  return useQuery({
    queryKey: ["professionals", activeOnly],
    queryFn: () => professionalsApi.list(activeOnly),
  });
}

export function useProfessionalMutations() {
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: ["professionals"] });
  return {
    create: useMutation({
      mutationFn: (input: ProfessionalInput) => professionalsApi.create(input),
      onSuccess: inv,
    }),
    update: useMutation({
      mutationFn: (v: { id: string; patch: Partial<ProfessionalInput> }) =>
        professionalsApi.update(v.id, v.patch),
      onSuccess: inv,
    }),
    remove: useMutation({
      mutationFn: (id: string) => professionalsApi.softDelete(id),
      onSuccess: inv,
    }),
  };
}

// ── Turnos ────────────────────────────────────────────────────────────────────

// Turnos del rango visible de la agenda. La key incluye el rango ISO para que el
// cambio de día/semana refetchee.
export function useAppointments(from: Date, to: Date) {
  return useQuery({
    queryKey: ["appointments", from.toISOString(), to.toISOString()],
    queryFn: () => appointmentsApi.listRange(from, to),
  });
}

// Un turno por id (cobro desde el POS). enabled evita el fetch sin id.
export function useAppointment(id: string | null) {
  return useQuery({
    queryKey: ["appointments", "by-id", id],
    enabled: Boolean(id),
    queryFn: () => appointmentsApi.getById(id!),
  });
}

export function useAppointmentMutations() {
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: ["appointments"] });
  return {
    create: useMutation({
      mutationFn: (input: AppointmentInput) => appointmentsApi.create(input),
      onSuccess: inv,
    }),
    update: useMutation({
      mutationFn: (v: {
        id: string;
        patch: Parameters<typeof appointmentsApi.update>[1];
      }) => appointmentsApi.update(v.id, v.patch),
      onSuccess: inv,
    }),
    setStatus: useMutation({
      mutationFn: (v: {
        id: string;
        status: AppointmentStatus;
        cancelReason?: string | null;
      }) => appointmentsApi.setStatus(v.id, v.status, v.cancelReason),
      onSuccess: inv,
    }),
  };
}
