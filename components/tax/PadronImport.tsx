"use client";

import { useMemo, useRef, useState } from "react";
import { Eye, FileUp, History, Lock, Pencil, Plus, Trash2, UserCheck } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { SettingsCard } from "@/components/settings/Settings";
import { JURISDICTIONS, isValidCuit, jurisdictionName, normalizeDigits } from "@/lib/tax/catalog";
import { parseDecimal } from "@/lib/tax/custom";
import {
  BUILTIN_PROFILES,
  DATE_FORMATS,
  FIELD_LABEL,
  PROFILE_REASON_LABEL,
  ProfileReader,
  SEPARATORS,
  previewProfile,
  validateProfile,
  type ColumnRef,
  type DateFormat,
  type PadronField,
  type PadronProfile,
  type PadronProfileConfig,
} from "@/lib/tax/padronProfile";
import { taxApi, type PadronImport as PadronImportRow, type TaxSettings } from "@/modules/tax/api";
import { usePadronImports } from "@/modules/tax/hooks";
import { useProfileMutations, usePadronProfiles } from "@/modules/tax/customHooks";
import { HistoryModal, errorText, fmtDate, todayAr } from "./custom/CustomValueKit";

// Padrones (ADR-068; ADR-101): el archivo se lee en el navegador por partes
// (los padrones completos pesan cientos de MB) y se sube en tandas. ARBA, AGIP
// y el genérico son perfiles de plantilla; el negocio arma los suyos (CSV o
// ancho fijo, columnas o posiciones, formato de fecha) y los reusa cada mes.
// Antes de aplicar se ve una vista previa con las filas leídas y los errores
// por fila. La alícuota manual de un CUIT manda sobre los archivos.

const KIND_LABEL = { perception: "Percepción", retention: "Retención", both: "Percepción y retención" } as const;
const STATUS: Record<PadronImportRow["status"], { label: string; tone: "success" | "info" | "danger" | "neutral" }> = {
  ready: { label: "Vigente", tone: "success" },
  loading: { label: "Cargando", tone: "info" },
  error: { label: "Con error", tone: "danger" },
  replaced: { label: "Reemplazado", tone: "neutral" },
};
const BATCH = 4000;
const PREVIEW_BYTES = 256 * 1024;
const JUR_OPTIONS = JURISDICTIONS.map((j) => ({ value: j.code, label: `${j.name} (${j.agency})` }));

type Choice = { key: string; profile: PadronProfile; format: "arba" | "agip" | "generic" | "profile" };

function hasDates(p: PadronProfile) {
  return Boolean(p.config.columns.valid_from && p.config.columns.valid_to);
}

