"use client";

import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { customersApi, customerGroupsApi } from "./api";
import { accountApi, type CollectionItem } from "./account";
import type { CustomerOutput } from "./schemas";
import type { AccountConfigOverride } from "@/lib/account/config";

export function useCustomers(search: string) {
  return useQuery({
    queryKey: ["customers", "list", search],
    queryFn: () => customersApi.list(search),
  });
}

// Selector de cliente del POS (bajo consumo): sin búsqueda trae sólo los más
// recientes; con búsqueda filtra server-side con límite. keepPreviousData evita
// el parpadeo de la lista mientras se tipea (el caller pasa el término ya
// debounced).
// `enabled`: el POS lo ata a que el selector esté abierto (antes se pedía la
// lista de recientes en cada arranque del POS aunque nadie abriera el selector).
export function useCustomersForPicker(search: string, enabled = true) {
  return useQuery({
    queryKey: ["customers", "picker", search],
    queryFn: () => customersApi.forPicker(search),
    placeholderData: keepPreviousData,
    enabled,
  });
}

// Listado paginado server-side de clientes. keepPreviousData evita parpadeos al
// cambiar de página o tipear (debounce desde la página).
export function useCustomersPaged(params: {
  page: number;
  pageSize: number;
  search?: string;
}) {
  return useQuery({
    queryKey: ["customers", "paged", params.page, params.pageSize, params.search ?? ""],
    queryFn: () => customersApi.listPaged(params),
    placeholderData: keepPreviousData,
  });
}

export function useStoreCreditBalance(customerId: string | null | undefined) {
  return useQuery({
    queryKey: ["customers", "store-credit", customerId],
    enabled: Boolean(customerId),
    queryFn: () => customersApi.storeCreditBalance(customerId!),
  });
}

export function useCustomerHistory(
  customerId: string | null | undefined,
  storeId: string | null = null,
) {
  return useQuery({
    queryKey: ["customers", "history", customerId, storeId],
    enabled: Boolean(customerId),
    queryFn: () => customersApi.history(customerId!, storeId),
    // Cambiar el filtro de sucursal no vuelve al spinner.
    placeholderData: (prev) => prev,
  });
}

// Compras por sucursal del cliente (F17 · H96). enabled: sólo con varias sucursales.
export function useCustomerBranchStats(customerId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ["customers", "branch-stats", customerId],
    enabled: Boolean(customerId) && enabled,
    queryFn: () => customersApi.branchStats(customerId!),
  });
}

// Ítems de la última venta del cliente (H40 — recompra rápida). enabled evita el
// fetch sin id. Lo usa el POS al entrar con ?repeat=<customerId>.
export function useCustomerLastSaleItems(customerId: string | null | undefined) {
  return useQuery({
    queryKey: ["customers", "last-sale-items", customerId],
    enabled: Boolean(customerId),
    queryFn: () => customersApi.lastSaleItems(customerId!),
  });
}

// Próximos turnos del cliente (H40, reusa H38). Para el historial del cliente.
export function useCustomerUpcomingAppointments(
  customerId: string | null | undefined,
) {
  return useQuery({
    queryKey: ["customers", "upcoming-appointments", customerId],
    enabled: Boolean(customerId),
    queryFn: () => customersApi.upcomingAppointments(customerId!),
  });
}

// ── Cuenta corriente v2 (RPC server-side) ────────────────────────────────────

export function useAccountAging(asOf?: string | null, enabled = true) {
  return useQuery({
    queryKey: ["account", "aging", asOf ?? ""],
    enabled,
    queryFn: () => accountApi.aging(asOf),
  });
}

export function useAccountStatement(
  customerId: string | null | undefined,
  range?: { from?: string | null; to?: string | null },
) {
  return useQuery({
    queryKey: ["account", "statement", customerId, range?.from ?? "", range?.to ?? ""],
    enabled: Boolean(customerId),
    queryFn: () => accountApi.statement(customerId!, range?.from, range?.to),
  });
}

// Info de cuenta para el POS (saldo, disponible, vencido, cuotas, bloqueo).
export function useAccountPosInfo(customerId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ["account", "pos-info", customerId],
    enabled: enabled && Boolean(customerId),
    queryFn: () => accountApi.posInfo(customerId!),
    // Siempre fresco: cada cobro a cuenta cambia el saldo y el disponible.
    staleTime: 0,
  });
}

export function useAccountTenantConfig() {
  return useQuery({
    queryKey: ["account", "tenant-config"],
    queryFn: () => accountApi.tenantConfig(),
  });
}

