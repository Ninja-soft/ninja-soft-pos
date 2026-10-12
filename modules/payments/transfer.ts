"use client";

// Cuentas de transferencia (ADR-055): datos y hooks. transfer_accounts no está
// en types/database.ts (no se regenera en este PR): cliente suelto, mismo
// enfoque que modules/config/api.ts. La base valida todo (RLS, guard y plan).

import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { getCurrentTenantId } from "@/lib/supabase/currentUser";
import { resolveEffective, type ResolveTarget } from "@/lib/config/inheritance";
import { useConfigOverrides, usePosResolveTarget } from "@/modules/config/hooks";
import { useGating } from "@/modules/saas/gating";
import { usePaymentMethodsStatus } from "@/modules/pos/layoutHooks";
import {
  resolveTransferConfig,
  toAccountRow,
  type TransferAccount,
  type TransferAccountInput,
  type TransferConfig,
} from "@/lib/payments/transfer";

type Res<T> = Promise<{ data: T | null; error: { message: string } | null }>;
interface Q<T> extends PromiseLike<Awaited<Res<T>>> {
  select: (cols: string) => Q<T>;
  eq: (col: string, v: unknown) => Q<T>;
  is: (col: string, v: null) => Q<T>;
  order: (col: string, opts?: { ascending?: boolean }) => Q<T>;
  single: () => Res<T>;
  insert: (row: Record<string, unknown>) => Q<T>;
  update: (row: Record<string, unknown>) => Q<T>;
}
interface Loose {
  from: <T = unknown>(table: string) => Q<T>;
  rpc: <T = unknown>(fn: string, args?: Record<string, unknown>) => Res<T>;
}
const loose = () => createClient() as unknown as Loose;

function check<T>(r: { data: T | null; error: { message: string } | null }): T {
  if (r.error) throw new Error(r.error.message);
  return r.data as T;
}

export const TRANSFER_LOGO_BUCKET = "transfer-logos";
const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const LOGO_MAX_BYTES = 512 * 1024;

const COLS =
  "id, bank_slug, bank_name, custom_logo_path, custom_logo_url, holder_name, cuit, cbu, alias, account_type, currency, note, is_default, is_active, sort, deleted_at";

export const transferApi = {
  /** Cuentas vivas del negocio actual (filtro por negocio además de la RLS, ADR-052). */
  list: async (): Promise<TransferAccount[]> => {
    const t = await getCurrentTenantId();
    if (!t) return [];
    const r = await loose()
      .from<TransferAccount[]>("transfer_accounts")
      .select(COLS)
      .eq("tenant_id", t)
      .is("deleted_at", null)
      .order("sort")
      .order("created_at");
    // Base sin la migración: error (la hoja de cobro registra la
    // transferencia como siempre, sin cuenta).
    if (r.error) throw new Error(r.error.message);
    return r.data ?? [];
  },

  save: async (
    id: string | null,
    input: TransferAccountInput,
    extra: { is_default?: boolean; custom_logo_path?: string | null; custom_logo_url?: string | null; sort?: number },
  ): Promise<TransferAccount> => {
    const row = { ...toAccountRow(input), ...extra };
    if (id) {
      return check(await loose().from<TransferAccount>("transfer_accounts").update(row).eq("id", id).select(COLS).single());
    }
    const t = await getCurrentTenantId();
    if (!t) throw new Error("no_tenant");
    return check(
      await loose()
        .from<TransferAccount>("transfer_accounts")
        .insert({ ...row, tenant_id: t })
        .select(COLS)
        .single(),
    );
  },

  patch: async (id: string, patch: Partial<Pick<TransferAccount, "is_default" | "is_active" | "sort">>) => {
    check(await loose().from("transfer_accounts").update(patch).eq("id", id));
  },

  /** Baja lógica (deleted_at). */
  remove: async (id: string) => {
    check(await loose().from("transfer_accounts").update({ deleted_at: new Date().toISOString() }).eq("id", id));
  },

  /** Sube el logo propio a la carpeta del negocio. Devuelve path y URL pública. */
  uploadLogo: async (file: File): Promise<{ path: string; url: string }> => {
    if (!LOGO_TYPES.includes(file.type)) throw new Error("logo_type");
    if (file.size > LOGO_MAX_BYTES) throw new Error("logo_size");
    const t = await getCurrentTenantId();
    if (!t) throw new Error("no_tenant");
    const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
    const path = `${t}/${crypto.randomUUID()}.${ext}`;
    const sb = createClient();
    const up = await sb.storage.from(TRANSFER_LOGO_BUCKET).upload(path, file, { contentType: file.type });
    if (up.error) throw new Error(up.error.message);
    return { path, url: sb.storage.from(TRANSFER_LOGO_BUCKET).getPublicUrl(path).data.publicUrl };
  },

  removeLogo: async (path: string) => {
    await createClient().storage.from(TRANSFER_LOGO_BUCKET).remove([path]);
  },

  saveSettings: async (v: { showScreen: boolean; requireReference: boolean }) => {
    check(
      await loose().rpc("transfer_settings_save", {
        p_show_screen: v.showScreen,
        p_require_reference: v.requireReference,
      }),
    );
  },
};

