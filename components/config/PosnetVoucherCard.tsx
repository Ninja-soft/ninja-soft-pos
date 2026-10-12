"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CreditCard, RotateCcw, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { SettingsCard } from "@/components/settings/Settings";
import { TenderLogo } from "@/components/pos/ui/TenderLogo";
import { cn } from "@/lib/utils/cn";
import { createClient } from "@/lib/supabase/client";
import { getCurrentTenantId } from "@/lib/supabase/currentUser";
import { configErrorMessage, ownOverride, parentTarget, resolveEffective } from "@/lib/config/inheritance";
import { ACQUIRERS, acquirerLogo, availableAcquirers, type AcquirerKey } from "@/lib/payments/acquirers";
import {
  FIELD_LABEL,
  MAX_LEN,
  VOUCHER_FIELDS,
  applyPreset,
  clearAcquirerField,
  compactRules,
  configuredRule,
  hasAcquirerOverride,
  parseRules,
  rulesShapeError,
  setFieldRule,
  type CardVoucherRules,
  type VoucherFieldKey,
  type VoucherFieldRule,
} from "@/lib/payments/voucherRules";
import { posApi } from "@/modules/pos/api";
import { useConfigMutations, useConfigOverrides, useStoreGroupMap } from "@/modules/config/hooks";
import { InheritBadge, targetFor, useScopeNamer, type ScopeSel } from "./ScopedConfig";

// =============================================================================
// Tarjeta en posnet: datos del cupón (ADR-054).
//
// El dueño elige qué terminales usa (adquirentes que ve el cajero) y, por dato
// del cupón, si se pide, si es obligatorio, si es numérico o alfanumérico y su
// largo, con excepciones por adquirente y valores sugeridos. Se guarda en
// pos_settings.card_voucher_rules (todo el negocio) o como override de la
// sucursal o caja (ADR-049). El servidor valida lo mismo al cobrar.
// =============================================================================

type Tab = "general" | AcquirerKey;

const ROW = "grid gap-3 px-5 py-3.5 sm:grid-cols-[150px_minmax(0,1fr)] sm:items-start";

