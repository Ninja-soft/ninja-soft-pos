"use client";

import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ResolveTarget } from "@/lib/config/inheritance";
import { useGating } from "@/modules/saas/gating";
import { useBranchContext, useCurrentRegister } from "@/modules/branches/hooks";
import { configApi, type PrinterInput, type TerminalInput } from "./api";

export function useConfigOverrides() {
  return useQuery({ queryKey: ["config-overrides"], queryFn: configApi.overrides, staleTime: 60_000 });
}

export function useStoreGroups() {
  return useQuery({ queryKey: ["store-groups"], queryFn: configApi.groups, staleTime: 60_000 });
}

export function useStoreGroupMap() {
  return useQuery({ queryKey: ["store-groups", "map"], queryFn: configApi.storeGroupMap, staleTime: 60_000 });
}

export function usePaymentTerminals() {
  return useQuery({ queryKey: ["payment-terminals"], queryFn: configApi.terminals, staleTime: 60_000 });
}

/** Features que habilitan cada nivel de herencia. */
export function useInheritanceFlags(): { multiStore: boolean; multiRegister: boolean } {
  const { data: gating } = useGating();
  return {
    multiStore: gating?.features?.multi_sucursal === true,
    multiRegister: gating?.features?.multi_caja === true,
  };
}

/** Destino de resolución para un lugar (sucursal y caja opcional). */
export function useResolveTarget(storeId: string | null, registerId: string | null): ResolveTarget {
  const flags = useInheritanceFlags();
  const { data: groupMap } = useStoreGroupMap();
  return useMemo(
    () => ({
      storeId,
      registerId,
      groupId: storeId ? (groupMap?.[storeId] ?? null) : null,
      ...flags,
    }),
    [storeId, registerId, groupMap, flags.multiStore, flags.multiRegister], // eslint-disable-line react-hooks/exhaustive-deps
  );
}

/** Destino del POS: sucursal del POS y caja de este dispositivo. */
export function usePosResolveTarget(): ResolveTarget {
  const ctx = useBranchContext();
  const register = useCurrentRegister();
  return useResolveTarget(ctx.posStoreId, register.data?.id ?? null);
}

export function useConfigMutations() {
  const qc = useQueryClient();
  const inv = () => {
    qc.invalidateQueries({ queryKey: ["config-overrides"] });
    qc.invalidateQueries({ queryKey: ["pos"] });
    qc.invalidateQueries({ queryKey: ["print-profiles"] });
  };
  return {
    set: useMutation({ mutationFn: configApi.set, onSuccess: inv }),
    copy: useMutation({ mutationFn: configApi.copy, onSuccess: inv }),
    resetField: useMutation({
      mutationFn: (v: { domain: Parameters<typeof configApi.resetField>[0]; domainKey: string; field: string }) =>
        configApi.resetField(v.domain, v.domainKey, v.field),
      onSuccess: inv,
    }),
  };
}

export function useStoreGroupMutations() {
  const qc = useQueryClient();
  const inv = () => {
    qc.invalidateQueries({ queryKey: ["store-groups"] });
    qc.invalidateQueries({ queryKey: ["branches"] });
  };
  return {
    create: useMutation({
      mutationFn: (v: { name: string; color: string | null }) => configApi.createGroup(v.name, v.color),
      onSuccess: inv,
    }),
    update: useMutation({
      mutationFn: (v: { id: string; name?: string; color?: string | null }) =>
        configApi.updateGroup(v.id, { ...(v.name ? { name: v.name } : {}), ...(v.color !== undefined ? { color: v.color } : {}) }),
      onSuccess: inv,
    }),
    archive: useMutation({ mutationFn: (id: string) => configApi.archiveGroup(id), onSuccess: inv }),
    assign: useMutation({
      mutationFn: (v: { storeId: string; groupId: string | null }) => configApi.setStoreGroup(v.storeId, v.groupId),
      onSuccess: inv,
    }),
  };
}

export function useTerminalMutations() {
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: ["payment-terminals"] });
  return {
    create: useMutation({ mutationFn: (i: TerminalInput) => configApi.createTerminal(i), onSuccess: inv }),
    update: useMutation({
      mutationFn: (v: { id: string; patch: Partial<TerminalInput> }) => configApi.updateTerminal(v.id, v.patch),
      onSuccess: inv,
    }),
    archive: useMutation({ mutationFn: (id: string) => configApi.archiveTerminal(id), onSuccess: inv }),
  };
}

// ── Impresoras ──────────────────────────────────────────────────────────────

export function usePrinters() {
  return useQuery({ queryKey: ["printers"], queryFn: configApi.printers, staleTime: 60_000 });
}

export function usePrinterMutations() {
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: ["printers"] });
  return {
    create: useMutation({ mutationFn: (i: PrinterInput) => configApi.createPrinter(i), onSuccess: inv }),
    update: useMutation({
      mutationFn: (v: { id: string; patch: Partial<PrinterInput> }) => configApi.updatePrinter(v.id, v.patch),
      onSuccess: inv,
    }),
    archive: useMutation({ mutationFn: (id: string) => configApi.archivePrinter(id), onSuccess: inv }),
    markTest: useMutation({
      mutationFn: (v: { id: string; ok: boolean }) => configApi.markPrinterTest(v.id, v.ok),
      onSuccess: inv,
    }),
  };
}

// ── Logo por sucursal ───────────────────────────────────────────────────────

export function useStoreLogos() {
  return useQuery({ queryKey: ["store-logos"], queryFn: configApi.storeLogos, staleTime: 5 * 60_000 });
}

/** Logo de la sucursal (null = hereda el del negocio). */
export function useStoreLogo(storeId: string | null | undefined): string | null {
  const { data } = useStoreLogos();
  return storeId ? (data?.[storeId] ?? null) : null;
}

export function useStoreLogoMutations() {
  const qc = useQueryClient();
  const inv = () => {
    qc.invalidateQueries({ queryKey: ["store-logos"] });
    qc.invalidateQueries({ queryKey: ["branches"] });
  };
  return {
    upload: useMutation({
      mutationFn: (v: { storeId: string; file: File }) => configApi.uploadStoreLogo(v.storeId, v.file),
      onSuccess: inv,
    }),
    clear: useMutation({ mutationFn: (storeId: string) => configApi.clearStoreLogo(storeId), onSuccess: inv }),
  };
}
