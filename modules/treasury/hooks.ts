"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFeature } from "@/modules/saas/gating";
import type { ChequeKind, ChequeStatus } from "@/lib/treasury/cheques";
import { treasuryApi, type ChequeInput, type MovementInput, type TreasuryAccountInput } from "./api";

/** Estado de la feature para la UI (la barrera real es el servidor). */
export function useTreasuryAccess() {
  const compras = useFeature("compras");
  const tesoreria = useFeature("tesoreria");
  return {
    ready: tesoreria !== undefined && compras !== undefined,
    enabled: tesoreria === true && compras === true,
    locked: tesoreria === false || compras === false,
  };
}

export function useTreasuryAccounts(opts: { includeArchived?: boolean } = {}, enabled = true) {
  return useQuery({
    queryKey: ["treasury", "accounts", opts],
    queryFn: () => treasuryApi.accounts(opts),
    enabled,
  });
}

export function useTreasuryBalances(enabled = true) {
  return useQuery({
    queryKey: ["treasury", "balances"],
    queryFn: () => treasuryApi.balances(),
    enabled,
  });
}

export function useTreasuryMovements(
  f: { accountId?: string | null; from?: string | null; to?: string | null; includeVoided?: boolean; onlyUnreconciled?: boolean },
  enabled = true,
) {
  return useQuery({
    queryKey: ["treasury", "movements", f],
    queryFn: () => treasuryApi.movements(f),
    enabled,
  });
}

export function useCheques(f: { kind?: ChequeKind | null; statuses?: ChequeStatus[] | null }, enabled = true) {
  return useQuery({
    queryKey: ["treasury", "cheques", f],
    queryFn: () => treasuryApi.cheques(f),
    enabled,
  });
}

export function useReceivables(to: string, enabled = true) {
  return useQuery({
    queryKey: ["treasury", "receivables", to],
    queryFn: () => treasuryApi.receivables(to),
    enabled,
  });
}

export function useMyOpenShift(enabled = true) {
  return useQuery({
    queryKey: ["cash", "my-open-shift"],
    queryFn: () => treasuryApi.myOpenShift(),
    enabled,
  });
}

export function useTreasuryMutations() {
  const qc = useQueryClient();
  const inv = () => {
    void qc.invalidateQueries({ queryKey: ["treasury"] });
    void qc.invalidateQueries({ queryKey: ["supplier-payments"] });
    void qc.invalidateQueries({ queryKey: ["supplier-payment-order"] });
  };
  return {
    saveAccount: useMutation({
      mutationFn: (v: { id: string | null; input: TreasuryAccountInput }) => treasuryApi.saveAccount(v.id, v.input),
      onSuccess: inv,
    }),
    archiveAccount: useMutation({ mutationFn: (id: string) => treasuryApi.archiveAccount(id), onSuccess: inv }),
    createMovement: useMutation({ mutationFn: (v: MovementInput) => treasuryApi.createMovement(v), onSuccess: inv }),
    transfer: useMutation({
      mutationFn: (v: Parameters<typeof treasuryApi.transfer>[0]) => treasuryApi.transfer(v),
      onSuccess: inv,
    }),
    voidMovement: useMutation({
      mutationFn: (v: { id: string; reason: string }) => treasuryApi.voidMovement(v.id, v.reason),
      onSuccess: inv,
    }),
    reconcile: useMutation({
      mutationFn: (v: { ids: string[]; reconciled: boolean; statementRef: string | null }) =>
        treasuryApi.reconcile(v.ids, v.reconciled, v.statementRef),
      onSuccess: inv,
    }),
    registerCheque: useMutation({ mutationFn: (v: ChequeInput) => treasuryApi.registerCheque(v), onSuccess: inv }),
    transitionCheque: useMutation({
      mutationFn: (v: {
        id: string;
        to: ChequeStatus;
        p: { account_id?: string | null; date?: string | null; reason?: string | null };
      }) => treasuryApi.transitionCheque(v.id, v.to, v.p),
      onSuccess: inv,
    }),
  };
}