export function PosnetVoucherCard({ scope = { scope: "tenant" } }: { scope?: ScopeSel }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const raw = useQuery({ queryKey: ["pos", "settings"], queryFn: () => posApi.posSettingsRaw() });
  const methods = useQuery({
    queryKey: ["pos", "payment-methods-status"],
    queryFn: () => posApi.paymentMethodsStatus(),
    staleTime: 60_000,
  });
  const { data: overrides } = useConfigOverrides();
  const { data: groupMap } = useStoreGroupMap();
  const mut = useConfigMutations();
  const name = useScopeNamer();
  const ovs = useMemo(() => overrides ?? [], [overrides]);

  const isTenant = scope.scope === "tenant";
  const base = useMemo(() => (raw.data ?? {}) as Record<string, unknown>, [raw.data]);
  const target = useMemo(() => targetFor(scope, groupMap), [scope, groupMap]);
  const eff = useMemo(() => resolveEffective("pos_settings", "", base, ovs, target), [base, ovs, target]);
  const effRules = useMemo(() => parseRules(eff.value.card_voucher_rules), [eff]);
  const requireFlag = Boolean(eff.value.require_card_voucher);
  const own = isTenant ? null : ownOverride(ovs, scope.scope, scope.id, "pos_settings", "");
  const custom = Boolean(own && Object.prototype.hasOwnProperty.call(own.patch ?? {}, "card_voucher_rules"));
  const parentSrc = isTenant
    ? null
    : resolveEffective("pos_settings", "", base, ovs, parentTarget(scope.scope, target)).sources.card_voucher_rules;
  const srcName =
    !parentSrc || parentSrc === "tenant" ? "Todo el negocio" : name(parentSrc.split(":")[0] as never, parentSrc.split(":")[1]);

  const savedKey = JSON.stringify(effRules);
  const [draft, setDraft] = useState<CardVoucherRules>(effRules);
  const [tab, setTab] = useState<Tab>("general");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setDraft(parseRules(JSON.parse(savedKey)));
  }, [savedKey]);
  const dirty = JSON.stringify(compactRules(draft)) !== JSON.stringify(compactRules(effRules));

  // Terminales del negocio: las elegidas o, sin elección, las de sus medios.
  const fromMethods = availableAcquirers(methods.data ?? [], null).filter((a) => a.key !== "other");
  const chosen = new Set(draft.acquirers ?? []);
  const named = ACQUIRERS.filter((a) => a.key !== "other");
  const tabs: { value: Tab; label: string }[] = [
    { value: "general", label: "General" },
    ...ACQUIRERS.filter((a) => (chosen.size > 0 ? chosen.has(a.key) : a.key === "other" || fromMethods.some((m) => m.key === a.key))).map(
      (a) => ({ value: a.key as Tab, label: a.short }),
    ),
  ];
  const tabAcq: AcquirerKey | null = tab === "general" ? null : tab;

  function toggleAcquirer(k: AcquirerKey) {
    const next = new Set(chosen);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setDraft((d) => compactRules({ ...d, acquirers: ACQUIRERS.map((a) => a.key).filter((x) => next.has(x)) }));
  }

  async function save() {
    const value = compactRules(draft);
    const err = rulesShapeError(value);
    if (err) {
      toast({ title: "Revisá los datos del cupón", description: err, variant: "error" });
      return;
    }
    setSaving(true);
    try {
      if (isTenant) {
        const tenantId = await getCurrentTenantId();
        if (!tenantId) throw new Error("no_tenant");
        const { error } = await createClient()
          .from("pos_settings")
          .upsert({ tenant_id: tenantId, card_voucher_rules: value } as never, { onConflict: "tenant_id" });
        if (error) throw error;
        await qc.invalidateQueries({ queryKey: ["pos"] });
      } else {
        await mut.set.mutateAsync({
          scope: scope.scope,
          scopeId: scope.id,
          domain: "pos_settings",
          patch: { card_voucher_rules: value },
        });
      }
      toast({ title: "Datos del cupón guardados", variant: "success" });
    } catch (e) {
      toast({ title: isTenant ? "No se pudo guardar" : configErrorMessage(e), variant: "error" });
    } finally {
      setSaving(false);
    }
  }

  function inherit() {
    if (isTenant) return;
    mut.set.mutate(
      { scope: scope.scope, scopeId: scope.id, domain: "pos_settings", clear: ["card_voucher_rules"] },
      { onError: (e) => toast({ title: configErrorMessage(e), variant: "error" }) },
    );
  }

  return (
    <div className="space-y-4" id="posnet-cupon">
      <SettingsCard
        title="Terminales que usás"
        icon={CreditCard}
        description="El cajero elige primero de qué terminal es el cobro. Mostramos sólo las que marques acá."
        actions={
          !isTenant ? (
            <InheritBadge custom={custom} source={custom ? undefined : srcName} onReset={inherit} busy={mut.set.isPending} />
          ) : undefined
        }
        padded
      >
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="group" aria-label="Terminales que usás">
          {named.map((a) => {
            const on = chosen.has(a.key);
            return (
              <button
                key={a.key}
                type="button"
                aria-pressed={on}
                onClick={() => toggleAcquirer(a.key)}
                className={cn(
                  "relative flex min-h-[52px] items-center gap-2.5 rounded-md border px-3 py-2 pr-8 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  on ? "choice-on choice-check border-transparent" : "border-border bg-card hover:bg-muted",
                )}
              >
                <TenderLogo source={{ logo: acquirerLogo(a.key) }} alt={a.label} size={24} fallback="card" />
                <span className="min-w-0 text-[13px] font-semibold leading-tight">{a.label}</span>
              </button>
            );
          })}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          {chosen.size === 0
            ? fromMethods.length > 0
              ? `Sin marcar: se ofrecen las de tus medios de pago (${fromMethods.map((a) => a.short).join(", ")}) y Otra.`
              : "Sin marcar: se ofrecen todas y Otra."
            : "Siempre se suma Otra, para una terminal que no esté en la lista."}
        </p>
      </SettingsCard>

      <SettingsCard
        title="Datos del cupón"
        description="Qué pide el POS al registrar el cobro y cómo. El servidor rechaza un cobro que no cumpla."
        actions={
          <Button size="sm" onClick={save} disabled={!dirty || saving} loading={saving}>
            Guardar
          </Button>
        }
      >
        <div className="space-y-3 border-b border-border px-5 py-3.5">
          <div className="-mx-1 overflow-x-auto px-1">
            <Segmented size="sm" aria-label="Reglas de" value={tab} onChange={setTab} options={tabs} />
          </div>
          {tabAcq && tabAcq !== "other" && (
            <div className="flex flex-wrap items-center gap-2">
              <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                Lo que no cambies acá usa la regla General.
              </p>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setDraft((d) => applyPreset(d, tabAcq as Exclude<AcquirerKey, "other">))}
              >
                <Wand2 size={14} aria-hidden /> Usar sugeridos
              </Button>
            </div>
          )}
          {requireFlag && (
            <Callout tone="neutral">
              Voucher de tarjeta obligatorio está activo en Operación: cupón, lote y autorización se piden siempre y son
              obligatorios.
            </Callout>
          )}
        </div>
        <div className="divide-y divide-border">
          {VOUCHER_FIELDS.map((f) => (
            <RuleRow
              key={`${tab}-${f}`}
              field={f}
              rule={configuredRule(draft, tabAcq, f)}
              locked={requireFlag && (f === "cupon" || f === "lote" || f === "autorizacion")}
              overridden={tabAcq ? hasAcquirerOverride(draft, tabAcq, f) : false}
              onChange={(r) => setDraft((d) => setFieldRule(d, tabAcq, f, r))}
              onReset={tabAcq ? () => setDraft((d) => clearAcquirerField(d, tabAcq, f)) : undefined}
            />
          ))}
        </div>
      </SettingsCard>
    </div>
  );
}

