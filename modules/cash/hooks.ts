"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { cashApi } from "./api";

export function useShiftMovements(shiftId: string | null) {
  return useQuery({
    queryKey: ["cash", "movements", shiftId],
    queryFn: () => cashApi.movements(shiftId!),
    enabled: Boolean(shiftId),
  });
}

export function useZClosures() {
  return useQuery({
    queryKey: ["cash", "z-closures"],
    queryFn: () => cashApi.zClosures(),
  });
}

export function useAddMovement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      shiftId: string;
      type: "income" | "expense";
      amount: number;
      reason: string;
    }) => cashApi.addMovement(vars.shiftId, vars.type, vars.amount, vars.reason),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cash", "movements"] }),
  });
}
