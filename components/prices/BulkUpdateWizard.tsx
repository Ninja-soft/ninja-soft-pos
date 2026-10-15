"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowRight, DollarSign, ImageOff } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { Checkbox } from "@/components/ui/Checkbox";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";
import type { RoundingRule } from "@/lib/prices/rounding";
import { BULK_FLAG_LABEL, type BulkFlag, type RepriceMode, type UtilityMode } from "@/lib/prices/costing";
import { useBrands, useCategories } from "@/modules/products/hooks";
import { useSuppliers } from "@/modules/purchases/hooks";
import { useFeature } from "@/modules/saas/gating";
import {
  priceProApi,
  FX_SOURCES,
  type BulkRequest,
  type BulkV2Preview,
  type BulkV2Request,
  type BulkV2Row,
  type FxSource,
  type ProList,
} from "@/modules/prices/proApi";
import { useFxQuote, usePriceProMutations } from "@/modules/prices/proHooks";
import { Field, RoundingPicker, fieldCls, friendlyPriceError, fromLocalInput, numOrNull } from "@/components/prices/shared";
import { MultiPick, categoryTree } from "@/components/prices/MultiPick";

type Step = "what" | "how" | "when" | "preview";
export type WizardMode = "fx" | "pct" | "amount" | "markup" | "cost" | "index";

const MODE_HINT: Record<WizardMode, string> = {
  fx: "Recalcula el costo en pesos de los productos con costo en dólares con la cotización elegida y actualiza el precio.",
  pct: "Sube o baja un porcentaje sobre el precio actual.",
  amount: "Suma o resta un monto fijo a cada precio.",
  markup: "Pone el precio a partir del costo final con la ganancia que elijas.",
  cost: "Recalcula el precio desde el costo final con la utilidad objetivo cargada en cada producto.",
  index: "Aplica la variación de un índice (IPC u otro) o de una cotización entre dos fechas.",
};

const REPRICE: { value: RepriceMode; label: string; hint: string }[] = [
  { value: "keep_markup", label: "Mantener la ganancia", hint: "El precio sube en la misma proporción que el costo final." },
  { value: "target", label: "Utilidad objetivo", hint: "Usa el markup o margen cargado en cada producto." },
  { value: "none", label: "Sólo el costo", hint: "Actualiza el costo y deja los precios como están." },
];

