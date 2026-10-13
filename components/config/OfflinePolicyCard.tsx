"use client";

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CloudOff } from "lucide-react";
import { SettingRow, SettingsCard } from "@/components/settings/Settings";
import { Switch } from "@/components/ui/Switch";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { usePosSettings } from "@/modules/pos/hooks";
import { useMyTenant } from "@/modules/tenants/hooks";
import { offlineApi } from "@/modules/pos/offline/api";
import { OFFLINE_POLICY_DEFAULTS, offlinePolicyError, type OfflinePolicy } from "@/lib/pos/offline/policy";

// Política de venta sin conexión (ADR-077, FLAG-OPERATIVO): el dueño decide si
// el POS sigue vendiendo cuando se corta internet y con qué límites. El
// servidor la aplica al sincronizar (lo que se pase queda en revisión).
export function OfflinePolicyCard() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: me } = useMyTenant();
  const canEdit = me?.role === "owner" || me?.role === "manager";
  const { data: settings } = usePosSettings();
  const [p, setP] = useState<OfflinePolicy>(OFFLINE_POLICY_DEFAULTS);
  useEffect(() => {
    if (settings?.offlinePolicy) setP(settings.offlinePolicy);
  }, [settings?.offlinePolicy]);
  const err = offlinePolicyError(p);
  const save = useMutation({
    mutationFn: () => offlineApi.savePolicy(p),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["pos", "settings"] });
      toast({ title: "Venta sin conexión guardada", variant: "success" });
    },
    onError: (e) =>
      toast({ title: "No se pudo guardar", description: e instanceof Error ? e.message : undefined, variant: "error" }),
  });
  const num = (v: string) => (v.trim() === "" ? NaN : Number(v));

  return (
    <SettingsCard
      title="Venta sin conexión"
      icon={CloudOff}
      description="Si se corta internet, el POS sigue cobrando en efectivo, transferencia o tarjeta en posnet y envía las ventas al volver."
      actions={
        canEdit ? (
          <Button size="sm" disabled={Boolean(err) || save.isPending} onClick={() => save.mutate()}>
            Guardar
          </Button>
        ) : null
      }
    >
      <SettingRow label="Permitir vender sin conexión" description="Apagado, el POS no cobra cuando no hay internet.">
        <Switch
          checked={p.enabled}
          disabled={!canEdit}
          label="Permitir vender sin conexión"
          onCheckedChange={(v) => setP({ ...p, enabled: v })}
        />
      </SettingRow>
      <SettingRow label="Monto máximo por venta" description="En pesos. Una venta más grande espera a tener conexión.">
        <Input
          type="number"
          inputMode="decimal"
          min={0}
          value={Number.isFinite(p.maxAmount) ? p.maxAmount : ""}
          disabled={!canEdit || !p.enabled}
          onChange={(e) => setP({ ...p, maxAmount: num(e.target.value) })}
        />
      </SettingRow>
      <SettingRow label="Ventas por turno" description="Máximo de ventas sin conexión por cajero en un turno.">
        <Input
          type="number"
          inputMode="numeric"
          min={1}
          max={500}
          value={Number.isFinite(p.maxSales) ? p.maxSales : ""}
          disabled={!canEdit || !p.enabled}
          onChange={(e) => setP({ ...p, maxSales: num(e.target.value) })}
        />
      </SettingRow>
      <SettingRow
        label="Plazo para enviarlas"
        description="Horas. Lo que llegue después queda para revisar en Ventas offline."
      >
        <Input
          type="number"
          inputMode="numeric"
          min={1}
          max={168}
          value={Number.isFinite(p.maxHours) ? p.maxHours : ""}
          disabled={!canEdit || !p.enabled}
          onChange={(e) => setP({ ...p, maxHours: num(e.target.value) })}
          error={err ?? undefined}
        />
      </SettingRow>
    </SettingsCard>
  );
}
