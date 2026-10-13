"use client";

// IIBB (ADR-095; ADR-101): alícuota y mínimo de cada actividad con cambios
// con vigencia (la liquidación del mes usa los vigentes al primer día) y
// comparación con la plantilla orientativa. Reglas propias para clasificar
// las retenciones y percepciones sufridas (procesadores, bancos, archivos).

import Link from "next/link";
import { useMemo, useState } from "react";
import { CalendarClock, ListFilter, Lock, Plus, Receipt, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { SettingsCard } from "@/components/settings/Settings";
import { JURISDICTIONS, jurisdictionName } from "@/lib/tax/catalog";
import { IIBB_ACTIVITY_FIELDS, resolveCustom, validateValidity, type CustomState, type CustomValue } from "@/lib/tax/custom";
import {
  SUFFERED_KIND_LABEL,
  SUFFERED_REGIME_LABEL,
  SUFFERED_TAX_LABEL,
  classifyWithRules,
  normalizeRulePattern,
  type SufferedKind,
  type SufferedRegime,
  type SufferedRule,
  type SufferedTax,
} from "@/lib/tax/suffered";
import type { TaxSettings } from "@/modules/tax/api";
import { useCustomMutations, useCustomValues, versionsOf } from "@/modules/tax/customHooks";
import { useIibbActivities, useIibbMutations, useIibbTemplates } from "@/modules/tax/subjectHooks";
import type { IibbActivity } from "@/modules/tax/subjectApi";
import { CustomValueModal, HistoryModal, RowActions, StateBadge, errorText, fmtField, todayAr, validityText } from "./CustomValueKit";

export function IibbActivitiesCard({ settings }: { settings: TaxSettings }) {
  const enabled = settings.features.percepciones;
  const acts = useIibbActivities(enabled);
  const tpls = useIibbTemplates(enabled);
  const values = useCustomValues(enabled);
  const { saveActivity } = useIibbMutations();
  const { reset } = useCustomMutations();
  const { toast } = useToast();
  const [plan, setPlan] = useState<IibbActivity | null>(null);
  const [hist, setHist] = useState<IibbActivity | null>(null);
  const [back, setBack] = useState<{ a: IibbActivity; rate: number } | null>(null);
  const ro = !settings.can_write;
  const today = todayAr();
  const list = (acts.data ?? []).filter((a) => a.is_active);
  const byJur = useMemo(() => {
    const m = new Map<string, IibbActivity[]>();
    for (const a of list) m.set(a.jurisdiction, [...(m.get(a.jurisdiction) ?? []), a]);
    return [...m.entries()];
  }, [list]);

  return (
    <SettingsCard
      title="Actividades de Ingresos Brutos"
      description="Alícuota e impuesto mínimo de cada actividad. Cargá los cambios con la fecha desde la que rigen: la liquidación de cada mes usa los vigentes."
      icon={Receipt}
      padded
    >
      {!enabled ? (
        <Callout tone="neutral" icon={Lock} title="Desde el plan Business">
          Liquidación mensual de Ingresos Brutos por jurisdicción.
        </Callout>
      ) : list.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Todavía no cargaste actividades. Agregalas en{" "}
          <Link className="underline" href="/impuestos/iibb">
            Contabilidad &gt; Ingresos Brutos
          </Link>{" "}
          (podés partir de una plantilla).
        </p>
      ) : (
        <div className="space-y-4">
          {byJur.map(([jur, items]) => (
            <div key={jur}>
              <h4 className="mb-1 text-sm font-semibold">{jurisdictionName(jur)}</h4>
              <ul className="divide-y divide-border">
                {items.map((a) => {
                  const versions = versionsOf(values.data, "iibb_activity", a.id);
                  const r = resolveCustom({ rate: a.rate, min_tax: a.min_tax }, versions, today);
                  const tpl = (tpls.data ?? []).find((t) => t.jurisdiction === a.jurisdiction && t.code === a.code);
                  const state: CustomState = versions.length
                    ? "custom"
                    : !tpl
                      ? "own"
                      : tpl.rate === a.rate
                        ? "template"
                        : "custom";
                  return (
                    <li key={a.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                          {a.code ? `${a.code} · ` : ""}
                          {a.name}
                          <StateBadge state={state} />
                        </p>
                        <p className="mt-0.5 text-[13px] text-muted-foreground">
                          Hoy {fmtField({ kind: "percent" }, r.values.rate)} · mínimo {fmtField({ kind: "money" }, r.values.min_tax)}
                          {r.version ? ` · ${validityText(r.version)}` : ""}
                          {tpl ? ` · plantilla ${fmtField({ kind: "percent" }, tpl.rate)}` : ""}
                        </p>
                      </div>
                      <div className="flex shrink-0 gap-1">
                        {!ro && tpl && state === "custom" && (
                          <Button variant="ghost" size="sm" aria-label="Volver a la plantilla" onClick={() => setBack({ a, rate: tpl.rate })}>
                            <RotateCcw size={15} />
                          </Button>
                        )}
                        {!ro && (
                          <Button variant="ghost" size="sm" aria-label="Cambios con vigencia" onClick={() => setPlan(a)}>
                            <CalendarClock size={15} />
                          </Button>
                        )}
                        <RowActions readOnly onEdit={() => undefined} onHistory={() => setHist(a)} editLabel={a.name} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            Altas, categorías y coeficientes de Convenio Multilateral:{" "}
            <Link className="underline" href="/impuestos/iibb">
              Contabilidad &gt; Ingresos Brutos
            </Link>
            .
          </p>
        </div>
      )}
      {plan && (
        <CustomValueModal
          title={`Cambios con vigencia · ${plan.name}`}
          description="La liquidación de un mes usa la alícuota y el mínimo vigentes el primer día del mes."
          catalog="iibb_activity"
          itemKey={plan.id}
          fields={IIBB_ACTIVITY_FIELDS}
          template={{ rate: plan.rate, min_tax: plan.min_tax }}
          versions={versionsOf(values.data, "iibb_activity", plan.id)}
          onClose={() => setPlan(null)}
        />
      )}
      {hist && <HistoryModal catalog="iibb_activities" itemKey={hist.id} title={hist.name} onClose={() => setHist(null)} />}
      <ConfirmDialog
        open={Boolean(back)}
        onOpenChange={(o) => !o && setBack(null)}
        title="Volver a la plantilla"
        description="La actividad toma la alícuota de la plantilla de NinjaSoft y se quitan los cambios con vigencia. Las liquidaciones confirmadas no cambian."
        confirmLabel="Volver a la plantilla"
        onConfirm={async () => {
          if (!back) return;
          try {
            await saveActivity.mutateAsync({ ...back.a, rate: back.rate });
            await reset.mutateAsync({ catalog: "iibb_activity", key: back.a.id });
            toast({ title: "Rige la plantilla", variant: "success" });
          } catch (e) {
            toast({ title: "No se pudo", description: errorText(e), variant: "error" });
          }
          setBack(null);
        }}
      />
    </SettingsCard>
  );
}

// ---------------------------------------------------------------------------
// Reglas de retenciones sufridas
// ---------------------------------------------------------------------------
const TAXES: SufferedTax[] = ["iibb", "iva", "ganancias", "suss", "debitos_creditos", "otro"];
const KINDS: SufferedKind[] = ["retencion", "percepcion", "pago_a_cuenta"];
const REGIMES: SufferedRegime[] = ["general", "sircreb", "sirtac", "procesador", "otro"];

function toRule(v: CustomValue): SufferedRule {
  const d = v.data as Partial<SufferedRule>;
  return {
    pattern: v.item_key,
    skip: Boolean(d.skip),
    tax: d.tax,
    kind: d.kind,
    regime: d.regime ?? null,
    jurisdiction: d.jurisdiction ?? null,
  };
}

export function SufferedRulesCard({ settings }: { settings: TaxSettings }) {
  const enabled = settings.features.percepciones;
  const values = useCustomValues(enabled);
  const { remove } = useCustomMutations();
  const { toast } = useToast();
  const [edit, setEdit] = useState<CustomValue | "new" | null>(null);
  const [hist, setHist] = useState<string | null>(null);
  const [test, setTest] = useState("");
  const ro = !settings.can_write;
  const today = todayAr();
  const rules = (values.data ?? []).filter((v) => v.catalog === "suffered_rule");
  const activeRules = rules
    .filter((v) => v.is_active && v.valid_from <= today && (!v.valid_to || v.valid_to >= today))
    .map(toRule);
  const result = test.trim() ? classifyWithRules(test, settings.iibb_jurisdiction, "procesador", activeRules) : null;

  return (
    <SettingsCard
      title="Cómo clasificar las retenciones que te hacen"
      description="Reglas propias por texto o código para las liquidaciones de procesadores, bancos y archivos que importás. Mandan sobre la clasificación de NinjaSoft."
      icon={ListFilter}
      actions={
        enabled &&
        !ro && (
          <Button size="sm" variant="secondary" onClick={() => setEdit("new")}>
            <Plus size={15} /> Regla
          </Button>
        )
      }
      padded
    >
      {!enabled ? (
        <Callout tone="neutral" icon={Lock} title="Desde el plan Business">
          Retenciones y percepciones sufridas con saldo a favor para la DDJJ.
        </Callout>
      ) : (
        <div className="space-y-4">
          {rules.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">
              Sin reglas propias: se usa la clasificación de NinjaSoft (IIBB, SIRCREB, SIRTAC, Ganancias, IVA, SUSS, débitos
              y créditos, por palabra clave). Agregá una si un texto queda &quot;para revisar&quot; o mal clasificado.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {rules.map((v) => {
                const r = toRule(v);
                return (
                  <li key={v.id} className="flex flex-col gap-2 py-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0 text-[13px]">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        &quot;{v.item_key}&quot;
                        <StateBadge state={v.is_active ? "own" : "disabled"} />
                      </p>
                      <p className="text-muted-foreground">
                        {r.skip
                          ? "Se ignora (no es una retención)"
                          : `${SUFFERED_TAX_LABEL[r.tax ?? "otro"]} · ${SUFFERED_KIND_LABEL[r.kind ?? "retencion"]}${r.regime ? ` · ${SUFFERED_REGIME_LABEL[r.regime]}` : ""}${r.jurisdiction ? ` · ${jurisdictionName(r.jurisdiction)}` : ""}`}
                        {` · ${validityText(v)}`}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <RowActions readOnly={ro} editLabel={v.item_key} onEdit={() => setEdit(v)} onHistory={() => setHist(v.item_key)} />
                      {!ro && (
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label="Quitar regla"
                          onClick={() =>
                            remove.mutate(v.id, {
                              onError: (e) => toast({ title: "No se quitó", description: errorText(e), variant: "error" }),
                            })
                          }
                        >
                          <Trash2 size={15} />
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="space-y-1">
            <Input
              label="Probar un texto"
              value={test}
              placeholder="Retención IIBB SIRTAC Córdoba"
              hint="Escribí el texto como viene en la liquidación o el archivo y mirá cómo queda."
              onChange={(e) => setTest(e.target.value)}
            />
            {result && (
              <p className="text-[13px] text-muted-foreground">
                {result.skip
                  ? "Se ignora."
                  : `${SUFFERED_TAX_LABEL[result.tax]} · ${SUFFERED_KIND_LABEL[result.kind]} · ${SUFFERED_REGIME_LABEL[result.regime]}${result.jurisdiction ? ` · ${jurisdictionName(result.jurisdiction)}` : ""}${result.needs_review ? " · para revisar" : ""}`}
                {result.rule ? ` (regla "${result.rule}")` : " (clasificación de NinjaSoft)"}
              </p>
            )}
          </div>
        </div>
      )}
      {edit && <RuleModal value={edit === "new" ? null : edit} onClose={() => setEdit(null)} />}
      {hist && <HistoryModal catalog="suffered_rule" itemKey={hist} title={`Regla "${hist}"`} onClose={() => setHist(null)} />}
    </SettingsCard>
  );
}

function RuleModal({ value, onClose }: { value: CustomValue | null; onClose: () => void }) {
  const { save } = useCustomMutations();
  const { toast } = useToast();
  const r = value ? toRule(value) : null;
  const [pattern, setPattern] = useState(value?.item_key ?? "");
  const [skip, setSkip] = useState(r?.skip ?? false);
  const [tax, setTax] = useState<SufferedTax>(r?.tax ?? "iibb");
  const [kind, setKind] = useState<SufferedKind>(r?.kind ?? "retencion");
  const [regime, setRegime] = useState<string>(r?.regime ?? "");
  const [jur, setJur] = useState<string>(r?.jurisdiction ?? "");
  const [from, setFrom] = useState(value?.valid_from ?? "2000-01-01");
  const [to, setTo] = useState(value?.valid_to ?? "");
  const [active, setActive] = useState(value?.is_active ?? true);
  const norm = normalizeRulePattern(pattern);

  const submit = () => {
    const bad = validateValidity(from, to || null);
    if (norm.length < 2 || norm.length > 60) {
      toast({ title: "El texto tiene que tener entre 2 y 60 caracteres", variant: "error" });
      return;
    }
    if (bad) {
      toast({ title: bad, variant: "error" });
      return;
    }
    const k: SufferedKind = tax === "debitos_creditos" ? "pago_a_cuenta" : kind === "pago_a_cuenta" ? "retencion" : kind;
    save.mutate(
      {
        id: value?.id ?? null,
        catalog: "suffered_rule",
        item_key: norm,
        valid_from: from,
        valid_to: to || null,
        is_active: active,
        is_custom: true,
        data: skip ? { skip: true } : { tax, kind: k, regime: regime || null, jurisdiction: tax === "iibb" ? jur || null : null },
      },
      {
        onSuccess: () => {
          toast({ title: "Regla guardada", variant: "success" });
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
      title={value ? "Editar regla" : "Nueva regla"}
      description="Si el texto del impuesto contiene estas palabras (sin importar mayúsculas ni tildes), se clasifica así."
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
        <Input
          label="Texto o código"
          value={pattern}
          disabled={Boolean(value)}
          maxLength={60}
          hint={value ? "Para cambiar el texto, creá otra regla." : `Se guarda como "${norm}". Si dos reglas coinciden, gana la más larga.`}
          onChange={(e) => setPattern(e.target.value)}
        />
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>
            Ignorar esta línea
            <span className="block text-[13px] text-muted-foreground">No es una retención (por ejemplo, un cargo o el IVA de una comisión).</span>
          </span>
          <Switch checked={skip} onCheckedChange={setSkip} label="Ignorar" />
        </label>
        {!skip && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Select label="Impuesto" value={tax} onChange={setTax} options={TAXES.map((t) => ({ value: t, label: SUFFERED_TAX_LABEL[t] }))} />
            {tax !== "debitos_creditos" && (
              <Select
                label="Tipo"
                value={kind}
                onChange={setKind}
                options={KINDS.filter((k) => k !== "pago_a_cuenta").map((k) => ({ value: k, label: SUFFERED_KIND_LABEL[k] }))}
              />
            )}
            <Select
              label="Régimen"
              value={regime}
              onChange={setRegime}
              options={[{ value: "", label: "El que diga el texto" }, ...REGIMES.map((g) => ({ value: g, label: SUFFERED_REGIME_LABEL[g] }))]}
            />
            {tax === "iibb" && (
              <Select
                label="Jurisdicción"
                value={jur}
                onChange={setJur}
                hint="Vacío: la que diga el texto o la de tu negocio (queda para revisar)."
                options={[{ value: "", label: "La del texto" }, ...JURISDICTIONS.map((j) => ({ value: j.code, label: j.name }))]}
              />
            )}
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Rige desde" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <Input label="Hasta (opcional)" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <label className="flex items-center justify-between gap-3 text-sm">
          Activa
          <Switch checked={active} onCheckedChange={setActive} label="Activa" />
        </label>
      </div>
    </Modal>
  );
}

