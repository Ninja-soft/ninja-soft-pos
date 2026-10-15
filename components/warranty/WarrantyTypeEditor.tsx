"use client";

import { useEffect, useMemo, useState } from "react";
import { Layers, Package, ShieldCheck } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { formatCurrency } from "@/lib/utils/format";
import { monthsLabel, warrantyUnitPrice, type CategoryNodeLike } from "@/lib/warranty/pricing";
import {
  draftFromScopes,
  draftToRows,
  normalizeDraft,
  setAppliesToAll,
  type ScopeDraft,
} from "@/lib/warranty/scopes";
import type { WarrantyScope, WarrantyType } from "@/modules/warranty/api";
import { warrantyErrorMessage } from "@/modules/warranty/api";
import { useWarrantyMutations } from "@/modules/warranty/hooks";
import { CategoryScopeTree } from "./CategoryScopeTree";
import { ProductScopePicker } from "./ProductScopePicker";

export const EXAMPLE_PRICE = 100_000;

const ROUNDING = [
  { value: "0", label: "Sin redondeo" },
  { value: "10", label: "$10" },
  { value: "100", label: "$100" },
  { value: "500", label: "$500" },
  { value: "1000", label: "$1.000" },
];

export interface WarrantyTemplate {
  label: string;
  months: number;
  price_pct?: number;
  price?: number;
  description?: string;
}

interface Form {
  label: string;
  months: string;
  mode: "pct" | "fixed";
  pct: string;
  fixed: string;
  min: string;
  max: string;
  step: string;
  commission: string;
  description: string;
  terms: string;
  active: boolean;
}

const toNum = (s: string): number => Number(String(s).replace(",", ".")) || 0;
const optNum = (s: string): number | null => (s.trim() === "" ? null : toNum(s));

function formFrom(p: WarrantyType | null, t: WarrantyTemplate | null): Form {
  const pct = p ? Number(p.price_pct) : (t?.price_pct ?? 0);
  return {
    label: p?.label ?? t?.label ?? "",
    months: String(p?.months ?? t?.months ?? 12),
    mode: (p ? pct > 0 : t?.price == null) ? "pct" : "fixed",
    pct: pct > 0 ? String(pct) : "",
    fixed: p && Number(p.price) > 0 ? String(p.price) : t?.price ? String(t.price) : "",
    min: p?.min_price != null ? String(p.min_price) : "",
    max: p?.max_price != null ? String(p.max_price) : "",
    step: String(Number(p?.rounding_step ?? 0)),
    commission: p && Number(p.commission_pct) > 0 ? String(p.commission_pct) : "",
    description: p?.description ?? t?.description ?? "",
    terms: p?.terms ?? "",
    active: p?.is_active ?? true,
  };
}

