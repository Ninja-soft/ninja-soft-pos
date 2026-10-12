"use client";

import { useEffect, useState } from "react";
import { Wallet } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { useMyTenant } from "@/modules/tenants/hooks";
import { useFeature } from "@/modules/saas/gating";
import { accountErrorMessage } from "@/modules/customers/account";
import { useAccountMutations, useAccountTenantConfig } from "@/modules/customers/hooks";
import type { AccountConfig } from "@/lib/account/config";
import { AccountConfigForm, isConfigValid } from "./AccountConfigForm";

// Configuración de cuenta corriente del negocio (Configuración → Cuenta
// corriente). Guarda pos_settings.account_config vía RPC (dueño, auditado).
export function AccountSettingsCard() {
  const { toast } = useToast();
  const { data: me } = useMyTenant();
  const { data, isLoading } = useAccountTenantConfig();
  const { saveSettings } = useAccountMutations();
  const punitorios = useFeature("cc_punitorios");
  const cobranza = useFeature("cc_cobranza");
  const [cfg, setCfg] = useState<AccountConfig | null>(null);

  useEffect(() => {
    if (data) setCfg(data.effective);
  }, [data]);

  const isOwner = me?.role === "owner";

  async function save() {
    if (!cfg) return;
    try {
      await saveSettings.mutateAsync(cfg);
      toast({ title: "Configuración guardada", variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo guardar", description: accountErrorMessage(e), variant: "error" });
    }
  }

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div>
          <div className="flex items-center gap-2 font-semibold">
            <Wallet size={16} className="text-ninja-flameSoft" /> Condiciones generales
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Plazos, cuotas, punitorios, bloqueo por mora y recordatorios. Cada cliente puede tener condiciones
            propias desde su cuenta.
          </p>
        </div>

        {(punitorios === false || cobranza === false) && (
          <p className="rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            {punitorios === false && "Los punitorios se configuran acá pero se calculan sólo con un plan que los incluya. "}
            {cobranza === false && "Los recordatorios automáticos requieren la gestión de cobranza en tu plan."}
          </p>
        )}

        {isLoading || !cfg ? (
          <SpinnerBlock />
        ) : (
          <>
            <AccountConfigForm value={cfg} onChange={setCfg} disabled={!isOwner} />
            {isOwner ? (
              <div className="flex justify-end">
                <Button loading={saveSettings.isPending} disabled={!isConfigValid(cfg)} onClick={save}>
                  Guardar
                </Button>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Sólo el dueño puede cambiar esta configuración.</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