const FIELD_HINT: Partial<Record<VoucherFieldKey, string>> = {
  comercio: "Sin pedirlo, sale de Medios de pago según la terminal y la marca.",
  cuotas: "Sin pedirlo, sale del plan de cuotas elegido.",
  ultimos4: "Los 4 números finales de la tarjeta.",
};

function RuleRow({
  field,
  rule,
  locked,
  overridden,
  onChange,
  onReset,
}: {
  field: VoucherFieldKey;
  rule: VoucherFieldRule;
  locked: boolean;
  overridden: boolean;
  onChange: (r: VoucherFieldRule) => void;
  onReset?: () => void;
}) {
  const exact = rule.min === rule.max;
  const set = (patch: Partial<VoucherFieldRule>) => {
    const next = { ...rule, ...patch };
    if (next.min > next.max) next.max = next.min;
    onChange(next);
  };
  return (
    <div className={ROW}>
      <div className="min-w-0">
        <p className="text-sm font-semibold">{FIELD_LABEL[field]}</p>
        {FIELD_HINT[field] && <p className="mt-0.5 text-xs text-muted-foreground">{FIELD_HINT[field]}</p>}
        {onReset && overridden && (
          <button
            type="button"
            onClick={onReset}
            className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            <RotateCcw size={12} aria-hidden /> Usar la general
          </button>
        )}
        {onReset && !overridden && <p className="mt-1 text-[11px] text-muted-foreground">Igual que General</p>}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2.5">
        <label className="inline-flex items-center gap-2 text-[13px] font-medium">
          <Switch
            checked={rule.ask || locked}
            disabled={locked}
            onCheckedChange={(v) => set({ ask: v, required: v ? rule.required : false })}
            label={`Pedir ${FIELD_LABEL[field].toLowerCase()}`}
          />
          Pedir
        </label>
        {(rule.ask || locked) && (
          <>
            <Segmented
              size="sm"
              aria-label="Obligatorio u opcional"
              value={rule.required || locked ? "req" : "opt"}
              onChange={(v) => !locked && set({ required: v === "req" })}
              options={[
                { value: "req", label: "Obligatorio" },
                { value: "opt", label: "Opcional" },
              ]}
            />
            <Segmented
              size="sm"
              aria-label="Tipo"
              value={rule.type}
              onChange={(v) => set({ type: v })}
              options={[
                { value: "numeric", label: "Numérico" },
                { value: "alnum", label: "Alfanumérico" },
              ]}
            />
            <div className="flex items-center gap-2">
              <Segmented
                size="sm"
                aria-label="Largo"
                value={exact ? "exact" : "range"}
                onChange={(v) =>
                  v === "exact" ? set({ min: rule.max, max: rule.max }) : set({ min: 1, max: Math.max(rule.max, 2) })
                }
                options={[
                  { value: "exact", label: "Exacto" },
                  { value: "range", label: "Rango" },
                ]}
              />
              {exact ? (
                <LenInput label="Largo" value={rule.max} onChange={(n) => set({ min: n, max: n })} />
              ) : (
                <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <LenInput label="Mínimo" value={rule.min} onChange={(n) => set({ min: n })} />
                  a
                  <LenInput label="Máximo" value={rule.max} onChange={(n) => set({ max: Math.max(n, rule.min) })} />
                </span>
              )}
            </div>
          </>
        )}
        {locked && (
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <Check size={12} aria-hidden /> Exigido en Operación
          </span>
        )}
      </div>
    </div>
  );
}

function LenInput({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = Math.min(MAX_LEN, Math.max(1, Math.trunc(Number(text)) || 1));
    setText(String(n));
    if (n !== value) onChange(n);
  };
  return (
    <input
      type="text"
      inputMode="numeric"
      aria-label={label}
      value={text}
      onChange={(e) => setText(e.target.value.replace(/\D/g, "").slice(0, 2))}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
      className="h-8 w-11 rounded-md border border-border bg-background text-center text-sm font-semibold tabular-nums outline-none focus:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
    />
  );
}
