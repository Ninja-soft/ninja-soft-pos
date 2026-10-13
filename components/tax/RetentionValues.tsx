"use client";

// Valores de retención como agente (F18 · H106, ADR-079; ADR-101): conceptos
// de Ganancias de la RG 830 y actividades de SUSS que vienen como PLANTILLA de
// NinjaSoft. El negocio o su contador los pisa con vigencia, los desactiva,
// crea conceptos propios y edita las escalas. Volver a la plantilla quita sus
// versiones.

import { useMemo, useState } from "react";
import { Lock, Percent, Plus, Table2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/Toast";
import { SettingsCard } from "@/components/settings/Settings";
import { formatCurrency } from "@/lib/utils/format";
import {
  RET_CONCEPT_FIELDS,
  parseDecimal,
  sortVersions,
  validateScale,
  validateValidity,
  type CustomState,
  type ScaleRow,
} from "@/lib/tax/custom";
import type { RetConceptEff, TaxSettings } from "@/modules/tax/api";
import { useRetConcepts } from "@/modules/tax/hooks";
import { useCustomMutations, useCustomValues, useScale, versionsOf } from "@/modules/tax/customHooks";
import {
  CustomValueModal,
  HistoryModal,
  RowActions,
  StateBadge,
  errorText,
  fmtDate,
  todayAr,
  validityText,
} from "./custom/CustomValueKit";

const pct = (n: number | null) => (n == null ? "escala" : `${n.toLocaleString("es-AR", { maximumFractionDigits: 4 })} %`);

function stateOf(c: RetConceptEff): CustomState {
  if (!c.is_active) return "disabled";
  if (c.custom) return "own";
  return c.overridden ? "custom" : "template";
}

const GAN_FIELDS = RET_CONCEPT_FIELDS;
const SUSS_FIELDS = RET_CONCEPT_FIELDS.filter((f) =>
  ["name", "rate_registered", "min_non_taxable", "min_withholding", "sicore_regime_code", "sicore_tax_code"].includes(f.key),
).map((f) =>
  f.key === "rate_registered"
    ? { ...f, label: "Alícuota", help: "Porcentaje de SUSS de la actividad." }
    : f.key === "min_non_taxable"
      ? { ...f, label: "Pago mínimo", help: "Debajo de este pago no se retiene." }
      : f,
);

export function RetentionValues({ settings }: { settings: TaxSettings }) {
  const enabled = settings.features.percepciones;
  const { data: concepts = [] } = useRetConcepts(enabled);
  const values = useCustomValues(enabled);
  const [edit, setEdit] = useState<RetConceptEff | null>(null);
  const [hist, setHist] = useState<RetConceptEff | null>(null);
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState<{ tax: "ganancias" | "suss"; code: string } | null>(null);
  const ro = !settings.can_write;
  const gan = concepts.filter((c) => c.tax === "ganancias");
  const suss = concepts.filter((c) => c.tax === "suss");

  return (
    <SettingsCard
      title="Conceptos de retención"
      description="Mínimos no sujetos, alícuotas, retención mínima y códigos de SICORE para Ganancias (RG 830) y SUSS."
      icon={Percent}
      actions={
        enabled &&
        !ro && (
          <Button size="sm" variant="secondary" onClick={() => setCreating(true)}>
            <Plus size={15} /> Concepto propio
          </Button>
        )
      }
      padded
    >
      {!enabled ? (
        <Callout tone="neutral" icon={Lock} title="Desde el plan Business">
          Retenciones como agente con acumulado mensual, certificados y archivos para SICORE y ARBA.
        </Callout>
      ) : (
        <div className="space-y-5">
          <Callout tone="warning" title="Verificalos con tu contador">
            Vienen cargados con los montos de la RG 5423/2023 y las resoluciones de SUSS. Cambian por resolución: cargá
            el valor nuevo con la fecha desde la que rige y los pagos de antes siguen con el anterior.
          </Callout>
          <Group title="Ganancias (RG 830)" items={gan} ro={ro} onEdit={setEdit} onHistory={setHist} />
          <Group title="SUSS" items={suss} ro={ro} onEdit={setEdit} onHistory={setHist} />
          <p className="text-xs text-muted-foreground">
            Cómo se calcula Ganancias: se suman los pagos del mes al proveedor por el mismo concepto, se resta el mínimo
            no sujeto y sobre el resto se aplica la alícuota (o la escala, en honorarios). Se retiene lo que falta
            respecto de lo ya retenido en el mes. Si da menos que la retención mínima, no se retiene y queda acumulado.
            A los no inscriptos no se les descuenta el mínimo.
          </p>
        </div>
      )}
      {(edit || newKey) && (
        <CustomValueModal
          title={edit ? edit.name : `Concepto propio ${newKey!.code}`}
          description={edit && !edit.custom ? `Fuente: ${edit.source}.` : "Concepto creado por tu negocio."}
          catalog="ret_concept"
          itemKey={edit ? `${edit.tax}:${edit.code}` : `${newKey!.tax}:${newKey!.code}`}
          fields={(edit ? edit.tax : newKey!.tax) === "ganancias" ? GAN_FIELDS : SUSS_FIELDS}
          template={edit && !edit.custom ? (edit.template ?? null) : null}
          versions={versionsOf(values.data, "ret_concept", edit ? `${edit.tax}:${edit.code}` : `${newKey!.tax}:${newKey!.code}`)}
          isCustom={Boolean(newKey) || Boolean(edit?.custom)}
          canReset={Boolean(edit?.overridden)}
          allowDisable
          readOnly={ro}
          onClose={() => {
            setEdit(null);
            setNewKey(null);
          }}
        />
      )}
      {hist && (
        <HistoryModal catalog="ret_concept" itemKey={`${hist.tax}:${hist.code}`} title={hist.name} onClose={() => setHist(null)} />
      )}
      {creating && (
        <NewConceptModal
          existing={concepts}
          onClose={() => setCreating(false)}
          onNext={(k) => {
            setCreating(false);
            setNewKey(k);
          }}
        />
      )}
    </SettingsCard>
  );
}

function Group({
  title,
  items,
  ro,
  onEdit,
  onHistory,
}: {
  title: string;
  items: RetConceptEff[];
  ro: boolean;
  onEdit: (c: RetConceptEff) => void;
  onHistory: (c: RetConceptEff) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <h4 className="mb-1 text-sm font-semibold">{title}</h4>
      <ul className="divide-y divide-border">
        {items.map((c) => (
          <li key={`${c.tax}:${c.code}`} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                {c.tax === "ganancias" ? `${c.code} · ` : ""}
                {c.name}
                <StateBadge state={stateOf(c)} />
              </p>
              <p className="mt-0.5 text-[13px] text-muted-foreground">
                {c.tax === "ganancias"
                  ? `Mínimo mensual ${formatCurrency(c.min_non_taxable)} · inscripto ${pct(c.rate_registered)} · no inscripto ${pct(c.rate_unregistered)}`
                  : `Alícuota ${pct(c.rate_registered)}`}
                {` · retención mínima ${formatCurrency(c.min_withholding)}`}
                {` · SICORE ${c.sicore_tax_code ?? "-"}/${c.sicore_regime_code ?? "sin código"}`}
              </p>
            </div>
            <RowActions readOnly={ro} editLabel={c.name} onEdit={() => onEdit(c)} onHistory={() => onHistory(c)} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function NewConceptModal({
  existing,
  onClose,
  onNext,
}: {
  existing: RetConceptEff[];
  onClose: () => void;
  onNext: (k: { tax: "ganancias" | "suss"; code: string }) => void;
}) {
  const [tax, setTax] = useState<"ganancias" | "suss">("ganancias");
  const [code, setCode] = useState("");
  const clean = code.trim().toLowerCase();
  const bad = !/^[a-z0-9_]{1,20}$/.test(clean)
    ? "Letras minúsculas, números o guion bajo (hasta 20)."
    : existing.some((c) => c.tax === tax && c.code === clean)
      ? "Ya existe un concepto con ese código."
      : null;
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Nuevo concepto propio"
      description="Para un régimen que la plantilla no trae. Después cargás sus valores y desde cuándo rigen."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={Boolean(bad)} onClick={() => onNext({ tax, code: clean })}>
            Seguir
          </Button>
        </div>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Select
          label="Impuesto"
          value={tax}
          onChange={setTax}
          options={[
            { value: "ganancias", label: "Ganancias" },
            { value: "suss", label: "SUSS" },
          ]}
        />
        <Input
          label="Código"
          value={code}
          maxLength={20}
          hint={code ? (bad ?? "Se usa para elegirlo en el proveedor.") : "Por ejemplo, el código del régimen (100) o comisiones."}
          error={code && bad ? bad : undefined}
          onChange={(e) => setCode(e.target.value)}
        />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Escalas
// ---------------------------------------------------------------------------
export function RetentionScales({ settings }: { settings: TaxSettings }) {
  const enabled = settings.features.percepciones;
  const values = useCustomValues(enabled);
  const [open, setOpen] = useState<string | null>(null);
  const [hist, setHist] = useState<string | null>(null);
  const [newCode, setNewCode] = useState("");
  const ro = !settings.can_write;
  const codes = useMemo(() => {
    const set = new Set<string>(["rg830_anexo8"]);
    for (const v of values.data ?? []) if (v.catalog === "ret_scale") set.add(v.item_key);
    return [...set];
  }, [values.data]);
  const today = todayAr();

  return (
    <SettingsCard
      title="Escalas de retención"
      description="Fijo más un porcentaje del excedente según el tramo del sujeto a retención del mes (honorarios RG 830 y escalas propias)."
      icon={Table2}
      padded
    >
      {!enabled ? (
        <Callout tone="neutral" icon={Lock} title="Desde el plan Business">
          Escalas de Ganancias editables.
        </Callout>
      ) : (
        <div className="space-y-4">
          <ul className="divide-y divide-border">
            {codes.map((code) => {
              const versions = versionsOf(values.data, "ret_scale", code);
              const v = versions.find((x) => x.valid_from <= today && (!x.valid_to || x.valid_to >= today));
              const state: CustomState = code === "rg830_anexo8" ? (v ? "custom" : "template") : "own";
              return (
                <li key={code} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      {code === "rg830_anexo8" ? "RG 830 Anexo VIII" : code}
                      <StateBadge state={state} />
                    </p>
                    <p className="mt-0.5 text-[13px] text-muted-foreground">
                      {v ? validityText(v) : "Rige la plantilla de NinjaSoft"} · {versions.length} versiones tuyas
                    </p>
                  </div>
                  <RowActions readOnly={false} editLabel={code} onEdit={() => setOpen(code)} onHistory={() => setHist(code)} />
                </li>
              );
            })}
          </ul>
          {!ro && (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <Input
                label="Escala propia"
                value={newCode}
                maxLength={30}
                placeholder="honorarios_2027"
                hint="Código en minúsculas. Después elegila en un concepto (campo Escala)."
                onChange={(e) => setNewCode(e.target.value.toLowerCase())}
              />
              <Button
                variant="secondary"
                disabled={!/^[a-z0-9_]{1,30}$/.test(newCode) || codes.includes(newCode)}
                onClick={() => {
                  setOpen(newCode);
                  setNewCode("");
                }}
              >
                <Plus size={15} /> Crear
              </Button>
            </div>
          )}
        </div>
      )}
      {open && <ScaleModal code={open} readOnly={ro} onClose={() => setOpen(null)} />}
      {hist && <HistoryModal catalog="ret_scale" itemKey={hist} title={`Escala ${hist}`} onClose={() => setHist(null)} />}
    </SettingsCard>
  );
}

type RowText = { from_amount: string; to_amount: string; fixed: string; rate: string };
const toText = (r: ScaleRow): RowText => ({
  from_amount: String(r.from_amount).replace(".", ","),
  to_amount: r.to_amount == null ? "" : String(r.to_amount).replace(".", ","),
  fixed: String(r.fixed).replace(".", ","),
  rate: String(r.rate).replace(".", ","),
});

function ScaleModal({ code, readOnly, onClose }: { code: string; readOnly: boolean; onClose: () => void }) {
  const q = useScale(code);
  const values = useCustomValues();
  const { save, remove, reset } = useCustomMutations();
  const { toast } = useToast();
  const versions = sortVersions(versionsOf(values.data, "ret_scale", code));
  const template = q.data?.template ?? [];
  const [rows, setRows] = useState<RowText[] | null>(null);
  const [from, setFrom] = useState(todayAr());
  const [to, setTo] = useState("");
  const current: RowText[] =
    rows ?? (q.data?.custom ?? (template.length ? template : [{ from_amount: 0, to_amount: null, fixed: 0, rate: 0 }])).map(toText);

  const submit = () => {
    const bad = validateValidity(from, to || null);
    const parsed: ScaleRow[] = current.map((r) => ({
      from_amount: parseDecimal(r.from_amount) ?? NaN,
      to_amount: r.to_amount.trim() ? (parseDecimal(r.to_amount) ?? NaN) : null,
      fixed: parseDecimal(r.fixed) ?? 0,
      rate: parseDecimal(r.rate) ?? NaN,
    }));
    const err = bad ?? validateScale(parsed);
    if (err) {
      toast({ title: err, variant: "error" });
      return;
    }
    save.mutate(
      { catalog: "ret_scale", item_key: code, valid_from: from, valid_to: to || null, data: { brackets: parsed }, is_custom: code !== "rg830_anexo8" },
      {
        onSuccess: () => {
          toast({ title: `Escala guardada desde el ${fmtDate(from)}`, variant: "success" });
          setRows(null);
        },
        onError: (e) => toast({ title: "No se guardó", description: errorText(e), variant: "error" }),
      },
    );
  };

  const set = (i: number, k: keyof RowText, v: string) =>
    setRows(current.map((r, j) => (j === i ? { ...r, [k]: v } : r)));

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={code === "rg830_anexo8" ? "Escala RG 830 Anexo VIII" : `Escala ${code}`}
      description="Sobre el sujeto a retención del mes: fijo + (sujeto − desde) × porcentaje del tramo."
      className="max-w-2xl"
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
          <div>
            {!readOnly && code === "rg830_anexo8" && versions.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  reset.mutate(
                    { catalog: "ret_scale", key: code },
                    { onSuccess: () => setRows(null), onError: (e) => toast({ title: "No se pudo", description: errorText(e), variant: "error" }) },
                  )
                }
              >
                Volver a la plantilla
              </Button>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cerrar
            </Button>
            {!readOnly && (
              <Button onClick={submit} loading={save.isPending}>
                Guardar versión
              </Button>
            )}
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        {versions.length > 0 && (
          <ul className="divide-y divide-border text-[13px]">
            {versions.map((v) => (
              <li key={v.id} className="flex items-center justify-between gap-2 py-2">
                <span>
                  {validityText(v)} · {Array.isArray(v.data.brackets) ? v.data.brackets.length : 0} tramos
                </span>
                {!readOnly && (
                  <Button variant="ghost" size="sm" aria-label="Quitar versión" onClick={() => remove.mutate(v.id)}>
                    <Trash2 size={15} />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[480px] text-[13px]">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="py-1 pr-2 font-medium">Desde $</th>
                <th className="py-1 pr-2 font-medium">Hasta $</th>
                <th className="py-1 pr-2 font-medium">Fijo $</th>
                <th className="py-1 pr-2 font-medium">% excedente</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {current.map((r, i) => (
                <tr key={i}>
                  {(["from_amount", "to_amount", "fixed", "rate"] as const).map((k) => (
                    <td key={k} className="py-1 pr-2">
                      <Input
                        aria-label={k}
                        inputMode="decimal"
                        value={r[k]}
                        disabled={readOnly}
                        placeholder={k === "to_amount" ? "sin tope" : ""}
                        onChange={(e) => set(i, k, e.target.value)}
                      />
                    </td>
                  ))}
                  <td>
                    {!readOnly && current.length > 1 && (
                      <Button variant="ghost" size="sm" aria-label="Quitar tramo" onClick={() => setRows(current.filter((_, j) => j !== i))}>
                        <Trash2 size={15} />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!readOnly && (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setRows([...current, { from_amount: "", to_amount: "", fixed: "0", rate: "" }])}
            >
              <Plus size={15} /> Agregar tramo
            </Button>
            <div className="grid gap-3 sm:grid-cols-2">
              <Input label="Rige desde" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              <Input label="Hasta (opcional)" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
          </>
        )}
        {code === "rg830_anexo8" && template.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Plantilla NinjaSoft:{" "}
            {template.map((t) => `${formatCurrency(t.from_amount)}: ${formatCurrency(t.fixed)} + ${t.rate} %`).join(" · ")}
          </p>
        )}
      </div>
    </Modal>
  );
}