// Alta y edición de un tipo de garantía extendida (ADR-139): datos, precio
// con ejemplo en vivo, condiciones para el comprobante y alcance (todos,
// categorías con herencia y productos puntuales).
export function WarrantyTypeEditor({
  open,
  onOpenChange,
  plan,
  template,
  scopes,
  categories,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  plan: WarrantyType | null;
  template?: WarrantyTemplate | null;
  scopes: WarrantyScope[];
  categories: CategoryNodeLike[];
}) {
  const { toast } = useToast();
  const { save } = useWarrantyMutations();
  const [f, setF] = useState<Form>(() => formFrom(plan, template ?? null));
  const [draft, setDraft] = useState<ScopeDraft>(() =>
    draftFromScopes(plan?.id ?? null, plan?.applies_to_all ?? true, plan ? scopes : []),
  );
  const [tab, setTab] = useState<"categories" | "products">("categories");

  useEffect(() => {
    if (!open) return;
    setF(formFrom(plan, template ?? null));
    setDraft(draftFromScopes(plan?.id ?? null, plan?.applies_to_all ?? true, plan ? scopes : []));
    setTab("categories");
    // Sólo al abrir: lo que llegue después no pisa lo que se está editando.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, plan?.id]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((prev) => ({ ...prev, [k]: v }));
  const pricing = useMemo(
    () => ({
      price_pct: f.mode === "pct" ? toNum(f.pct) : 0,
      price: f.mode === "fixed" ? toNum(f.fixed) : 0,
      min_price: optNum(f.min),
      max_price: optNum(f.max),
      rounding_step: toNum(f.step),
    }),
    [f],
  );
  const example = warrantyUnitPrice(pricing, EXAMPLE_PRICE);
  const months = Math.trunc(toNum(f.months));
  const errors = {
    label: f.label.trim() === "" ? "Poné un nombre" : f.label.trim().length > 60 ? "Hasta 60 caracteres" : undefined,
    months: months < 1 || months > 120 ? "Entre 1 y 120 meses" : undefined,
    price:
      f.mode === "pct"
        ? toNum(f.pct) <= 0 || toNum(f.pct) > 100
          ? "Un % entre 0 y 100"
          : undefined
        : toNum(f.fixed) <= 0
          ? "Cargá el monto"
          : undefined,
    max:
      pricing.min_price != null && pricing.max_price != null && pricing.max_price < pricing.min_price
        ? "El máximo tiene que ser mayor al mínimo"
        : undefined,
  };
  const valid = !errors.label && !errors.months && !errors.price && !errors.max;
  const [touched, setTouched] = useState(false);

  function submit() {
    setTouched(true);
    if (!valid) return;
    const clean = normalizeDraft(draft, categories);
    save.mutate(
      {
        plan: {
          ...(plan ? { id: plan.id } : {}),
          label: f.label.trim(),
          months,
          price_pct: pricing.price_pct,
          price: pricing.price,
          min_price: pricing.min_price,
          max_price: pricing.max_price,
          rounding_step: pricing.rounding_step,
          commission_pct: toNum(f.commission),
          description: f.description.trim() || null,
          terms: f.terms.trim() || null,
          applies_to_all: clean.appliesToAll,
          is_active: f.active,
        },
        scopes: draftToRows(clean),
      },
      {
        onSuccess: () => {
          toast({ title: plan ? "Garantía actualizada" : "Garantía creada", variant: "success" });
          onOpenChange(false);
        },
        onError: (e) => toast({ title: warrantyErrorMessage(e), variant: "error" }),
      },
    );
  }

  const LABEL = "mb-1.5 block text-xs font-medium text-muted-foreground";
  const area =
    "w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none transition placeholder:text-muted-foreground focus:border-ninja-flameSoft focus:ring-2 focus:ring-ninja-flameSoft/20";

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={plan ? "Editar garantía extendida" : "Nueva garantía extendida"}
      description="Duración, precio y a qué productos se ofrece al cobrar."
      className="sm:max-w-2xl"
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <Switch checked={f.active} onCheckedChange={(v) => set("active", v)} label="Activa" />
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button onClick={submit} loading={save.isPending}>
              Guardar
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-6">
        {/* Ejemplo en vivo */}
        <div className="flex items-center gap-3 rounded-lg bg-muted px-4 py-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-background text-foreground">
            <ShieldCheck size={18} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-foreground">{f.label.trim() || "Garantía extendida"}</p>
            <p className="text-xs text-muted-foreground">
              {months >= 1 ? `+${monthsLabel(months)}` : "Elegí la duración"} · producto de {formatCurrency(EXAMPLE_PRICE)}
            </p>
          </div>
          <p className="font-price text-lg font-semibold tabular-nums text-foreground" aria-live="polite">
            +{formatCurrency(example)}
          </p>
        </div>

        <section className="grid gap-3 sm:grid-cols-[1fr_9rem]">
          <Input
            label="Nombre"
            value={f.label}
            onChange={(e) => set("label", e.target.value)}
            placeholder="+12 meses, Protección total"
            maxLength={60}
            error={touched ? errors.label : undefined}
          />
          <Input
            label="Duración (meses)"
            type="number"
            inputMode="numeric"
            min={1}
            max={120}
            value={f.months}
            onChange={(e) => set("months", e.target.value)}
            error={touched ? errors.months : undefined}
          />
        </section>

        <section className="space-y-3">
          <div>
            <span className={LABEL}>Precio</span>
            <Segmented
              size="sm"
              aria-label="Cómo se calcula el precio"
              value={f.mode}
              onChange={(v) => set("mode", v)}
              options={[
                { value: "pct", label: "% del precio del producto" },
                { value: "fixed", label: "Monto fijo" },
              ]}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {f.mode === "pct" ? (
              <Input
                label="Porcentaje"
                type="number"
                inputMode="decimal"
                min={0}
                max={100}
                step="0.5"
                value={f.pct}
                onChange={(e) => set("pct", e.target.value)}
                placeholder="12"
                error={touched ? errors.price : undefined}
              />
            ) : (
              <Input
                label="Monto por unidad ($)"
                type="number"
                inputMode="decimal"
                min={0}
                value={f.fixed}
                onChange={(e) => set("fixed", e.target.value)}
                placeholder="15000"
                error={touched ? errors.price : undefined}
              />
            )}
            <Input
              label="Mínimo ($, opcional)"
              type="number"
              inputMode="decimal"
              min={0}
              value={f.min}
              onChange={(e) => set("min", e.target.value)}
              placeholder="Sin mínimo"
            />
            <Input
              label="Máximo ($, opcional)"
              type="number"
              inputMode="decimal"
              min={0}
              value={f.max}
              onChange={(e) => set("max", e.target.value)}
              placeholder="Sin máximo"
              error={errors.max}
            />
          </div>
          <div>
            <span className={LABEL}>Redondear el precio a</span>
            <Segmented scrollOnMobile size="sm" aria-label="Redondeo" value={f.step} onChange={(v) => set("step", v)} options={ROUNDING} />
          </div>
          <div className="grid gap-3 sm:grid-cols-[9rem_1fr]">
            <Input
              label="Comisión vendedor (%)"
              type="number"
              inputMode="decimal"
              min={0}
              max={100}
              value={f.commission}
              onChange={(e) => set("commission", e.target.value)}
              placeholder="0"
            />
            <Input
              label="Descripción corta (se ve al cobrar)"
              value={f.description}
              onChange={(e) => set("description", e.target.value)}
              placeholder="Cubre fallas de funcionamiento"
              maxLength={300}
            />
          </div>
          <label className="block">
            <span className={LABEL}>Condiciones en el comprobante (opcional)</span>
            <textarea
              value={f.terms}
              onChange={(e) => set("terms", e.target.value)}
              rows={3}
              maxLength={1000}
              placeholder="Cubre fallas de fabricación desde que vence la garantía oficial. No cubre golpes, humedad ni mal uso. Presentá este comprobante."
              className={area}
            />
          </label>
        </section>

        <section className="space-y-3">
          <div>
            <span className={LABEL}>¿A qué productos se ofrece?</span>
            <Segmented
              fill
              size="sm"
              aria-label="Alcance"
              value={draft.appliesToAll ? "all" : "some"}
              onChange={(v) => setDraft((d) => setAppliesToAll(d, v === "all", categories))}
              options={[
                { value: "all", label: "Todos los productos" },
                { value: "some", label: "Sólo los que elijas" },
              ]}
            />
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {draft.appliesToAll
                ? "Se ofrece en todo el catálogo. Destildá rubros o categorías para sacarla (lo de adentro hereda)."
                : "Tildá rubros o categorías: todo lo que cuelga de ellos la hereda. Podés sacar una subcategoría puntual."}{" "}
              Manda el producto, después la categoría más específica y por último {"“"}Todos{"”"}.
            </p>
          </div>
          <Segmented
            scrollOnMobile
            size="sm"
            aria-label="Asignar por"
            value={tab}
            onChange={setTab}
            options={[
              { value: "categories", label: "Categorías", icon: <Layers size={13} /> },
              {
                value: "products",
                label: `Productos puntuales${Object.keys(draft.products).length ? ` (${Object.keys(draft.products).length})` : ""}`,
                icon: <Package size={13} />,
              },
            ]}
          />
          {tab === "categories" ? (
            <CategoryScopeTree draft={draft} onChange={setDraft} categories={categories} />
          ) : (
            <ProductScopePicker draft={draft} onChange={setDraft} />
          )}
        </section>
      </div>
    </Modal>
  );
}
