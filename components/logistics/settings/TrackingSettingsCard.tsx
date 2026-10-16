"use client";

// Configuración › Logística › Seguimiento (ADR-164): cada cuánto manda el
// teléfono, cuándo avisa un desvío, cuánto se guardan las posiciones y con
// qué velocidad y minutos por parada se calcula la llegada estimada.

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { SettingRow, SettingsCard } from "@/components/settings/Settings";
import { logisticsErrorMessage } from "@/lib/logistics/logic";
import { DEFAULT_TRACKING, trackingRange, type TrackingSettings } from "@/lib/logistics/tracking";
import { useMapMutations, useTrackingSettings } from "@/modules/logistics/map";

type NumKey = "interval_s" | "deviation_m" | "deviation_minutes" | "retention_days" | "avg_speed_kmh" | "service_minutes" | "min_move_m";

const FIELDS: { k: NumKey; label: string; unit: string; desc: string; step?: number }[] = [
  { k: "interval_s", label: "Cada cuánto manda la posición", unit: "segundos", desc: "Con el camión en movimiento. Quieto, cada 2 minutos. Menos segundos gasta más batería." },
  { k: "min_move_m", label: "Movimiento mínimo", unit: "metros", desc: "Si no se movió esto, no manda otra posición hasta los 2 minutos.", step: 10 },
  { k: "deviation_m", label: "Desvío de la ruta", unit: "metros", desc: "A esta distancia de la ruta planificada se considera fuera de ruta.", step: 50 },
  { k: "deviation_minutes", label: "Minutos fuera de ruta para avisar", unit: "minutos", desc: "Te avisamos (a vos y al encargado) si sigue afuera este tiempo." },
  { k: "avg_speed_kmh", label: "Velocidad promedio", unit: "km/h", desc: "Para la llegada estimada a cada parada." },
  { k: "service_minutes", label: "Minutos en cada parada", unit: "minutos", desc: "Lo que tarda en bajar y entregar." },
  { k: "retention_days", label: "Guardar el recorrido", unit: "días", desc: "Después se borra solo. Las entregas, firmas y fotos se conservan." },
];

export function TrackingSettingsCard({ canEdit }: { canEdit: boolean }) {
  const { toast } = useToast();
  const { data } = useTrackingSettings();
  const m = useMapMutations();
  const [s, setS] = useState<TrackingSettings>(DEFAULT_TRACKING);
  useEffect(() => {
    if (data) setS(data);
  }, [data]);
  const dirty = useMemo(() => Boolean(data) && JSON.stringify({ ...s, saved: false }) !== JSON.stringify({ ...data, saved: false }), [s, data]);

  async function save() {
    try {
      const { saved: _saved, ...rest } = s;
      await m.saveTracking.mutateAsync(rest);
      toast({ title: "Seguimiento actualizado", variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo guardar", description: logisticsErrorMessage(e), variant: "error" });
    }
  }

  return (
    <SettingsCard
      title="Seguimiento del camión"
      description="La app del repartidor manda la ubicación sólo con la hoja en curso. El mapa en vivo se actualiza cada 15 segundos."
      actions={
        canEdit ? (
          <Button size="sm" onClick={save} loading={m.saveTracking.isPending} disabled={!dirty}>
            Guardar
          </Button>
        ) : undefined
      }
    >
      <SettingRow label="Seguir la posición" description="Apagado, el mapa muestra las paradas y las entregas, pero no dónde está el camión.">
        <Switch label="Seguir la posición" disabled={!canEdit} checked={s.enabled} onCheckedChange={(v) => setS((x) => ({ ...x, enabled: v }))} />
      </SettingRow>
      {FIELDS.map((f) => {
        const [min, max] = trackingRange(f.k);
        return (
          <SettingRow key={f.k} label={f.label} description={f.desc} htmlFor={`trk-${f.k}`}>
            <div className="flex max-w-[14rem] items-center gap-2">
              <input
                id={`trk-${f.k}`}
                type="number"
                inputMode="numeric"
                min={min}
                max={max}
                step={f.step ?? 1}
                disabled={!canEdit}
                value={s[f.k]}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setS((x) => ({ ...x, [f.k]: Number.isFinite(v) ? Math.max(min, Math.min(max, Math.round(v))) : x[f.k] }));
                }}
                className="h-11 w-24 rounded-lg border border-input bg-background px-3 text-sm"
              />
              <span className="text-sm text-muted-foreground">{f.unit}</span>
            </div>
          </SettingRow>
        );
      })}
    </SettingsCard>
  );
}
TrackingSettingsCard.displayName = "TrackingSettingsCard";