// Asistente "Actualizar precios" (ADR-058 → ADR-140). Qué productos (árbol de
// categorías, marcas, proveedores, etiqueta, sólo costos en dólares) y qué
// precios (venta y precios fijos de las listas), cómo (dólar, %, monto, markup,
// desde costo o índice), cuándo y una vista previa con miniaturas, antes y
// después, margen y alertas. Todo se calcula en el servidor; se aplica en un
// lote auditado que se puede deshacer.
export function BulkUpdateWizard({
  open,
  onOpenChange,
  lists,
  pro,
  requireApproval,
  initialMode,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  lists: ProList[];
  pro: boolean;
  requireApproval: boolean;
  initialMode?: WizardMode;
}) {
  const { toast } = useToast();
  const m = usePriceProMutations();
  const hasLists = useFeature("listas_precios") !== false;
  const hasPurchases = useFeature("compras") !== false;
  const hasUsd = useFeature("precios_usd") !== false;
  const { data: categories } = useCategories();
  const { data: brands } = useBrands();
  const { data: suppliers } = useSuppliers({}, open && hasPurchases);

  const [step, setStep] = useState<Step>("what");
  const [cats, setCats] = useState<string[]>([]);
  const [brandIds, setBrandIds] = useState<string[]>([]);
  const [supplierIds, setSupplierIds] = useState<string[]>([]);
  const [tag, setTag] = useState("");
  const [usdOnly, setUsdOnly] = useState(false);
  const [base, setBase] = useState(true);
  const [listIds, setListIds] = useState<string[]>([]);
  const [mode, setMode] = useState<WizardMode>("pct");
  const [value, setValue] = useState("");
  const [markupMode, setMarkupMode] = useState<UtilityMode>("markup");
  const [reprice, setReprice] = useState<RepriceMode>("keep_markup");
  const [fxSource, setFxSource] = useState<FxSource>("oficial");
  const [fxManual, setFxManual] = useState("");
  const [rounding, setRounding] = useState<RoundingRule | null>(null);
  const [idxKind, setIdxKind] = useState<"fx" | "index">("index");
  const [idxKey, setIdxKey] = useState("ipc");
  const [idxFrom, setIdxFrom] = useState("");
  const [cap, setCap] = useState("");
  const [when, setWhen] = useState<"now" | "date">("now");
  const [date, setDate] = useState("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<BulkV2Preview | null>(null);
  const [onlyAlerts, setOnlyAlerts] = useState(false);
  const [loading, setLoading] = useState(false);
  const quote = useFxQuote(fxSource, open && hasUsd && mode === "fx");

  useEffect(() => {
    if (!open) return;
    setStep("what");
    setPreview(null);
    setOnlyAlerts(false);
    const start = initialMode === "fx" && !hasUsd ? "pct" : (initialMode ?? "pct");
    setMode(start);
    setUsdOnly(start === "fx");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const catOptions = useMemo(
    () => categoryTree((categories ?? []).map((c) => ({ id: c.id, name: c.name, parent_id: c.parent_id }))),
    [categories],
  );

  const scope: BulkV2Request["scope"] = {
    category_ids: cats,
    brand_ids: brandIds,
    supplier_ids: supplierIds,
    tag: tag.trim() || null,
    usd_only: usdOnly || mode === "fx",
  };

  function v2(): BulkV2Request | null {
    const targets = { base, list_ids: hasLists ? listIds : [] };
    const common = {
      targets,
      scope,
      rounding,
      reason: reason.trim() || null,
      effective_at: when === "date" && mode !== "fx" ? fromLocalInput(date) : null,
    };
    if (mode === "fx") {
      const manual = fxSource === "manual" ? numOrNull(fxManual) : null;
      if (fxSource === "manual" && !(manual && manual > 0)) return null;
      return { ...common, mode: "fx", reprice, fx: { source: fxSource, rate: manual } };
    }
    if (mode === "cost") return { ...common, mode: "cost" };
    const v = numOrNull(value);
    if (v == null) return null;
    if (mode === "markup") return { ...common, mode: "markup", value: v, markup_mode: markupMode };
    if (mode === "pct" || mode === "amount") return { ...common, mode, value: v };
    return null;
  }

  // Índice (PRO): asistente v1, un solo destino.
  function v1(): BulkRequest | null {
    if (!idxFrom) return null;
    const dest = base ? null : listIds.length === 1 ? listIds[0] : undefined;
    if (dest === undefined || (base && listIds.length > 0)) return null;
    const legacy: BulkRequest["scope"] = {
      category_id: cats[0] ?? null,
      brand_id: brandIds[0] ?? null,
      supplier_id: supplierIds[0] ?? null,
      tag: tag.trim() || null,
    };
    return {
      mode: "index",
      list_id: dest,
      scope: legacy,
      rounding,
      reason: reason.trim() || null,
      effective_at: when === "date" ? fromLocalInput(date) : null,
      index:
        idxKind === "fx"
          ? { kind: "fx", currency: "USD", source: fxSource, from: idxFrom, cap_pct: numOrNull(cap) }
          : { kind: "index", key: idxKey.trim().toLowerCase(), from: idxFrom, cap_pct: numOrNull(cap) },
    };
  }

  async function loadPreview() {
    setLoading(true);
    try {
      if (mode === "index") {
        const r = v1();
        if (!r) {
          toast({
            title: "Por índice elegí una fecha y un solo destino (precio de venta o una lista), con un filtro por tipo",
            variant: "error",
          });
          return;
        }
        const p = await priceProApi.bulkPreview(r);
        setPreview({
          count: p.count,
          products: p.count,
          usd_products: 0,
          fx: null,
          before: p.before,
          after: p.after,
          price_changes: p.count,
          cost_changes: 0,
          below_cost: p.below_cost,
          below_floor: 0,
          low_margin: 0,
          skipped: 0,
          rows: p.rows.map((x) => ({
            ...x,
            list_id: r.list_id ?? null,
            sku: null,
            image_url: null,
            old_cost: x.cost,
            new_cost: x.cost,
            final_cost: x.cost,
            margin_pct: null,
            flags: x.cost != null && x.cost > 0 && x.new_price < x.cost ? (["below_cost"] as BulkFlag[]) : [],
          })),
        });
      } else {
        const r = v2();
        if (!r) {
          toast({ title: "Completá cuánto querés cambiar", variant: "error" });
          return;
        }
        setPreview(await priceProApi.bulkV2Preview(r));
      }
      setStep("preview");
    } catch (e) {
      toast({ title: friendlyPriceError(e), variant: "error" });
    } finally {
      setLoading(false);
    }
  }

  function done(res: { status: string; count: number }) {
    const msg =
      res.status === "pending_approval"
        ? `Quedó para aprobar (${res.count} cambios)`
        : res.status === "scheduled"
          ? `Programado: ${res.count} precios cambian en la fecha elegida`
          : `Listo: ${res.count} cambios aplicados. Lo podés deshacer desde Cambios.`;
    toast({ title: msg, variant: "success" });
    onOpenChange(false);
  }

  function confirm() {
    const onError = (e: unknown) => toast({ title: friendlyPriceError(e), variant: "error" });
    if (mode === "index") {
      const r = v1();
      if (r) m.bulkCreate.mutate(r, { onSuccess: done, onError });
      return;
    }
    const r = v2();
    if (r) m.bulkV2Create.mutate(r, { onSuccess: done, onError });
  }

  const listName = useMemo(() => new Map(lists.map((l) => [l.id, l.name])), [lists]);
  const rows = useMemo(
    () => (preview?.rows ?? []).filter((r) => !onlyAlerts || r.flags.length > 0),
    [preview, onlyAlerts],
  );
  const alerts = preview ? preview.below_cost + preview.below_floor + preview.low_margin : 0;
  const pending = m.bulkCreate.isPending || m.bulkV2Create.isPending;

  const steps: { value: Step; label: string }[] = [
    { value: "what", label: "Qué" },
    { value: "how", label: "Cómo" },
    { value: "when", label: "Cuándo" },
    { value: "preview", label: "Revisar" },
  ];
  const modes: { value: WizardMode; label: string }[] = [
    ...(hasUsd ? [{ value: "fx" as const, label: "Dólar" }] : []),
    { value: "pct", label: "%" },
    { value: "amount", label: "Monto" },
    { value: "markup", label: "Markup" },
    { value: "cost", label: "Desde costo" },
    ...(pro ? [{ value: "index" as const, label: "Índice" }] : []),
  ];

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Actualizar precios"
      className="sm:max-w-3xl"
      footer={
        <div className="flex items-center justify-between gap-2">
          <Button
            variant="ghost"
            onClick={() => setStep(step === "preview" ? "when" : step === "when" ? "how" : "what")}
            disabled={step === "what"}
          >
            Atrás
          </Button>
          {step === "preview" ? (
            <Button onClick={confirm} loading={pending} disabled={!preview || preview.count === 0}>
              {requireApproval ? "Enviar a aprobar" : when === "date" && mode !== "fx" ? "Programar" : "Aplicar"}
            </Button>
          ) : step === "when" ? (
            <Button onClick={loadPreview} loading={loading}>
              Ver cambios
            </Button>
          ) : (
            <Button
              onClick={() => setStep(step === "what" ? "how" : "when")}
              disabled={step === "what" && !base && listIds.length === 0 && mode !== "fx"}
            >
              Siguiente <ArrowRight size={15} />
            </Button>
          )}
        </div>
      }
    >
      <div className="space-y-5">
        <Segmented aria-label="Paso" value={step} options={steps} onChange={setStep} size="sm" fill />

        {step === "what" && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Sin filtros entran todos los productos activos. Cada filtro achica la lista.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Categorías" hint="Incluye las subcategorías.">
                <MultiPick options={catOptions} value={cats} onChange={setCats} placeholder="Buscar categoría" empty="Sin categorías" />
              </Field>
              <Field label="Marcas">
                <MultiPick
                  options={(brands ?? []).map((b) => ({ id: b.id, name: b.name }))}
                  value={brandIds}
                  onChange={setBrandIds}
                  placeholder="Buscar marca"
                  empty="Sin marcas"
                />
              </Field>
              {hasPurchases && (
                <Field label="Proveedores">
                  <MultiPick
                    options={((suppliers ?? []) as { id: string; name: string }[]).map((s) => ({ id: s.id, name: s.name }))}
                    value={supplierIds}
                    onChange={setSupplierIds}
                    placeholder="Buscar proveedor"
                    empty="Sin proveedores"
                  />
                </Field>
              )}
              <div className="space-y-3">
                <Field label="Etiqueta">
                  <input className={fieldCls} value={tag} onChange={(e) => setTag(e.target.value)} placeholder="importado" />
                </Field>
                {hasUsd && (
                  <div className="flex items-center justify-between gap-3 rounded-md bg-muted/60 px-3 py-2.5 text-sm">
                    <span>
                      Sólo productos con costo en dólares
                      <span className="block text-xs text-muted-foreground">Por dólar siempre es así.</span>
                    </span>
                    <Switch
                      checked={usdOnly || mode === "fx"}
                      disabled={mode === "fx"}
                      onCheckedChange={setUsdOnly}
                      label="Sólo productos con costo en dólares"
                    />
                  </div>
                )}
              </div>
            </div>

            <Field
              label="Qué precios"
              hint={
                hasLists
                  ? "En las listas cambian los precios fijos por producto. Las listas derivadas y sobre costo se recalculan solas."
                  : undefined
              }
            >
              <div className="divide-y divide-border rounded-md border border-border">
                <label className="flex cursor-pointer items-center gap-2.5 px-3 py-2.5 text-sm">
                  <Checkbox checked={base} onCheckedChange={setBase} aria-label="Precio de venta" />
                  <span className="font-medium">Precio de venta</span>
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
                        <span className="min-w-0 truncate">Lista {l.name}</span>
                        {l.kind !== "fixed" && <Badge tone="neutral">Sólo precios fijos</Badge>}
                      </label>
                    ))}
              </div>
            </Field>
          </div>
        )}

        {step === "how" && (
          <div className="space-y-4">
            <Segmented aria-label="Cómo" value={mode} onChange={setMode} size="sm" options={modes} scrollOnMobile />
            <p className="text-sm text-muted-foreground">{MODE_HINT[mode]}</p>

            {mode === "fx" && (
              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Cotización">
                    <select className={fieldCls} value={fxSource} onChange={(e) => setFxSource(e.target.value as FxSource)}>
                      {FX_SOURCES.map((s) => (
                        <option key={s.value} value={s.value}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {fxSource === "manual" ? (
                    <Field label="Dólar a usar" hint="Pesos por dólar, sin IVA.">
                      <input className={fieldCls} inputMode="decimal" value={fxManual} onChange={(e) => setFxManual(e.target.value)} placeholder="1250" />
                    </Field>
                  ) : (
                    <div className="flex items-center gap-3 rounded-md bg-muted/60 px-3 py-2.5">
                      <DollarSign size={18} className="shrink-0 text-muted-foreground" />
                      <div className="min-w-0 text-sm">
                        {quote.data?.rate ? (
                          <>
                            <div className="font-price text-lg font-bold tabular-nums">{formatCurrency(quote.data.rate)}</div>
                            <div className="text-xs text-muted-foreground">
                              Venta del {quote.data.rate_date ? new Date(`${quote.data.rate_date}T12:00:00`).toLocaleDateString("es-AR") : ""}
                              {quote.data.origin === "plataforma" ? " · oficial de NinjaSoft" : " · cargada por tu negocio"}
                            </div>
                          </>
                        ) : (
                          <span className="text-muted-foreground">
                            {quote.isLoading ? "Buscando la cotización" : "Sin cotización para esa fuente. Cargala o usá Manual."}
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
                <Field label="Qué pasa con el precio">
                  <div className="grid gap-2 sm:grid-cols-3">
                    {REPRICE.map((r) => (
                      <button
                        key={r.value}
                        type="button"
                        onClick={() => setReprice(r.value)}
                        aria-pressed={reprice === r.value}
                        className={cn(
                          "rounded-md border px-3 py-2.5 text-left text-sm transition",
                          reprice === r.value ? "border-foreground bg-muted" : "border-border hover:bg-muted/60",
                        )}
                      >
                        <span className="block font-medium text-foreground">{r.label}</span>
                        <span className="mt-0.5 block text-xs font-normal text-muted-foreground">{r.hint}</span>
                      </button>
                    ))}
                  </div>
                </Field>
              </div>
            )}

            {(mode === "pct" || mode === "amount") && (
              <Field
                label={mode === "pct" ? "Porcentaje" : "Monto en pesos"}
                hint={mode === "pct" ? "Negativo para bajar. Ej. 12,5" : "Se suma a cada precio. Negativo para bajar."}
              >
                <input className={fieldCls} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />
              </Field>
            )}

            {mode === "markup" && (
              <div className="space-y-3">
                <Segmented
                  aria-label="Tipo de ganancia"
                  size="sm"
                  value={markupMode}
                  onChange={setMarkupMode}
                  options={[
                    { value: "markup", label: "Markup sobre costo" },
                    { value: "margin", label: "Margen sobre precio" },
                  ]}
                />
                <Field
                  label={markupMode === "markup" ? "Markup %" : "Margen %"}
                  hint={
                    markupMode === "markup"
                      ? "Costo $100 con 50 % de markup = precio sin IVA $150."
                      : "Margen 50 % = la mitad del precio sin IVA es ganancia: costo $100, precio $200."
                  }
                >
                  <input className={fieldCls} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />
                </Field>
                <p className="text-xs text-muted-foreground">
                  Se calcula sobre el costo final (costo más flete e impuestos no recuperables) y se le suma el IVA del producto si tu
                  negocio lo discrimina.
                </p>
              </div>
            )}

            {mode === "cost" && (
              <Callout tone="info">
                Los productos sin utilidad objetivo o sin costo no cambian: la vista previa te dice cuántos son. La utilidad
                objetivo se carga en la ficha del producto, en Precios.
              </Callout>
            )}

            {mode === "index" && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Índice">
                  <select className={fieldCls} value={idxKind} onChange={(e) => setIdxKind(e.target.value as "fx" | "index")}>
                    <option value="index">IPC u otro índice</option>
                    <option value="fx">Cotización entre dos fechas</option>
                  </select>
                </Field>
                {idxKind === "fx" ? (
                  <Field label="Cotización">
                    <select className={fieldCls} value={fxSource} onChange={(e) => setFxSource(e.target.value as FxSource)}>
                      {FX_SOURCES.map((s) => (
                        <option key={s.value} value={s.value}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                ) : (
                  <Field label="Clave del índice">
                    <input className={fieldCls} value={idxKey} onChange={(e) => setIdxKey(e.target.value)} />
                  </Field>
                )}
                <Field label="Desde (valor de referencia)" hint="Se compara contra el último valor cargado.">
                  <input type="date" className={fieldCls} value={idxFrom} onChange={(e) => setIdxFrom(e.target.value)} />
                </Field>
                <Field label="Tope %" hint="Opcional: no sube más que esto.">
                  <input className={fieldCls} inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} />
                </Field>
              </div>
            )}

            {!(mode === "fx" && reprice === "none") && (
              <Field label="Redondeo" hint="Se aplica a los precios calculados.">
                <RoundingPicker value={rounding} onChange={setRounding} />
              </Field>
            )}
          </div>
        )}

        {step === "when" && (
          <div className="space-y-4">
            {mode === "fx" ? (
              <p className="text-sm text-muted-foreground">
                Por dólar se aplica en el momento (o cuando el dueño lo aprueba). Para que pase solo cuando el dólar se mueve,
                armá una regla automática en la pestaña Dólar.
              </p>
            ) : (
              <>
                <Segmented
                  aria-label="Cuándo"
                  value={when}
                  onChange={setWhen}
                  size="sm"
                  options={[
                    { value: "now", label: "Ahora" },
                    { value: "date", label: "En una fecha" },
                  ]}
                />
                {when === "date" && (
                  <Field label="Fecha y hora" hint="Ese día los precios cambian solos. Hasta entonces se puede deshacer.">
                    <input type="datetime-local" className={fieldCls} value={date} onChange={(e) => setDate(e.target.value)} />
                  </Field>
                )}
              </>
            )}
            <Field label="Motivo (opcional)" hint="Queda en el historial de cada precio.">
              <input className={fieldCls} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Lista nueva del proveedor" />
            </Field>
            {requireApproval && <Callout tone="info">El dueño tiene que aprobar este cambio antes de que se aplique.</Callout>}
          </div>
        )}

        {step === "preview" && preview && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Cambios" value={String(preview.count)} />
              <Stat
                label="Variación"
                value={
                  preview.before > 0
                    ? `${preview.after >= preview.before ? "+" : ""}${(Math.round(((preview.after - preview.before) / preview.before) * 1000) / 10).toLocaleString("es-AR")}%`
                    : "Sin dato"
                }
              />
              <Stat label={mode === "fx" ? "Costos" : "Productos"} value={String(mode === "fx" ? preview.cost_changes : preview.products)} />
              <Stat label="Alertas" value={String(alerts)} tone={alerts > 0 ? "warn" : undefined} />
            </div>
            {preview.fx && (
              <p className="text-xs text-muted-foreground">
                Dólar usado: {formatCurrency(preview.fx.rate)} ({preview.fx.origin === "plataforma" ? "oficial venta de NinjaSoft" : preview.fx.origin === "manual" ? "manual" : "cargado por tu negocio"}
                {preview.fx.rate_date ? `, ${new Date(`${preview.fx.rate_date}T12:00:00`).toLocaleDateString("es-AR")}` : ""}).
              </p>
            )}
            {preview.skipped > 0 && (
              <Callout tone="info">
                {preview.skipped} productos no cambian porque no tienen costo o utilidad objetivo cargados.
              </Callout>
            )}
            {alerts > 0 && (
              <Callout tone="warning" icon={AlertTriangle}>
                {[
                  preview.below_cost > 0 ? `${preview.below_cost} debajo del costo` : null,
                  preview.below_floor > 0 ? `${preview.below_floor} debajo del mínimo (el POS cobra el mínimo)` : null,
                  preview.low_margin > 0 ? `${preview.low_margin} con margen bajo` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </Callout>
            )}
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                {preview.count > preview.rows.length ? `Se muestran ${preview.rows.length} de ${preview.count}. Se aplican todos.` : ""}
              </span>
              {alerts > 0 && (
                <Segmented
                  aria-label="Filtro"
                  size="sm"
                  value={onlyAlerts ? "alerts" : "all"}
                  onChange={(v) => setOnlyAlerts(v === "alerts")}
                  options={[
                    { value: "all", label: "Todos" },
                    { value: "alerts", label: "Con alerta" },
                  ]}
                />
              )}
            </div>
            <PreviewTable rows={rows} listName={listName} />
          </div>
        )}
      </div>
    </Modal>
  );
}

export function PreviewTable({ rows, listName }: { rows: BulkV2Row[]; listName: Map<string, string> }) {
  if (rows.length === 0) return <p className="py-6 text-center text-sm text-muted-foreground">No hay cambios para mostrar.</p>;
  return (
    <div className="max-h-[50vh] overflow-auto overscroll-contain rounded-md border border-border">
      <table className="w-full min-w-[520px] text-sm">
        <thead className="sticky top-0 z-10 bg-popover text-left text-xs text-muted-foreground [&>tr]:bg-muted">
          <tr>
            <th className="px-3 py-2 font-medium">Producto</th>
            <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">Costo final</th>
            <th className="px-3 py-2 text-right font-medium">Antes</th>
            <th className="px-3 py-2 text-right font-medium">Después</th>
            <th className="px-3 py-2 text-right font-medium">Margen</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => {
            const diff = r.new_price - r.old_price;
            return (
              <tr key={`${r.product_id}-${r.variant_id ?? ""}-${r.list_id ?? ""}`}>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2.5">
                    {r.image_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={r.image_url} alt="" loading="lazy" className="h-9 w-9 shrink-0 rounded-md bg-muted object-cover" />
                    ) : (
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                        <ImageOff size={14} />
                      </span>
                    )}
                    <div className="min-w-0">
                      <div className="truncate font-medium">{r.name}</div>
                      <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                        {r.list_id ? <Badge tone="neutral">{r.list_name ?? listName.get(r.list_id) ?? "Lista"}</Badge> : <span>Precio de venta</span>}
                        {r.new_cost != null && r.old_cost != null && r.new_cost !== r.old_cost && (
                          <span className="tabular-nums">
                            costo {formatCurrency(r.old_cost)} a {formatCurrency(r.new_cost)}
                          </span>
                        )}
                        {r.flags.map((f) => (
                          <Badge key={f} tone={f === "low_margin" ? "warning" : "danger"}>
                            {BULK_FLAG_LABEL[f]}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  </div>
                </td>
                <td className="hidden px-3 py-2 text-right tabular-nums text-muted-foreground sm:table-cell">
                  {r.final_cost != null ? formatCurrency(r.final_cost) : "Sin costo"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{formatCurrency(r.old_price)}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  <div className="font-medium">{formatCurrency(r.new_price)}</div>
                  {diff !== 0 && (
                    <div className={cn("text-xs", diff > 0 ? "text-success" : "text-danger")}>
                      {diff > 0 ? "+" : ""}
                      {formatCurrency(diff)}
                    </div>
                  )}
                </td>
                <td
                  className={cn(
                    "px-3 py-2 text-right tabular-nums",
                    r.flags.includes("below_cost") ? "text-danger" : r.flags.includes("low_margin") ? "text-warning" : "",
                  )}
                >
                  {r.margin_pct != null ? `${r.margin_pct.toLocaleString("es-AR")}%` : "Sin dato"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "warn" }) {
  return (
    <div className="rounded-md bg-muted/60 px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={"text-base font-semibold tabular-nums " + (tone === "warn" ? "text-warning" : "")}>{value}</div>
    </div>
  );
}
