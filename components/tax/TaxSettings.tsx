"use client";

import { useEffect, useState } from "react";
import { Building2, Lock, Save } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { SettingRow, SettingsCard } from "@/components/settings/Settings";
import {
  EMITTER_CONDITIONS,
  FISCAL_CONDITION_LABEL,
  IVA_CODES,
  IVA_RATES,
  JURISDICTIONS,
  isValidCuit,
  type EmitterCondition,
  type IvaCode,
} from "@/lib/tax/catalog";
import { taxErrorMessage, type TaxSettings as Settings } from "@/modules/tax/api";
import { useSaveTaxSettings, useTaxSettings } from "@/modules/tax/hooks";
import { TaxRegimes } from "./TaxRegimes";
import { PadronImport } from "./PadronImport";

// Configuración > Impuestos (ADR-068): datos fiscales del negocio (BASE),
// agente de percepción y retención y padrones (percepciones_retenciones).
export function TaxSettings() {
  const q = useTaxSettings();
  if (q.isLoading) return <SpinnerBlock className="py-16" />;
  if (q.error || !q.data) {
    return (
      <Callout tone="warning" icon={Lock} title="No disponible">
        {taxErrorMessage(q.error)}
      </Callout>
    );
  }
  return (
    <div className="space-y-6">
      <FiscalCard settings={q.data} />
      <TaxRegimes settings={q.data} />
      <PadronImport settings={q.data} />
    </div>
  );
}

const JUR_OPTIONS = [
  { value: "", label: "Sin jurisdicción" },
  ...JURISDICTIONS.map((j) => ({ value: j.code, label: `${j.name} (${j.agency})` })),
];

function FiscalCard({ settings }: { settings: Settings }) {
  const save = useSaveTaxSettings();
  const { toast } = useToast();
  const [cond, setCond] = useState<EmitterCondition | "">(settings.iva_condition ?? "");
  const [cuit, setCuit] = useState(settings.cuit ?? "");
  const [iibb, setIibb] = useState(settings.iibb_number ?? "");
  const [jur, setJur] = useState(settings.iibb_jurisdiction ?? "");
  const [cm, setCm] = useState(settings.convenio_multilateral);
  const [rate, setRate] = useState<IvaCode>(settings.default_rate_code);
  const [m, setM] = useState(settings.issues_cbte_m);

  useEffect(() => {
    setCond(settings.iva_condition ?? "");
    setCuit(settings.cuit ?? "");
    setIibb(settings.iibb_number ?? "");
    setJur(settings.iibb_jurisdiction ?? "");
    setCm(settings.convenio_multilateral);
    setRate(settings.default_rate_code);
    setM(settings.issues_cbte_m);
  }, [settings]);

  const ro = !settings.can_write;
  const cuitBad = cuit.trim() !== "" && !isValidCuit(cuit);
  const ri = cond === "responsable_inscripto";

  const onSave = () =>
    save.mutate(
      {
        iva_condition: cond || null,
        cuit: cuit.trim() || null,
        iibb_number: iibb.trim() || null,
        iibb_jurisdiction: jur || null,
        convenio_multilateral: cm,
        default_rate_code: rate,
        issues_cbte_m: ri && m,
      },
      {
        onSuccess: () => toast({ title: "Datos fiscales guardados", variant: "success" }),
        onError: (e) => toast({ title: "No se guardó", description: taxErrorMessage(e), variant: "error" }),
      },
    );

  return (
    <SettingsCard
      title="Datos fiscales del negocio"
      description="De acá salen el tipo de comprobante de cada venta y si se discrimina el IVA."
      icon={Building2}
      actions={
        !ro && (
          <Button size="sm" onClick={onSave} loading={save.isPending} disabled={cuitBad}>
            <Save size={15} /> Guardar
          </Button>
        )
      }
    >
      {!settings.configured && (
        <div className="px-5 pt-4">
          <Callout tone="info" title="Todavía sin configurar">
            Mientras no elijas la condición, las ventas guardan el IVA contenido como si fueras responsable inscripto pero
            sin tipo de comprobante.
          </Callout>
        </div>
      )}
      <SettingRow label="Condición frente al IVA" description="Responsable inscripto emite A o B; el resto, C.">
        <Select
          value={cond}
          disabled={ro}
          onChange={(v) => setCond(v as EmitterCondition | "")}
          options={[
            { value: "", label: "Sin configurar" },
            ...EMITTER_CONDITIONS.map((c) => ({ value: c, label: FISCAL_CONDITION_LABEL[c] })),
          ]}
        />
      </SettingRow>
      <SettingRow label="CUIT" htmlFor="tax-cuit">
        <Input
          id="tax-cuit"
          value={cuit}
          disabled={ro}
          inputMode="numeric"
          placeholder="30-12345678-9"
          error={cuitBad ? "CUIT inválido" : undefined}
          onChange={(e) => setCuit(e.target.value)}
        />
      </SettingRow>
      <SettingRow label="Ingresos Brutos" description="Número de inscripción y jurisdicción sede.">
        <div className="grid gap-3 sm:grid-cols-2">
          <Input value={iibb} disabled={ro} placeholder="N° de IIBB" onChange={(e) => setIibb(e.target.value)} />
          <Select value={jur} disabled={ro} onChange={setJur} options={JUR_OPTIONS} aria-label="Jurisdicción" />
        </div>
      </SettingRow>
      <SettingRow label="Convenio Multilateral" description="Tenés actividad en más de una jurisdicción (SIFERE).">
        <Switch checked={cm} disabled={ro} onCheckedChange={setCm} label="Convenio Multilateral" />
      </SettingRow>
      <SettingRow
        label="IVA de los ítems sin producto"
        description="Venta libre, recargos, garantías y envío: la alícuota con la que se desglosan."
      >
        <Select
          value={rate}
          disabled={ro}
          onChange={setRate}
          options={IVA_CODES.map((c) => ({ value: c, label: IVA_RATES[c].label }))}
        />
      </SettingRow>
      {ri && (
        <SettingRow
          label="Emitís comprobantes M"
          description="Sólo si ARCA te lo indicó: las ventas a responsables inscriptos y monotributistas pasan de A a M."
        >
          <Switch checked={m} disabled={ro} onCheckedChange={setM} label="Comprobantes M" />
        </SettingRow>
      )}
    </SettingsCard>
  );
}
