"use client";

import { useEffect, useMemo, useState } from "react";
import { BookOpen, Coins, Lock, RefreshCw, Settings2, Truck, Warehouse } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { UpgradeModal } from "@/components/saas/UpgradeModal";
import { selectCls } from "@/components/stock/transfers/shared";
import { formatCurrency, formatRelative } from "@/lib/utils/format";
import { fullErrorMessage } from "@/lib/mercadolibre/full";
import { FULL_LABEL_FORMATS, labelFormat } from "@/lib/mercadolibre/fullLabels";
import { useFeature } from "@/modules/saas/gating";
import {
  useMlFullCosts,
  useMlFullInbounds,
  useMlFullMutations,
  useMlFullOverview,
  type MlFullSettings,
} from "@/modules/mercadolibre/fullHooks";
import type { MlAccount } from "@/modules/mercadolibre/hooks";
import { MlFullGuide } from "./MlFullGuide";
import { MlFullInboundEditor, type DraftLine } from "./MlFullInboundEditor";
import { MlFullInbounds } from "./MlFullInbounds";
import { MlFullStock } from "./MlFullStock";

type Sub = "stock" | "inbounds" | "costs" | "guide";

function SettingsModal({
  open,
  onOpenChange,
  accountId,
  settings,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  accountId: string;
  settings: MlFullSettings;
}) {
  const { toast } = useToast();
  const { saveSettings } = useMlFullMutations();
  const [lead, setLead] = useState(settings.lead_days);
  const [target, setTarget] = useState(settings.target_days);
  const [fmt, setFmt] = useState(labelFormat(settings.label_format).key);
  useEffect(() => {
    if (!open) return;
    setLead(settings.lead_days);
    setTarget(settings.target_days);
    setFmt(labelFormat(settings.label_format).key);
  }, [open, settings]);
  const valid = lead >= 1 && lead <= 90 && target >= 7 && target <= 180 && target >= lead;
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Configuración de Full"
      description="Con estos datos se calculan las alertas de quiebre y cuánto conviene mandar."
      footer={
        <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            disabled={!valid}
            loading={saveSettings.isPending}
            onClick={() =>
              saveSettings.mutate(
                { accountId, lead_days: lead, target_days: target, label_format: fmt },
                {
                  onSuccess: () => {
                    toast({ title: "Configuración guardada", variant: "success" });
                    onOpenChange(false);
                  },
                  onError: (e) => toast({ title: "No se pudo guardar", description: fullErrorMessage(e), variant: "error" }),
                },
              )
            }
          >
            Guardar
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <Input
          label="Días hasta que un envío está disponible en Full"
          type="number"
          inputMode="numeric"
          min={1}
          max={90}
          value={lead}
          onChange={(e) => setLead(Math.floor(Number(e.target.value) || 0))}
          hint="Preparación, colecta y recepción. Si lo disponible no llega a cubrir estos días, se marca como crítico."
        />
        <Input
          label="Cobertura objetivo en días"
          type="number"
          inputMode="numeric"
          min={7}
          max={180}
          value={target}
          onChange={(e) => setTarget(Math.floor(Number(e.target.value) || 0))}
          hint="Cuántos días de venta querés tener en Full. Mantener mucho stock en Full puede generar cargos de almacenamiento."
          error={valid ? undefined : "Llegada entre 1 y 90; objetivo entre 7 y 180 y mayor o igual a la llegada."}
        />
        <label className="block space-y-1 text-sm">
          <span className="font-medium">Tamaño de etiqueta por defecto</span>
          <select className={selectCls} value={fmt} onChange={(e) => setFmt(e.target.value as typeof fmt)} aria-label="Tamaño de etiqueta">
            {Object.values(FULL_LABEL_FORMATS).map((x) => (
              <option key={x.key} value={x.key}>
                {x.label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </Modal>
  );
}

function Costs({ accountId, canManage }: { accountId: string; canManage: boolean }) {
  const { toast } = useToast();
  const { data: costs = [], isLoading } = useMlFullCosts(accountId, canManage);
  const { costs: refresh } = useMlFullMutations();
  const byPeriod = useMemo(() => {
    const m = new Map<string, typeof costs>();
    for (const c of costs) m.set(c.period_key, [...(m.get(c.period_key) ?? []), c]);
    return [...m.entries()];
  }, [costs]);
  if (!canManage) return <Callout tone="info" icon={Lock}>Los costos los ve el dueño o un encargado.</Callout>;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Cargos de Full del resumen de facturación de Mercado Libre (almacenamiento, retiro y descarte), por período.
        </p>
        <Button
          size="sm"
          variant="secondary"
          loading={refresh.isPending}
          onClick={() =>
            refresh.mutate(accountId, {
              onError: (e) => toast({ title: "No se pudieron leer los costos", description: fullErrorMessage(e), variant: "error" }),
            })
          }
        >
          <RefreshCw size={15} /> Actualizar
        </Button>
      </div>
      {isLoading ? (
        <SpinnerBlock className="py-10" />
      ) : byPeriod.length === 0 ? (
        <EmptyState
          icon={Coins}
          title="Sin cargos de Full informados"
          description="Se leen una vez por día. Si tu app de Mercado Libre no tiene el permiso de facturación, pedilo en DevCenter."
        />
      ) : (
        byPeriod.map(([period, list]) => (
          <div key={period} className="rounded-xl bg-card p-3.5">
            <p className="text-sm font-semibold">
              Período {new Date(`${period}T12:00:00`).toLocaleDateString("es-AR", { month: "long", year: "numeric" })}
            </p>
            <ul className="mt-2 space-y-1 text-sm">
              {list.map((c) => (
                <li key={c.id} className="flex justify-between gap-2">
                  <span>{c.label}</span>
                  <span className="font-semibold tabular-nums">{formatCurrency(Number(c.amount))}</span>
                </li>
              ))}
              <li className="flex justify-between gap-2 border-t border-border pt-1 font-semibold">
                <span>Total</span>
                <span className="tabular-nums">{formatCurrency(list.reduce((a, c) => a + Number(c.amount), 0))}</span>
              </li>
            </ul>
          </div>
        ))
      )}
    </div>
  );
}

/**
 * Mercado Libre Full (ADR-142): depósito virtual por cuenta, envíos a Full,
 * etiquetas, cobertura y costos, con la explicación de cada paso.
 */
export function MlFullTab({ account, canManage }: { account: MlAccount; canManage: boolean }) {
  const { toast } = useToast();
  const enabled = useFeature("mercadolibre_full");
  const [sub, setSub] = useState<Sub>("stock");
  const [upgrade, setUpgrade] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draft, setDraft] = useState<DraftLine[] | null>(null);
  const on = enabled === true;
  const { data: overview, isLoading, error } = useMlFullOverview(account.id, on);
  const { data: inbounds = [] } = useMlFullInbounds(account.id, on);
  const { sync } = useMlFullMutations();

  if (enabled === false) {
    return (
      <>
        <Callout
          tone="brand"
          icon={Lock}
          title="Mercado Libre Full no está en tu plan"
          actions={<Button size="sm" onClick={() => setUpgrade(true)}>Ver planes</Button>}
        >
          Controlá el stock que tenés en Full, armá los envíos con sus etiquetas y recibí alertas antes de quedarte sin stock.
        </Callout>
        <div className="mt-5">
          <MlFullGuide />
        </div>
        <UpgradeModal open={upgrade} onOpenChange={setUpgrade} featureKey="mercadolibre_full" featureLabel="Mercado Libre Full" />
      </>
    );
  }
  if (enabled === undefined || isLoading) return <SpinnerBlock className="py-16" />;
  if (error || !overview) {
    return (
      <Callout tone="danger" title="No se pudo cargar Full">
        {fullErrorMessage(error)}
      </Callout>
    );
  }

  const s = overview.settings;
  const done = {
    enable: overview.rows.length > 0,
    draft: inbounds.length > 0,
    ml: inbounds.some((i) => i.ml_inbound_id),
    labels: inbounds.some((i) => i.label_units_printed > 0),
    dispatch: inbounds.some((i) => i.dispatched_at),
    receive: inbounds.some((i) => i.status === "received" || i.status === "closed_with_diff"),
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 rounded-xl bg-card p-3.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <Warehouse size={20} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
          <div>
            <p className="text-sm font-semibold">Depósito Mercado Libre Full · {account.nickname || account.ml_user_id}</p>
            <p className="text-xs text-muted-foreground">
              No se vende en el mostrador. {s.last_sync_at ? `Sincronizado ${formatRelative(s.last_sync_at)}.` : "Todavía no se sincronizó."}
              {s.sync_note ? ` ${s.sync_note}` : ""}
            </p>
            {s.sync_error && <p className="text-xs text-danger">Última sincronización con error: {fullErrorMessage(s.sync_error)}</p>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {canManage && (
            <Button
              size="sm"
              variant="secondary"
              loading={sync.isPending}
              onClick={() =>
                sync.mutate(account.id, {
                  onSuccess: (r) =>
                    toast({
                      title: "Full sincronizado",
                      description: `${r.sync?.inventories ?? 0} códigos de inventario leídos${r.sync?.errors ? `, ${r.sync.errors} con error` : ""}.`,
                      variant: "success",
                    }),
                  onError: (e) => toast({ title: "No se pudo sincronizar", description: fullErrorMessage(e), variant: "error" }),
                })
              }
            >
              <RefreshCw size={15} /> Sincronizar
            </Button>
          )}
          {canManage && (
            <Button size="sm" variant="ghost" onClick={() => setSettingsOpen(true)}>
              <Settings2 size={15} /> Configuración
            </Button>
          )}
        </div>
      </div>

      <Segmented
        value={sub}
        onChange={setSub}
        aria-label="Secciones de Full"
        scrollOnMobile
        options={[
          { value: "stock", label: "Stock en Full", icon: <Warehouse size={15} /> },
          { value: "inbounds", label: "Envíos a Full", icon: <Truck size={15} /> },
          { value: "costs", label: "Costos", icon: <Coins size={15} /> },
          { value: "guide", label: "Cómo funciona", icon: <BookOpen size={15} /> },
        ]}
      />

      {sub === "stock" && (
        <MlFullStock
          overview={overview}
          onSend={
            canManage
              ? (lines) => {
                  setDraft(lines);
                }
              : undefined
          }
        />
      )}
      {sub === "inbounds" && (
        <MlFullInbounds
          accountId={account.id}
          accountName={account.nickname || String(account.ml_user_id)}
          inbounds={inbounds}
          rows={overview.rows}
          defaultStoreId={s.own_store_id}
          labelFormat={s.label_format}
          canManage={canManage}
          onNew={() => setDraft([])}
        />
      )}
      {sub === "costs" && <Costs accountId={account.id} canManage={canManage} />}
      {sub === "guide" && <MlFullGuide done={done} />}

      <MlFullInboundEditor
        open={draft !== null}
        onOpenChange={(o) => !o && setDraft(null)}
        accountId={account.id}
        rows={overview.rows}
        defaultStoreId={s.own_store_id}
        initial={draft ?? []}
        onSaved={() => setSub("inbounds")}
      />
      <SettingsModal open={settingsOpen} onOpenChange={setSettingsOpen} accountId={account.id} settings={s} />
    </div>
  );
}
