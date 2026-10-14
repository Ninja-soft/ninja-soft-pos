"use client";

import { useEffect, useState } from "react";
import { Segmented } from "@/components/ui/Segmented";
import { Building2, Lock, Save } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { SettingRow, SettingsCard, SettingsNotice } from "@/components/settings/Settings";
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
import { RetentionScales, RetentionValues } from "./RetentionValues";
import { IvaRatesCard, ParametersCard } from "./custom/TaxValueCards";
import { IibbActivitiesCard, SufferedRulesCard } from "./custom/IibbAndRulesCards";
import { CertificateIsNotTheLetter, LetterGuide, PadronConditionCheck } from "@/components/arca/InvoiceLettersGuide";

// Configuración > Impuestos (ADR-068, ADR-105), por secciones. Todo valor
// impositivo es del negocio: cada uno muestra si rige la plantilla de
// NinjaSoft o uno propio, con vigencia, historial y "volver a la plantilla".
type Section = "general" | "iva" | "percepciones" | "retenciones" | "padrones" | "iibb" | "exportaciones";
const SECTIONS: { value: Section; label: string }[] = [
  { value: "general", label: "Datos fiscales" },
  { value: "iva", label: "IVA" },
  { value: "percepciones", label: "Percepciones" },
  { value: "retenciones", label: "Retenciones" },
  { value: "padrones", label: "Padrones" },
  { value: "iibb", label: "IIBB" },
  { value: "exportaciones", label: "Exportaciones" },
];

export function TaxSettings() {
  const q = useTaxSettings();
  const [section, setSection] = useState<Section>("general");
  if (q.isLoading) return <SpinnerBlock className="py-16" />;
  if (q.error || !q.data) {
    return (
      <Callout tone="warning" icon={Lock} title="No disponible">
        {taxErrorMessage(q.error)}
      </Callout>
    );
  }
  const s = q.data;
  return (
    <div className="space-y-6">
      <Segmented value={section} onChange={setSection} options={SECTIONS} aria-label="Secciones de impuestos" size="sm" />
      {section === "general" && (
        <>
          <FiscalCard settings={s} />
          <Callout tone="info" title="Todo es tuyo">
            Alícuotas, regímenes, padrones, mínimos, escalas y códigos vienen cargados como plantilla de NinjaSoft
            (orientativa). Podés cambiar cada valor con la fecha desde la que rige, crear los tuyos y volver a la
            plantilla cuando quieras. Cada cambio queda en el historial.
          </Callout>
        </>
      )}
      {section === "iva" && (
        <>
          <IvaRatesCard settings={s} />
          <ParametersCard settings={s} section="iva" needsFeature="iva" />
        </>
      )}
      {section === "percepciones" && <TaxRegimes settings={s} role="perception" />}
      {section === "retenciones" && (
        <>
          <TaxRegimes settings={s} role="retention" />
          <RetentionValues settings={s} />
          <RetentionScales settings={s} />
          <ParametersCard settings={s} section="retenciones" />
          <SufferedRulesCard settings={s} />
        </>
      )}
      {section === "padrones" && <PadronImport settings={s} />}
      {section === "iibb" && <IibbActivitiesCard settings={s} />}
      {section === "exportaciones" && (
        <>
          <ParametersCard settings={s} section="exportaciones" />
          <p className="text-xs text-muted-foreground">
            Los códigos de régimen de SICORE de cada concepto se cargan en Retenciones (Conceptos de retención) y el de
            cada régimen de IVA o SUSS, en el régimen. El Libro IVA Digital usa los datos guardados en cada venta y
            compra.
          </p>
        </>
      )}
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

  // `withCond`: guardar con otra condición (la que informa ARCA) sin perder el resto.
  const onSave = (withCond?: EmitterCondition) =>
    save.mutate(
      {
        iva_condition: (withCond ?? cond) || null,
        cuit: cuit.trim() || null,
        iibb_number: iibb.trim() || null,
        iibb_jurisdiction: jur || null,
        convenio_multilateral: cm,
        default_rate_code: rate,
        issues_cbte_m: (withCond ?? cond) === "responsable_inscripto" && m,
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
          <Button size="sm" onClick={() => onSave()} loading={save.isPending} disabled={cuitBad}>
            <Save size={15} /> Guardar
          </Button>
        )
      }
    >
      {!settings.configured && (
        <SettingsNotice>
          <Callout tone="info" title="Todavía sin configurar">
            Mientras no elijas la condición, las ventas guardan el IVA contenido como si fueras responsable inscripto pero
            sin tipo de comprobante.
          </Callout>
        </SettingsNotice>
      )}
      <SettingRow
        label="Condición frente al IVA"
        description="Elegí la misma que figura en tu constancia de ARCA: de esto sale la letra de tus facturas."
      >
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
      <SettingRow
        label="Qué facturas vas a emitir"
        description="Cambia en vivo según la condición que elijas."
        stacked
      >
        <div className="space-y-3">
          <LetterGuide condition={cond || null} issuesM={ri && m} />
          <CertificateIsNotTheLetter />
          <PadronConditionCheck
            cuit={cuit}
            condition={cond || null}
            canWrite={!ro}
            fixing={save.isPending}
            onUseArca={(a) => {
              setCond(a as EmitterCondition);
              onSave(a as EmitterCondition);
            }}
          />
        </div>
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
