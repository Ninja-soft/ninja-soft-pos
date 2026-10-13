"use client";

// Valores de retención como agente (F18 · H106, ADR-079): conceptos de
// Ganancias de la RG 830 y actividades de SUSS que vienen cargados por
// NinjaSoft (catálogo con vigencia) y que el negocio o su contador pueden
// ajustar sin esperar una actualización. Vacío = usa el valor del catálogo.

import { useState } from "react";
import { Lock, Pencil, Percent } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { SettingsCard } from "@/components/settings/Settings";
import { formatCurrency } from "@/lib/utils/format";
import { taxErrorMessage, type RetConceptEff, type RetConceptSetting, type TaxSettings } from "@/modules/tax/api";
import { useRetConceptSettings, useRetConcepts, useSaveRetConceptSetting } from "@/modules/tax/hooks";

const pct = (n: number | null) => (n == null ? "escala" : `${n.toLocaleString("es-AR", { maximumFractionDigits: 4 })} %`);

export function RetentionValues({ settings }: { settings: TaxSettings }) {
  const enabled = settings.features.percepciones;
  const { data: concepts = [] } = useRetConcepts(enabled);
  const { data: overrides = [] } = useRetConceptSettings(enabled);
  const [edit, setEdit] = useState<RetConceptEff | null>(null);
  const ro = !settings.can_write;
  const gan = concepts.filter((c) => c.tax === "ganancias");
  const suss = concepts.filter((c) => c.tax === "suss");

  return (
    <SettingsCard
      title="Valores de retención"
      description="Mínimos no sujetos, alícuotas y códigos de SICORE para retener Ganancias (RG 830) y SUSS."
      icon={Percent}
      padded
    >
      {!enabled ? (
        <Callout tone="neutral" icon={Lock} title="Desde el plan Business">
          Retenciones como agente con acumulado mensual, certificados y archivos para SICORE y ARBA.
        </Callout>
      ) : (
        <div className="space-y-5">
          <Callout tone="warning" title="Verificalos con tu contador">
            Vienen cargados con los montos de la RG 5423/2023 y las resoluciones de SUSS. Cambian por resolución: si tu
            contador te pasa otros valores, ajustalos acá (vacío = el valor de NinjaSoft).
          </Callout>
          <Group title="Ganancias (RG 830)" items={gan} overrides={overrides} ro={ro} onEdit={setEdit} />
          <Group title="SUSS" items={suss} overrides={overrides} ro={ro} onEdit={setEdit} />
          <p className="text-xs text-muted-foreground">
            Cómo se calcula Ganancias: se suman los pagos del mes al proveedor por el mismo concepto, se resta el mínimo
            no sujeto y sobre el resto se aplica la alícuota (o la escala, en honorarios). Se retiene lo que falta
            respecto de lo ya retenido en el mes. Si da menos que la retención mínima, no se retiene y queda acumulado.
            A los no inscriptos no se les descuenta el mínimo.
          </p>
        </div>
      )}
      {edit && (
        <ValueModal
          concept={edit}
          current={overrides.find((o) => o.tax === edit.tax && o.code === edit.code) ?? null}
          onClose={() => setEdit(null)}
        />
      )}
    </SettingsCard>
  );
}

