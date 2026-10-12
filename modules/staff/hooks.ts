"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { staffApi, type SetStatusInput } from "./api";

export function useStaffPeople(enabled = true) {
  return useQuery({ queryKey: ["staff", "people"], queryFn: () => staffApi.people(), enabled, staleTime: 30_000 });
}

export function useStaffEvents(enabled = true) {
  return useQuery({ queryKey: ["staff", "events"], queryFn: () => staffApi.events(), enabled, staleTime: 30_000 });
}

export function useMyStaffStatus() {
  return useQuery({ queryKey: ["staff", "me"], queryFn: () => staffApi.myStatus(), staleTime: 60_000 });
}

export function useStaffStatusMutations() {
  const qc = useQueryClient();
  const inv = () => {
    qc.invalidateQueries({ queryKey: ["staff"] });
    qc.invalidateQueries({ queryKey: ["branches"] });
    qc.invalidateQueries({ queryKey: ["tenant-members"] });
    qc.invalidateQueries({ queryKey: ["owner-stats"] });
  };
  return {
    setStatus: useMutation({ mutationFn: (i: SetStatusInput) => staffApi.setStatus(i), onSuccess: inv }),
    endStatus: useMutation({
      mutationFn: (v: { id: string; reason: string | null }) => staffApi.endStatus(v.id, v.reason),
      onSuccess: inv,
    }),
    rehire: useMutation({
      mutationFn: (v: Parameters<typeof staffApi.rehire>[0]) => staffApi.rehire(v),
      onSuccess: inv,
    }),
  };
}
