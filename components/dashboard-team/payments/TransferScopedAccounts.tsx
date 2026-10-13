"use client";

import { useState } from "react";
import { Lock } from "lucide-react";
import { Switch } from "@/components/ui/Switch";
import { Callout } from "@/components/ui/Callout";
import { useToast } from "@/components/ui/Toast";
import { UpgradeModal } from "@/components/saas/UpgradeModal";
import { SettingsCard, SettingsNotice } from "@/components/settings/Settings";
import { InheritBadge, useScopeNamer, type ScopeSel } from "@/components/config/ScopedConfig";
import { BankLogo } from "@/components/payments/BankLogo";
import { cn } from "@/lib/utils/cn";
import { configErrorMessage, inheritState, parentTarget, resolveEffective, type ResolveTarget } from "@/lib/config/inheritance";
import { resolveTransferConfig } from "@/lib/payments/transfer";
import { useConfigMutations, useConfigOverrides, useStoreGroupMap } from "@/modules/config/hooks";
import { useTransferAccounts, useTransferMultiAccount } from "@/modules/payments/transfer";

// Cuentas de transferencia por grupo o sucursal (ADR-055 sobre ADR-049): qué
// cuentas muestra el POS y cuál va por defecto. Override por cuenta en el mapa
// transfer_accounts (id → visible) y transfer_default_account. La caja no
// elige cuentas (sólo puede omitir la pantalla, en el panel de campos).

type Scope = Exclude<ScopeSel, { scope: "tenant" }>;

export function TransferScopedAccounts({ scope }: { scope: Scope }) {
  const { toast } = useToast();
  const { data: accounts = [] } = useTransferAccounts();
  const { data: overrides } = useConfigOverrides();
  const { data: groupMap } = useStoreGroupMap();
  const multi = useTransferMultiAccount();
  const mut = useConfigMutations();
  const name = useScopeNamer();
  const [upgrade, setUpgrade] = useState(false);

  if (scope.scope === "register") return null;
  const live = accounts.filter((a) => a.is_active);
  if (live.length === 0) return null;

  const storeId = scope.scope === "store" ? scope.id : null;
  const target: ResolveTarget = {
    multiStore: true,
    multiRegister: true,
    storeId,
    registerId: null,
    groupId: scope.scope === "store_group" ? scope.id : storeId ? (groupMap?.[storeId] ?? null) : null,
  };
  const ovs = overrides ?? [];
  const base = { transfer_accounts: {}, transfer_default_account: null };
  const eff = resolveEffective("payment_method", "transfer", base, ovs, target);
  const inherited = resolveEffective("payment_method", "transfer", base, ovs, parentTarget(scope.scope, target));
  const cfg = resolveTransferConfig(accounts, eff.value, true);
  const visible = new Set(cfg.accounts.map((a) => a.id));
  const customVis = inheritState(ovs, scope.scope, scope.id, "payment_method", "transfer", "transfer_accounts") === "custom";
  const customDef = inheritState(ovs, scope.scope, scope.id, "payment_method", "transfer", "transfer_default_account") === "custom";
  const own = ovs.find(
    (o) => !o.deleted_at && o.scope === scope.scope && o.scope_id === scope.id && o.domain === "payment_method" && o.domain_key === "transfer",
  );
  const ownVis = (own?.patch?.transfer_accounts ?? {}) as Record<string, boolean>;
  const srcName = (field: string) => {
    const src = inherited.sources[field];
    return !src || src === "tenant" ? "Todo el negocio" : name(src.split(":")[0] as "store_group", src.split(":")[1]);
  };

  const onErr = (e: unknown) => toast({ title: configErrorMessage(e), variant: "error" });
  const set = (patch: Record<string, unknown>) => {
    if (!multi) return setUpgrade(true);
    mut.set.mutate({ scope: scope.scope, scopeId: scope.id, domain: "payment_method", domainKey: "transfer", patch }, { onError: onErr });
  };
  const reset = (field: string) =>
    mut.set.mutate(
      { scope: scope.scope, scopeId: scope.id, domain: "payment_method", domainKey: "transfer", clear: [field] },
      { onError: onErr },
    );

  return (
    <SettingsCard title="Cuentas de transferencia" description="Qué cuentas muestra el POS acá y cuál va primero.">
      {!multi && (
        <SettingsNotice>
          <Callout
            tone="neutral"
            icon={Lock}
            actions={
              <button type="button" onClick={() => setUpgrade(true)} className="text-xs font-semibold text-foreground hover:underline">
                Ver planes
              </button>
            }
          >
            Elegir cuentas distintas por sucursal viene con Varias cuentas de transferencia.
          </Callout>
        </SettingsNotice>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-5 pt-3">
        <span className="text-xs text-muted-foreground">Cuentas:</span>
        <InheritBadge custom={customVis} source={srcName("transfer_accounts")} onReset={() => reset("transfer_accounts")} busy={mut.set.isPending} />
        <span className="text-xs text-muted-foreground">Por defecto:</span>
        <InheritBadge
          custom={customDef}
          source={srcName("transfer_default_account")}
          onReset={() => reset("transfer_default_account")}
          busy={mut.set.isPending}
        />
      </div>
      <ul className="divide-y divide-border">
        {live.map((a) => {
          const on = visible.has(a.id);
          const isDef = cfg.defaultAccountId === a.id;
          return (
            <li key={a.id} className={cn("flex items-center gap-3 px-5 py-3", !on && "opacity-60")}>
              <BankLogo slug={a.bank_slug} customUrl={a.custom_logo_url} name={a.bank_name} size={32} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{a.bank_name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {a.holder_name}
                  {a.alias ? ` · ${a.alias}` : ""}
                </p>
              </div>
              <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                <input
                  type="radio"
                  name={`ta-default-${scope.id}`}
                  checked={isDef}
                  disabled={!on || mut.set.isPending}
                  onChange={() => set({ transfer_default_account: a.id })}
                  className="h-4 w-4 accent-[var(--pos-solid)]"
                />
                Por defecto
              </label>
              <Switch
                checked={on}
                disabled={mut.set.isPending}
                onCheckedChange={(c) => set({ transfer_accounts: { ...ownVis, [a.id]: c } })}
                label={`Mostrar ${a.bank_name} en ${name(scope.scope, scope.id)}`}
              />
            </li>
          );
        })}
      </ul>
      {upgrade && (
        <UpgradeModal
          open
          onOpenChange={(o) => !o && setUpgrade(false)}
          featureKey="transferencia_multicuenta"
          featureLabel="Varias cuentas de transferencia"
        />
      )}
    </SettingsCard>
  );
}
