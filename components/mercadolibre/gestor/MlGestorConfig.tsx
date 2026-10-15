"use client";

import { useEffect, useState } from "react";
import { Bell, FileText, Gauge, Pencil, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { SettingRow, SettingsCard } from "@/components/settings/Settings";
import { selectCls } from "@/components/stock/transfers/shared";
import { mlErrorMessage } from "@/lib/mercadolibre/labels";
import { DEFAULT_THRESHOLDS, cleanThresholds } from "@/supabase/functions/_shared/mercadolibre/reputation";
import { useMlGestorMutations, useMlGestorSettings, useMlTemplates, type MlTemplate } from "@/modules/mercadolibre/gestorHooks";
import type { MlAccount } from "@/modules/mercadolibre/hooks";

// Configuración del gestor (H141 · ADR-132, parte B): umbrales de reputación
// (como "Configuración > Reputación" de ANDESMAR), motivos que se pueden
// pedir excluir, avisos y plantillas de respuesta.

const DEFAULT_REASONS = ["PDD9939", "PNR9501", "PDD9502", "PDD9829"];
const SCOPE_LABELS: Record<MlTemplate["scope"], string> = { question: "Preguntas", claim: "Reclamos", message: "Mensajes de la venta" };

/** Qué parte mostrar: posventa (umbrales, avisos, plantillas de reclamos y mensajes) o preguntas (sus plantillas). */
export type GestorConfigPart = "all" | "postsale" | "questions";

export function MlGestorConfig({ account, canManage, part = "all" }: { account: MlAccount; canManage: boolean; part?: GestorConfigPart }) {
  if (part === "questions") return <TemplatesCard canManage={canManage} scopes={["question"]} />;
  return <PostsaleConfig account={account} canManage={canManage} scopes={part === "all" ? ["question", "claim", "message"] : ["claim", "message"]} />;
}

function PostsaleConfig({ account, canManage, scopes }: { account: MlAccount; canManage: boolean; scopes: MlTemplate["scope"][] }) {
  const { toast } = useToast();
  const { data: settings, isLoading, isError, refetch } = useMlGestorSettings(account.id);
  const { saveSettings } = useMlGestorMutations();
  const th = cleanThresholds(settings?.thresholds ?? DEFAULT_THRESHOLDS);
  const [f, setF] = useState({ claims: "1", cancellations: "0.5", delayed: "8", reasons: DEFAULT_REASONS.join(", "), notifyClaims: true, dueHours: "24", notifyRep: true });
  useEffect(() => {
    setF({
      claims: String(th.claims),
      cancellations: String(th.cancellations),
      delayed: String(th.delayed),
      reasons: (settings?.exclusion_reasons ?? DEFAULT_REASONS).join(", "),
      notifyClaims: settings?.notify?.claims ?? true,
      dueHours: String(settings?.notify?.due_hours ?? 24),
      notifyRep: settings?.notify?.reputation ?? true,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  const reasons = f.reasons
    .split(/[\s,;]+/)
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean);
  const n = (v: string) => Number(v.replace(",", "."));
  const valid =
    n(f.claims) >= 0.1 && n(f.claims) <= 20 &&
    n(f.cancellations) >= 0.1 && n(f.cancellations) <= 20 &&
    n(f.delayed) >= 0.1 && n(f.delayed) <= 50 &&
    reasons.every((r) => /^[A-Z]{2,4}\d{3,5}$/.test(r)) && reasons.length <= 50 &&
    Number.isInteger(n(f.dueHours)) && n(f.dueHours) >= 1 && n(f.dueHours) <= 168;
  const disabled = !canManage || saveSettings.isPending || isLoading;

  const save = () =>
    saveSettings.mutate(
      {
        accountId: account.id,
        p: {
          thresholds: { claims: n(f.claims), cancellations: n(f.cancellations), delayed: n(f.delayed) },
          exclusion_reasons: reasons,
          notify: { claims: f.notifyClaims, due_hours: n(f.dueHours), reputation: f.notifyRep },
        },
      },
      {
        onSuccess: () => toast({ title: "Configuración del gestor guardada", variant: "success" }),
        onError: (e) => toast({ title: "No se pudo guardar", description: mlErrorMessage(e), variant: "error" }),
      },
    );

  if (isError) {
    return (
      <Callout tone="warning" title="No pudimos leer la configuración de posventa" actions={<Button size="sm" variant="secondary" onClick={() => void refetch()}>Reintentar</Button>}>
        Probá de nuevo en unos segundos.
      </Callout>
    );
  }

  return (
    <>
      <SettingsCard title="Reputación" description="El límite para seguir en verde de cada métrica. Se usa en Métricas para el margen y para avisarte." icon={Gauge}>
        <div className="divide-y divide-border">
          <SettingRow label="Umbrales para seguir en verde" description="Por defecto los de Mercado Libre para el verde: reclamos 1 %, cancelaciones 0,5 % y despachos con demora 8 %.">
            <div className="grid w-full grid-cols-3 gap-2 sm:w-96">
              <Input label="Reclamos %" inputMode="decimal" value={f.claims} disabled={disabled} onChange={(e) => setF({ ...f, claims: e.target.value })} />
              <Input label="Cancelaciones %" inputMode="decimal" value={f.cancellations} disabled={disabled} onChange={(e) => setF({ ...f, cancellations: e.target.value })} />
              <Input label="Demoras %" inputMode="decimal" value={f.delayed} disabled={disabled} onChange={(e) => setF({ ...f, delayed: e.target.value })} />
            </div>
          </SettingRow>
          <SettingRow label="Motivos para pedir exclusión" description="Si un caso afecta la reputación y su motivo está en esta lista, se marca para que pidas la exclusión en Mercado Libre.">
            <Input className="sm:w-96" aria-label="Motivos" value={f.reasons} disabled={disabled} onChange={(e) => setF({ ...f, reasons: e.target.value })} hint="Códigos separados por coma, por ejemplo PDD9939" />
          </SettingRow>
        </div>
      </SettingsCard>

      <SettingsCard title="Avisos" description="Llegan al centro de notificaciones de dueños y encargados." icon={Bell}>
        <div className="divide-y divide-border">
          <SettingRow label="Reclamo, mediación o devolución nueva">
            <Switch checked={f.notifyClaims} disabled={disabled} label="Aviso de reclamo nuevo" onCheckedChange={(v) => setF({ ...f, notifyClaims: v })} />
          </SettingRow>
          <SettingRow label="Vence pronto" description="Horas hábiles antes del vencimiento en que un caso se marca como urgente.">
            <Input className="w-24" inputMode="numeric" aria-label="Horas" value={f.dueHours} disabled={disabled} onChange={(e) => setF({ ...f, dueHours: e.target.value })} />
          </SettingRow>
          <SettingRow label="Una métrica de reputación empeora">
            <Switch checked={f.notifyRep} disabled={disabled} label="Aviso de reputación" onCheckedChange={(v) => setF({ ...f, notifyRep: v })} />
          </SettingRow>
          {canManage && (
            <div className="flex justify-end px-5 py-4">
              <Button onClick={save} disabled={!valid || disabled} loading={saveSettings.isPending}>
                Guardar
              </Button>
            </div>
          )}
        </div>
      </SettingsCard>

      <TemplatesCard canManage={canManage} scopes={scopes} />
    </>
  );
}

function TemplatesCard({ canManage, scopes }: { canManage: boolean; scopes: MlTemplate["scope"][] }) {
  const { toast } = useToast();
  const { data: all = [] } = useMlTemplates(null);
  const templates = all.filter((t) => scopes.includes(t.scope));
  const { saveTemplate, deleteTemplate } = useMlGestorMutations();
  const [edit, setEdit] = useState<{ id: string | null; scope: MlTemplate["scope"]; name: string; body: string } | null>(null);
  const valid = edit && edit.name.trim().length >= 1 && edit.body.trim().length >= 2;

  return (
    <SettingsCard
      title={scopes.length === 1 && scopes[0] === "question" ? "Respuestas rápidas a preguntas" : "Plantillas de respuesta"}
      description={
        scopes.length === 1 && scopes[0] === "question"
          ? "Textos listos para las preguntas que más se repiten (stock, factura, envío). Se eligen al responder en Preguntas."
          : "Textos listos para reclamos y mensajes de la venta. Se eligen al responder."
      }
      icon={FileText}
      actions={
        canManage ? (
          <Button size="sm" variant="secondary" onClick={() => setEdit({ id: null, scope: scopes[0] ?? "claim", name: "", body: "" })}>
            <Plus size={15} /> Nueva
          </Button>
        ) : undefined
      }
    >
      {templates.length === 0 ? (
        <p className="px-5 py-4 text-sm text-muted-foreground">Todavía no hay plantillas. Ejemplo: &quot;Ya despachamos tu compra&quot; o &quot;Te pedimos una foto del producto&quot;.</p>
      ) : (
        <ul className="divide-y divide-border">
          {templates.map((t) => (
            <li key={t.id} className="flex items-start justify-between gap-3 px-5 py-3">
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-sm font-medium">
                  {t.name} <Badge tone="neutral">{SCOPE_LABELS[t.scope]}</Badge>
                </p>
                <p className="line-clamp-2 text-xs text-muted-foreground">{t.body}</p>
              </div>
              {canManage && (
                <div className="flex shrink-0 gap-1">
                  <Button variant="ghost" size="sm" aria-label={`Editar ${t.name}`} onClick={() => setEdit({ id: t.id, scope: t.scope, name: t.name, body: t.body })}>
                    <Pencil size={14} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Borrar ${t.name}`}
                    onClick={() =>
                      deleteTemplate.mutate(t.id, {
                        onSuccess: () => toast({ title: "Plantilla borrada", variant: "success" }),
                        onError: (e) => toast({ title: "No se pudo borrar", description: mlErrorMessage(e), variant: "error" }),
                      })
                    }
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {edit && (
        <Modal
          open
          onOpenChange={(o) => !o && setEdit(null)}
          title={edit.id ? "Editar plantilla" : "Nueva plantilla"}
          footer={
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setEdit(null)}>
                Cancelar
              </Button>
              <Button
                disabled={!valid}
                loading={saveTemplate.isPending}
                onClick={() =>
                  saveTemplate.mutate(
                    { id: edit.id, p: { scope: edit.scope, name: edit.name.trim(), body: edit.body.trim(), sort: 0 } },
                    {
                      onSuccess: () => {
                        toast({ title: "Plantilla guardada", variant: "success" });
                        setEdit(null);
                      },
                      onError: (e) => toast({ title: "No se pudo guardar", description: mlErrorMessage(e), variant: "error" }),
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
            <label className="block space-y-1 text-sm">
              <span className="font-medium">Para</span>
              <select className={selectCls} value={edit.scope} onChange={(e) => setEdit({ ...edit, scope: e.target.value as MlTemplate["scope"] })}>
                {(Object.keys(SCOPE_LABELS) as MlTemplate["scope"][]).filter((k) => scopes.includes(k) || k === edit.scope).map((k) => (
                  <option key={k} value={k}>
                    {SCOPE_LABELS[k]}
                  </option>
                ))}
              </select>
            </label>
            <Input label="Nombre" value={edit.name} maxLength={80} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            <label className="block space-y-1 text-sm">
              <span className="font-medium">Texto</span>
              <textarea
                className="min-h-[120px] w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-ninja-flameSoft"
                maxLength={2000}
                value={edit.body}
                onChange={(e) => setEdit({ ...edit, body: e.target.value })}
              />
            </label>
          </div>
        </Modal>
      )}
    </SettingsCard>
  );
}