export function useTransferAccounts() {
  return useQuery({ queryKey: ["transfer-accounts"], queryFn: transferApi.list, staleTime: 60_000, retry: 1 });
}

export function useTransferMutations() {
  const qc = useQueryClient();
  const inv = () => {
    qc.invalidateQueries({ queryKey: ["transfer-accounts"] });
    qc.invalidateQueries({ queryKey: ["pos", "payment-methods-status"] });
    qc.invalidateQueries({ queryKey: ["tenant-payment-methods"] });
  };
  return {
    save: useMutation({
      mutationFn: (v: { id: string | null; input: TransferAccountInput; extra: Parameters<typeof transferApi.save>[2] }) =>
        transferApi.save(v.id, v.input, v.extra),
      onSuccess: inv,
    }),
    patch: useMutation({
      mutationFn: (v: { id: string; patch: Parameters<typeof transferApi.patch>[1] }) => transferApi.patch(v.id, v.patch),
      onSuccess: inv,
    }),
    remove: useMutation({ mutationFn: transferApi.remove, onSuccess: inv }),
    settings: useMutation({ mutationFn: transferApi.saveSettings, onSuccess: inv }),
  };
}

/** ¿El plan permite varias cuentas y elegirlas por sucursal? */
export function useTransferMultiAccount(): boolean {
  const { data: gating } = useGating();
  return gating?.features?.transferencia_multicuenta === true;
}

/** `available`: la lista de cuentas se leyó (la base tiene la migración). */
function useTransferConfigFor(target: ResolveTarget): TransferConfig & { available: boolean } {
  const accounts = useTransferAccounts();
  const { data: overrides } = useConfigOverrides();
  const { data: methods } = usePaymentMethodsStatus();
  const multi = useTransferMultiAccount();
  return useMemo(() => {
    // Los métodos ya vienen con la herencia aplicada para el POS; la base del
    // negocio se arma igual que _config_base y se resuelve contra el destino.
    const row = (methods ?? []).find((m) => m.provider_key === "transfer");
    const base = {
      transfer_show_screen: row?.transfer_show_screen !== false,
      transfer_require_reference: row?.transfer_require_reference === true,
      transfer_accounts: {},
      transfer_default_account: null,
    };
    const eff = resolveEffective("payment_method", "transfer", base, overrides ?? [], target).value;
    return { ...resolveTransferConfig(accounts.data ?? [], eff, multi), available: accounts.isSuccess };
  }, [accounts.data, accounts.isSuccess, overrides, methods, multi, target]);
}

/** Configuración de transferencia del POS (sucursal del POS y caja del equipo). */
export function usePosTransferConfig() {
  return useTransferConfigFor(usePosResolveTarget());
}
