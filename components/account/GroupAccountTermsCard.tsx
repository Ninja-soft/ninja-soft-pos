"use client";

import { useState } from "react";
import { ChevronDown, UsersRound } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import {
  describeAccountConfig,
  effectiveAccountConfig,
  parseOverride,
  type AccountConfig,
} from "@/lib/account/config";
import { useMyTenant } from "@/modules/tenants/hooks";
import { accountErrorMessage } from "@/modules/customers/account";
import type { CustomerGroup } from "@/modules/customers/api";
import { useAccountMutations, useAccountTenantConfig, useCustomerGroups } from "@/modules/customers/hooks";
import { AccountConfigForm, isConfigValid } from "./AccountConfigForm";

// Badge de herencia: relleno suave, sin bordes de color.
export function InheritBadge({ own, label }: { own: boolean; label?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-md px-2 py-0.5 text-xs font-medium",
        own ? "bg-ninja-flame/15 text-ninja-flameSoft" : "bg-muted text-muted-foreground",
      )}
    >
      {label ?? (own ? "Condiciones propias" : "Hereda del negocio")}
    </span>
  );
}

function GroupRow({
  group,
  tenantEffective,
  canEdit,
}: {
  group: CustomerGroup;
  tenantEffective: AccountConfig;
  canEdit: boolean;
}) {
  const { toast } = useToast();
  const { setGroupConfig } = useAccountMutations();
  const saved = parseOverride(group.account_config);
  const [open, setOpen] = useState(false);
  const [own, setOwn] = useState(Boolean(saved));
  const [cfg, setCfg] = useState<AccountConfig>(effectiveAccountConfig(tenantEffective, saved));

  const effective = own ? cfg : tenantEffective;
  const savedEffective = effectiveAccountConfig(tenantEffective, saved);

  async function save() {
    try {
      await setGroupConfig.mutateAsync({ groupId: group.id, config: own ? cfg : null });
      toast({ title: `Condiciones de ${group.name} guardadas`, variant: "success" });
      setOpen(false);
    } catch (e) {
      toast({ title: "No se pudo guardar", description: accountErrorMessage(e), variant: "error" });
    }
  }

  return (
    <li className="rounded-lg bg-muted/30">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-start gap-3 rounded-lg px-3 py-3 text-left transition hover:bg-muted/50"
      >
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{group.name}</span>
            <InheritBadge own={Boolean(saved)} />
          </span>
          <span className="mt-1 block text-xs text-muted-foreground">
            {describeAccountConfig(savedEffective).join(" · ")}
          </span>
        </span>
        <ChevronDown size={16} className={cn("mt-1 shrink-0 transition", open && "rotate-180")} />
      </button>

      {open && (
        <div className="space-y-3 px-3 pb-3">
          <div className="flex items-center justify-between gap-2 rounded-lg bg-background/60 px-3 py-2">
            <span>
              <span className="block text-sm font-medium">Condiciones propias del grupo</span>
              <span className="block text-xs text-muted-foreground">
                Apagado, los clientes del grupo usan las del negocio. Un cliente con condiciones propias pisa las del
                grupo.
              </span>
            </span>
            <Switch
              checked={own}
              disabled={!canEdit}
              onCheckedChange={(v) => {
                setOwn(v);
                if (v && !saved) setCfg(tenantEffective);
              }}
              label="Condiciones propias del grupo"
            />
          </div>

          {own && <AccountConfigForm value={cfg} onChange={setCfg} disabled={!canEdit} />}

          <div className="rounded-lg bg-ninja-flame/10 px-3 py-2 text-sm">
            <div className="text-xs font-medium text-muted-foreground">Así queda para los clientes del grupo</div>
            <ul className="mt-1 grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
              {describeAccountConfig(effective).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>

          {canEdit && (
            <div className="flex justify-end">
              <Button loading={setGroupConfig.isPending} disabled={own && !isConfigValid(cfg)} onClick={save}>
                Guardar
              </Button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

// Condiciones de cuenta corriente por grupo de clientes (Configuración →
// Cuenta corriente). Override parcial en customer_groups.account_config vía
// RPC (dueño/encargado, auditado). Herencia: negocio → grupo → cliente.
export function GroupAccountTermsCard() {
  const { data: me } = useMyTenant();
  const { data: groups, isLoading } = useCustomerGroups();
  const { data: tenantCfg, isLoading: loadingCfg } = useAccountTenantConfig();
  const canEdit = me?.role === "owner" || me?.role === "manager";

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div>
          <div className="flex items-center gap-2 font-semibold">
            <UsersRound size={16} className="text-ninja-flameSoft" /> Condiciones por grupo
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Un grupo (por ejemplo, mayoristas) puede tener plazos, cuotas, punitorios o bloqueo distintos a los del
            negocio.
          </p>
        </div>

        {isLoading || loadingCfg || !tenantCfg ? (
          <SpinnerBlock />
        ) : (groups ?? []).length === 0 ? (
          <p className="rounded-lg bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
            Todavía no tenés grupos de clientes. Creálos desde la ficha de un cliente, en el campo Grupo.
          </p>
        ) : (
          <>
            {!canEdit && (
              <p className="text-sm text-muted-foreground">
                Sólo el dueño o un encargado pueden cambiar las condiciones de un grupo.
              </p>
            )}
            <ul className="space-y-2">
              {(groups ?? []).map((g) => (
                <GroupRow
                  key={`${g.id}:${JSON.stringify(g.account_config)}`}
                  group={g}
                  tenantEffective={tenantCfg.effective}
                  canEdit={canEdit}
                />
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}