export function PadronImport({ settings }: { settings: TaxSettings }) {
  const enabled = settings.features.percepciones;
  const list = usePadronImports(enabled);
  const profiles = usePadronProfiles(enabled);
  const { remove: removeProfile } = useProfileMutations();
  const qc = useQueryClient();
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [jur, setJur] = useState("902");
  const [choiceKey, setChoiceKey] = useState("arba");
  const [kind, setKind] = useState<PadronImportRow["kind"]>("perception");
  const [onlyKnown, setOnlyKnown] = useState(true);
  const [period, setPeriod] = useState({ from: todayAr().slice(0, 8) + "01", to: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const [del, setDel] = useState<PadronImportRow | null>(null);
  const [preview, setPreview] = useState<{ file: File; res: ReturnType<typeof previewProfile> } | null>(null);
  const [editProfile, setEditProfile] = useState<PadronProfile | null>(null);
  const [delProfile, setDelProfile] = useState<PadronProfile | null>(null);
  const [histProfile, setHistProfile] = useState<PadronProfile | null>(null);
  const ro = !settings.can_write;

  const choices: Choice[] = useMemo(() => {
    const out: Choice[] = [];
    for (const b of BUILTIN_PROFILES) {
      if (b.builtin === "arba" && jur !== "902") continue;
      if (b.builtin === "agip" && jur !== "901") continue;
      out.push({ key: b.builtin!, profile: { ...b, jurisdiction: jur }, format: b.builtin! });
    }
    for (const p of profiles.data ?? []) {
      if (p.jurisdiction !== jur) continue;
      out.push({ key: p.id!, profile: p, format: "profile" });
    }
    return out;
  }, [jur, profiles.data]);
  const choice = choices.find((c) => c.key === choiceKey) ?? choices[0]!;
  const effKind: PadronImportRow["kind"] = choice.format === "agip" ? "both" : kind;
  const needsPeriod = !hasDates(choice.profile);
  const periodOk = !needsPeriod || (Boolean(period.from) && Boolean(period.to) && period.from <= period.to);
  const parseOpts = { kind: effKind, period: needsPeriod ? { from: period.from, to: period.to } : null };

  const startPreview = async (file: File) => {
    try {
      const text = await file.slice(0, PREVIEW_BYTES).text();
      const cut = file.size > PREVIEW_BYTES ? text.slice(0, text.lastIndexOf("\n") + 1) : text;
      setPreview({ file, res: previewProfile(cut, choice.profile, { ...parseOpts, limit: 15 }) });
    } catch (e) {
      toast({ title: "No se pudo leer el archivo", description: errorText(e), variant: "error" });
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const run = async (file: File) => {
    setPreview(null);
    setBusy("Leyendo el archivo…");
    let importId: string | null = null;
    try {
      const only = onlyKnown ? await taxApi.knownCuits() : null;
      const reader = new ProfileReader(choice.profile, { ...parseOpts, only });
      importId = await taxApi.padronStart({
        jurisdiction: jur,
        format: choice.format,
        kind: effKind,
        file_name: file.name,
        only_known: onlyKnown,
        profile_id: choice.format === "profile" ? choice.profile.id : undefined,
      });
      const stream = file.stream().pipeThrough(new TextDecoderStream("latin1"));
      const it = stream.getReader();
      let loaded = 0;
      for (;;) {
        const { value, done } = await it.read();
        if (done) break;
        reader.push(value);
        const rows = reader.take();
        for (let i = 0; i < rows.length; i += BATCH) {
          loaded += await taxApi.padronRows(importId, rows.slice(i, i + BATCH));
          setBusy(`Subiendo… ${loaded.toLocaleString("es-AR")} CUIT`);
        }
      }
      const res = reader.finish();
      if (res.rows.length) loaded += await taxApi.padronRows(importId, res.rows);
      const out = await taxApi.padronFinish(importId, {
        rows_skipped: res.skipped,
        rows_error: reader.errorTotal,
        period_from: res.period.from,
        period_to: res.period.to,
      });
      const firstErr = res.errors[0];
      toast({
        title: `Padrón cargado: ${out.rows_loaded.toLocaleString("es-AR")} CUIT`,
        description: firstErr
          ? `${reader.errorTotal} líneas con error (la ${firstErr.line}: ${PROFILE_REASON_LABEL[firstErr.reason] ?? firstErr.reason}).`
          : onlyKnown
            ? `${res.skipped.toLocaleString("es-AR")} CUIT del archivo no son clientes ni proveedores.`
            : undefined,
        variant: "success",
      });
    } catch (e) {
      if (importId) await taxApi.padronDelete(importId).catch(() => undefined);
      toast({ title: "No se pudo cargar el padrón", description: errorText(e), variant: "error" });
    } finally {
      setBusy(null);
      void qc.invalidateQueries({ queryKey: ["tax"] });
    }
  };

  return (
    <SettingsCard
      title="Padrones"
      description="Alícuotas de percepción y retención por CUIT y vigencia. Cargá el del mes cuando lo publica el organismo."
      icon={FileUp}
      padded
    >
      {!enabled ? (
        <Callout tone="neutral" icon={Lock} title="Desde el plan Business">
          Importá los padrones de ARBA, AGIP u otras jurisdicciones y el sistema usa la alícuota de cada cliente.
        </Callout>
      ) : (
        <div className="space-y-6">
          {!ro && (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Select label="Jurisdicción" value={jur} onChange={setJur} options={JUR_OPTIONS} />
                <Select
                  label="Formato del archivo"
                  value={choice.key}
                  onChange={setChoiceKey}
                  hint="Las plantillas de ARBA y AGIP siguen el diseño publicado. Para otro diseño, armá tu perfil."
                  options={choices.map((c) => ({
                    value: c.key,
                    label: c.format === "profile" ? `Mi perfil: ${c.profile.name}` : c.profile.name,
                  }))}
                />
              </div>
              {choice.format !== "agip" && (
                <Select
                  label="Contenido"
                  value={kind}
                  onChange={setKind}
                  hint={choice.format === "arba" ? "ARBA publica un archivo de percepción y otro de retención." : undefined}
                  options={(["perception", "retention", "both"] as const).map((k) => ({ value: k, label: KIND_LABEL[k] }))}
                />
              )}
              {needsPeriod && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Input
                    label="Vigencia desde"
                    type="date"
                    value={period.from}
                    hint="El archivo no trae fechas: estas valen para todas las filas."
                    onChange={(e) => setPeriod((p) => ({ ...p, from: e.target.value }))}
                  />
                  <Input
                    label="Vigencia hasta"
                    type="date"
                    value={period.to}
                    onChange={(e) => setPeriod((p) => ({ ...p, to: e.target.value }))}
                  />
                </div>
              )}
              <label className="flex items-center justify-between gap-3 text-sm">
                <span>
                  Sólo CUIT de mis clientes y proveedores
                  <span className="block text-[13px] text-muted-foreground">
                    Sube mucho menos. Un cliente nuevo aparece recién en el próximo import.
                  </span>
                </span>
                <Switch checked={onlyKnown} onCheckedChange={setOnlyKnown} label="Sólo CUIT conocidos" />
              </label>
              <input
                ref={fileRef}
                type="file"
                accept=".txt,.csv,text/plain,text/csv"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void startPreview(f);
                }}
              />
              <Button
                variant="secondary"
                disabled={Boolean(busy) || !periodOk}
                onClick={() => fileRef.current?.click()}
              >
                <Eye size={15} /> {busy ?? "Elegir archivo y ver la vista previa"}
              </Button>
            </div>
          )}

          <ProfilesBlock
            profiles={profiles.data ?? []}
            readOnly={ro}
            onNew={() =>
              setEditProfile({
                name: "",
                jurisdiction: jur,
                kind: "both",
                config: { file_type: "delimited", separator: ";", date_format: "auto", columns: { cuit: { index: 1 } } },
              })
            }
            onEdit={setEditProfile}
            onDelete={setDelProfile}
            onHistory={setHistProfile}
          />

          <ManualRate readOnly={ro} defaultJur={jur} />

          <div>
            <h4 className="mb-1 text-sm font-semibold">Importaciones</h4>
            {(list.data ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">Todavía no cargaste ningún padrón.</p>
            ) : (
              <ul className="divide-y divide-border">
                {(list.data ?? []).map((p) => {
                  const expired = p.status === "ready" && p.period_to != null && p.period_to < todayAr();
                  return (
                    <li key={p.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                          {jurisdictionName(p.jurisdiction)} · {KIND_LABEL[p.kind]}
                          {p.format === "manual" && <Badge tone="brand">Manual</Badge>}
                          <Badge tone={expired ? "warning" : STATUS[p.status].tone}>
                            {expired ? "Vencido" : STATUS[p.status].label}
                          </Badge>
                        </p>
                        <p className="mt-0.5 text-[13px] text-muted-foreground">
                          {p.period_from ? `${fmtDate(p.period_from)} al ${fmtDate(p.period_to)} · ` : ""}
                          {p.rows_loaded.toLocaleString("es-AR")} CUIT
                          {p.rows_error > 0 ? ` · ${p.rows_error.toLocaleString("es-AR")} con error` : ""}
                          {p.file_name ? ` · ${p.file_name}` : ""}
                        </p>
                      </div>
                      {!ro && (
                        <Button variant="ghost" size="sm" aria-label="Borrar" onClick={() => setDel(p)}>
                          <Trash2 size={15} />
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}

      {preview && (
        <PreviewModal
          file={preview.file}
          res={preview.res}
          truncated={preview.file.size > PREVIEW_BYTES}
          onClose={() => setPreview(null)}
          onApply={() => void run(preview.file)}
        />
      )}
      {editProfile && <ProfileModal profile={editProfile} onClose={() => setEditProfile(null)} />}
      {histProfile?.id && (
        <HistoryModal
          catalog="tax_padron_profiles"
          itemKey={histProfile.id}
          title={histProfile.name}
          onClose={() => setHistProfile(null)}
        />
      )}
      <ConfirmDialog
        open={Boolean(delProfile)}
        onOpenChange={(o) => !o && setDelProfile(null)}
        title="Quitar perfil"
        description="Los padrones ya cargados con este perfil siguen vigentes."
        confirmLabel="Quitar"
        danger
        onConfirm={() =>
          delProfile?.id &&
          removeProfile.mutate(delProfile.id, {
            onSuccess: () => setDelProfile(null),
            onError: (e) => toast({ title: "No se pudo quitar", description: errorText(e), variant: "error" }),
          })
        }
      />
      <ConfirmDialog
        open={Boolean(del)}
        onOpenChange={(o) => !o && setDel(null)}
        title="Borrar padrón"
        description="Las ventas nuevas dejan de usar estas alícuotas. Lo ya percibido queda igual."
        confirmLabel="Borrar"
        danger
        onConfirm={async () => {
          if (!del) return;
          try {
            await taxApi.padronDelete(del.id);
            void qc.invalidateQueries({ queryKey: ["tax"] });
          } catch (e) {
            toast({ title: "No se pudo borrar", description: errorText(e), variant: "error" });
          }
          setDel(null);
        }}
      />
    </SettingsCard>
  );
}

// ---------------------------------------------------------------------------
// Vista previa
// ---------------------------------------------------------------------------
function PreviewModal({
  file,
  res,
  truncated,
  onClose,
  onApply,
}: {
  file: File;
  res: ReturnType<typeof previewProfile>;
  truncated: boolean;
  onClose: () => void;
  onApply: () => void;
}) {
  const read = res.rows.length + res.skipped;
  const allBad = read === 0 && res.errors.length > 0;
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Vista previa del padrón"
      description={`${file.name}${truncated ? " · primeras líneas del archivo" : ""}`}
      className="max-w-3xl"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={onApply} disabled={allBad}>
            <FileUp size={15} /> Aplicar el archivo completo
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <p className="text-sm">
          Leídas bien: <strong>{read.toLocaleString("es-AR")}</strong> · con error:{" "}
          <strong>{res.errors.length.toLocaleString("es-AR")}</strong>
          {res.period.from ? ` · vigencia ${fmtDate(res.period.from)} al ${fmtDate(res.period.to)}` : ""}
        </p>
        {allBad && (
          <Callout tone="warning" title="Ninguna fila se pudo leer">
            Revisá el formato elegido: separador, columnas o posiciones y formato de fecha.
          </Callout>
        )}
        {res.sample.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-[13px]">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-1 pr-2 font-medium">CUIT</th>
                  <th className="py-1 pr-2 font-medium">Percepción</th>
                  <th className="py-1 pr-2 font-medium">Retención</th>
                  <th className="py-1 pr-2 font-medium">Desde</th>
                  <th className="py-1 pr-2 font-medium">Hasta</th>
                </tr>
              </thead>
              <tbody>
                {res.sample.map((r, i) => (
                  <tr key={`${r.cuit}-${i}`} className="border-t border-border">
                    <td className="py-1 pr-2 tabular-nums">{r.cuit}</td>
                    <td className="py-1 pr-2 tabular-nums">{r.perception_rate ?? "-"}</td>
                    <td className="py-1 pr-2 tabular-nums">{r.retention_rate ?? "-"}</td>
                    <td className="py-1 pr-2">{fmtDate(r.valid_from)}</td>
                    <td className="py-1 pr-2">{fmtDate(r.valid_to)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {res.errors.length > 0 && (
          <div>
            <h4 className="mb-1 text-sm font-semibold">Filas con error (no se cargan)</h4>
            <ul className="max-h-48 space-y-1 overflow-y-auto text-xs">
              {res.errors.map((e) => (
                <li key={e.line} className="text-muted-foreground">
                  <span className="font-medium text-foreground">Línea {e.line}</span>: {PROFILE_REASON_LABEL[e.reason] ?? e.reason}
                  <span className="block truncate font-mono">{e.text}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Perfiles
// ---------------------------------------------------------------------------
function ProfilesBlock({
  profiles,
  readOnly,
  onNew,
  onEdit,
  onDelete,
  onHistory,
}: {
  profiles: PadronProfile[];
  readOnly: boolean;
  onNew: () => void;
  onEdit: (p: PadronProfile) => void;
  onDelete: (p: PadronProfile) => void;
  onHistory: (p: PadronProfile) => void;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">Mis perfiles de importación</h4>
        {!readOnly && (
          <Button variant="ghost" size="sm" onClick={onNew}>
            <Plus size={15} /> Nuevo perfil
          </Button>
        )}
      </div>
      {profiles.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          Si tu provincia publica el padrón con otro diseño (CSV o ancho fijo), armá un perfil con las columnas y usalo
          cada mes.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {profiles.map((p) => (
            <li key={p.id} className="flex flex-col gap-2 py-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 text-[13px]">
                <p className="text-sm font-medium">{p.name}</p>
                <p className="text-muted-foreground">
                  {jurisdictionName(p.jurisdiction)} · {KIND_LABEL[p.kind]} ·{" "}
                  {p.config.file_type === "fixed" ? "ancho fijo" : `CSV (${p.config.separator === "\\t" ? "tab" : p.config.separator})`}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button variant="ghost" size="sm" aria-label={`Historial de ${p.name}`} onClick={() => onHistory(p)}>
                  <History size={15} />
                </Button>
                {!readOnly && (
                  <>
                    <Button variant="ghost" size="sm" aria-label={`Editar ${p.name}`} onClick={() => onEdit(p)}>
                      <Pencil size={15} />
                    </Button>
                    <Button variant="ghost" size="sm" aria-label={`Quitar ${p.name}`} onClick={() => onDelete(p)}>
                      <Trash2 size={15} />
                    </Button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const FIELDS: PadronField[] = [
  "cuit",
  "perception_rate",
  "retention_rate",
  "rate",
  "regime",
  "valid_from",
  "valid_to",
  "group_code",
  "name",
];

const FIELD_HELP: Partial<Record<PadronField, string>> = {
  cuit: "Obligatorio.",
  perception_rate: "Si el archivo trae las dos alícuotas en columnas separadas (como AGIP).",
  retention_rate: "Idem, la de retención.",
  rate: "Si trae una sola alícuota. Con una columna de régimen, la fila dice si es de percepción o de retención.",
  regime: "Opcional: la columna que dice P (percepción) o R (retención).",
  valid_from: "Opcional: sin fechas, se usa el período que elegís al importar.",
  valid_to: "Opcional.",
};

type ColText = Record<PadronField, { a: string; b: string }>;

function colsToText(c: PadronProfileConfig): ColText {
  const out = {} as ColText;
  for (const f of FIELDS) {
    const ref = c.columns[f];
    out[f] = !ref ? { a: "", b: "" } : "start" in ref ? { a: String(ref.start), b: String(ref.length) } : { a: String(ref.index), b: "" };
  }
  return out;
}

function ProfileModal({ profile, onClose }: { profile: PadronProfile; onClose: () => void }) {
  const { save } = useProfileMutations();
  const { toast } = useToast();
  const [name, setName] = useState(profile.name);
  const [jur, setJur] = useState(profile.jurisdiction || "902");
  const [kind, setKind] = useState<PadronProfile["kind"]>(profile.kind);
  const [c, setC] = useState<PadronProfileConfig>(profile.config);
  const [cols, setCols] = useState<ColText>(() => colsToText(profile.config));
  const fixed = c.file_type === "fixed";

  const config = (): PadronProfileConfig => {
    const columns: Partial<Record<PadronField, ColumnRef | null>> = {};
    for (const f of FIELDS) {
      const a = Number(cols[f].a);
      const b = Number(cols[f].b);
      if (!cols[f].a.trim()) continue;
      columns[f] = fixed ? { start: a, length: b } : { index: a };
    }
    return { ...c, columns };
  };
  const problems = validateProfile(config());

  const submit = () => {
    if (!name.trim()) {
      toast({ title: "Poné un nombre al perfil", variant: "error" });
      return;
    }
    if (problems.length) {
      toast({ title: problems[0]!, variant: "error" });
      return;
    }
    save.mutate(
      { id: profile.id, name: name.trim(), jurisdiction: jur, kind, config: config() },
      {
        onSuccess: () => {
          toast({ title: "Perfil guardado", variant: "success" });
          onClose();
        },
        onError: (e) => toast({ title: "No se guardó", description: errorText(e), variant: "error" }),
      },
    );
  };

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={profile.id ? "Editar perfil de padrón" : "Nuevo perfil de padrón"}
      description="Decile al sistema cómo leer el archivo. Lo guardás una vez y lo usás cada mes."
      className="max-w-2xl"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={submit} loading={save.isPending}>
            Guardar perfil
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {!profile.id && (
          <Select
            label="Empezar desde"
            value={null}
            placeholder="Una plantilla (opcional)"
            onChange={(k) => {
              const b = BUILTIN_PROFILES.find((x) => x.builtin === k)!;
              setC(b.config);
              setCols(colsToText(b.config));
              if (!name) setName(`${b.name} (mío)`);
            }}
            options={BUILTIN_PROFILES.map((b) => ({ value: b.builtin!, label: b.name }))}
          />
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Nombre" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          <Select label="Jurisdicción" value={jur} onChange={setJur} options={JUR_OPTIONS} />
          <Select
            label="Contenido"
            value={kind}
            onChange={setKind}
            options={(["perception", "retention", "both"] as const).map((k) => ({ value: k, label: KIND_LABEL[k] }))}
          />
          <Select
            label="Tipo de archivo"
            value={c.file_type}
            onChange={(t) => setC((x) => ({ ...x, file_type: t }))}
            hint="CSV: los datos separados por un carácter. Ancho fijo: cada dato en una posición de la línea."
            options={[
              { value: "delimited", label: "CSV o texto con separador" },
              { value: "fixed", label: "Texto de ancho fijo" },
            ]}
          />
          {!fixed && (
            <Select
              label="Separador"
              value={c.separator ?? ";"}
              onChange={(v) => setC((x) => ({ ...x, separator: v }))}
              options={SEPARATORS}
            />
          )}
          <Select
            label="Formato de fecha"
            value={c.date_format ?? "auto"}
            onChange={(v) => setC((x) => ({ ...x, date_format: v as DateFormat }))}
            options={DATE_FORMATS}
          />
          <Select
            label="Decimales de la alícuota"
            value={c.decimal_sep ?? "auto"}
            onChange={(v) => setC((x) => ({ ...x, decimal_sep: v === "auto" ? undefined : (v as "," | ".") }))}
            options={[
              { value: "auto", label: "Detectar" },
              { value: ",", label: "Coma (1,50)" },
              { value: ".", label: "Punto (1.50)" },
            ]}
          />
          <Select
            label="La alícuota viene"
            value={String(c.rate_divisor ?? 1)}
            onChange={(v) => setC((x) => ({ ...x, rate_divisor: Number(v) }))}
            hint="Algunos archivos traen 150 para decir 1,50 %."
            options={[
              { value: "1", label: "En porcentaje (1,50)" },
              { value: "100", label: "Multiplicada por 100 (150)" },
              { value: "10000", label: "Multiplicada por 10000 (15000)" },
            ]}
          />
          <Input
            label="Líneas a saltear al principio"
            inputMode="numeric"
            value={String(c.skip_lines ?? 0)}
            onChange={(e) => setC((x) => ({ ...x, skip_lines: Math.max(0, Number(normalizeDigits(e.target.value)) || 0) }))}
          />
          <label className="flex items-center justify-between gap-3 text-sm">
            La primera línea es el encabezado
            <Switch
              checked={Boolean(c.has_header)}
              onCheckedChange={(v) => setC((x) => ({ ...x, has_header: v }))}
              label="Encabezado"
            />
          </label>
        </div>

        <div>
          <h4 className="mb-1 text-sm font-semibold">{fixed ? "Posiciones (1 = primer carácter)" : "Columnas (1 = primera)"}</h4>
          <div className="space-y-2">
            {FIELDS.map((f) => (
              <div key={f} className="grid items-end gap-2 sm:grid-cols-[minmax(0,1fr)_7rem_7rem]">
                <div className="text-[13px]">
                  <p className="font-medium">{FIELD_LABEL[f]}</p>
                  {FIELD_HELP[f] && <p className="text-xs text-muted-foreground">{FIELD_HELP[f]}</p>}
                </div>
                <Input
                  aria-label={`${FIELD_LABEL[f]} ${fixed ? "posición" : "columna"}`}
                  inputMode="numeric"
                  placeholder={fixed ? "Posición" : "Columna"}
                  value={cols[f].a}
                  onChange={(e) => setCols((x) => ({ ...x, [f]: { ...x[f], a: normalizeDigits(e.target.value) } }))}
                />
                {fixed ? (
                  <Input
                    aria-label={`${FIELD_LABEL[f]} largo`}
                    inputMode="numeric"
                    placeholder="Largo"
                    value={cols[f].b}
                    onChange={(e) => setCols((x) => ({ ...x, [f]: { ...x[f], b: normalizeDigits(e.target.value) } }))}
                  />
                ) : (
                  <span />
                )}
              </div>
            ))}
          </div>
        </div>
        {cols.regime.a && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label="Valor de percepción en la columna de régimen"
              value={c.regime_values?.perception ?? "P"}
              maxLength={5}
              onChange={(e) => setC((x) => ({ ...x, regime_values: { ...x.regime_values, perception: e.target.value } }))}
            />
            <Input
              label="Valor de retención"
              value={c.regime_values?.retention ?? "R"}
              maxLength={5}
              onChange={(e) => setC((x) => ({ ...x, regime_values: { ...x.regime_values, retention: e.target.value } }))}
            />
          </div>
        )}
        {problems.length > 0 && (
          <Callout tone="warning" title="Falta completar">
            {problems.join(" ")}
          </Callout>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Alícuota manual por CUIT
// ---------------------------------------------------------------------------
function ManualRate({ readOnly, defaultJur }: { readOnly: boolean; defaultJur: string }) {
  const { manual } = useProfileMutations();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [jur, setJur] = useState(defaultJur);
  const [cuit, setCuit] = useState("");
  const [per, setPer] = useState("");
  const [ret, setRet] = useState("");
  const [from, setFrom] = useState(todayAr());
  const [to, setTo] = useState("");
  const qc = useQueryClient();
  const d = normalizeDigits(cuit);
  const cuitBad = d.length > 0 && !isValidCuit(d);

  const submit = () => {
    const p = parseDecimal(per);
    const r = parseDecimal(ret);
    if (!isValidCuit(d) || (p == null && r == null) || Number.isNaN(p) || Number.isNaN(r) || !from || !to || to < from) {
      toast({ title: "Completá el CUIT, al menos una alícuota y la vigencia", variant: "error" });
      return;
    }
    manual.mutate(
      { jurisdiction: jur, cuit: d, perception_rate: p, retention_rate: r, valid_from: from, valid_to: to },
      {
        onSuccess: () => {
          toast({ title: "Alícuota cargada para el CUIT", variant: "success" });
          setOpen(false);
          setCuit("");
          setPer("");
          setRet("");
          void qc.invalidateQueries({ queryKey: ["tax"] });
        },
        onError: (e) => toast({ title: "No se guardó", description: errorText(e), variant: "error" }),
      },
    );
  };

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">Alícuota a mano para un CUIT</h4>
        {!readOnly && (
          <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
            <UserCheck size={15} /> Cargar
          </Button>
        )}
      </div>
      <p className="text-[13px] text-muted-foreground">
        Para un cliente o proveedor con una alícuota distinta (constancia, nota del organismo). Manda sobre los padrones
        importados mientras esté vigente.
      </p>
      {open && (
        <Modal
          open
          onOpenChange={(o) => !o && setOpen(false)}
          title="Alícuota a mano para un CUIT"
          footer={
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setOpen(false)}>
                Cancelar
              </Button>
              <Button onClick={submit} loading={manual.isPending}>
                Guardar
              </Button>
            </div>
          }
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Select label="Jurisdicción" value={jur} onChange={setJur} options={JUR_OPTIONS} />
            <Input
              label="CUIT"
              inputMode="numeric"
              value={cuit}
              error={cuitBad ? "CUIT inválido" : undefined}
              onChange={(e) => setCuit(e.target.value)}
            />
            <Input label="Percepción %" inputMode="decimal" value={per} hint="Vacío: no cambia la percepción." onChange={(e) => setPer(e.target.value)} />
            <Input label="Retención %" inputMode="decimal" value={ret} hint="Vacío: no cambia la retención." onChange={(e) => setRet(e.target.value)} />
            <Input label="Desde" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            <Input label="Hasta" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </Modal>
      )}
    </div>
  );
}