function Group({
  title,
  items,
  overrides,
  ro,
  onEdit,
}: {
  title: string;
  items: RetConceptEff[];
  overrides: RetConceptSetting[];
  ro: boolean;
  onEdit: (c: RetConceptEff) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <h4 className="mb-1 text-sm font-semibold">{title}</h4>
      <ul className="divide-y divide-border">
        {items.map((c) => {
          const o = overrides.find((x) => x.tax === c.tax && x.code === c.code);
          return (
            <li key={`${c.tax}:${c.code}`} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {c.tax === "ganancias" ? `${c.code} · ` : ""}
                  {c.name}
                  {c.overridden && <Badge tone="info">Ajustado</Badge>}
                  {!c.is_active && <Badge tone="neutral">Desactivado</Badge>}
                </p>
                <p className="mt-0.5 text-[13px] text-muted-foreground">
                  {c.tax === "ganancias"
                    ? `Mínimo mensual ${formatCurrency(c.min_non_taxable)} · inscripto ${pct(c.rate_registered)} · no inscripto ${pct(c.rate_unregistered)}`
                    : `Alícuota ${pct(c.rate_registered)}`}
                  {` · retención mínima ${formatCurrency(c.min_withholding)}`}
                  {` · SICORE ${c.sicore_tax_code ?? "-"}/${c.sicore_regime_code ?? "sin código"}`}
                </p>
                {o?.notes && <p className="mt-0.5 text-xs text-muted-foreground">{o.notes}</p>}
              </div>
              {!ro && (
                <Button variant="ghost" size="sm" aria-label={`Ajustar ${c.name}`} onClick={() => onEdit(c)}>
                  <Pencil size={15} />
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function num(v: string): number | null {
  const s = v.trim().replace(",", ".");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
const str = (n: number | null | undefined) => (n == null ? "" : String(n).replace(".", ","));

function ValueModal({
  concept,
  current,
  onClose,
}: {
  concept: RetConceptEff;
  current: RetConceptSetting | null;
  onClose: () => void;
}) {
  const save = useSaveRetConceptSetting();
  const { toast } = useToast();
  const gan = concept.tax === "ganancias";
  const [active, setActive] = useState(current?.is_active ?? true);
  const [min, setMin] = useState(str(current?.min_non_taxable));
  const [reg, setReg] = useState(str(current?.rate_registered));
  const [unreg, setUnreg] = useState(str(current?.rate_unregistered));
  const [minWh, setMinWh] = useState(str(current?.min_withholding));
  const [code, setCode] = useState(current?.sicore_regime_code ?? "");
  const [notes, setNotes] = useState(current?.notes ?? "");

  const submit = () => {
    save.mutate(
      {
        id: current?.id ?? null,
        tax: concept.tax,
        code: concept.code,
        is_active: active,
        min_non_taxable: num(min),
        rate_registered: concept.uses_scale ? null : num(reg),
        rate_unregistered: num(unreg),
        min_withholding: num(minWh),
        sicore_regime_code: code.trim() || null,
        notes: notes.trim() || null,
      },
      {
        onSuccess: () => {
          toast({ title: "Valores guardados", variant: "success" });
          onClose();
        },
        onError: (e) => toast({ title: "No se guardó", description: taxErrorMessage(e), variant: "error" }),
      },
    );
  };

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={concept.name}
      description={`Fuente: ${concept.source}. Vacío = usa el valor de NinjaSoft.`}
      className="max-w-xl"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={submit} loading={save.isPending}>
            Guardar
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          {gan && (
            <Input
              label="Mínimo no sujeto mensual $"
              inputMode="decimal"
              value={min}
              placeholder={str(concept.min_non_taxable)}
              onChange={(e) => setMin(e.target.value)}
            />
          )}
          {!concept.uses_scale && (
            <Input
              label={gan ? "Alícuota inscripto %" : "Alícuota %"}
              inputMode="decimal"
              value={reg}
              placeholder={str(concept.rate_registered)}
              onChange={(e) => setReg(e.target.value)}
            />
          )}
          {gan && (
            <Input
              label="Alícuota no inscripto %"
              inputMode="decimal"
              value={unreg}
              placeholder={str(concept.rate_unregistered)}
              onChange={(e) => setUnreg(e.target.value)}
            />
          )}
          <Input
            label="Retención mínima $"
            inputMode="decimal"
            value={minWh}
            placeholder={str(concept.min_withholding)}
            onChange={(e) => setMinWh(e.target.value)}
          />
          <Input
            label="Código de régimen SICORE"
            value={code}
            maxLength={3}
            placeholder={concept.sicore_regime_code ?? "3 dígitos"}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          />
        </div>
        {concept.uses_scale && (
          <p className="text-xs text-muted-foreground">
            Los inscriptos se calculan con la escala del Anexo VIII de la RG 830 (se actualiza con NinjaSoft).
          </p>
        )}
        <Input label="Nota (opcional)" value={notes} maxLength={300} onChange={(e) => setNotes(e.target.value)} />
        <label className="flex items-center justify-between gap-3 text-sm">
          Usar este concepto
          <Switch checked={active} onCheckedChange={setActive} label="Usar este concepto" />
        </label>
      </div>
    </Modal>
  );
}
