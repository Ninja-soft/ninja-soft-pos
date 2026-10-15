"use client";

import { useEffect, useMemo, useState } from "react";
import { FileText, Percent, Plus, Receipt, Trash2, UserRound } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Checkbox } from "@/components/ui/Checkbox";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { SettingRow, SettingsCard } from "@/components/settings/Settings";
import { selectCls } from "@/components/stock/transfers/shared";
import { mlErrorMessage } from "@/lib/mercadolibre/labels";
import {
  COUPON_MODES,
  INVOICE_MODES,
  LOGISTIC_LABELS,
  PERC_CONDITIONS,
  STRATEGY_LABELS,
  billingErrorMessage,
} from "@/lib/mercadolibre/billing";
import {
  DEFAULT_PLAN_SETTINGS,
  planSettingsFrom,
  type LogisticKind,
  type PercRule,
  type PerceptionStrategy,
  type PlanSettings,
} from "@/supabase/functions/_shared/mercadolibre/invoicePlan";
import { jurisdictionName } from "@/supabase/functions/_shared/mercadolibre/perceptionLink";
import { useMlBillingMutations, type MlBillingSettings } from "@/modules/mercadolibre/billingHooks";
import type { MlAccount } from "@/modules/mercadolibre/hooks";

const errText = (e: unknown) => billingErrorMessage(e) ?? mlErrorMessage(e);
const JURISDICTIONS = Array.from({ length: 24 }, (_, i) => String(901 + i));
const LOGISTICS: LogisticKind[] = ["me2", "me1", "custom", "a_convenir", "flex", "full", "none"];

/** Plantillas de arranque (valores de ANDESMAR, orientativos: validar con el contador). */
const RULE_TEMPLATES: Record<string, Partial<PercRule>> = {
  "902": { rate_source: "padron", base_pct: 100, min_base: 3500 },
  "921": { rate_source: "padron", base_pct: 100, min_base: 360000 },
  "917": { rate_source: "fixed", rate: 3.6, base_pct: 100, min_base: 1000 },
};

const newRule = (jur: string): PercRule => ({
  jurisdiction: jur,
  enabled: true,
  rate_source: "padron",
  rate: null,
  base_pct: 100,
  min_base: 0,
  min_amount: 0,
  conditions: ["responsable_inscripto", "monotributo", "exento"],
  base: "neto",
  base_exempt: "total",
  without_padron: false,
  ...RULE_TEMPLATES[jur],
});

