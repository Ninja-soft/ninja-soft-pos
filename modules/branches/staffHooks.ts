"use client";

import { useMemo } from "react";
import { useBranchContext, useBranches, useStaffAssignments, useStaffDirectory } from "./hooks";
import { todayAR, type StaffRole } from "./logic";
import { professionalsForStore, staffForStore } from "./staffScope";

// Personal (usuarios y perfiles sin cuenta) habilitado en la sucursal del POS.
// Con una sola sucursal devuelve a todos (las reglas dan "todas").
export function usePosStoreStaff() {
  const ctx = useBranchContext();
  const branches = useBranches();
  const assignments = useStaffAssignments();
  const people = useStaffDirectory();
  const storeId = ctx.posStoreId;
  return useMemo(() => {
    const staff = staffForStore(
      people.data ?? [],
      storeId,
      branches.data ?? [],
      assignments.data ?? [],
      todayAR(),
    );
    return {
      ready: Boolean(branches.data && assignments.data && people.data),
      storeId,
      staff,
      profiles: staff.filter((p) => p.profileId !== null),
    };
  }, [branches.data, assignments.data, people.data, storeId]);
}

// Vendedores del POS filtrados por la sucursal donde vende el dispositivo.
export function useProfessionalsForPosStore<T extends { user_id: string | null }>(
  list: T[] | undefined,
): T[] {
  const ctx = useBranchContext();
  const branches = useBranches();
  const assignments = useStaffAssignments();
  const people = useStaffDirectory();
  return useMemo(() => {
    const all = list ?? [];
    if (!ctx.isMulti || !branches.data || !assignments.data || !people.data) return all;
    const roles = new Map<string, StaffRole>();
    for (const p of people.data) if (p.userId && p.role) roles.set(p.userId, p.role);
    return professionalsForStore(all, ctx.posStoreId, roles, branches.data, assignments.data, todayAR());
  }, [list, ctx.isMulti, ctx.posStoreId, branches.data, assignments.data, people.data]);
}
