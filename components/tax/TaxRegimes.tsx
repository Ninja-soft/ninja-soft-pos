"use client";

import { useState } from "react";
import { CalendarClock, History, Lock, Pencil, Scale, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Checkbox } from "@/components/ui/Checkbox";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { SettingsCard } from "@/components/settings/Settings";
import { FISCAL_CONDITIONS, FISCAL_CONDITION_LABEL, JURISDICTIONS, jurisdictionName } from "@/lib/tax/catalog";
import {
  taxErrorMessage,
  type BaseKind,
  type PadronSource,
  type RegimeRole,
  type RegimeTax,
  type TaxRegime,
  type TaxRegimeInput,
  type TaxSettings,
} from "@/modules/tax/api";
import { useTaxRegimeMutations, useTaxRegimes } from "@/modules/tax/hooks";
import { REGIME_VALUE_FIELDS, parseDecimal, resolveCustom } from "@/lib/tax/custom";
import { useCustomValues, versionsOf } from "@/modules/tax/customHooks";
import { CustomValueModal, HistoryModal, StateBadge, fmtDate, todayAr } from "./custom/CustomValueKit";

// Regímenes en los que el negocio es agente (ADR-068): jurisdicción ×
// impuesto × condición del cliente → alícuota del padrón o general, base y
// mínimos. Las percepciones se suman a la venta; las retenciones se calculan
// en las órdenes de pago a proveedores. ADR-105: vigencia del régimen,
// alícuota por condición y cambios de valores con vigencia (sin perder la
// numeración de los certificados).

const TAX_LABEL: Record<RegimeTax, string> = { iva: "IVA", iibb: "IIBB", ganancias: "Ganancias", suss: "SUSS" };
const ROLE_LABEL: Record<RegimeRole, string> = { perception: "Percepción", retention: "Retención" };
const BASE_LABEL: Record<BaseKind, string> = {
  net: "Neto sin IVA (gravado, exento y no gravado)",
  net_taxed: "Neto gravado",
  total: "Total con IVA",
  vat: "El IVA facturado (retención de IVA)",
};
const SOURCE_LABEL: Record<PadronSource, string> = {
  none: "Sin padrón (alícuota general)",
  arba: "Padrón ARBA",
  agip: "Padrón AGIP",
  generic: "Padrón genérico importado",
};

const EMPTY: TaxRegimeInput = {
  tax: "iibb",
  role: "perception",
  jurisdiction: "902",
  name: "",
  is_active: true,
  agent_number: null,
  regime_code: null,
  padron_source: "arba",
  default_rate: null,
  rates_by_condition: {},
  base_kind: "net",
  min_base: 0,
  min_amount: 0,
  applies_to: ["responsable_inscripto", "monotributo", "exento"],
  notes: null,
  valid_from: null,
  valid_to: null,
};

// Plantillas de arranque (valores orientativos: confirmalos con tu contador y
// con la norma vigente de cada organismo).
const TEMPLATES: { label: string; value: TaxRegimeInput }[] = [
  { label: "Percepción IIBB ARBA", value: { ...EMPTY, name: "Percepción IIBB ARBA" } },
  {
    label: "Percepción IIBB AGIP (CABA)",
    value: { ...EMPTY, name: "Percepción IIBB AGIP", jurisdiction: "901", padron_source: "agip" },
  },
  {
    label: "Percepción de IVA (RG 2408)",
    value: {
      ...EMPTY,
      tax: "iva",
      jurisdiction: null,
      padron_source: "none",
      name: "Percepción de IVA RG 2408",
      default_rate: 3,
      base_kind: "net_taxed",
      applies_to: ["responsable_inscripto"],
    },
  },
  { label: "Retención IIBB ARBA", value: { ...EMPTY, role: "retention", name: "Retención IIBB ARBA" } },
  {
    label: "Retención IIBB AGIP (CABA)",
    value: { ...EMPTY, role: "retention", name: "Retención IIBB AGIP", jurisdiction: "901", padron_source: "agip" },
  },
  // Retenciones como agente (ADR-079). Ganancias toma mínimos, alícuotas y
  // escala de los conceptos de la RG 830 (abajo, "Valores de retención").
  {
    label: "Retención de Ganancias (RG 830)",
    value: {
      ...EMPTY,
      role: "retention",
      tax: "ganancias",
      jurisdiction: null,
      padron_source: "none",
      name: "Retención de Ganancias RG 830",
    },
  },
  {
    label: "Retención de IVA (agente designado)",
    value: {
      ...EMPTY,
      role: "retention",
      tax: "iva",
      jurisdiction: null,
      padron_source: "none",
      name: "Retención de IVA",
      default_rate: 50,
      base_kind: "vat",
      applies_to: ["responsable_inscripto"],
    },
  },
  {
    label: "Retención SUSS",
    value: {
      ...EMPTY,
      role: "retention",
      tax: "suss",
      jurisdiction: null,
      padron_source: "none",
      name: "Retención SUSS",
      applies_to: ["responsable_inscripto"],
    },
  },
  {
    label: "Otra jurisdicción",
    value: { ...EMPTY, name: "Percepción IIBB", jurisdiction: "904", padron_source: "generic" },
  },
];