// Configuración de facturación de una cuenta de Mercado Libre (ADR-141).
// Cuándo facturar y subir la factura son de la base (ADR-104); el resto de
// las reglas, de la facturación pro. Lo valida el servidor
// (ml_billing_settings_save).
export function MlBillingSettingsForm({
  account,
  settings,
  canManage,
}: {
  account: MlAccount;
  settings: MlBillingSettings;
  canManage: boolean;
}) {
  const { toast } = useToast();
  const { saveSettings } = useMlBillingMutations();
  const pro = settings.features.billing;
  const initial = useMemo(
    () => ({
      invoice_mode: settings.invoice_mode === "ml_billing" ? "none" : settings.invoice_mode,
      upload_invoice: settings.upload_invoice,
      pto_vta: settings.pto_vta ? String(settings.pto_vta) : "",
      concepto: settings.concepto ? String(settings.concepto) : "",
      pdf_format: settings.pdf_format,
      upload_credit_notes: settings.upload_credit_notes,
      nc_on_refund: settings.nc_on_refund,
      perc_link_days: String(settings.perc_link_days),
      perc_on_expire: settings.perc_on_expire,
      perc_message: settings.perc_message ?? "",
      rules: planSettingsFrom(settings.rules),
    }),
    [settings],
  );
  const [f, setF] = useState(initial);
  useEffect(() => setF(initial), [initial]);
  const r = f.rules;
  const setR = (patch: Partial<PlanSettings>) => setF({ ...f, rules: { ...f.rules, ...patch } });
  const setRule = (i: number, patch: Partial<PercRule>) =>
    setR({ perc_rules: r.perc_rules.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  const disabled = !canManage || saveSettings.isPending;
  const proDisabled = disabled || !pro;
  const [addJur, setAddJur] = useState("902");

  const pvNum = f.pto_vta ? Number(f.pto_vta) : null;
  const days = Number(f.perc_link_days);
  const valid = (pvNum === null || (pvNum >= 1 && pvNum <= 99998)) && Number.isInteger(days) && days >= 1 && days <= 30;

  const save = () => {
    if (!valid) return;
    const p: Record<string, unknown> = { invoice_mode: f.invoice_mode, upload_invoice: f.upload_invoice };
    if (pro) {
      Object.assign(p, {
        pto_vta: f.pto_vta || null,
        concepto: f.concepto || null,
        pdf_format: f.pdf_format,
        upload_credit_notes: f.upload_credit_notes,
        nc_on_refund: f.nc_on_refund,
        perc_link_days: days,
        perc_on_expire: f.perc_on_expire,
        perc_message: f.perc_message,
        rules: r,
      });
    }
    saveSettings.mutate(
      { accountId: account.id, p },
      {
        onSuccess: () => toast({ title: "Facturación guardada", description: "Las ventas nuevas se arman con estas reglas.", variant: "success" }),
        onError: (e) => toast({ title: "No se pudo guardar", description: errText(e), variant: "error" }),
      },
    );
  };

  return (
    <div className="space-y-5">
      <SettingsCard title="Cuándo y cómo se factura" icon={Receipt} description="Siempre por la cola de ARCA, con la letra que acepta ARCA para cada comprador.">
        <div className="divide-y divide-border">
          <SettingRow label="Cuándo facturar" description={INVOICE_MODES.find((m) => m.key === f.invoice_mode)?.hint}>
            <select
              className={`${selectCls} sm:w-72`}
              value={f.invoice_mode}
              disabled={disabled}
              aria-label="Cuándo facturar"
              onChange={(e) => setF({ ...f, invoice_mode: e.target.value })}
            >
              {INVOICE_MODES.map((m) => (
                <option key={m.key} value={m.key} disabled={m.pro && !pro}>
                  {m.label}
                  {m.pro && !pro ? " (plan con facturación de ML)" : ""}
                </option>
              ))}
            </select>
          </SettingRow>
          <SettingRow label="Subir la factura a la venta" description="Cuando ARCA la aprueba, el PDF se sube solo a la venta en Mercado Libre y el comprador la recibe.">
            <Switch checked={f.upload_invoice} disabled={disabled} label="Subir la factura" onCheckedChange={(v) => setF({ ...f, upload_invoice: v })} />
          </SettingRow>
          {pro && (
            <>
              <SettingRow label="Punto de venta de la cuenta" description={`Vacío = el de la sucursal${settings.store_pto_vta ? ` (${settings.store_pto_vta})` : ""}. Tiene que estar dado de alta en ARCA como Web Services.`}>
                <Input
                  className="sm:w-40"
                  inputMode="numeric"
                  aria-label="Punto de venta"
                  value={f.pto_vta}
                  disabled={proDisabled}
                  onChange={(e) => setF({ ...f, pto_vta: e.target.value.replace(/\D/g, "").slice(0, 5) })}
                />
              </SettingRow>
              <SettingRow label="Concepto" description="Productos, servicios o los dos. Vacío = según los productos de la venta.">
                <select className={`${selectCls} sm:w-72`} value={f.concepto} disabled={proDisabled} aria-label="Concepto" onChange={(e) => setF({ ...f, concepto: e.target.value })}>
                  <option value="">Según la venta</option>
                  <option value="1">Productos</option>
                  <option value="2">Servicios</option>
                  <option value="3">Productos y servicios</option>
                </select>
              </SettingRow>
              <SettingRow label="PDF que se sube" description="Hoja A4 o ticket de 80 mm. Se puede cambiar por venta.">
                <select className={`${selectCls} sm:w-72`} value={f.pdf_format} disabled={proDisabled} aria-label="Formato del PDF" onChange={(e) => setF({ ...f, pdf_format: e.target.value as "a4" | "ticket" })}>
                  <option value="a4">Hoja A4</option>
                  <option value="ticket">Ticket</option>
                </select>
              </SettingRow>
            </>
          )}
        </div>
      </SettingsCard>

      {pro && (
        <>
          <SettingsCard title="Qué va en la factura" icon={FileText} description="Comisiones y cargos de Mercado Libre nunca van en la factura al comprador.">
            <div className="divide-y divide-border">
              <SettingRow label="Cupones" description={COUPON_MODES.find((c) => c.key === r.coupon_mode)?.hint}>
                <select className={`${selectCls} sm:w-72`} value={r.coupon_mode} disabled={proDisabled} aria-label="Cupones" onChange={(e) => setR({ coupon_mode: e.target.value as PlanSettings["coupon_mode"] })}>
                  {COUPON_MODES.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </SettingRow>
              <SettingRow label="Envío pagado por el comprador" description="Renglón aparte con lo que pagó. Envío gratis, bonificado, Full o a convenir: nunca va.">
                <div className="flex w-full flex-col gap-2 sm:w-72">
                  <Switch checked={r.shipping_line} disabled={proDisabled} label="Sumar el envío a la factura" onCheckedChange={(v) => setR({ shipping_line: v })} />
                  {r.shipping_line && (
                    <Input aria-label="Texto del renglón de envío" value={r.shipping_label} disabled={proDisabled} onChange={(e) => setR({ shipping_label: e.target.value.slice(0, 120) })} />
                  )}
                </div>
              </SettingRow>
              <SettingRow label="Control de lo cobrado" description="Si lo que cobró Mercado Libre no cierra con la factura por más que esto, la venta queda para revisar.">
                <Input
                  className="sm:w-40"
                  type="number"
                  inputMode="decimal"
                  aria-label="Tolerancia en pesos"
                  value={String(r.check_tolerance)}
                  disabled={proDisabled}
                  onChange={(e) => setR({ check_tolerance: Math.max(0.01, Number(e.target.value) || 1) })}
                />
              </SettingRow>
            </div>
          </SettingsCard>

          <SettingsCard title="A quién se factura" icon={UserRound} description="Con los datos de facturación que carga el comprador en Mercado Libre y, si está, la condición del padrón de ARCA.">
            <div className="divide-y divide-border">
              <SettingRow label="Receptor" description="Con los datos del comprador sale A a responsables inscriptos y monotributistas, y B al resto. Siempre consumidor final: B (o C) para todos.">
                <select className={`${selectCls} sm:w-72`} value={r.receptor_policy} disabled={proDisabled} aria-label="Receptor" onChange={(e) => setR({ receptor_policy: e.target.value as PlanSettings["receptor_policy"] })}>
                  <option value="auto">Con los datos del comprador</option>
                  <option value="always_cf">Siempre consumidor final</option>
                </select>
              </SettingRow>
              <SettingRow label="Usar el padrón de ARCA" description="Si el CUIT ya se consultó (Verificar en ARCA), manda la condición, la razón social y el domicilio del padrón sobre lo que cargó el comprador.">
                <Switch checked={r.use_padron} disabled={proDisabled} label="Usar el padrón" onCheckedChange={(v) => setR({ use_padron: v })} />
              </SettingRow>
              <SettingRow label="Consumidor final con CUIT de persona" description="La factura B lleva el DNI que está dentro del CUIT o CUIL.">
                <Switch checked={r.cf_dni_from_cuit} disabled={proDisabled} label="Usar el DNI del CUIT" onCheckedChange={(v) => setR({ cf_dni_from_cuit: v })} />
              </SettingRow>
              <SettingRow label="Empresa como consumidor final" description="Bajo el tope de ARCA para identificar al consumidor final, la B sale sin identificar. Si no, queda para revisar.">
                <Switch checked={r.cf_generic_company} disabled={proDisabled} label="B sin identificar bajo el tope" onCheckedChange={(v) => setR({ cf_generic_company: v })} />
              </SettingRow>
              <SettingRow label="Jurisdicciones que no se facturan" description="Envíos a estas provincias quedan bloqueados (por ejemplo, Tierra del Fuego).">
                <div className="flex w-full flex-wrap gap-1.5 sm:w-72">
                  {["923", ...r.blocked_jurisdictions.filter((j) => j !== "923")].map((j) => (
                    <label key={j} className="flex items-center gap-1.5 text-sm">
                      <Checkbox
                        checked={r.blocked_jurisdictions.includes(j)}
                        disabled={proDisabled}
                        onCheckedChange={(on) =>
                          setR({ blocked_jurisdictions: on ? [...new Set([...r.blocked_jurisdictions, j])] : r.blocked_jurisdictions.filter((x) => x !== j) })
                        }
                        aria-label={jurisdictionName(j)}
                      />
                      {jurisdictionName(j)}
                    </label>
                  ))}
                </div>
              </SettingRow>
              <SettingRow label="Reintegro total en un reclamo" description="Nota de crédito automática por el total, o avisar para revisarla.">
                <select className={`${selectCls} sm:w-72`} value={f.nc_on_refund} disabled={proDisabled} aria-label="Reintegro" onChange={(e) => setF({ ...f, nc_on_refund: e.target.value as "review" | "auto" })}>
                  <option value="review">Avisar para revisar</option>
                  <option value="auto">Nota de crédito automática</option>
                </select>
              </SettingRow>
              <SettingRow label="Subir las notas de crédito" description="Además de la factura, subir la nota de crédito a la venta en Mercado Libre.">
                <Switch checked={f.upload_credit_notes} disabled={proDisabled} label="Subir notas de crédito" onCheckedChange={(v) => setF({ ...f, upload_credit_notes: v })} />
              </SettingRow>
            </div>
          </SettingsCard>

          <SettingsCard title="Percepciones de Ingresos Brutos" icon={Percent} description="Si sos agente de percepción. Mercado Libre cobra el precio publicado: la percepción se cobra aparte, por link de pago, antes de la factura A.">
            <div className="divide-y divide-border">
              {!settings.features.perceptions && (
                <Callout tone="info" className="m-4">
                  Las percepciones necesitan el plan con percepciones y retenciones.
                </Callout>
              )}
              <SettingRow label="Percibir IIBB en ventas de Mercado Libre">
                <Switch
                  checked={r.perc_enabled}
                  disabled={proDisabled || !settings.features.perceptions}
                  label="Percibir"
                  onCheckedChange={(v) => setR({ perc_enabled: v })}
                />
              </SettingRow>
              {r.perc_enabled && (
                <>
                  <SettingRow label="Jurisdicciones" description="Acumulado: todos los padrones donde figura el CUIT. Destino: sólo la provincia a la que va el envío.">
                    <select className={`${selectCls} sm:w-72`} value={r.perc_mode} disabled={proDisabled} aria-label="Modo de jurisdicción" onChange={(e) => setR({ perc_mode: e.target.value as PlanSettings["perc_mode"] })}>
                      <option value="acumulado">Acumulado</option>
                      <option value="destino">Destino del envío</option>
                    </select>
                  </SettingRow>
                  <SettingRow label="Qué hacer según el envío" description="Full y Flex no dejan esperar: se factura B y, si el comprador pide A, se le cobra por link." stacked>
                    <div className="grid w-full gap-2 sm:grid-cols-2">
                      {LOGISTICS.map((k) => (
                        <label key={k} className="block space-y-1">
                          <span className="text-xs text-muted-foreground">{LOGISTIC_LABELS[k]}</span>
                          <select
                            className={selectCls}
                            value={r.perc_strategy[k] ?? DEFAULT_PLAN_SETTINGS.perc_strategy[k]}
                            disabled={proDisabled}
                            aria-label={`Percepción con ${LOGISTIC_LABELS[k]}`}
                            onChange={(e) => setR({ perc_strategy: { ...r.perc_strategy, [k]: e.target.value as PerceptionStrategy } })}
                          >
                            {(Object.keys(STRATEGY_LABELS) as PerceptionStrategy[]).map((s) => (
                              <option key={s} value={s}>
                                {STRATEGY_LABELS[s]}
                              </option>
                            ))}
                          </select>
                        </label>
                      ))}
                    </div>
                  </SettingRow>
                  <SettingRow label="Link de pago" description="Mercado Pago del negocio. Si no se paga a tiempo, qué se factura.">
                    <div className="grid w-full gap-2 sm:w-72">
                      <Input label="Días para pagar" type="number" inputMode="numeric" value={f.perc_link_days} disabled={proDisabled} onChange={(e) => setF({ ...f, perc_link_days: e.target.value })} />
                      <select className={selectCls} value={f.perc_on_expire} disabled={proDisabled} aria-label="Al vencer" onChange={(e) => setF({ ...f, perc_on_expire: e.target.value as MlBillingSettings["perc_on_expire"] })}>
                        <option value="invoice_b">Al vencer: factura B sin percepción</option>
                        <option value="invoice_a">Al vencer: factura A sin percibir</option>
                        <option value="hold">Al vencer: dejar para revisar</option>
                      </select>
                    </div>
                  </SettingRow>
                  <SettingRow label="Mensaje al comprador" description="Variables: {nombre}, {monto}, {detalle}, {dias}, {link}. Vacío = el mensaje de NinjaSoft." stacked>
                    <textarea
                      className={`${selectCls} min-h-[84px] w-full py-2`}
                      maxLength={1000}
                      value={f.perc_message}
                      disabled={proDisabled}
                      aria-label="Mensaje al comprador"
                      onChange={(e) => setF({ ...f, perc_message: e.target.value })}
                    />
                  </SettingRow>
                  <SettingRow label="Reglas por jurisdicción" description="Valores orientativos: validalos con tu contador. El padrón de IIBB se importa en Configuración › Impuestos (completo, no sólo tus clientes)." stacked>
                    <div className="w-full space-y-3">
                      {r.perc_rules.length === 0 && <p className="text-sm text-muted-foreground">Todavía no hay reglas: sumá una jurisdicción.</p>}
                      {r.perc_rules.map((rule, i) => (
                        <RuleEditor key={`${rule.jurisdiction}-${i}`} rule={rule} disabled={proDisabled} onChange={(p) => setRule(i, p)} onRemove={() => setR({ perc_rules: r.perc_rules.filter((_, j) => j !== i) })} />
                      ))}
                      <div className="flex flex-wrap items-center gap-2">
                        <select className={`${selectCls} sm:w-56`} value={addJur} disabled={proDisabled} aria-label="Jurisdicción a sumar" onChange={(e) => setAddJur(e.target.value)}>
                          {JURISDICTIONS.filter((j) => !r.perc_rules.some((x) => x.jurisdiction === j)).map((j) => (
                            <option key={j} value={j}>
                              {jurisdictionName(j)}
                            </option>
                          ))}
                        </select>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={proDisabled || r.perc_rules.some((x) => x.jurisdiction === addJur)}
                          onClick={() => setR({ perc_rules: [...r.perc_rules, newRule(addJur)] })}
                        >
                          <Plus size={14} /> Sumar jurisdicción
                        </Button>
                      </div>
                    </div>
                  </SettingRow>
                </>
              )}
            </div>
          </SettingsCard>
        </>
      )}

      {canManage && (
        <div className="flex justify-end">
          <Button onClick={save} disabled={!valid || disabled} loading={saveSettings.isPending}>
            Guardar facturación
          </Button>
        </div>
      )}
    </div>
  );
}

function RuleEditor({
  rule,
  disabled,
  onChange,
  onRemove,
}: {
  rule: PercRule;
  disabled: boolean;
  onChange: (p: Partial<PercRule>) => void;
  onRemove: () => void;
}) {
  const num = (v: string) => (v === "" ? 0 : Number(v));
  return (
    <fieldset className="space-y-2 rounded-lg bg-secondary/40 p-3" aria-label={`Regla de ${jurisdictionName(rule.jurisdiction)}`}>
      <div className="flex items-center justify-between gap-2">
        <legend className="text-sm font-medium">{jurisdictionName(rule.jurisdiction)}</legend>
        <div className="flex items-center gap-2">
          <Switch checked={rule.enabled} disabled={disabled} label="Activa" onCheckedChange={(v) => onChange({ enabled: v })} />
          <Button size="sm" variant="ghost" disabled={disabled} onClick={onRemove} aria-label={`Quitar ${jurisdictionName(rule.jurisdiction)}`}>
            <Trash2 size={14} />
          </Button>
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">Alícuota</span>
          <select className={selectCls} value={rule.rate_source} disabled={disabled} aria-label="Origen de la alícuota" onChange={(e) => onChange({ rate_source: e.target.value as PercRule["rate_source"] })}>
            <option value="padron">La del padrón</option>
            <option value="fixed">Fija</option>
            <option value="zero">No percibir</option>
          </select>
        </label>
        {rule.rate_source === "fixed" && (
          <Input label="Alícuota fija %" type="number" inputMode="decimal" value={rule.rate == null ? "" : String(rule.rate)} disabled={disabled} onChange={(e) => onChange({ rate: e.target.value === "" ? null : Number(e.target.value) })} />
        )}
        <Input label="% de la base" type="number" inputMode="decimal" hint="50 para Convenio Multilateral" value={String(rule.base_pct)} disabled={disabled} onChange={(e) => onChange({ base_pct: num(e.target.value) || 100 })} />
        <Input label="Base mínima $" type="number" inputMode="decimal" value={String(rule.min_base)} disabled={disabled} onChange={(e) => onChange({ min_base: num(e.target.value) })} />
        <Input label="Percepción mínima $" type="number" inputMode="decimal" value={String(rule.min_amount)} disabled={disabled} onChange={(e) => onChange({ min_amount: num(e.target.value) })} />
        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">Base</span>
          <select className={selectCls} value={rule.base} disabled={disabled} aria-label="Base" onChange={(e) => onChange({ base: e.target.value as PercRule["base"] })}>
            <option value="neto">Neto sin IVA</option>
            <option value="total">Total</option>
          </select>
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">Base para exentos</span>
          <select className={selectCls} value={rule.base_exempt} disabled={disabled} aria-label="Base para exentos" onChange={(e) => onChange({ base_exempt: e.target.value as PercRule["base_exempt"] })}>
            <option value="total">Total</option>
            <option value="neto">Neto sin IVA</option>
          </select>
        </label>
      </div>
      <div className="flex flex-wrap gap-3">
        {PERC_CONDITIONS.map((c) => (
          <label key={c.key} className="flex items-center gap-1.5 text-sm">
            <Checkbox
              checked={rule.conditions.includes(c.key)}
              disabled={disabled}
              aria-label={c.label}
              onCheckedChange={(on) => onChange({ conditions: on ? [...new Set([...rule.conditions, c.key])] : rule.conditions.filter((x) => x !== c.key) })}
            />
            {c.label}
          </label>
        ))}
        {rule.rate_source === "fixed" && (
          <label className="flex items-center gap-1.5 text-sm">
            <Checkbox checked={rule.without_padron} disabled={disabled} aria-label="Aunque no esté en el padrón" onCheckedChange={(on) => onChange({ without_padron: on })} />
            Aunque no esté en el padrón, si el envío va ahí
          </label>
        )}
      </div>
    </fieldset>
  );
}
