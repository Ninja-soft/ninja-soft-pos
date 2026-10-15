"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { permissionsApi, type SaveRoleInput } from "./api";

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

/** Roles, equipo y permisos para el editor. */
export function usePermissionOverview(enabled = true) {
  return useQuery({
    queryKey: ["permissions", "overview"],
    queryFn: () => permissionsApi.overview(),
    enabled,
    staleTime: 15_000,
    retry: 1,
  });
}

export function usePermissionMutations() {
  const qc = useQueryClient();
  const inv = () => {
    qc.invalidateQueries({ queryKey: ["permissions"] });
    qc.invalidateQueries({ queryKey: ["staff"] });
    qc.invalidateQueries({ queryKey: ["my-tenant"] });
  };
  return {
    saveRole: useMutation({ mutationFn: (i: SaveRoleInput) => permissionsApi.saveRole(i), onSuccess: inv }),
    duplicateRole: useMutation({
      mutationFn: (v: { source: string; name: string }) => permissionsApi.duplicateRole(v.source, v.name),
      onSuccess: inv,
    }),
    deleteRole: useMutation({
      mutationFn: (v: { id: string; reassignTo: string }) => permissionsApi.deleteRole(v.id, v.reassignTo),
      onSuccess: inv,
    }),
    assignRole: useMutation({
      mutationFn: (v: { userId: string; roleId: string }) => permissionsApi.assignRole(v.userId, v.roleId),
      onSuccess: inv,
    }),
    setBranchRole: useMutation({
      mutationFn: (v: { userId: string; storeId: string; roleId: string | null }) =>
        permissionsApi.setBranchRole(v.userId, v.storeId, v.roleId),
      onSuccess: inv,
    }),
    setOverride: useMutation({
      mutationFn: (v: { userId: string; capability: string; effect: "grant" | "revoke" | null; reason: string | null }) =>
        permissionsApi.setOverride(v.userId, v.capability, v.effect, v.reason),
      onSuccess: inv,
    }),
  };
}
