"use client";

import { useId } from "react";
import { CheckCircle2, ExternalLink, Info, Layers, Package } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Spinner } from "@/components/ui/Spinner";
import { selectCls } from "@/components/stock/transfers/shared";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import { LISTING_TYPE_LABELS } from "@/lib/mercadolibre/labels";
import { MlCauseList } from "@/components/mercadolibre/MlPublishFeedback";
import type { AttrField } from "@/supabase/functions/_shared/mercadolibre/items";
import type { AttrSource, AttrValues, QuickRowState } from "@/supabase/functions/_shared/mercadolibre/quick";

// Fila de la publicación rápida (H141 · ADR-132, rediseño "antibalas"). Una
// grilla con las mismas columnas en todas las filas: Título, Categoría,
// Código de barras, Condición y Publicar como. Cada campo tiene una etiqueta
// de la misma altura (h-5) y un control de la misma altura (h-10), así los
// controles quedan alineados entre columnas y entre filas. Lo que falta
// (motivo sin código, atributos obligatorios) va en una segunda grilla y los
// mensajes debajo, a todo el ancho. En mobile, una columna.

/** Columnas de la fila (también las usa el encabezado, si lo hay). */
export const QUICK_GRID = "grid grid-cols-1 gap-x-3 gap-y-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,0.75fr)_minmax(14.5rem,1.3fr)]";
const CONTROL = "h-10 text-sm";
const INPUT =
  "h-10 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none transition placeholder:text-muted-foreground focus:border-ninja-flameSoft focus:ring-2 focus:ring-ninja-flameSoft/20 disabled:opacity-60";

const SOURCE_LABEL: Record<AttrSource, string> = {
  user: "",
  product: "de la ficha",
  catalog: "del catálogo",
  domain: "sugerido",
  memory: "último uso",
};

export const QUICK_STATE: Record<QuickRowState, { label: string; tone: "neutral" | "warning" | "success" | "danger" | "info" }> = {
  loading: { label: "Preparando", tone: "neutral" },
  needs_input: { label: "Falta completar", tone: "warning" },
  ready: { label: "Lista", tone: "info" },
  validating: { label: "Validando", tone: "neutral" },
  valid: { label: "Validada", tone: "success" },
  publishing: { label: "Publicando", tone: "neutral" },
  published: { label: "Publicada", tone: "success" },
  partial: { label: "Publicada en parte", tone: "warning" },
  error: { label: "Corregir", tone: "danger" },
};

/** Campo con etiqueta de altura fija: todos los controles arrancan a la misma altura. */
export function QuickField({
  label,
  aside,
  htmlFor,
  className,
  children,
}: {
  label: string;
  aside?: React.ReactNode;
  htmlFor?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <div className="mb-1 flex h-5 items-center justify-between gap-2 text-xs">
        <label htmlFor={htmlFor} className="truncate font-medium text-muted-foreground">
          {label}
        </label>
        {aside != null && <span className="shrink-0 truncate text-muted-foreground">{aside}</span>}
      </div>
      {children}
    </div>
  );
}

