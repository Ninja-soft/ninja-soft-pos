"use client";

// Valores impositivos editables por el negocio (ADR-101): alícuotas de IVA y
// parámetros (tope del consumidor final, criterio del proveedor sin
// constancia, códigos de los archivos). Cada uno muestra si rige la
// plantilla de NinjaSoft o un valor propio, con vigencia e historial.

import { useState } from "react";
import { FileOutput, Lock, Percent, SlidersHorizontal } from "lucide-react";
import { Callout } from "@/components/ui/Callout";
import { SettingsCard } from "@/components/settings/Settings";
import { IVA_CODES, IVA_RATES, type IvaCode } from "@/lib/tax/catalog";
import {
  IVA_RATE_FIELDS,
  PARAMETER_DEFS,
  resolveCustom,
  type FieldDef,
} from "@/lib/tax/custom";
import type { TaxSettings } from "@/modules/tax/api";
import { useCustomValues, useParameterTemplates, versionsOf } from "@/modules/tax/customHooks";
import { CustomValueModal, HistoryModal, RowActions, StateBadge, fmtField, todayAr, validityText } from "./CustomValueKit";

export function IvaRatesCard({ settings }: { settings: TaxSettings }) {
  const enabled = settings.features.iva;
  const values = useCustomValues(enabled);
  const [edit, setEdit] = useState<IvaCode | null>(null);
  const [hist, setHist] = useState<IvaCode | null>(null);
  const ro = !settings.can_write;
  const today = todayAr();

  return (
    <SettingsCard
      title="Alícuotas de IVA"
      description="Las que usás en los productos para desglosar cada venta. El código y el id de ARCA los fija ARCA; la alícuota y el nombre son tuyos."
      icon={Percent}
      padded
    >
      {!settings.features.iva ? (
        <Callout tone="neutral" icon={Lock} title="No incluido en tu plan">
          La configuración de IVA viene con todos los planes con facturación.
        </Callout>
      ) : (
        <ul className="divide-y divide-border">
          {IVA_CODES.map((code) => {
            const t = IVA_RATES[code];
            const versions = versionsOf(values.data, "iva_rate", code);
            const r = resolveCustom({ rate: t.rate, label: t.label }, versions, today);
            const next = versions.filter((v) => v.valid_from > today).sort((a, b) => a.valid_from.localeCompare(b.valid_from))[0];
            return (
              <li key={code} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {String(r.values.label)}
                    <StateBadge state={r.state} />
                  </p>
                  <p className="mt-0.5 text-[13px] text-muted-foreground">
                    {t.kind === "gravado" ? `Hoy ${fmtField({ kind: "percent" }, r.values.rate)}` : t.kind === "exento" ? "Exento" : "No gravado"}
                    {` · ARCA ${t.arcaId}`}
                    {r.version ? ` · ${validityText(r.version)}` : ""}
                    {next ? ` · Cambia el ${next.valid_from.split("-").reverse().join("/")}` : ""}
                  </p>
                </div>
                <RowActions readOnly={ro} editLabel={t.label} onEdit={() => setEdit(code)} onHistory={() => setHist(code)} />
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        Los impuestos internos se cargan en cada producto (pestaña Precios, Impuestos): son del negocio desde el inicio.
      </p>
      {edit && (
        <CustomValueModal
          title={`IVA ${IVA_RATES[edit].label}`}
          description="Un cambio de alícuota rige para las ventas desde la fecha que elijas. Lo ya vendido no cambia."
          catalog="iva_rate"
          itemKey={edit}
          fields={IVA_RATES[edit].kind === "gravado" ? IVA_RATE_FIELDS : IVA_RATE_FIELDS.filter((f) => f.key === "label")}
          template={{ rate: IVA_RATES[edit].rate, label: IVA_RATES[edit].label }}
          versions={versionsOf(values.data, "iva_rate", edit)}
          readOnly={ro}
          onClose={() => setEdit(null)}
        />
      )}
      {hist && <HistoryModal catalog="iva_rate" itemKey={hist} title={`IVA ${IVA_RATES[hist].label}`} onClose={() => setHist(null)} />}
    </SettingsCard>
  );
}

const SECTION_COPY = {
  iva: { title: "Valores de IVA", description: "Topes y avisos del comprobante.", icon: SlidersHorizontal },
  retenciones: {
    title: "Criterios de retención",
    description: "Qué hacer cuando falta un dato del proveedor.",
    icon: SlidersHorizontal,
  },
  exportaciones: {
    title: "Archivos para SICORE y ARBA",
    description: "Códigos fijos que van en cada archivo. Cambialos sólo si tu contador o el aplicativo lo piden.",
    icon: FileOutput,
  },
} as const;

/** Parámetros de una sección (plantilla en tax_parameters, valor del negocio con vigencia). */
export function ParametersCard({
  settings,
  section,
  needsFeature = "percepciones",
}: {
  settings: TaxSettings;
  section: keyof typeof SECTION_COPY;
  needsFeature?: "iva" | "percepciones";
}) {
  const enabled = needsFeature === "iva" ? settings.features.iva : settings.features.percepciones;
  const values = useCustomValues(enabled);
  const templates = useParameterTemplates(enabled);
  const [edit, setEdit] = useState<string | null>(null);
  const [hist, setHist] = useState<string | null>(null);
  const ro = !settings.can_write;
  const today = todayAr();
  const keys = Object.entries(PARAMETER_DEFS).filter(([, d]) => d.section === section);
  const copy = SECTION_COPY[section];

  return (
    <SettingsCard title={copy.title} description={copy.description} icon={copy.icon} padded>
      {!enabled ? (
        <Callout tone="neutral" icon={Lock} title="Desde el plan Business">
          Disponible con percepciones y retenciones.
        </Callout>
      ) : (
        <ul className="divide-y divide-border">
          {keys.map(([key, def]) => {
            const t = templates.data?.[key];
            const versions = versionsOf(values.data, "parameter", key);
            const r = resolveCustom(t ? { value: t.value } : null, versions, today);
            const shown = r.active ? r.values.value : null;
            const opt = def.options?.find((o) => o.value === Number(shown));
            return (
              <li key={key} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {def.label}
                    <StateBadge state={t ? r.state : "own"} />
                  </p>
                  <p className="mt-0.5 text-[13px] text-muted-foreground">
                    {r.active ? (opt ? opt.label : fmtField({ kind: def.kind }, shown)) : "Desactivado"}
                    {r.version ? ` · ${validityText(r.version)}` : ""}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{def.help}</p>
                </div>
                <RowActions readOnly={ro} editLabel={def.label} onEdit={() => setEdit(key)} onHistory={() => setHist(key)} />
              </li>
            );
          })}
        </ul>
      )}
      {edit && (
        <CustomValueModal
          title={PARAMETER_DEFS[edit]!.label}
          description={PARAMETER_DEFS[edit]!.help}
          catalog="parameter"
          itemKey={edit}
          fields={[
            {
              key: "value",
              label: "Valor",
              kind: PARAMETER_DEFS[edit]!.kind,
              min: 0,
              help: templates.data?.[edit]?.note ?? "",
            } satisfies FieldDef,
          ]}
          options={
            PARAMETER_DEFS[edit]!.options
              ? { value: PARAMETER_DEFS[edit]!.options!.map((o) => ({ value: String(o.value), label: o.label })) }
              : undefined
          }
          template={templates.data?.[edit] ? { value: templates.data[edit]!.value } : null}
          versions={versionsOf(values.data, "parameter", edit)}
          allowDisable={edit === "cf_id_threshold"}
          readOnly={ro}
          onClose={() => setEdit(null)}
        />
      )}
      {hist && <HistoryModal catalog="parameter" itemKey={hist} title={PARAMETER_DEFS[hist]?.label ?? hist} onClose={() => setHist(null)} />}
    </SettingsCard>
  );
}
