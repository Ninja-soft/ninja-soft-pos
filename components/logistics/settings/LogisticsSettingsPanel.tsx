"use client";

// Configuración › Logística (ADR-161, R6, R11, R21): cómo trabaja el negocio
// sus envíos, en pestañas. Remitos (cuándo, copias con su leyenda y modelo,
// más COT, precios y leyenda de remito_config), Entrega en la calle (qué se
// exige al marcar entregado, distancia máxima, intentos y motivos de no
// entrega), Orígenes del reparto y Flota. Guarda el dueño (logistics.settings);
// el resto lo ve sólo para leer.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { SettingRow, SettingsCard } from "@/components/settings/Settings";
import { RemitoSettingsCard } from "@/components/remitos/RemitoSettingsCard";
import { OriginsCard } from "@/components/logistics/settings/OriginsCard";
import { ExpeditionSettingsCard } from "@/components/logistics/settings/ExpeditionSettingsCard";
import { TrackingSettingsCard } from "@/components/logistics/settings/TrackingSettingsCard";
import { selectCls } from "@/components/stock/transfers/shared";
import {
  DEFAULT_LOGISTICS_SETTINGS,
  REMITO_MODEL_LABEL,
  REMITO_POLICY_HINT,
  REMITO_POLICY_LABEL,
  logisticsErrorMessage,
  reasonKeyFromLabel,
  settingsProblems,
  type FailureReason,
  type LogisticsSettings,
  type RemitoModel,
  type RemitoPolicy,
} from "@/lib/logistics/logic";
import { useCan, useLogisticsMutations, useLogisticsSettings } from "@/modules/logistics/api";
import { useFeature } from "@/modules/saas/gating";

type Tab = "remitos" | "entrega" | "expedicion" | "origenes" | "seguimiento" | "flota";

const COPY_NAMES = ["Original", "Duplicado", "Triplicado"];