function AttrField_({ f, value, source, disabled, onChange }: { f: AttrField; value: AttrValues[string] | undefined; source?: AttrSource; disabled?: boolean; onChange: (v: AttrValues[string]) => void }) {
  const id = useId();
  const hint = source && SOURCE_LABEL[source] ? SOURCE_LABEL[source] : undefined;
  if (f.options.length > 0 && f.valueType !== "number_unit") {
    return (
      <QuickField label={f.name} aside={hint} htmlFor={id}>
        <select
          id={id}
          className={cn(selectCls, CONTROL, "px-3")}
          value={value?.value_id ?? ""}
          disabled={disabled}
          onChange={(e) => {
            const opt = f.options.find((o) => o.id === e.target.value);
            onChange(opt ? { value_id: opt.id, value_name: opt.name } : {});
          }}
        >
          <option value="">Elegí</option>
          {f.options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      </QuickField>
    );
  }
  return (
    <QuickField label={f.name} aside={hint} htmlFor={id}>
      <input
        id={id}
        className={INPUT}
        value={value?.value_name ?? ""}
        maxLength={f.maxLength ?? 255}
        disabled={disabled}
        placeholder={f.valueType === "number_unit" && f.defaultUnit ? `10 ${f.defaultUnit}` : undefined}
        onChange={(e) => onChange({ value_name: e.target.value })}
      />
    </QuickField>
  );
}

export interface QuickRowViewProps {
  productId: string;
  name: string;
  picture: string | null;
  meta: string;
  state: QuickRowState;
  catalogName: string | null;
  /** La cuenta no tiene Mercado Envíos: un producto de catálogo sale como publicación propia. */
  ownListingNote: string | null;
  skip: "variants" | "kit" | "failed" | null;
  done: boolean;
  locked: boolean;
  title: string;
  maxTitleLength: number;
  categoryId: string;
  catOptions: Array<{ id: string; name: string }>;
  gtin: string;
  emptyGtinReason: string | null;
  emptyGtinOptions: Array<{ id: string; name: string }>;
  condition: "new" | "used";
  listingPrices: Array<{ id: string; price: number | null; skip: boolean }>;
  types: string[];
  missing: AttrField[];
  attrs: AttrValues;
  sources: Record<string, AttrSource>;
  published: Array<{ ml_item_id: string; permalink: string | null; listing_type_id?: string }>;
  errors: string[];
  warnings: string[];
  notices: string[];
  attrNames: Record<string, string>;
  problems: string[];
  onTitle: (v: string) => void;
  onCategory: (id: string) => void;
  onGtin: (v: string) => void;
  onEmptyGtin: (v: string | null) => void;
  onCondition: (v: "new" | "used") => void;
  onToggleType: (id: string, on: boolean) => void;
  onAttr: (id: string, v: AttrValues[string]) => void;
  onFull: () => void;
}

export function MlQuickRow(p: QuickRowViewProps) {
  const uid = useId();
  const st = QUICK_STATE[p.state];
  const spin = p.state === "loading" || p.state === "validating" || p.state === "publishing";
  const noGtin = !p.gtin.trim();
  const visiblePrices = p.listingPrices;
  const showExtra = !p.skip && !p.done && (noGtin || p.missing.length > 0);

  return (
    <section aria-label={p.name} className="space-y-3 rounded-xl bg-muted/60 p-3 sm:p-4">
      {/* Encabezado: producto, datos y estado. */}
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1.5">
        {p.picture ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={p.picture} alt="" className="h-10 w-10 shrink-0 rounded-md bg-background object-cover" />
        ) : (
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground">
            <Package size={16} aria-hidden />
          </span>
        )}
        <div className="min-w-0 flex-1 basis-[12rem]">
          <p className="truncate text-sm font-medium">{p.name}</p>
          <p className="truncate text-xs text-muted-foreground">{p.meta}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 max-sm:w-full max-sm:pl-[52px] sm:shrink-0 sm:justify-end">
          {p.catalogName && <Badge tone="info">En el catálogo de ML</Badge>}
          <Badge tone={st.tone}>
            {spin && <Spinner size={12} />}
            {st.label}
          </Badge>
        </div>
      </div>

      {p.skip === "variants" ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-background px-3 py-2 text-sm">
          <span className="text-muted-foreground">Tiene variantes: se publica con la pantalla completa (talle, color y precio por variante).</span>
          <Button variant="secondary" size="sm" onClick={p.onFull}>
            <Layers size={15} /> Publicación completa
          </Button>
        </div>
      ) : p.skip === "kit" ? (
        <p className="rounded-lg bg-background px-3 py-2 text-sm text-muted-foreground">Los combos no se publican: publicá cada producto del combo.</p>
      ) : p.skip === "failed" ? null : (
        <>
          {/* Grilla principal: mismas columnas en todas las filas. */}
          <div className={QUICK_GRID}>
            <QuickField label="Título" aside={`${p.title.length}/${p.maxTitleLength}`} htmlFor={`${uid}-t`}>
              <input
                id={`${uid}-t`}
                className={INPUT}
                value={p.title}
                maxLength={p.maxTitleLength}
                disabled={p.done}
                onChange={(e) => p.onTitle(e.target.value)}
              />
            </QuickField>
            <QuickField label="Categoría" htmlFor={`${uid}-c`}>
              <select
                id={`${uid}-c`}
                className={cn(selectCls, CONTROL, "px-3")}
                value={p.categoryId}
                disabled={p.done || p.locked}
                onChange={(e) => p.onCategory(e.target.value)}
              >
                {!p.categoryId && <option value="">Elegí la categoría</option>}
                {p.catOptions.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </QuickField>
            <QuickField label="Código de barras" htmlFor={`${uid}-g`}>
              <input
                id={`${uid}-g`}
                className={INPUT}
                value={p.gtin}
                inputMode="numeric"
                placeholder="Sin código"
                disabled={p.done}
                onChange={(e) => p.onGtin(e.target.value)}
              />
            </QuickField>
            <QuickField label="Condición" htmlFor={`${uid}-n`}>
              <select
                id={`${uid}-n`}
                className={cn(selectCls, CONTROL, "px-3")}
                value={p.condition}
                disabled={p.done}
                onChange={(e) => p.onCondition(e.target.value as "new" | "used")}
              >
                <option value="new">Nuevo</option>
                <option value="used">Usado</option>
              </select>
            </QuickField>
            <fieldset className="min-w-0" disabled={p.done}>
              <legend className="mb-1 flex h-5 items-center text-xs font-medium text-muted-foreground">Publicar como</legend>
              {visiblePrices.length === 0 ? (
                <p className="flex h-10 items-center text-xs text-muted-foreground">Preparando precios…</p>
              ) : (
                <div className="space-y-1">
                  {visiblePrices.map((l) => {
                    const on = p.types.includes(l.id);
                    const noPrice = !(typeof l.price === "number" && l.price > 0);
                    return (
                      <label
                        key={l.id}
                        className={cn(
                          "flex h-10 items-center justify-between gap-2 rounded-lg bg-background px-3 text-sm",
                          noPrice ? "opacity-60" : "cursor-pointer",
                        )}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <Checkbox checked={on} disabled={noPrice || p.done} onCheckedChange={(v) => p.onToggleType(l.id, v)} aria-label={LISTING_TYPE_LABELS[l.id] ?? l.id} />
                          <span className="truncate">{LISTING_TYPE_LABELS[l.id] ?? l.id}</span>
                        </span>
                        <span className="shrink-0 tabular-nums text-muted-foreground">
                          {noPrice ? (l.skip ? "No se publica" : "Sin precio") : formatCurrency(Number(l.price))}
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
            </fieldset>
          </div>

          {/* Lo que falta: misma altura de etiqueta y control. */}
          {showExtra && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {noGtin && (
                <QuickField label="Sin código porque" htmlFor={`${uid}-r`}>
                  <select
                    id={`${uid}-r`}
                    className={cn(selectCls, CONTROL, "px-3")}
                    value={p.emptyGtinReason ?? ""}
                    onChange={(e) => p.onEmptyGtin(e.target.value || null)}
                  >
                    <option value="">Elegí el motivo</option>
                    {p.emptyGtinOptions.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                </QuickField>
              )}
              {p.missing.map((f) => (
                <AttrField_ key={f.id} f={f} value={p.attrs[f.id]} source={p.sources[f.id]} onChange={(v) => p.onAttr(f.id, v)} />
              ))}
            </div>
          )}
        </>
      )}

      {/* Mensajes: a todo el ancho, debajo de los campos. */}
      {p.ownListingNote && !p.done && (
        <p className="flex gap-1.5 text-xs text-muted-foreground">
          <Info size={13} className="mt-0.5 shrink-0 text-info" aria-hidden />
          {p.ownListingNote}
        </p>
      )}
      {p.published.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <CheckCircle2 size={15} className="text-success" aria-hidden />
          {p.published.map((x) => (
            <span key={x.ml_item_id} className="inline-flex items-center gap-1">
              {LISTING_TYPE_LABELS[x.listing_type_id ?? ""] ?? ""} {x.ml_item_id}
              {x.permalink && (
                <a href={x.permalink} target="_blank" rel="noreferrer" className="text-muted-foreground hover:underline" aria-label={`Ver ${x.ml_item_id} en Mercado Libre`}>
                  <ExternalLink size={13} />
                </a>
              )}
            </span>
          ))}
        </div>
      )}
      {p.notices.length > 0 && <MlCauseList items={p.notices} tone="info" compact max={4} />}
      {p.errors.length > 0 && <MlCauseList items={p.errors} names={p.attrNames} compact max={6} />}
      {p.errors.length === 0 && p.warnings.length > 0 && <MlCauseList items={p.warnings} names={p.attrNames} tone="warning" compact max={4} />}
      {p.errors.length === 0 && p.problems.length > 0 && p.state === "needs_input" && (
        <p className="text-xs text-warning">{p.problems.join(" ")}</p>
      )}
    </section>
  );
}