export function TaxRegimes({ settings, role }: { settings: TaxSettings; role?: RegimeRole }) {
  const enabled = settings.features.percepciones;
  const q = useTaxRegimes(enabled);
  const values = useCustomValues(enabled);
  const { remove } = useTaxRegimeMutations();
  const { toast } = useToast();
  const [edit, setEdit] = useState<{ id?: string; value: TaxRegimeInput } | null>(null);
  const [del, setDel] = useState<TaxRegime | null>(null);
  const [plan, setPlan] = useState<TaxRegime | null>(null);
  const [hist, setHist] = useState<TaxRegime | null>(null);
  const ro = !settings.can_write;
  const today = todayAr();
  const list = (q.data ?? []).filter((r) => !role || r.role === role);
  const templates = TEMPLATES.map((t, i) => ({ ...t, i })).filter((t) => !role || t.value.role === role);

  return (
    <SettingsCard
      title={
        role === "retention"
          ? "Regímenes de retención"
          : role === "perception"
            ? "Regímenes de percepción"
            : "Agente de percepción y retención"
      }
      description={
        role === "retention"
          ? "Sólo si te designaron agente de retención. Se calculan en cada orden de pago a proveedores."
          : "Sólo si ARCA o una provincia te designó agente. Cada régimen dice a quién, cuánto y desde qué monto."
      }
      icon={Scale}
      actions={
        enabled &&
        !ro && (
          <Select
            value={null}
            placeholder="Agregar régimen"
            onChange={(i) => setEdit({ value: TEMPLATES[Number(i)]!.value })}
            options={templates.map((t) => ({ value: String(t.i), label: t.label }))}
            aria-label="Agregar régimen"
          />
        )
      }
      padded
    >
      {!enabled ? (
        <Callout tone="neutral" icon={Lock} title="Desde el plan Business">
          Percepciones de IVA e IIBB con padrones por CUIT, mínimos y exclusiones, y retenciones de Ganancias, IVA, IIBB
          y SUSS calculadas en las órdenes de pago con su certificado.
        </Callout>
      ) : list.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No sos agente en ningún régimen. Si te designaron, agregalo con el botón de arriba.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {list.map((r) => (
            <li key={r.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
              <RegimeSummary r={r} versions={versionsOf(values.data, "regime_values", r.id)} today={today} />
              <div className="flex shrink-0 gap-1">
                <Button variant="ghost" size="sm" aria-label="Historial" onClick={() => setHist(r)}>
                  <History size={15} />
                </Button>
                {!ro && (
                  <Button variant="ghost" size="sm" aria-label="Cambios con vigencia" onClick={() => setPlan(r)}>
                    <CalendarClock size={15} />
                  </Button>
                )}
              {!ro && (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label="Editar"
                    onClick={() => {
                      const { id, ...value } = r;
                      setEdit({ id, value });
                    }}
                  >
                    <Pencil size={15} />
                  </Button>
                  <Button variant="ghost" size="sm" aria-label="Quitar" onClick={() => setDel(r)}>
                    <Trash2 size={15} />
                  </Button>
                </>
              )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {edit && <RegimeModal initial={edit} onClose={() => setEdit(null)} />}
      {plan && (
        <CustomValueModal
          title={`Cambios con vigencia · ${plan.name}`}
          description="Para un cambio de alícuota o de mínimos que rige desde una fecha. El régimen y la numeración de sus certificados siguen siendo los mismos."
          catalog="regime_values"
          itemKey={plan.id}
          fields={REGIME_VALUE_FIELDS}
          template={{ default_rate: plan.default_rate, min_base: plan.min_base, min_amount: plan.min_amount }}
          versions={versionsOf(values.data, "regime_values", plan.id)}
          allowDisable
          onClose={() => setPlan(null)}
        />
      )}
      {hist && <HistoryModal catalog="regime_values" itemKey={hist.id} title={hist.name} onClose={() => setHist(null)} />}
      <ConfirmDialog
        open={Boolean(del)}
        onOpenChange={(o) => !o && setDel(null)}
        title="Quitar régimen"
        description="Las ventas nuevas dejan de percibir (o las órdenes de pago de retener) este régimen. Lo ya registrado queda igual."
        confirmLabel="Quitar"
        danger
        loading={remove.isPending}
        onConfirm={() =>
          del &&
          remove.mutate(del.id, {
            onSuccess: () => setDel(null),
            onError: (e) => toast({ title: "No se pudo quitar", description: taxErrorMessage(e), variant: "error" }),
          })
        }
      />
    </SettingsCard>
  );
}

function RegimeSummary({
  r,
  versions,
  today,
}: {
  r: TaxRegime;
  versions: ReturnType<typeof versionsOf>;
  today: string;
}) {
  const eff = resolveCustom(
    { default_rate: r.default_rate, min_base: r.min_base, min_amount: r.min_amount } as Record<string, unknown>,
    versions,
    today,
  );
  const expired = r.valid_to != null && r.valid_to < today;
  const future = r.valid_from != null && r.valid_from > today;
  const nCond = Object.keys(r.rates_by_condition).length;
  return (
    <div className="min-w-0">
      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
        {r.name}
        <Badge tone={r.role === "perception" ? "info" : "gold"}>{ROLE_LABEL[r.role]}</Badge>
        {!r.is_active && <Badge tone="neutral">Pausado</Badge>}
        {expired && <Badge tone="warning">Vencido</Badge>}
        {future && <Badge tone="info">Empieza el {fmtDate(r.valid_from)}</Badge>}
        {versions.length > 0 && <StateBadge state={eff.active ? "custom" : "disabled"} />}
      </p>
      <p className="mt-0.5 text-[13px] text-muted-foreground">
        {TAX_LABEL[r.tax]}
        {r.jurisdiction ? ` · ${jurisdictionName(r.jurisdiction)}` : ""} · {SOURCE_LABEL[r.padron_source]}
        {eff.values.default_rate != null ? ` · general ${String(eff.values.default_rate)} %` : ""}
        {Number(eff.values.min_amount) > 0 ? ` · mínimo $${String(eff.values.min_amount)}` : ""}
        {nCond > 0 ? ` · ${nCond} alícuotas por condición` : ""}
        {r.valid_to ? ` · hasta ${fmtDate(r.valid_to)}` : ""}
      </p>
    </div>
  );
}

function num(v: string): number | null {
  const s = v.trim().replace(",", ".");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function RegimeModal({ initial, onClose }: { initial: { id?: string; value: TaxRegimeInput }; onClose: () => void }) {
  const { save } = useTaxRegimeMutations();
  const { toast } = useToast();
  const [v, setV] = useState<TaxRegimeInput>(initial.value);
  const [rate, setRate] = useState(v.default_rate == null ? "" : String(v.default_rate));
  const [minBase, setMinBase] = useState(String(v.min_base || ""));
  const [minAmount, setMinAmount] = useState(String(v.min_amount || ""));
  const [byCond, setByCond] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(v.rates_by_condition ?? {}).map(([k, x]) => [k, String(x).replace(".", ",")])),
  );
  const set = (p: Partial<TaxRegimeInput>) => setV((x) => ({ ...x, ...p }));
  const iibb = v.tax === "iibb";

  const padronOptions: { value: PadronSource; label: string }[] = [
    { value: "none", label: SOURCE_LABEL.none },
    ...(v.jurisdiction === "902" ? [{ value: "arba" as const, label: SOURCE_LABEL.arba }] : []),
    ...(v.jurisdiction === "901" ? [{ value: "agip" as const, label: SOURCE_LABEL.agip }] : []),
    ...(iibb ? [{ value: "generic" as const, label: SOURCE_LABEL.generic }] : []),
  ];

  const submit = () => {
    const payload: TaxRegimeInput = {
      ...v,
      name: v.name.trim() || `${ROLE_LABEL[v.role]} ${TAX_LABEL[v.tax]}`,
      jurisdiction: iibb ? v.jurisdiction : null,
      padron_source: padronOptions.some((o) => o.value === v.padron_source) ? v.padron_source : "none",
      default_rate: num(rate),
      min_base: num(minBase) ?? 0,
      min_amount: num(minAmount) ?? 0,
      rates_by_condition: Object.fromEntries(
        Object.entries(byCond)
          .filter(([k, x]) => v.applies_to.includes(k) && x.trim() !== "")
          .map(([k, x]) => [k, parseDecimal(x)] as const)
          .filter((e): e is readonly [string, number] => e[1] != null && Number.isFinite(e[1])),
      ),
      valid_from: v.valid_from || null,
      valid_to: v.valid_to || null,
    };
    if (payload.valid_from && payload.valid_to && payload.valid_to < payload.valid_from) {
      toast({ title: "La fecha de fin no puede ser anterior al inicio", variant: "error" });
      return;
    }
    save.mutate(
      { id: initial.id, ...payload },
      {
        onSuccess: () => {
          toast({ title: "Régimen guardado", variant: "success" });
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
      title={initial.id ? "Editar régimen" : "Nuevo régimen"}
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
        <Input label="Nombre" value={v.name} onChange={(e) => set({ name: e.target.value })} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Select
            label="Impuesto"
            value={v.tax}
            onChange={(t) => set({ tax: t, jurisdiction: t === "iibb" ? (v.jurisdiction ?? "902") : null })}
            options={(Object.keys(TAX_LABEL) as RegimeTax[]).map((t) => ({ value: t, label: TAX_LABEL[t] }))}
          />
          <Select
            label="Tipo"
            value={v.role}
            onChange={(role) => set({ role })}
            options={(Object.keys(ROLE_LABEL) as RegimeRole[]).map((r) => ({ value: r, label: ROLE_LABEL[r] }))}
          />
        </div>
        {iibb && (
          <Select
            label="Jurisdicción"
            value={v.jurisdiction ?? "902"}
            onChange={(j) => set({ jurisdiction: j })}
            options={JURISDICTIONS.map((j) => ({ value: j.code, label: `${j.name} (${j.agency})` }))}
          />
        )}
        <Select
          label="Alícuota por CUIT"
          value={v.padron_source}
          onChange={(p) => set({ padron_source: p })}
          options={padronOptions}
          hint={
            v.tax === "ganancias" || v.tax === "suss"
              ? "Ganancias y SUSS toman la alícuota del concepto o la actividad (Valores de retención)."
              : "Con padrón, se usa la alícuota del CUIT vigente a la fecha. Si no figura, la general."
          }
        />
        <div className="grid gap-3 sm:grid-cols-3">
          <Input
            label="Alícuota general %"
            value={rate}
            inputMode="decimal"
            hint="Vacío: no percibe si no figura"
            onChange={(e) => setRate(e.target.value)}
          />
          <Input label="Base mínima $" value={minBase} inputMode="decimal" onChange={(e) => setMinBase(e.target.value)} />
          <Input
            label="Monto mínimo $"
            value={minAmount}
            inputMode="decimal"
            onChange={(e) => setMinAmount(e.target.value)}
          />
        </div>
        <Select
          label="Base de cálculo"
          value={v.base_kind}
          onChange={(b) => set({ base_kind: b })}
          options={(Object.keys(BASE_LABEL) as BaseKind[]).map((b) => ({ value: b, label: BASE_LABEL[b] }))}
        />
        <div>
          <p className="mb-2 text-sm font-medium text-muted-foreground">Se aplica a clientes (o proveedores)</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {FISCAL_CONDITIONS.map((c) => (
              <label key={c} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={v.applies_to.includes(c)}
                  onCheckedChange={(on) =>
                    set({ applies_to: on ? [...v.applies_to, c] : v.applies_to.filter((x) => x !== c) })
                  }
                />
                {FISCAL_CONDITION_LABEL[c]}
              </label>
            ))}
          </div>
        </div>
        {v.applies_to.length > 0 && (
          <div>
            <p className="mb-1 text-sm font-medium text-muted-foreground">Alícuota por condición (opcional)</p>
            <p className="mb-2 text-xs text-muted-foreground">
              Si el CUIT no figura en el padrón, se usa la de su condición; si no cargás ninguna, la general.
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {v.applies_to.map((c) => (
                <Input
                  key={c}
                  label={`${FISCAL_CONDITION_LABEL[c as keyof typeof FISCAL_CONDITION_LABEL] ?? c} %`}
                  inputMode="decimal"
                  value={byCond[c] ?? ""}
                  placeholder={rate || "general"}
                  onChange={(e) => setByCond((x) => ({ ...x, [c]: e.target.value }))}
                />
              ))}
            </div>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label="Vigente desde (opcional)"
            type="date"
            value={v.valid_from ?? ""}
            hint="Vacío: desde siempre. Por ejemplo, la fecha de tu designación como agente."
            onChange={(e) => set({ valid_from: e.target.value || null })}
          />
          <Input
            label="Vigente hasta (opcional)"
            type="date"
            value={v.valid_to ?? ""}
            hint="Vacío: sin fin. Por ejemplo, si te dieron de baja como agente."
            onChange={(e) => set({ valid_to: e.target.value || null })}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label="N° de agente"
            value={v.agent_number ?? ""}
            onChange={(e) => set({ agent_number: e.target.value.trim() || null })}
          />
          <Input
            label="Código de régimen"
            value={v.regime_code ?? ""}
            hint="Para SICORE, SIRCAR o el aplicativo"
            onChange={(e) => set({ regime_code: e.target.value.trim() || null })}
          />
        </div>
        <label className="flex items-center justify-between gap-3 text-sm">
          Activo
          <Switch checked={v.is_active} onCheckedChange={(is_active) => set({ is_active })} label="Activo" />
        </label>
      </div>
    </Modal>
  );
}