function ReasonsEditor({ value, onChange, disabled }: { value: FailureReason[]; onChange: (v: FailureReason[]) => void; disabled: boolean }) {
  const [label, setLabel] = useState("");
  const set = (i: number, patch: Partial<FailureReason>) => onChange(value.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= value.length) return;
    const next = [...value];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  return (
    <div className="space-y-2">
      <ul className="divide-y divide-border rounded-lg ring-1 ring-border">
        {value.map((r, i) => (
          <li key={r.key} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center">
            <input
              aria-label="Motivo"
              disabled={disabled}
              value={r.label}
              maxLength={60}
              onChange={(e) => set(i, { label: e.target.value })}
              className="h-10 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 text-sm"
            />
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <label className="flex items-center gap-1.5">
                <input type="checkbox" disabled={disabled} checked={r.requires_photo} onChange={(e) => set(i, { requires_photo: e.target.checked })} /> Pide foto
              </label>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" disabled={disabled} checked={r.requires_note} onChange={(e) => set(i, { requires_note: e.target.checked })} /> Pide nota
              </label>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" disabled={disabled} checked={r.active} onChange={(e) => set(i, { active: e.target.checked })} /> Activo
              </label>
              {!disabled && (
                <span className="flex">
                  <Button size="icon" variant="ghost" className="h-8 w-8" aria-label="Subir" onClick={() => move(i, -1)} disabled={i === 0}>
                    <ArrowUp size={14} />
                  </Button>
                  <Button size="icon" variant="ghost" className="h-8 w-8" aria-label="Bajar" onClick={() => move(i, 1)} disabled={i === value.length - 1}>
                    <ArrowDown size={14} />
                  </Button>
                  <Button size="icon" variant="ghost" className="h-8 w-8 text-danger" aria-label={`Quitar ${r.label}`} onClick={() => onChange(value.filter((_, k) => k !== i))}>
                    <Trash2 size={14} />
                  </Button>
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>
      {!disabled && value.length < 20 && (
        <div className="flex gap-2">
          <input
            aria-label="Nuevo motivo"
            placeholder="Nuevo motivo, por ejemplo Portón cerrado"
            value={label}
            maxLength={60}
            onChange={(e) => setLabel(e.target.value)}
            className="h-10 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 text-sm"
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={label.trim().length < 2}
            onClick={() => {
              onChange([...value, { key: reasonKeyFromLabel(label, value.map((r) => r.key)), label: label.trim(), requires_photo: false, requires_note: false, active: true }]);
              setLabel("");
            }}
          >
            <Plus size={15} /> Sumar
          </Button>
        </div>
      )}
    </div>
  );
}

export function LogisticsSettingsPanel() {
  const enabled = useFeature("pedidos_despacho") === true;
  const reparto = useFeature("reparto_propio") === true;
  const canEdit = useCan("logistics.settings");
  const { toast } = useToast();
  const { data: cfg } = useLogisticsSettings(enabled);
  const m = useLogisticsMutations();
  const [tab, setTab] = useState<Tab>("remitos");
  const [s, setS] = useState<LogisticsSettings>(DEFAULT_LOGISTICS_SETTINGS);
  useEffect(() => {
    if (cfg) setS(cfg);
  }, [cfg]);
  const dirty = useMemo(() => Boolean(cfg) && JSON.stringify({ ...s, saved: false }) !== JSON.stringify({ ...cfg, saved: false }), [s, cfg]);
  const problems = settingsProblems(s);

  if (!enabled) return null;
  const set = <K extends keyof LogisticsSettings>(k: K, v: LogisticsSettings[K]) => setS((x) => ({ ...x, [k]: v }));

  async function save() {
    try {
      const { saved: _saved, ...rest } = s;
      await m.saveSettings.mutateAsync(rest);
      toast({ title: "Logística actualizada", variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo guardar", description: logisticsErrorMessage(e), variant: "error" });
    }
  }

  const saveBar =
    canEdit && (tab === "remitos" || tab === "entrega") ? (
      <Button size="sm" onClick={save} loading={m.saveSettings.isPending} disabled={!dirty || problems.length > 0}>
        Guardar
      </Button>
    ) : undefined;

  return (
    <div className="space-y-6">
      <Segmented
        value={tab}
        onChange={setTab}
        aria-label="Logística"
        scroll
        options={[
          { value: "remitos", label: "Remitos" },
          { value: "entrega", label: "Entrega en la calle" },
          { value: "expedicion", label: "Expedición" },
          { value: "origenes", label: "Orígenes" },
          { value: "seguimiento", label: "Seguimiento" },
          { value: "flota", label: "Flota y equipo" },
        ]}
      />
      {!canEdit && (tab === "remitos" || tab === "entrega" || tab === "expedicion") && (
        <p className="text-sm text-muted-foreground">Sólo el dueño cambia esta configuración. Ves cómo está.</p>
      )}

      {tab === "remitos" && (
        <>
          <SettingsCard title="Cuándo y cómo sale el remito" description="Lo que se usa al emitir y al imprimir cada remito." actions={saveBar}>
            <SettingRow label="Emitir remito" description={REMITO_POLICY_HINT[s.remito_policy]} htmlFor="lg-policy">
              <select id="lg-policy" disabled={!canEdit} className={selectCls} value={s.remito_policy} onChange={(e) => set("remito_policy", e.target.value as RemitoPolicy)}>
                {(Object.keys(REMITO_POLICY_LABEL) as RemitoPolicy[]).map((k) => (
                  <option key={k} value={k} className="bg-popover text-popover-foreground">
                    {REMITO_POLICY_LABEL[k]}
                  </option>
                ))}
              </select>
            </SettingRow>
            <SettingRow label="Copias" description="Cuántas se imprimen de cada remito y qué dice cada una.">
              <Segmented
                size="sm"
                value={String(s.remito_copies) as "1" | "2" | "3"}
                onChange={(v) => canEdit && set("remito_copies", Number(v) as 1 | 2 | 3)}
                aria-label="Copias"
                options={[
                  { value: "1", label: "1" },
                  { value: "2", label: "2" },
                  { value: "3", label: "3" },
                ]}
              />
              <div className="mt-3 space-y-2">
                {s.remito_copy_labels.slice(0, s.remito_copies).map((l, i) => (
                  <Input
                    key={i}
                    label={COPY_NAMES[i]}
                    disabled={!canEdit}
                    value={l}
                    maxLength={40}
                    onChange={(e) => {
                      const next = [...s.remito_copy_labels] as [string, string, string];
                      next[i] = e.target.value;
                      set("remito_copy_labels", next);
                    }}
                  />
                ))}
              </div>
            </SettingRow>
            <SettingRow label="Modelo" description="A4 completo, medio A4 (dos por hoja), ticket de 80 mm o sobre tu talonario preimpreso." htmlFor="lg-model">
              <select id="lg-model" disabled={!canEdit} className={selectCls} value={s.remito_model} onChange={(e) => set("remito_model", e.target.value as RemitoModel)}>
                {(Object.keys(REMITO_MODEL_LABEL) as RemitoModel[]).map((k) => (
                  <option key={k} value={k} className="bg-popover text-popover-foreground">
                    {REMITO_MODEL_LABEL[k]}
                  </option>
                ))}
              </select>
              {s.remito_model === "preimpreso" && (
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <Input
                    label="Corrimiento horizontal (mm)"
                    type="number"
                    step="0.5"
                    disabled={!canEdit}
                    value={String(s.preprinted_offset_x_mm)}
                    onChange={(e) => set("preprinted_offset_x_mm", Math.max(-30, Math.min(30, Number(e.target.value) || 0)))}
                  />
                  <Input
                    label="Corrimiento vertical (mm)"
                    type="number"
                    step="0.5"
                    disabled={!canEdit}
                    value={String(s.preprinted_offset_y_mm)}
                    onChange={(e) => set("preprinted_offset_y_mm", Math.max(-30, Math.min(30, Number(e.target.value) || 0)))}
                  />
                  <p className="col-span-2 text-xs text-muted-foreground">Imprimí uno de prueba en una hoja común, ponela sobre el talonario a contraluz y corregí.</p>
                </div>
              )}
            </SettingRow>
          </SettingsCard>
          <RemitoSettingsCard />
        </>
      )}

      {tab === "entrega" && (
        <SettingsCard title="Qué se pide en cada entrega" description="Lo controla el servidor: sin esto, el repartidor no puede marcar entregado." actions={saveBar}>
          {(
            [
              ["require_geo", "Ubicación del teléfono", "Se guarda dónde se marcó la entrega."],
              ["require_signature", "Firma en pantalla", "Quien recibe firma con el dedo en el celular."],
              ["require_receiver_name", "Nombre de quien recibe", null],
              ["require_receiver_doc", "DNI de quien recibe", null],
              ["require_photo", "Foto de la entrega", "Del paquete entregado o de la puerta."],
              ["require_remito_photo", "Foto del remito firmado", "El duplicado firmado queda en el remito."],
            ] as const
          ).map(([k, label, desc]) => (
            <SettingRow key={k} label={label} description={desc ?? undefined}>
              <Switch label={label} disabled={!canEdit} checked={s[k]} onCheckedChange={(v) => set(k, v)} />
            </SettingRow>
          ))}
          <SettingRow label="Distancia máxima a la dirección" description="Si se marca más lejos, el teléfono pide confirmarlo y queda registrado." htmlFor="lg-dist">
            <div className="flex max-w-[12rem] items-center gap-2">
              <input
                id="lg-dist"
                type="number"
                min={50}
                max={20000}
                step={50}
                disabled={!canEdit}
                value={s.max_distance_m}
                onChange={(e) => set("max_distance_m", Math.max(50, Math.min(20000, Number(e.target.value) || 300)))}
                className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm"
              />
              <span className="text-sm text-muted-foreground">metros</span>
            </div>
          </SettingRow>
          <SettingRow label="Intentos antes de avisar" description="Después de esta cantidad de intentos fallidos, la entrega se marca para revisar con el cliente." htmlFor="lg-att">
            <input
              id="lg-att"
              type="number"
              min={1}
              max={10}
              disabled={!canEdit}
              value={s.max_attempts}
              onChange={(e) => set("max_attempts", Math.max(1, Math.min(10, Number(e.target.value) || 3)))}
              className="h-11 w-24 rounded-lg border border-input bg-background px-3 text-sm"
            />
          </SettingRow>
          <SettingRow label="Motivos de no entrega" description="Los que elige el repartidor cuando no puede entregar. Cada uno puede pedir foto o nota." stacked>
            <ReasonsEditor value={s.failure_reasons} onChange={(v) => set("failure_reasons", v)} disabled={!canEdit} />
            {problems.length > 0 && <p className="mt-2 text-sm text-warning">{problems[0]}</p>}
          </SettingRow>
        </SettingsCard>
      )}

      {tab === "expedicion" && <ExpeditionSettingsCard canEdit={canEdit} />}

      {tab === "origenes" &&
        (reparto ? (
          <OriginsCard />
        ) : (
          <p className="rounded-lg bg-muted/40 p-4 text-sm text-muted-foreground">Los orígenes del reparto llegan con el reparto propio (plan Pro o superior).</p>
        ))}

      {tab === "seguimiento" &&
        (reparto ? (
          <TrackingSettingsCard canEdit={canEdit} />
        ) : (
          <p className="rounded-lg bg-muted/40 p-4 text-sm text-muted-foreground">El seguimiento del camión llega con el reparto propio (plan Pro o superior).</p>
        ))}

      {tab === "flota" && (
        <SettingsCard title="Flota y equipo" description="Vehículos con fotos, capacidad y vencimientos, y quién reparte.">
          <div className="space-y-3 px-5 py-4 text-sm">
            <p>Los vehículos y los perfiles de los repartidores están en Logística › Flota.</p>
            <p className="text-muted-foreground">
              Para que alguien reparta, invitalo desde Equipo y dale el rol Repartidor: entra directo a la app de reparto en su celular, sin ventas, sin caja y sin ver clientes.
            </p>
            <div className="flex flex-wrap gap-2">
              <Link href={"/logistica/flota" as Route} className={buttonVariants({ size: "sm" })}>
                Ir a Flota
              </Link>
              <Link href={"/dashboard-team" as Route} className={buttonVariants({ size: "sm", variant: "secondary" })}>
                Ir a Equipo
              </Link>
            </div>
          </div>
        </SettingsCard>
      )}
    </div>
  );
}
LogisticsSettingsPanel.displayName = "LogisticsSettingsPanel";
