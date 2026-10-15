"use client";

// Configuración de remitos (ADR-136): monto desde el que se avisa que falta
// el COT, jurisdicción por defecto, precios en el remito y leyenda. Dueño o
// encargado (remito_config_save, auditado). Con la feature apagada no se ve.

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { SettingRow, SettingsCard } from "@/components/settings/Settings";
import { useFeature } from "@/modules/saas/gating";
import { useMyTenant } from "@/modules/tenants/hooks";
import { useRemitoConfig, useRemitoMutations } from "@/modules/remitos/api";
import {
  COT_JURISDICTION_LABEL,
  DEFAULT_REMITO_CONFIG,
  remitoErrorMessage,
  type CotJurisdiction,
  type RemitoConfig,
} from "@/lib/remitos/logic";

const field =
  "h-11 w-full rounded-lg border border-border bg-background/40 px-3 text-sm text-foreground outline-none focus:border-[color-mix(in_srgb,var(--foreground)_30%,transparent)]";

export function RemitoSettingsCard() {
  const enabled = useFeature("entregas_remitos") === true;
  const { toast } = useToast();
  const { data: me } = useMyTenant();
  const canEdit = Boolean(me?.canManage);
  const { data: cfg } = useRemitoConfig(enabled);
  const m = useRemitoMutations();
  const [c, setC] = useState<RemitoConfig>(DEFAULT_REMITO_CONFIG);
  const [threshold, setThreshold] = useState("");
  useEffect(() => {
    if (!cfg) return;
    setC(cfg);
    setThreshold(cfg.cot_threshold == null ? "" : String(cfg.cot_threshold));
  }, [cfg]);
  if (!enabled) return null;
  const tOk = threshold.trim() === "" || /^[0-9]{1,12}([.,][0-9]{1,2})?$/.test(threshold.trim());
  const next = { ...c, cot_threshold: threshold.trim() ? Number(threshold.replace(",", ".")) : null };
  const dirty = Boolean(cfg) && JSON.stringify(next) !== JSON.stringify(cfg);

  async function save() {
    try {
      await m.saveConfig.mutateAsync(next);
      toast({ title: "Remitos actualizados", variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo guardar", description: remitoErrorMessage(e), variant: "error" });
    }
  }

  return (
    <SettingsCard
      title="Remitos y COT"
      description="Remitos de entrega y de envío con numeración propia por sucursal. El COT lo pedís en ARBA o AGIP y lo cargás en el remito."
      actions={
        canEdit ? (
          <Button size="sm" onClick={save} loading={m.saveConfig.isPending} disabled={!dirty || !tOk}>
            Guardar
          </Button>
        ) : undefined
      }
    >
      <SettingRow
        label="Avisar que falta el COT desde"
        description="Valor declarado desde el que el remito te avisa que el traslado suele necesitar COT en PBA o CABA. El monto lo fija cada organismo y cambia: cargá el vigente. Vacío, no avisa."
        htmlFor="r-cot"
      >
        <div className="flex max-w-[14rem] items-center gap-2">
          <span className="text-sm text-muted-foreground">$</span>
          <input id="r-cot" inputMode="decimal" disabled={!canEdit} value={threshold} onChange={(e) => setThreshold(e.target.value)} className={field} />
        </div>
        {!tOk && <p className="mt-1 text-xs text-danger">Poné un monto válido.</p>}
      </SettingRow>
      <SettingRow label="Jurisdicción del COT por defecto" htmlFor="r-jur">
        <select
          id="r-jur"
          disabled={!canEdit}
          className={field}
          value={c.cot_jurisdiction}
          onChange={(e) => setC({ ...c, cot_jurisdiction: e.target.value as CotJurisdiction })}
        >
          {(Object.keys(COT_JURISDICTION_LABEL) as CotJurisdiction[]).map((j) => (
            <option key={j} value={j} className="bg-popover text-popover-foreground">
              {COT_JURISDICTION_LABEL[j]}
            </option>
          ))}
        </select>
      </SettingRow>
      <SettingRow label="Precios en el remito" description="Por defecto, el remito sale sin precios (se puede cambiar al emitir).">
        <Switch label="Precios en el remito" disabled={!canEdit} checked={c.show_prices} onCheckedChange={(v) => setC({ ...c, show_prices: v })} />
      </SettingRow>
      <SettingRow label="Leyenda al pie" description="Por ejemplo, condiciones de traslado o de recepción." htmlFor="r-leg" stacked>
        <input
          id="r-leg"
          disabled={!canEdit}
          maxLength={300}
          value={c.legend ?? ""}
          onChange={(e) => setC({ ...c, legend: e.target.value || null })}
          className={field}
        />
      </SettingRow>
    </SettingsCard>
  );
}
