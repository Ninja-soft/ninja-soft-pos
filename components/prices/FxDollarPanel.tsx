"use client";

import { useEffect, useMemo, useState } from "react";
import { DollarSign, Pencil, Plus, Trash2, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { Checkbox } from "@/components/ui/Checkbox";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Modal } from "@/components/ui/Modal";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";
import type { RoundingRule } from "@/lib/prices/rounding";
import { describeRounding } from "@/lib/prices/rounding";
import type { RepriceMode } from "@/lib/prices/costing";
import { useBrands, useCategories } from "@/modules/products/hooks";
import { useFeature } from "@/modules/saas/gating";
import { FX_SOURCES, type FxRule, type FxSource, type ProList } from "@/modules/prices/proApi";
import { useFxQuote, useFxRules, usePriceProMutations, usePriceSettings } from "@/modules/prices/proHooks";
import { Field, RoundingPicker, fieldCls, formatWhen, friendlyPriceError, numOrNull } from "@/components/prices/shared";
import { MultiPick, categoryTree } from "@/components/prices/MultiPick";

const REPRICE_LABEL: Record<RepriceMode, string> = {
  keep_markup: "Mantener la ganancia",
  target: "Utilidad objetivo",
  none: "Sólo el costo",
};

function day(d: string | null | undefined) {
  return d ? new Date(`${d}T12:00:00`).toLocaleDateString("es-AR") : "";
}

// Pestaña Dólar (ADR-140): cotización del día (oficial venta de la plataforma o
// la del negocio), botón "Actualizar por dólar" y reglas automáticas "cuando el
// dólar se mueva más de X %" con aprobación opcional.
export function FxDollarPanel({
  lists,
  isOwner,
  onUpdateByDollar,
}: {
  lists: ProList[];
  isOwner: boolean;
  onUpdateByDollar: () => void;
}) {
  const { toast } = useToast();
  const { data: settings } = usePriceSettings();
  const source: FxSource = settings?.fx_source ?? "oficial";
  const quote = useFxQuote(source);
  const { data: rules = [] } = useFxRules();
  const m = usePriceProMutations();
  const [editing, setEditing] = useState<FxRule | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [toDelete, setToDelete] = useState<FxRule | null>(null);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-muted/60 px-4 py-3">
        <div className="flex items-center gap-3">
          <DollarSign size={20} className="shrink-0 text-muted-foreground" />
          <div>
            <div className="font-price text-2xl font-bold tabular-nums">
              {quote.data?.rate ? formatCurrency(quote.data.rate) : "Sin cotización"}
            </div>
            <div className="text-xs text-muted-foreground">
              {quote.data?.rate
                ? `${FX_SOURCES.find((s) => s.value === source)?.label ?? source}, venta del ${day(quote.data.rate_date)}${
                    quote.data.origin === "plataforma" ? " (NinjaSoft, ArgentinaDatos)" : " (cargada por tu negocio)"
                  }`
                : "Cargá la cotización en Dólar e índices o elegí otra fuente."}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className={cn(fieldCls, "h-9 w-auto")}
            value={source}
            aria-label="Fuente del dólar"
            onChange={(e) =>
              m.saveSettings.mutate(
                { fx_source: e.target.value as FxSource },
                { onError: (err) => toast({ title: friendlyPriceError(err), variant: "error" }) },
              )
            }
          >
            {FX_SOURCES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          <Button size="sm" onClick={onUpdateByDollar}>
            <TrendingUp size={15} /> Actualizar por dólar
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        La cotización oficial (venta) la trae NinjaSoft todos los días. Si cargás una tuya para el mismo día, manda la tuya.
      </p>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">Actualización automática</h3>
            <p className="text-xs text-muted-foreground">
              Dos veces por día se compara el dólar con el de la última actualización. Si se movió más que el umbral, se arma el
              cambio solo.
            </p>
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
          >
            <Plus size={15} /> Nueva regla
          </Button>
        </div>
        {rules.length === 0 && (
          <p className="py-4 text-center text-sm text-muted-foreground">Sin reglas. Creá una para no tener que acordarte.</p>
        )}
        {rules.map((r) => (
          <div key={r.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border px-3 py-2.5 text-sm">
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="truncate font-medium">{r.name}</span>
                <Badge tone="neutral">Más de {r.threshold_pct.toLocaleString("es-AR")} %</Badge>
                <Badge tone={r.require_approval ? "info" : "neutral"}>{r.require_approval ? "Con aprobación" : "Se aplica solo"}</Badge>
              </div>
              <div className="text-xs text-muted-foreground">
                {REPRICE_LABEL[(r.request.reprice ?? "keep_markup") as RepriceMode]}
                {r.request.rounding ? ` · ${describeRounding(r.request.rounding)}` : ""}
                {r.last_rate ? ` · base ${formatCurrency(r.last_rate)} (${day(r.last_rate_date)})` : ""}
                {r.last_checked_at ? ` · revisada ${formatWhen(r.last_checked_at)}` : ""}
                {r.last_result ? ` · ${r.last_result}` : ""}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Switch
                checked={r.is_active}
                onCheckedChange={(v) =>
                  m.saveFxRule.mutate(
                    { ...r, is_active: v },
                    { onError: (e) => toast({ title: friendlyPriceError(e), variant: "error" }) },
                  )
                }
                label="Activa"
              />
              <button
                type="button"
                title="Editar regla"
                aria-label="Editar regla"
                onClick={() => {
                  setEditing(r);
                  setFormOpen(true);
                }}
                className="rounded p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
              >
                <Pencil size={15} />
              </button>
              <button
                type="button"
                title="Eliminar regla"
                aria-label="Eliminar regla"
                onClick={() => setToDelete(r)}
                className="rounded p-1.5 text-muted-foreground transition hover:bg-muted hover:text-destructive"
              >
                <Trash2 size={15} />
              </button>
            </div>
          </div>
        ))}
      </div>

      <FxRuleForm open={formOpen} onOpenChange={setFormOpen} rule={editing} lists={lists} isOwner={isOwner} defaultSource={source} />
      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(o) => !o && setToDelete(null)}
        title="Eliminar regla"
        description="Deja de revisar el dólar para esta regla. Los cambios que ya hizo no se tocan."
        confirmLabel="Eliminar"
        danger
        loading={m.deleteFxRule.isPending}
        onConfirm={() =>
          toDelete &&
          m.deleteFxRule.mutate(toDelete.id, {
            onSuccess: () => setToDelete(null),
            onError: (e) => toast({ title: friendlyPriceError(e), variant: "error" }),
          })
        }
      />
    </div>
  );
}

