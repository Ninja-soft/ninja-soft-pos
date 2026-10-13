"use client";

// Piezas comunes de los valores impositivos del negocio (ADR-105): indicador
// "plantilla / personalizado", modal para cargar una versión con vigencia
// (los campos vacíos usan la plantilla), lista de versiones, "volver a la
// plantilla" e historial de cambios (audit_logs).

import { useMemo, useState } from "react";
import { History, Pencil, RotateCcw, Trash2 } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { formatCurrency } from "@/lib/utils/format";
import {
  CUSTOM_STATE_LABEL,
  buildData,
  customErrorMessage,
  describeHistory,
  formatDecimal,
  sortVersions,
  validateValidity,
  type CustomCatalog,
  type CustomState,
  type CustomValue,
  type FieldDef,
} from "@/lib/tax/custom";
import { taxErrorMessage } from "@/modules/tax/api";
import { useCustomHistory, useCustomMutations } from "@/modules/tax/customHooks";

const STATE_TONE: Record<CustomState, BadgeTone> = {
  template: "neutral",
  custom: "info",
  own: "brand",
  disabled: "warning",
};

export function StateBadge({ state }: { state: CustomState }) {
  return <Badge tone={STATE_TONE[state]}>{CUSTOM_STATE_LABEL[state]}</Badge>;
}

export function todayAr(): string {
  return new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
}

export function fmtDate(d: string | null | undefined): string {
  if (!d) return "";
  const [y, m, dd] = d.slice(0, 10).split("-");
  return `${dd}/${m}/${y}`;
}

export function errorText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e ?? "");
  return customErrorMessage(m) ?? taxErrorMessage(e);
}

/** Valor para mostrar según el tipo del campo. */
export function fmtField(f: Pick<FieldDef, "kind">, v: unknown): string {
  if (v == null || v === "") return "sin valor";
  if (f.kind === "bool") return v === true || v === "true" ? "sí" : "no";
  if (f.kind === "percent") return `${Number(v).toLocaleString("es-AR", { maximumFractionDigits: 4 })} %`;
  if (f.kind === "money") return formatCurrency(Number(v));
  return String(v);
}

function versionSummary(fields: readonly FieldDef[], v: CustomValue): string {
  if (!v.is_active) return "Desactivado en este período";
  const parts = fields.filter((f) => v.data[f.key] !== undefined).map((f) => `${f.label}: ${fmtField(f, v.data[f.key])}`);
  return parts.length ? parts.join(" · ") : "Sin cambios de valores";
}

export function validityText(v: Pick<CustomValue, "valid_from" | "valid_to">): string {
  const from = v.valid_from <= "2000-01-01" ? "Desde siempre" : `Desde ${fmtDate(v.valid_from)}`;
  return v.valid_to ? `${from} hasta ${fmtDate(v.valid_to)}` : from;
}

