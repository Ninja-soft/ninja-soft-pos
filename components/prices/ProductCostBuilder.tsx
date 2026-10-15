"use client";

import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Segmented } from "@/components/ui/Segmented";
import { InfoHint } from "@/components/ui/InfoHint";
import { FeatureGate } from "@/components/saas/FeatureGate";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";
import {
  COST_EXTRA_PRESETS,
  MAX_COST_EXTRAS,
  costBreakdown,
  finalCost,
  priceFromCost,
  usdToArs,
  utility,
  type CostExtra,
  type UtilityMode,
} from "@/lib/prices/costing";
import { useFeature } from "@/modules/saas/gating";
import { FX_SOURCES, type FxQuote, type FxSource } from "@/modules/prices/proApi";
import type { CostingDraft } from "@/modules/prices/costingApi";
import { fieldCls, numOrNull } from "@/components/prices/shared";

// Costo final y utilidad en la ficha del producto (ADR-140).
//   costo de compra (en pesos o en dólares × cotización)
//   + componentes (impuestos internos y percepciones no recuperables, flete, otros; % o $)
//   = costo final
//   utilidad objetivo (markup sobre costo o margen sobre precio) → precio sugerido
//   utilidad actual en $ y % contra el precio de venta (sin IVA).
export function ProductCostBuilder({
  draft,
  onChange,
  arsCost,
  price,
  ivaPct,
  quote,
  onUsePrice,
}: {
  draft: CostingDraft;
  onChange: (d: CostingDraft) => void;
  /** Costo de compra en pesos que figura en el formulario. */
  arsCost: number | null;
  price: number;
  /** IVA que lleva el precio de venta (0 si el negocio no discrimina). */
  ivaPct: number;
  quote: FxQuote | null | undefined;
  onUsePrice: (p: number) => void;
}) {
  const hasUsd = useFeature("precios_usd") !== false;
  const usd = draft.cost_currency === "USD";
  const usdAmount = numOrNull(draft.cost_usd);
  const rate = quote?.rate ?? null;
  const purchase = usd ? usdToArs(usdAmount, rate) : arsCost;
  const final = finalCost(purchase, draft.cost_extras);
  const breakdown = costBreakdown(purchase, draft.cost_extras);
  const target = numOrNull(draft.markup_pct);
  const suggested = priceFromCost(final, draft.markup_mode, target, ivaPct);
  const now = utility(price, final, ivaPct);
  const set = (p: Partial<CostingDraft>) => onChange({ ...draft, ...p });

  function setExtra(i: number, p: Partial<CostExtra>) {
    set({ cost_extras: draft.cost_extras.map((e, k) => (k === i ? { ...e, ...p } : e)) });
  }

  return (
    <div className="space-y-4">
      {/* Moneda del costo */}
      <div className="space-y-3 rounded-xl bg-muted p-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium">Costo de compra</span>
          <FeatureGate feature="precios_usd" featureLabel="Costos en dólares">
            <Segmented
              aria-label="Moneda del costo"
              size="sm"
              value={draft.cost_currency}
              onChange={(v) => set({ cost_currency: hasUsd ? v : "ARS" })}
              options={[
                { value: "ARS", label: "Pesos" },
                { value: "USD", label: "Dólares" },
              ]}
            />
          </FeatureGate>
        </div>
        {usd ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block text-xs font-medium text-muted-foreground">
              Costo en dólares (sin IVA)
              <input
                className={cn(fieldCls, "mt-1")}
                inputMode="decimal"
                value={draft.cost_usd}
                onChange={(e) => set({ cost_usd: e.target.value })}
                placeholder="0"
              />
            </label>
            <label className="block text-xs font-medium text-muted-foreground">
              Cotización
              <select
                className={cn(fieldCls, "mt-1")}
                value={draft.cost_fx_source}
                onChange={(e) => set({ cost_fx_source: e.target.value as FxSource })}
              >
                {FX_SOURCES.filter((s) => s.value !== "manual").map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="text-xs text-muted-foreground">
              <span className="font-medium">En pesos</span>
              <div className="mt-1 font-price text-lg font-bold tabular-nums text-foreground">
                {purchase != null ? formatCurrency(purchase) : "Sin cotización"}
              </div>
              {rate ? `Dólar ${formatCurrency(rate)} del ${quote?.rate_date ? new Date(`${quote.rate_date}T12:00:00`).toLocaleDateString("es-AR") : ""}` : ""}
            </div>
            <p className="text-[11px] text-muted-foreground sm:col-span-3">
              El costo en pesos se recalcula cuando actualizás por dólar (a mano o con la regla automática). Si una compra entra en
              pesos, el costo en dólares la sigue.
            </p>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {arsCost != null ? `${formatCurrency(arsCost)} (el campo Costo de arriba, sin IVA).` : "Cargá el costo arriba, sin IVA."}
          </p>
        )}
      </div>

      {/* Componentes */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-sm font-medium">
            Lo que se suma al costo
            <InfoHint>
              Impuestos y percepciones que pagás al comprar y no recuperás, flete, embalaje. Los % van sobre el costo de compra.
              Negativo = bonificación.
            </InfoHint>
          </span>
          <select
            className={cn(fieldCls, "h-9 w-auto")}
            value=""
            aria-label="Agregar componente"
            disabled={draft.cost_extras.length >= MAX_COST_EXTRAS}
            onChange={(e) => {
              const p = COST_EXTRA_PRESETS.find((x) => x.label === e.target.value);
              if (p) set({ cost_extras: [...draft.cost_extras, { label: p.label, type: p.type, value: 0 }] });
              else if (e.target.value === "custom") set({ cost_extras: [...draft.cost_extras, { label: "", type: "pct", value: 0 }] });
            }}
          >
            <option value="">Agregar</option>
            {COST_EXTRA_PRESETS.map((p) => (
              <option key={p.label} value={p.label}>
                {p.label}
              </option>
            ))}
            <option value="custom">Otro</option>
          </select>
        </div>
        {draft.cost_extras.length === 0 && <p className="text-xs text-muted-foreground">Sin componentes: el costo final es el de compra.</p>}
        {draft.cost_extras.map((e, i) => (
          <div key={i} className="grid grid-cols-[1fr_auto_6rem_auto] items-center gap-2">
            <input
              className={fieldCls}
              value={e.label}
              onChange={(ev) => setExtra(i, { label: ev.target.value })}
              placeholder="Concepto"
              aria-label="Concepto"
            />
            <select
              className={cn(fieldCls, "w-16")}
              value={e.type}
              onChange={(ev) => setExtra(i, { type: ev.target.value as CostExtra["type"] })}
              aria-label="Tipo"
            >
              <option value="pct">%</option>
              <option value="amount">$</option>
            </select>
            <input
              className={cn(fieldCls, "text-right")}
              inputMode="decimal"
              defaultValue={String(e.value).replace(".", ",")}
              onChange={(ev) => setExtra(i, { value: numOrNull(ev.target.value) ?? 0 })}
              aria-label="Valor"
            />
            <button
              type="button"
              aria-label="Quitar"
              onClick={() => set({ cost_extras: draft.cost_extras.filter((_, k) => k !== i) })}
              className="rounded p-1.5 text-muted-foreground transition hover:bg-muted hover:text-destructive"
            >
              <Trash2 size={15} />
            </button>
            {e.type === "pct" && purchase != null && (
              <span className="col-span-4 -mt-1 text-right text-[11px] tabular-nums text-muted-foreground">
                {formatCurrency(breakdown[i]?.amount ?? 0)}
              </span>
            )}
          </div>
        ))}
        <div className="flex items-center justify-between rounded-xl bg-muted px-3.5 py-3">
          <span className="text-sm font-medium">Costo final</span>
          <span className="font-price text-lg font-bold tabular-nums">{final != null ? formatCurrency(final) : "Sin costo"}</span>
        </div>
      </div>

      {/* Utilidad */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-sm font-medium">
            Utilidad objetivo
            <InfoHint>
              Markup: lo que le sumás al costo (costo $100 con 50 % = $150). Margen: qué parte del precio es ganancia (precio $150
              con costo $100 = 33,3 %). Para el mismo precio el markup siempre es mayor que el margen.
            </InfoHint>
          </span>
          <Segmented
            aria-label="Tipo de utilidad"
            size="sm"
            value={draft.markup_mode}
            onChange={(v) => set({ markup_mode: v as UtilityMode })}
            options={[
              { value: "markup", label: "Markup" },
              { value: "margin", label: "Margen" },
            ]}
          />
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <label className="block text-xs font-medium text-muted-foreground">
            {draft.markup_mode === "markup" ? "Markup %" : "Margen %"}
            <input
              className={cn(fieldCls, "mt-1")}
              inputMode="decimal"
              value={draft.markup_pct}
              onChange={(e) => set({ markup_pct: e.target.value })}
              placeholder="Sin objetivo"
            />
          </label>
          <div className="text-xs text-muted-foreground">
            <span className="font-medium">Precio sugerido{ivaPct > 0 ? " (con IVA)" : ""}</span>
            <div className="mt-1 font-price text-lg font-bold tabular-nums text-foreground">
              {suggested != null ? formatCurrency(suggested) : "Sin dato"}
            </div>
          </div>
          <div className="col-span-2 flex items-end sm:col-span-1">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={suggested == null || suggested === price}
              onClick={() => suggested != null && onUsePrice(suggested)}
            >
              <Plus size={14} /> Usar este precio
            </Button>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Metric label="Ganás por unidad" value={now ? formatCurrency(now.amount) : "Sin dato"} tone={now && now.amount < 0 ? "bad" : undefined} />
          <Metric label="Markup" value={now ? `${now.markupPct.toLocaleString("es-AR")} %` : "Sin dato"} tone={now && now.amount < 0 ? "bad" : undefined} />
          <Metric label="Margen" value={now ? `${now.marginPct.toLocaleString("es-AR")} %` : "Sin dato"} tone={now && now.amount < 0 ? "bad" : undefined} />
        </div>
        <p className="text-[11px] text-muted-foreground">
          {ivaPct > 0
            ? `Sobre el precio sin IVA (${ivaPct.toLocaleString("es-AR")} %) contra el costo final.`
            : "Sobre el precio de venta contra el costo final."}
          {now && now.amount < 0 && (
            <Badge tone="danger" className="ml-2">
              Vendés a pérdida
            </Badge>
          )}
        </p>
      </div>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "bad" }) {
  return (
    <div className="rounded-md bg-muted/60 px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={cn("text-sm font-semibold tabular-nums", tone === "bad" && "text-danger")}>{value}</div>
    </div>
  );
}