function FxRuleForm({
  open,
  onOpenChange,
  rule,
  lists,
  isOwner,
  defaultSource,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  rule: FxRule | null;
  lists: ProList[];
  isOwner: boolean;
  defaultSource: FxSource;
}) {
  const { toast } = useToast();
  const m = usePriceProMutations();
  const hasLists = useFeature("listas_precios") !== false;
  const { data: categories } = useCategories();
  const { data: brands } = useBrands();
  const [name, setName] = useState("");
  const [threshold, setThreshold] = useState("5");
  const [source, setSource] = useState<FxSource>(defaultSource);
  const [approval, setApproval] = useState(true);
  const [reprice, setReprice] = useState<RepriceMode>("keep_markup");
  const [rounding, setRounding] = useState<RoundingRule | null>(null);
  const [cats, setCats] = useState<string[]>([]);
  const [brandIds, setBrandIds] = useState<string[]>([]);
  const [base, setBase] = useState(true);
  const [listIds, setListIds] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    setName(rule?.name ?? "Actualizar por dólar");
    setThreshold(String(rule?.threshold_pct ?? 5).replace(".", ","));
    setSource(rule?.fx_source ?? defaultSource);
    setApproval(rule?.require_approval ?? true);
    setReprice((rule?.request.reprice as RepriceMode) ?? "keep_markup");
    setRounding(rule?.request.rounding ?? null);
    setCats(rule?.request.scope?.category_ids ?? []);
    setBrandIds(rule?.request.scope?.brand_ids ?? []);
    setBase(rule?.request.targets?.base ?? true);
    setListIds(rule?.request.targets?.list_ids ?? []);
  }, [open, rule, defaultSource]);

  const catOptions = useMemo(
    () => categoryTree((categories ?? []).map((c) => ({ id: c.id, name: c.name, parent_id: c.parent_id }))),
    [categories],
  );

  function save() {
    const thr = numOrNull(threshold);
    if (!(thr && thr > 0 && thr <= 100)) {
      toast({ title: "La variación tiene que ser mayor a 0 y hasta 100 %", variant: "error" });
      return;
    }
    m.saveFxRule.mutate(
      {
        id: rule?.id,
        name: name.trim() || "Actualizar por dólar",
        is_active: rule?.is_active ?? true,
        threshold_pct: thr,
        fx_source: source,
        require_approval: approval,
        request: {
          reprice,
          rounding,
          targets: { base, list_ids: hasLists ? listIds : [] },
          scope: { category_ids: cats, brand_ids: brandIds, usd_only: true },
        },
      },
      {
        onSuccess: () => {
          toast({ title: "Regla guardada", variant: "success" });
          onOpenChange(false);
        },
        onError: (e) => toast({ title: friendlyPriceError(e), variant: "error" }),
      },
    );
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={rule ? "Editar regla automática" : "Nueva regla automática"}
      className="sm:max-w-2xl"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={save} loading={m.saveFxRule.isPending}>
            Guardar
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Nombre" className="sm:col-span-3">
            <input className={fieldCls} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Cuando el dólar se mueva más de (%)" className="sm:col-span-2">
            <input className={fieldCls} inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
          </Field>
          <Field label="Cotización">
            <select className={fieldCls} value={source} onChange={(e) => setSource(e.target.value as FxSource)}>
              {FX_SOURCES.filter((s) => s.value !== "manual").map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="flex items-center justify-between gap-3 rounded-md bg-muted/60 px-3 py-2.5 text-sm">
          <span>
            Pedir mi aprobación antes de aplicar
            <span className="block text-xs text-muted-foreground">
              {isOwner ? "Te llega un aviso con los cambios para revisar." : "Sólo el dueño puede sacar la aprobación."}
            </span>
          </span>
          <Switch checked={approval} disabled={!isOwner && approval} onCheckedChange={setApproval} label="Pedir aprobación" />
        </div>

        <Field label="Qué pasa con el precio">
          <div className="grid gap-2 sm:grid-cols-3">
            {(Object.keys(REPRICE_LABEL) as RepriceMode[]).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={reprice === k}
                onClick={() => setReprice(k)}
                className={cn(
                  "rounded-md border px-3 py-2 text-left text-sm transition",
                  reprice === k ? "border-foreground bg-muted" : "border-border hover:bg-muted/60",
                )}
              >
                {REPRICE_LABEL[k]}
              </button>
            ))}
          </div>
        </Field>
        {reprice !== "none" && (
          <Field label="Redondeo">
            <RoundingPicker value={rounding} onChange={setRounding} />
          </Field>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Categorías (vacío = todas)" hint="Incluye las subcategorías. Sólo productos con costo en dólares.">
            <MultiPick options={catOptions} value={cats} onChange={setCats} placeholder="Buscar categoría" />
          </Field>
          <Field label="Marcas (vacío = todas)">
            <MultiPick options={(brands ?? []).map((b) => ({ id: b.id, name: b.name }))} value={brandIds} onChange={setBrandIds} placeholder="Buscar marca" />
          </Field>
        </div>

        <Field label="Qué precios">
          <div className="divide-y divide-border rounded-md border border-border">
            <label className="flex cursor-pointer items-center gap-2.5 px-3 py-2.5 text-sm">
              <Checkbox checked={base} onCheckedChange={setBase} aria-label="Precio de venta" />
              <span>Precio de venta</span>
            </label>
            {hasLists &&
              lists
                .filter((l) => l.kind !== "currency")
                .map((l) => (
                  <label key={l.id} className="flex cursor-pointer items-center gap-2.5 px-3 py-2.5 text-sm">
                    <Checkbox
                      checked={listIds.includes(l.id)}
                      onCheckedChange={(v) => setListIds(v ? [...listIds, l.id] : listIds.filter((x) => x !== l.id))}
                      aria-label={`Lista ${l.name}`}
                    />
                    <span className="truncate">Lista {l.name} (precios fijos)</span>
                  </label>
                ))}
          </div>
        </Field>
        <Callout tone="info">
          El costo en pesos de los productos en dólares se actualiza siempre. Cada cambio queda en Cambios y se puede deshacer.
        </Callout>
      </div>
    </Modal>
  );
}