/** Botones de una fila: editar, historial. */
export function RowActions({
  onEdit,
  onHistory,
  editLabel,
  readOnly,
}: {
  onEdit: () => void;
  onHistory: () => void;
  editLabel: string;
  readOnly: boolean;
}) {
  return (
    <div className="flex shrink-0 gap-1">
      <Button variant="ghost" size="sm" aria-label={`Historial de ${editLabel}`} onClick={onHistory}>
        <History size={15} />
      </Button>
      {!readOnly && (
        <Button variant="ghost" size="sm" aria-label={`Editar ${editLabel}`} onClick={onEdit}>
          <Pencil size={15} />
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modal de versiones
// ---------------------------------------------------------------------------
export interface CustomValueModalProps {
  title: string;
  description?: string;
  catalog: CustomCatalog;
  itemKey: string;
  fields: readonly FieldDef[];
  /** Valores de NinjaSoft (null = valor propio, sin plantilla). */
  template: Record<string, unknown> | null;
  versions: readonly CustomValue[];
  /** El valor lo creó el negocio (concepto o regla propia). */
  isCustom?: boolean;
  /** Ofrecer "usar este valor en el período" (desactivar con vigencia). */
  allowDisable?: boolean;
  /** Para conceptos propios: no se puede quitar la última versión. */
  readOnly?: boolean;
  /** Opciones fijas para un campo (en lugar de un número o texto). */
  options?: Record<string, { value: string; label: string }[]>;
  /** Hay un ajuste viejo sin vigencia: ofrecer volver a la plantilla aunque no haya versiones. */
  canReset?: boolean;
  onClose: () => void;
}

export function CustomValueModal({
  title,
  description,
  catalog,
  itemKey,
  fields,
  template,
  versions,
  isCustom = false,
  allowDisable = false,
  readOnly = false,
  options,
  canReset = false,
  onClose,
}: CustomValueModalProps) {
  const { save, remove, reset } = useCustomMutations();
  const { toast } = useToast();
  const sorted = useMemo(() => sortVersions(versions), [versions]);
  const [editing, setEditing] = useState<CustomValue | null>(null);
  const [from, setFrom] = useState(todayAr());
  const [to, setTo] = useState("");
  const [active, setActive] = useState(true);
  const [notes, setNotes] = useState("");
  const [form, setForm] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmReset, setConfirmReset] = useState(false);
  const [history, setHistory] = useState(false);

  const load = (v: CustomValue | null) => {
    setEditing(v);
    setFrom(v ? v.valid_from : todayAr());
    setTo(v?.valid_to ?? "");
    setActive(v ? v.is_active : true);
    setNotes(v?.notes ?? "");
    const f: Record<string, string> = {};
    for (const d of fields) {
      const x = v?.data[d.key];
      f[d.key] = x == null ? "" : d.kind === "bool" ? String(x === true) : d.kind === "text" || d.kind === "code" ? String(x) : formatDecimal(x);
    }
    setForm(f);
    setErrors({});
  };

  const submit = () => {
    const bad = validateValidity(from, to || null);
    if (bad) {
      toast({ title: bad, variant: "error" });
      return;
    }
    const { data, errors: errs } = buildData(fields, form);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    save.mutate(
      {
        id: editing?.id ?? null,
        catalog,
        item_key: itemKey,
        valid_from: from,
        valid_to: to || null,
        is_active: active,
        is_custom: isCustom,
        data,
        notes: notes.trim() || null,
      },
      {
        onSuccess: () => {
          toast({ title: "Guardado. Rige desde el " + fmtDate(from), variant: "success" });
          load(null);
        },
        onError: (e) => toast({ title: "No se guardó", description: errorText(e), variant: "error" }),
      },
    );
  };

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={title}
      description={description}
      className="max-w-2xl"
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" size="sm" onClick={() => setHistory(true)}>
              <History size={15} /> Historial
            </Button>
            {!readOnly && template && (versions.length > 0 || canReset) && (
              <Button variant="ghost" size="sm" onClick={() => setConfirmReset(true)}>
                <RotateCcw size={15} /> Volver a la plantilla
              </Button>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cerrar
            </Button>
            {!readOnly && (
              <Button onClick={submit} loading={save.isPending}>
                {editing ? "Guardar cambios" : "Agregar versión"}
              </Button>
            )}
          </div>
        </div>
      }
    >
      <div className="space-y-5">
        {template ? (
          <div className="rounded-sm bg-muted/50 px-3 py-2 text-[13px]">
            <p className="font-medium">Plantilla NinjaSoft</p>
            <p className="mt-0.5 text-muted-foreground">
              {fields
                .filter((f) => template[f.key] !== undefined && template[f.key] !== null)
                .map((f) => `${f.label}: ${fmtField(f, template[f.key])}`)
                .join(" · ") || "Sin valores"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Es orientativa. Si tu contador te indica otro valor, cargalo abajo con la fecha desde la que rige. Lo que
              dejes vacío sigue la plantilla.
            </p>
          </div>
        ) : (
          <p className="text-[13px] text-muted-foreground">Valor propio del negocio: no hay plantilla de NinjaSoft.</p>
        )}

        <div>
          <h4 className="mb-1 text-sm font-semibold">Tus versiones</h4>
          {sorted.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">Todavía no cambiaste este valor: rige la plantilla.</p>
          ) : (
            <ul className="divide-y divide-border">
              {sorted.map((v) => (
                <li key={v.id} className="flex flex-col gap-2 py-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 text-[13px]">
                    <p className="font-medium">{validityText(v)}</p>
                    <p className="text-muted-foreground">{versionSummary(fields, v)}</p>
                    {v.notes && <p className="text-xs text-muted-foreground">{v.notes}</p>}
                  </div>
                  {!readOnly && (
                    <div className="flex shrink-0 gap-1">
                      <Button variant="ghost" size="sm" aria-label="Editar versión" onClick={() => load(v)}>
                        <Pencil size={15} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label="Quitar versión"
                        onClick={() =>
                          remove.mutate(v.id, {
                            onSuccess: () => editing?.id === v.id && load(null),
                            onError: (e) => toast({ title: "No se quitó", description: errorText(e), variant: "error" }),
                          })
                        }
                      >
                        <Trash2 size={15} />
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {!readOnly && (
          <div className="space-y-4 border-t border-border pt-4">
            <h4 className="text-sm font-semibold">{editing ? "Editar versión" : "Nueva versión"}</h4>
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                label="Rige desde"
                type="date"
                value={from}
                hint="Las operaciones desde este día usan estos valores."
                onChange={(e) => setFrom(e.target.value)}
              />
              <Input
                label="Hasta (opcional)"
                type="date"
                value={to}
                hint="Vacío: sin fecha de fin. Después vuelve a regir la plantilla."
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
            {(!allowDisable || active) && (
              <div className="grid gap-3 sm:grid-cols-2">
                {fields.map((f) => {
                  const opts = options?.[f.key];
                  const tpl = template?.[f.key];
                  const hint = `${f.help}${tpl != null && tpl !== "" ? ` Plantilla: ${fmtField(f, tpl)}.` : ""}`;
                  if (f.kind === "bool" || opts) {
                    const list = opts ?? [
                      { value: "true", label: "Sí" },
                      { value: "false", label: "No" },
                    ];
                    return (
                      <Select
                        key={f.key}
                        label={f.label}
                        hint={hint}
                        value={form[f.key] ?? ""}
                        onChange={(v) => setForm((x) => ({ ...x, [f.key]: v }))}
                        options={[{ value: "", label: template ? "Como la plantilla" : "Sin valor" }, ...list]}
                      />
                    );
                  }
                  return (
                    <Input
                      key={f.key}
                      label={f.label + (f.kind === "percent" ? " %" : f.kind === "money" ? " $" : "")}
                      inputMode={f.kind === "text" ? "text" : f.kind === "code" ? "numeric" : "decimal"}
                      maxLength={f.kind === "text" || f.kind === "code" ? f.maxLength : undefined}
                      placeholder={tpl != null ? formatDecimal(tpl) || String(tpl) : ""}
                      value={form[f.key] ?? ""}
                      error={errors[f.key]}
                      hint={errors[f.key] ? undefined : hint}
                      onChange={(e) => setForm((x) => ({ ...x, [f.key]: e.target.value }))}
                    />
                  );
                })}
              </div>
            )}
            {allowDisable && (
              <label className="flex items-center justify-between gap-3 text-sm">
                <span>
                  Usar en este período
                  <span className="block text-[13px] text-muted-foreground">
                    Apagado: no se aplica entre esas fechas (por ejemplo, un concepto que no usás).
                  </span>
                </span>
                <Switch checked={active} onCheckedChange={setActive} label="Usar en este período" />
              </label>
            )}
            <Input label="Nota (opcional)" value={notes} maxLength={300} onChange={(e) => setNotes(e.target.value)} />
            {editing && (
              <Button variant="ghost" size="sm" onClick={() => load(null)}>
                Cargar una versión nueva en lugar de editar
              </Button>
            )}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title="Volver a la plantilla"
        description="Se quitan todas tus versiones de este valor y rige el de NinjaSoft. Lo ya calculado (ventas, retenciones, liquidaciones) no cambia."
        confirmLabel="Volver a la plantilla"
        loading={reset.isPending}
        onConfirm={() =>
          reset.mutate(
            { catalog, key: itemKey },
            {
              onSuccess: () => {
                setConfirmReset(false);
                toast({ title: "Rige la plantilla de NinjaSoft", variant: "success" });
                load(null);
              },
              onError: (e) => toast({ title: "No se pudo", description: errorText(e), variant: "error" }),
            },
          )
        }
      />
      {history && <HistoryModal catalog={catalog} itemKey={itemKey} title={title} onClose={() => setHistory(false)} />}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Historial
// ---------------------------------------------------------------------------
export function HistoryModal({
  catalog,
  itemKey,
  title,
  onClose,
}: {
  catalog: string;
  itemKey: string;
  title: string;
  onClose: () => void;
}) {
  const q = useCustomHistory(catalog, itemKey);
  const lines = useMemo(() => describeHistory(q.data ?? []), [q.data]);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={`Historial · ${title}`} className="max-w-xl">
      {q.isLoading ? (
        <SpinnerBlock className="py-10" />
      ) : q.error ? (
        <Callout tone="warning" title="No se pudo leer el historial">
          {errorText(q.error)}
        </Callout>
      ) : lines.length === 0 ? (
        <p className="text-sm text-muted-foreground">Sin cambios registrados: rige la plantilla.</p>
      ) : (
        <ul className="divide-y divide-border">
          {lines.map((l, i) => (
            <li key={`${l.at}-${i}`} className="py-2 text-[13px]">
              <p className="font-medium">
                {new Date(l.at).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" })} · {l.actor}
              </p>
              <p className="text-muted-foreground">{l.what}</p>
              {l.changes.length > 0 && (
                <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                  {l.changes.slice(0, 12).map((c) => (
                    <li key={c.field}>
                      {c.field}: {c.before} → {c.after}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
