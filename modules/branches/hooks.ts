"use client";

import { useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { getCurrentUser } from "@/lib/supabase/currentUser";
import {
  branchesAdminApi,
  type RegisterInput,
  type ScheduleInput,
  type StoreInput,
} from "./api";
import {
  ALL_BRANCHES,
  resolveBranchContext,
  resolveRegister,
  type Branch,
  type BranchRegister,
  type BranchSelection,
  type StaffRole,
} from "./logic";
import { useBranchStore } from "./store";

// Usuario, negocio y rol (para la clave del contexto y para la UI).
export function useBranchScope() {
  return useQuery({
    queryKey: ["branch-scope"],
    queryFn: async () => {
      const user = await getCurrentUser();
      if (!user) return null;
      const tenantId =
        ((user.app_metadata as { current_tenant_id?: string } | null)?.current_tenant_id as
          | string
          | undefined) ?? null;
      // B-04: rol en el negocio ACTIVO (con dos membresías no vale cualquiera).
      let q = createClient().from("tenant_users").select("role").eq("user_id", user.id).eq("status", "active");
      if (tenantId) q = q.eq("tenant_id", tenantId);
      const { data } = await q.limit(1).maybeSingle();
      return { userId: user.id, tenantId, role: (data?.role ?? null) as StaffRole | null };
    },
    staleTime: 5 * 60_000,
  });
}

// Todas las sucursales del negocio con sus cajas (incluye archivadas).
export function useBranches() {
  return useQuery({
    queryKey: ["branches"],
    queryFn: () => branchesAdminApi.list(),
    staleTime: 60_000,
  });
}

export function useAllowedStoreIds() {
  return useQuery({
    queryKey: ["branches", "allowed"],
    queryFn: () => branchesAdminApi.allowedStoreIds(),
    staleTime: 60_000,
  });
}

function sortBranches(list: Branch[]): Branch[] {
  return [...list].sort(
    (a, b) =>
      Number(b.is_default) - Number(a.is_default) ||
      a.sort - b.sort ||
      a.created_at.localeCompare(b.created_at),
  );
}

export interface BranchContextValue {
  ready: boolean;
  isMulti: boolean;
  // Sucursales vivas a las que el usuario tiene acceso (principal primero).
  allowed: Branch[];
  // Todas las sucursales del negocio (para nombres en listados históricos).
  all: Branch[];
  canSeeAll: boolean;
  selection: BranchSelection | null;
  filterStoreId: string | null;
  filterStore: Branch | null;
  posStoreId: string | null;
  posStore: Branch | null;
  setSelection: (s: BranchSelection) => void;
  setPosLocation: (storeId: string, registerId?: string | null) => void;
  branchName: (id: string | null | undefined) => string | null;
}

// Contexto global "dónde estoy": filtro del panel y sucursal del POS.
export function useBranchContext(): BranchContextValue {
  const scope = useBranchScope();
  const branches = useBranches();
  const allowedIds = useAllowedStoreIds();
  const hydrate = useBranchStore((s) => s.hydrate);
  const scopeKey = useBranchStore((s) => s.scopeKey);
  const selection = useBranchStore((s) => s.selection);
  const savedPos = useBranchStore((s) => s.posStoreId);
  const setSelection = useBranchStore((s) => s.setSelection);
  const setPosLocation = useBranchStore((s) => s.setPosLocation);

  const key = scope.data ? `${scope.data.tenantId ?? "t"}.${scope.data.userId}` : null;
  useEffect(() => {
    if (key) hydrate(key);
  }, [key, hydrate]);

  return useMemo(() => {
    const all = branches.data ?? [];
    const ids = new Set(allowedIds.data ?? []);
    const allowed = sortBranches(all.filter((b) => !b.deleted_at && ids.has(b.id)));
    const ctx = resolveBranchContext({
      allowed,
      saved: scopeKey === key ? selection : null,
      savedPos: scopeKey === key ? savedPos : null,
    });
    const byId = new Map(all.map((b) => [b.id, b]));
    const live = all.filter((b) => !b.deleted_at);
    return {
      ready: branches.isFetched && allowedIds.isFetched && Boolean(scope.data),
      isMulti: ctx.isMulti,
      allowed,
      all,
      canSeeAll: allowed.length > 1 && live.every((b) => ids.has(b.id)),
      selection: ctx.isMulti ? (ctx.filterStoreId ?? ALL_BRANCHES) : ctx.filterStoreId,
      filterStoreId: ctx.isMulti ? ctx.filterStoreId : null,
      filterStore: ctx.filterStoreId ? (byId.get(ctx.filterStoreId) ?? null) : null,
      posStoreId: ctx.posStoreId,
      posStore: ctx.posStoreId ? (byId.get(ctx.posStoreId) ?? null) : null,
      setSelection,
      setPosLocation,
      branchName: (id) => (id ? (byId.get(id)?.short_name || byId.get(id)?.name) ?? null : null),
    };
  }, [
    branches.data,
    branches.isFetched,
    allowedIds.data,
    allowedIds.isFetched,
    scope.data,
    scopeKey,
    key,
    selection,
    savedPos,
    setSelection,
    setPosLocation,
  ]);
}

// Turnos abiertos de la sucursal del POS. La key cuelga de ["pos","open-shift"]
// para que abrir o cerrar caja la invalide junto con el turno.
export function useStoreOpenShifts(storeId: string | null) {
  return useQuery({
    queryKey: ["pos", "open-shift", "store", storeId],
    queryFn: () => branchesAdminApi.openShifts(storeId!),
    enabled: Boolean(storeId),
  });
}

// Caja que usa este dispositivo (dentro de la sucursal del POS).
export function useCurrentRegister(): {
  data: BranchRegister | null;
  store: Branch | null;
  registers: BranchRegister[];
  isFetched: boolean;
} {
  const ctx = useBranchContext();
  const scope = useBranchScope();
  const registerByStore = useBranchStore((s) => s.registerByStore);
  const shifts = useStoreOpenShifts(ctx.posStoreId);
  const store = ctx.posStore;
  const saved = store ? (registerByStore[store.id] ?? null) : null;
  const data = useMemo(
    () =>
      store
        ? resolveRegister(store.registers, saved, shifts.data ?? [], scope.data?.userId ?? null)
        : null,
    [store, saved, shifts.data, scope.data?.userId],
  );
  // Respaldo: si el contexto de sucursales no carga (p. ej. el front llega
  // antes que las migraciones de F17), se usa la primera caja activa como
  // antes, para no dejar el POS sin poder abrir caja.
  const fallbackOn = ctx.ready && !store;
  const fallback = useQuery({
    queryKey: ["pos", "register", "fallback"],
    enabled: fallbackOn,
    queryFn: async () => {
      const tid = scope.data?.tenantId ?? null;
      let rq = createClient().from("cash_registers").select("*").eq("is_active", true);
      if (tid) rq = rq.eq("tenant_id", tid);
      const { data: r } = await rq
        .order("created_at")
        .limit(1)
        .maybeSingle();
      return (r ?? null) as unknown as BranchRegister | null;
    },
  });
  return {
    data: data ?? (fallbackOn ? (fallback.data ?? null) : null),
    store,
    registers: store?.registers ?? [],
    isFetched: ctx.ready && (store ? shifts.isFetched : !fallbackOn || fallback.isFetched),
  };
}

export function useBranchMutations() {
  const qc = useQueryClient();
  const inv = () => {
    qc.invalidateQueries({ queryKey: ["branches"] });
    qc.invalidateQueries({ queryKey: ["pos"] });
    qc.invalidateQueries({ queryKey: ["gating"] });
  };
  return {
    createStore: useMutation({ mutationFn: (i: StoreInput) => branchesAdminApi.createStore(i), onSuccess: inv }),
    updateStore: useMutation({
      mutationFn: (v: { id: string; patch: Partial<StoreInput> }) => branchesAdminApi.updateStore(v.id, v.patch),
      onSuccess: inv,
    }),
    archiveStore: useMutation({
      mutationFn: (v: { id: string; reason: string | null }) => branchesAdminApi.archiveStore(v.id, v.reason),
      onSuccess: inv,
    }),
    restoreStore: useMutation({ mutationFn: (id: string) => branchesAdminApi.restoreStore(id), onSuccess: inv }),
    setDefaultStore: useMutation({ mutationFn: (id: string) => branchesAdminApi.setDefaultStore(id), onSuccess: inv }),
    createRegister: useMutation({
      mutationFn: (i: RegisterInput) => branchesAdminApi.createRegister(i),
      onSuccess: inv,
    }),
    updateRegister: useMutation({
      mutationFn: (v: { id: string; patch: Partial<RegisterInput> }) => branchesAdminApi.updateRegister(v.id, v.patch),
      onSuccess: inv,
    }),
    archiveRegister: useMutation({
      mutationFn: (v: { id: string; reason: string | null }) => branchesAdminApi.archiveRegister(v.id, v.reason),
      onSuccess: inv,
    }),
    restoreRegister: useMutation({ mutationFn: (id: string) => branchesAdminApi.restoreRegister(id), onSuccess: inv }),
  };
}

export function useStaffAssignments() {
  return useQuery({
    queryKey: ["branches", "staff"],
    queryFn: () => branchesAdminApi.assignments(),
  });
}

export function useStaffMutations() {
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: ["branches"] });
  return {
    schedule: useMutation({ mutationFn: (i: ScheduleInput) => branchesAdminApi.schedule(i), onSuccess: inv }),
    cancel: useMutation({
      mutationFn: (v: { id: string; reason: string | null }) => branchesAdminApi.cancel(v.id, v.reason),
      onSuccess: inv,
    }),
  };
}