export function useTeamMembers(enabled = true) {
  return useQuery({
    queryKey: ["account", "team"],
    enabled,
    queryFn: () => accountApi.team(),
    staleTime: 5 * 60_000,
  });
}

export function useSupervisorPinStatus(enabled = true) {
  return useQuery({
    queryKey: ["account", "pin-status"],
    enabled,
    queryFn: () => accountApi.pinStatus(),
  });
}

export function useAccountSupervisors(enabled = true) {
  return useQuery({
    queryKey: ["account", "supervisors"],
    enabled,
    queryFn: () => accountApi.supervisors(),
    staleTime: 0,
  });
}

export function useAccountMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["account"] });
    qc.invalidateQueries({ queryKey: ["customers", "history"] });
  };
  return {
    collect: useMutation({ mutationFn: accountApi.collect, onSuccess: invalidate }),
    voidPayment: useMutation({
      mutationFn: (v: { id: string; reason: string }) => accountApi.voidPayment(v.id, v.reason),
      onSuccess: invalidate,
    }),
    waiveInterest: useMutation({
      mutationFn: (v: { id: string; amount: number; reason: string }) =>
        accountApi.waiveInterest(v.id, v.amount, v.reason),
      onSuccess: invalidate,
    }),
    adjust: useMutation({ mutationFn: accountApi.adjust, onSuccess: invalidate }),
    setTerms: useMutation({
      mutationFn: accountApi.setCustomerTerms,
      onSuccess: () => {
        invalidate();
        qc.invalidateQueries({ queryKey: ["customers"] });
      },
    }),
    addItem: useMutation({ mutationFn: accountApi.addItem, onSuccess: invalidate }),
    updateItem: useMutation({
      mutationFn: (v: { id: string; status: CollectionItem["status"]; remove?: boolean }) =>
        accountApi.updateItem(v.id, v.status, v.remove),
      onSuccess: invalidate,
    }),
    sendStatement: useMutation({
      mutationFn: (v: { customerId: string; to?: string | null }) =>
        accountApi.sendStatement(v.customerId, v.to),
      onSuccess: invalidate,
    }),
    accrue: useMutation({ mutationFn: accountApi.accrueInterest, onSuccess: invalidate }),
    saveSettings: useMutation({
      mutationFn: accountApi.saveSettings,
      onSuccess: invalidate,
    }),
    setPin: useMutation({ mutationFn: accountApi.setPin, onSuccess: invalidate }),
    clearPin: useMutation({
      mutationFn: (userId?: string | null) => accountApi.clearPin(userId),
      onSuccess: invalidate,
    }),
    authorizeOverride: useMutation({ mutationFn: accountApi.authorizeOverride }),
    setGroupConfig: useMutation({
      mutationFn: (v: { groupId: string; config: AccountConfigOverride | null }) =>
        accountApi.setGroupConfig(v.groupId, v.config),
      onSuccess: () => {
        invalidate();
        qc.invalidateQueries({ queryKey: ["customer-groups"] });
      },
    }),
  };
}

export function useBirthdays(month: number, enabled = true) {
  return useQuery({
    queryKey: ["customers", "birthdays", month],
    enabled,
    queryFn: () => customersApi.birthdays(month),
  });
}

export function useRequiredCustomerFields() {
  return useQuery({
    queryKey: ["customers", "required-fields"],
    queryFn: () => customersApi.requiredFields(),
  });
}

export function useCustomerGroups() {
  return useQuery({
    queryKey: ["customer-groups"],
    queryFn: () => customerGroupsApi.list(true),
  });
}

export function useCustomerMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["customers"] });
  return {
    create: useMutation({
      mutationFn: (input: CustomerOutput) => customersApi.create(input),
      onSuccess: invalidate,
    }),
    createQuick: useMutation({
      mutationFn: (input: {
        name: string;
        phone?: string | null;
        email?: string | null;
        document_type?: string | null;
        document_number?: string | null;
        birth_date?: string | null;
        iva_condition?: string | null;
        address?: string | null;
        iibb_jurisdiction?: string | null;
        fiscal_verification?: "padron" | "manual" | null;
        fiscal_verified_at?: string | null;
      }) => customersApi.createQuick(input),
      onSuccess: invalidate,
    }),
    update: useMutation({
      mutationFn: (vars: { id: string; input: CustomerOutput }) =>
        customersApi.update(vars.id, vars.input),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: (id: string) => customersApi.softDelete(id),
      onSuccess: invalidate,
    }),
  };
}
