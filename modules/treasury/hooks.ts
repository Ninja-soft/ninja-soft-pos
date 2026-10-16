"use client";

import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFeature } from "@/modules/saas/gating";
import type { ChequeKind, ChequeStatus } from "@/lib/treasury/cheques";
import {
  treasuryApi,
  type BankStatementLine,
  type ChequeInput,
  type MovementInput,
  type TreasuryAccountInput,
} from "./api";

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

/** Posición (H150): cuentas de dinero con saldo, cajas del POS y lo a acreditar. */
export function useTreasuryPosition(enabled = true) {
  return useQuery({
    queryKey: ["treasury", "position"],
    queryFn: () => treasuryApi.position(),
    enabled,
  });
}

/**
 * Crea las cuentas de sistema que falten (cajas del POS, a acreditar) una vez
 * por sesión al abrir Posición. Silenciosa: si falla, la pantalla sigue.
 */
let synced = false;
export function useTreasuryAccountsSync(enabled: boolean) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled || synced) return;
    synced = true;
    treasuryApi
      .syncAccounts()
      .then((created) => {
        if (created > 0) void qc.invalidateQueries({ queryKey: ["treasury"] });
      })
      .catch(() => {
        synced = false;
      });
  }, [enabled, qc]);
}

export function usePendingCollections(provider: string | null, enabled = true) {
  return useQuery({
    queryKey: ["treasury", "pending-collections", provider],
    queryFn: () => treasuryApi.pendingCollections(provider),
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

export function useTreasuryMovement(id: string | null) {
  return useQuery({
    queryKey: ["treasury", "movement", id],
    queryFn: () => treasuryApi.movement(id!),
    enabled: Boolean(id),
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

/** ¿El plan trae la conciliación bancaria? (H152; la barrera real es el servidor). */
export function useBankStatementAccess() {
  const f = useFeature("conciliacion_bancaria");
  return { ready: f !== undefined, enabled: f === true, locked: f === false };
}

/** Cajas fuertes y bancos para el retiro del cajón (H151). */
export function useDropDestinations(enabled = true) {
  return useQuery({
    queryKey: ["treasury", "drop-destinations"],
    queryFn: () => treasuryApi.dropDestinations(),
    enabled,
    staleTime: 60_000,
  });
}

export function useStatementImports(accountId: string | null) {
  return useQuery({
    queryKey: ["treasury", "statement-imports", accountId],
    queryFn: () => treasuryApi.statementImports(accountId!),
    enabled: Boolean(accountId),
  });
}

export function useStatementLines(f: { accountId: string | null; status?: BankStatementLine["match_status"] | null }) {
  return useQuery({
    queryKey: ["treasury", "statement-lines", f],
    queryFn: () => treasuryApi.statementLines({ accountId: f.accountId!, status: f.status ?? null }),
    enabled: Boolean(f.accountId),
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
    linkTransfer: useMutation({
      mutationFn: (v: { treasuryId: string; transferId: string; linked: boolean }) =>
        treasuryApi.linkTransfer(v.treasuryId, v.transferId, v.linked),
      onSuccess: inv,
    }),
    createLedgerAccount: useMutation({
      mutationFn: (accountId: string) => treasuryApi.createLedgerAccount(accountId),
      onSuccess: () => {
        inv();
        void qc.invalidateQueries({ queryKey: ["accounting"] });
      },
    }),
    createMovement: useMutation({ mutationFn: (v: MovementInput) => treasuryApi.createMovement(v), onSuccess: inv }),
    setSettlementProviders: useMutation({
      mutationFn: (v: { accountId: string; providers: string[] }) => treasuryApi.setSettlementProviders(v.accountId, v.providers),
      onSuccess: () => {
        inv();
        void qc.invalidateQueries({ queryKey: ["accounting"] });
      },
    }),
    importStatement: useMutation({
      mutationFn: (v: Parameters<typeof treasuryApi.importStatement>[0]) => treasuryApi.importStatement(v),
      onSuccess: inv,
    }),
    resolveStatementLine: useMutation({
      mutationFn: (v: Parameters<typeof treasuryApi.resolveStatementLine>[0]) => treasuryApi.resolveStatementLine(v),
      onSuccess: () => {
        inv();
        void qc.invalidateQueries({ queryKey: ["accounting"] });
      },
    }),
    rematchStatement: useMutation({ mutationFn: (accountId: string) => treasuryApi.rematchStatement(accountId), onSuccess: inv }),
    deleteStatement: useMutation({
      mutationFn: (v: { importId: string; reason: string }) => treasuryApi.deleteStatement(v.importId, v.reason),
      onSuccess: inv,
    }),
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