export interface StaffPerson {
  key: string; // "u:<user_id>" | "p:<cashier_profile_id>"
  userId: string | null;
  profileId: string | null;
  name: string;
  role: StaffRole | null; // null = perfil sin cuenta (opera como cajero)
}

// Personas del negocio (usuarios con login y perfiles sin cuenta) para el
// módulo de personal por sucursal.
export function useStaffDirectory() {
  return useQuery({
    queryKey: ["branches", "people"],
    queryFn: async (): Promise<StaffPerson[]> => {
      const sb = createClient();
      const tenantId = (await getCurrentUser())?.app_metadata?.current_tenant_id as string | undefined;
      let profilesQ = sb.from("cashier_profiles").select("id, display_name, status").is("deleted_at", null);
      if (tenantId) profilesQ = profilesQ.eq("tenant_id", tenantId);
      const [members, profiles] = await Promise.all([sb.rpc("tenant_members"), profilesQ]);
      const out: StaffPerson[] = [];
      for (const m of (members.data ?? []) as {
        user_id: string;
        email: string | null;
        full_name: string | null;
        display_name: string | null;
        role: string;
        status: string;
      }[]) {
        // B-07: sólo miembros activos (suspendidos, invitados y de baja, no).
        if (m.status !== "active") continue;
        out.push({
          key: `u:${m.user_id}`,
          userId: m.user_id,
          profileId: null,
          name: m.display_name || m.full_name || m.email || "Miembro",
          role: m.role as StaffRole,
        });
      }
      for (const p of (profiles.data ?? []) as { id: string; display_name: string; status: string }[]) {
        if (p.status !== "active") continue;
        out.push({ key: `p:${p.id}`, userId: null, profileId: p.id, name: p.display_name, role: null });
      }
      return out;
    },
    staleTime: 60_000,
  });
}
