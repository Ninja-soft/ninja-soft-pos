"use client";

// Configuración › Logística › Expedición (ADR-165, R14 a R17): escaneo al
// armar, al cargar y al entregar (no, opcional u obligatorio), entrega
// parcial, adónde va lo roto, foto obligatoria de la rotura y qué pasa con lo
// que no se entregó. Guarda el dueño (logistics.settings); el resto lo ve.

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { SettingRow, SettingsCard } from "@/components/settings/Settings";
import {
  DEFAULT_EXPEDITION_SETTINGS,
  SCAN_MODE_LABEL,
  SCAN_STAGE_HINT,
  SCAN_STAGE_LABEL,
  expeditionErrorMessage,
  type ExpeditionSettings,
  type ScanMode,
} from "@/lib/logistics/expedition";
import { useExpeditionMutations, useExpeditionSettings } from "@/modules/logistics/expedition";

const MODE_OPTIONS = (["no", "opcional", "obligatorio"] as ScanMode[]).map((v) => ({ value: v, label: SCAN_MODE_LABEL[v] }));

export function ExpeditionSettingsCard({ canEdit }: { canEdit: boolean }) {
  const { toast } = useToast();
  const { data: cfg } = useExpeditionSettings();
  const m = useExpeditionMutations();
  const [s, setS] = useState<ExpeditionSettings>(DEFAULT_EXPEDITION_SETTINGS);
  useEffect(() => {
    if (cfg) setS(cfg);
  }, [cfg]);
  const dirty = useMemo(() => Boolean(cfg) && JSON.stringify({ ...s, saved: false }) !== JSON.stringify({ ...cfg, saved: false }), [s, cfg]);
  const set = <K extends keyof ExpeditionSettings>(k: K, v: ExpeditionSettings[K]) => canEdit && setS((x) => ({ ...x, [k]: v }));

  async function save() {
    try {
      const { saved: _saved, ...rest } = s;
      await m.saveSettings.mutateAsync(rest);
      toast({ title: "Expedición actualizada", variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo guardar", description: expeditionErrorMessage(e), variant: "error" });
    }
  }

  const actions = canEdit ? (
    <Button size="sm" onClick={() => void save()} loading={m.saveSettings.isPending} disabled={!dirty}>
      Guardar
    </Button>
  ) : undefined;

  return (
    <div className="space-y-6">
      <SettingsCard
        title="Escaneo de productos"
        description="Para controlar lo que sale y evitar cruces: si se escanea algo de otra entrega, suena y queda registrado. Sirve un lector USB o la cámara del celular."
        actions={actions}
      >
        {(["armado", "carga", "entrega"] as const).map((stage) => {
          const key = stage === "armado" ? "scan_on_pick" : stage === "carga" ? "scan_on_load" : "scan_on_deliver";
          return (
            <SettingRow key={stage} label={SCAN_STAGE_LABEL[stage]} description={SCAN_STAGE_HINT[stage]}>
              <Segmented<ScanMode> size="sm" aria-label={SCAN_STAGE_LABEL[stage]} value={s[key]} onChange={(v) => set(key, v)} options={MODE_OPTIONS} />
            </SettingRow>
          );
        })}
      </SettingsCard>

      <SettingsCard title="Entregas con problemas" description="Qué pasa cuando no se entrega todo: algo roto, algo que el cliente no quiere o algo que faltó." actions={actions}>
        <SettingRow label="Permitir entrega parcial" description="Apagado, cada entrega se entrega completa o vuelve entera.">
          <Switch label="Permitir entrega parcial" disabled={!canEdit} checked={s.allow_partial} onCheckedChange={(v) => set("allow_partial", v)} />
        </SettingRow>
        <SettingRow label="Lo roto" description="Siempre descuenta del stock vendible. Con depósito, queda guardado en el depósito de merma o devolución de la sucursal (para reclamar al proveedor).">
          <Segmented<"merma" | "deposito">
            size="sm"
            aria-label="Lo roto"
            value={s.damaged_destination}
            onChange={(v) => set("damaged_destination", v)}
            options={[
              { value: "merma", label: "Baja como merma" },
              { value: "deposito", label: "Al depósito de merma" },
            ]}
          />
        </SettingRow>
        <SettingRow label="Foto obligatoria de lo roto" description="La foto queda con la merma y con la entrega.">
          <Switch label="Foto obligatoria de lo roto" disabled={!canEdit} checked={s.damage_requires_photo} onCheckedChange={(v) => set("damage_requires_photo", v)} />
        </SettingRow>
        <SettingRow label="Lo que no se entregó" description="Lo roto y lo que faltó en una entrega parcial. Lo que el cliente rechazó siempre queda para revisar.">
          <Segmented<"reprogramar" | "revisar">
            size="sm"
            aria-label="Lo que no se entregó"
            value={s.undelivered_action}
            onChange={(v) => set("undelivered_action", v)}
            options={[
              { value: "reprogramar", label: "Reprogramar solo" },
              { value: "revisar", label: "Dejar para revisar" },
            ]}
          />
        </SettingRow>
        <div className="space-y-1 px-5 py-4 text-sm">
          <p className="font-medium">¿Cómo queda?</p>
          <p className="text-muted-foreground">
            Una entrega de 5 productos llega con 1 roto y 1 rechazado: se entregan 3, el roto se descuenta como merma con su foto
            {s.undelivered_action === "reprogramar" ? ", sale una entrega nueva con el reemplazo" : ""} y lo rechazado queda en Con problemas hasta que hagas la devolución o lo vuelvas a enviar.
          </p>
        </div>
      </SettingsCard>

      <SettingsCard title="Pedir stock a otra sucursal" description="Desde una entrega en Pendientes que no tiene stock.">
        <div className="space-y-1 px-5 py-4 text-sm text-muted-foreground">
          <p>Arma un traslado con lo que falta y lo deja enlazado a la entrega. Cuando la sucursal lo recibe, la entrega deja de esperar sola.</p>
          <p>Quién puede y si necesita aprobación se configura en Traslados (lo piden el dueño o un encargado).</p>
        </div>
      </SettingsCard>
    </div>
  );
}
ExpeditionSettingsCard.displayName = "ExpeditionSettingsCard";
