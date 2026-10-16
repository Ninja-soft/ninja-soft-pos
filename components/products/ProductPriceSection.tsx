"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { UseFormRegisterReturn } from "react-hook-form";
import { Input } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { FeatureGate } from "@/components/saas/FeatureGate";
import { useFeature } from "@/modules/saas/gating";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import { priceFromCost, utility } from "@/lib/prices/costing";
import { openPriceSettingsError, type PriceMode } from "@/lib/prices/openPrice";
import { describeListRule } from "@/lib/prices/listExplain";
import { resolveUnitPrice, type PricingWorld } from "@/lib/prices/resolve";
import { priceProApi, type ProList } from "@/modules/prices/proApi";
import { useProductPricesOverview } from "@/modules/prices/proHooks";

// Sección Precio de la ficha (ADR-151). Primero y bien grande el precio de
// venta (u honorarios), con el foco al entrar a la pestaña; abajo, como datos
// secundarios, costo y margen con la cuenta en vivo. Si el precio se define al
// cobrar, el de arriba queda como sugerido y se cargan mínimo y máximo.

function pct(n: number): string {
  return `${n.toLocaleString("es-AR", { maximumFractionDigits: 1 })} %`;
}

function numOrNull(v: string | number | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

export interface ProductPriceSectionProps {
  /** La pestaña Precios está a la vista: enfoca y selecciona el precio. */
  active: boolean;
  isService: boolean;
  /** IVA que lleva el precio de venta (0 si el negocio no discrimina). */
  ivaPct: number;
  price: number;
  /** Costo final (costo de compra + componentes). null = sin costo. */
  finalCost: number | null;
  priceRegister: UseFormRegisterReturn;
  costRegister: UseFormRegisterReturn;
  priceError?: string;
  costError?: string;
  costReadOnly?: boolean;
  onPriceChange: (p: number) => void;
  priceMode: PriceMode;
  onPriceModeChange: (m: PriceMode) => void;
  openMinRegister: UseFormRegisterReturn;
  openMaxRegister: UseFormRegisterReturn;
  openMin: string | number | null | undefined;
  openMax: string | number | null | undefined;
  openMaxError?: string;
}

export function ProductPriceSection({
  active,
  isService,
  ivaPct,
  price,
  finalCost,
  priceRegister,
  costRegister,
  priceError,
  costError,
  costReadOnly,
  onPriceChange,
  priceMode,
  onPriceModeChange,
  openMinRegister,
  openMaxRegister,
  openMin,
  openMax,
  openMaxError,
}: ProductPriceSectionProps) {
  const priceRef = useRef<HTMLInputElement | null>(null);
  const [marginDraft, setMarginDraft] = useState<string | null>(null);
  const openOn = useFeature("precio_libre") !== false;
  const open = priceMode === "open";

  useEffect(() => {
    if (!active) return;
    const el = priceRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [active]);

  const now = utility(price, finalCost, ivaPct);
  const loses = now != null && now.amount < 0;
  const marginValue =
    marginDraft ?? (now != null ? String(Math.round(now.marginPct * 10) / 10).replace(".", ",") : "");
  const draftMargin = marginDraft != null ? numOrNull(marginDraft) : null;
  const settingsError = open ? openPriceSettingsError(numOrNull(openMin), numOrNull(openMax)) : null;

  function onMargin(v: string) {
    setMarginDraft(v);
    const m = numOrNull(v);
    if (finalCost == null || finalCost <= 0 || m == null || m >= 100) return;
    const p = priceFromCost(finalCost, "margin", m, ivaPct);
    if (p != null) onPriceChange(p);
  }

  const priceLabel = isService
    ? open
      ? "Honorarios sugeridos"
      : "Honorarios"
    : open
      ? "Precio sugerido"
      : "Precio de venta";

  return (
    <div className="space-y-4">
      {/* Precio de venta: lo primero que se ve y donde queda el foco. */}
      <div className="rounded-xl bg-muted p-4">
        <label htmlFor="product-price" className="block text-sm font-semibold text-foreground">
          {priceLabel}
        </label>
        <div className="mt-2 flex items-center gap-2">
          <span className="font-price text-2xl font-bold text-muted-foreground" aria-hidden>
            $
          </span>
          <input
            id="product-price"
            type="number"
            step="0.01"
            inputMode="decimal"
            aria-invalid={priceError ? true : undefined}
            className={cn(
              "h-14 w-full min-w-0 rounded-lg border border-input bg-background px-3 font-price text-3xl font-bold tabular-nums text-foreground outline-none transition focus:border-ninja-flameSoft focus:ring-2 focus:ring-ninja-flameSoft/20",
              priceError && "border-destructive",
            )}
            {...priceRegister}
            ref={(el) => {
              priceRegister.ref(el);
              priceRef.current = el;
            }}
            onChange={(e) => {
              setMarginDraft(null);
              void priceRegister.onChange(e);
            }}
          />
        </div>
        {priceError && <p className="mt-2 text-sm text-destructive">{priceError}</p>}
        <p className="mt-2 text-xs text-muted-foreground">
          {open
            ? "Se usa como sugerido al cobrar."
            : ivaPct > 0
              ? `Precio final con IVA (${ivaPct.toLocaleString("es-AR")} %): es lo que paga el cliente.`
              : "Es lo que paga el cliente."}
        </p>
        <p
          data-testid="price-summary"
          className={cn("mt-1 text-sm font-medium tabular-nums", loses ? "text-danger" : "text-foreground")}
        >
          {now == null
            ? "Cargá el costo para ver cuánto ganás."
            : loses
              ? `Perdés ${formatCurrency(-now.amount)} por unidad · margen ${pct(now.marginPct)} · markup ${pct(now.markupPct)}`
              : `Ganás ${formatCurrency(now.amount)} por unidad · margen ${pct(now.marginPct)} · markup ${pct(now.markupPct)}`}
        </p>
      </div>

      {/* Modo de precio: fijo o a definir al cobrar. */}
      <div className="space-y-3">
        <FeatureGate feature="precio_libre" featureLabel="Precio a definir al cobrar">
          <Segmented
            aria-label="Modo de precio"
            size="sm"
            value={priceMode}
            onChange={(v) => openOn && onPriceModeChange(v)}
            options={[
              { value: "fixed", label: "Precio fijo" },
              { value: "open", label: "A definir al cobrar" },
            ]}
          />
        </FeatureGate>
        {open && (
          <div className="space-y-3 rounded-xl bg-muted p-3.5">
            <p className="text-xs text-muted-foreground">
              El POS te pide el precio cada vez que lo agregás. El precio de arriba queda como sugerido. Mínimo y máximo son
              opcionales: el servidor no acepta un precio fuera de esos límites.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <Input
                variant="filled"
                label="Mínimo"
                type="number"
                step="0.01"
                inputMode="decimal"
                placeholder="Sin mínimo"
                {...openMinRegister}
              />
              <Input
                variant="filled"
                label="Máximo"
                type="number"
                step="0.01"
                inputMode="decimal"
                placeholder="Sin máximo"
                error={openMaxError ?? settingsError ?? undefined}
                {...openMaxRegister}
              />
            </div>
          </div>
        )}
      </div>

      {/* Costo y margen: secundarios, con la explicación corta. */}
      <div className="space-y-2">
        <div className="grid grid-cols-2 gap-3">
          <Input
            variant="filled"
            label="Costo (sin IVA)"
            type="number"
            step="0.01"
            inputMode="decimal"
            placeholder="0"
            error={costError}
            readOnly={costReadOnly}
            hint={costReadOnly ? "Sale del costo en dólares" : undefined}
            {...costRegister}
            onChange={(e) => {
              setMarginDraft(null);
              void costRegister.onChange(e);
            }}
          />
          <Input
            variant="filled"
            label="Margen %"
            inputMode="decimal"
            placeholder={finalCost && finalCost > 0 ? "0" : "Cargá el costo"}
            disabled={!finalCost || finalCost <= 0}
            value={marginValue}
            onChange={(e) => onMargin(e.target.value)}
            onBlur={() => setMarginDraft(null)}
            error={draftMargin != null && draftMargin >= 100 ? "El margen tiene que ser menor a 100 %" : undefined}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Costo sin IVA. El margen es la parte del precio que te queda; el markup, cuánto le sumás al costo
          {now != null ? ` (acá, ${pct(now.markupPct)})` : ""}. Se calculan sobre el precio sin IVA y el costo final.
        </p>
      </div>
    </div>
  );
}

// ── Precio en cada lista ─────────────────────────────────────────────────────

/**
 * Cómo queda el precio en cada lista activa, con el mismo resolver que el POS
 * (`resolveUnitPrice`) sobre la foto de precios del negocio, los precios fijos
 * de este producto y el precio que se está tipeando.
 */
export function ProductListPrices({
  productId,
  price,
  lists,
  priceMode,
  costs,
}: {
  productId: string | null;
  price: number;
  lists: ProList[];
  priceMode: PriceMode;
  costs?: { cost: number | null; final_cost: number | null } | null;
}) {
  const active = useMemo(() => lists.filter((l) => l.is_active !== false && !l.deleted_at), [lists]);
  const snap = useQuery({
    queryKey: ["price-pro", "snapshot", null, null],
    queryFn: () => priceProApi.snapshot(null, null),
    enabled: active.length > 0 && priceMode !== "open",
    staleTime: 60_000,
  });
  const overview = useProductPricesOverview(priceMode !== "open" && active.length > 0 ? productId : null);

  const rows = useMemo(() => {
    const items = new Map<string, number>();
    for (const l of overview.data?.lists ?? []) if (l.item_price != null) items.set(l.list_id, Number(l.item_price));
    const base = snap.data;
    const pid = productId ?? "__nuevo__";
    const world: PricingWorld | null = base
      ? {
          ...base,
          assigned: [],
          items: [
            ...base.items.filter((i) => i.product_id !== pid),
            ...[...items.entries()].map(([lid, p]) => ({ price_list_id: lid, product_id: pid, variant_id: null, price: p })),
          ],
          costs: costs ? { ...base.costs, [pid]: { ...(base.costs[pid] ?? {}), ...costs } } : base.costs,
        }
      : null;
    const pro = base?.pro ?? false;
    return active.map((l) => {
      let value: number | null = null;
      if (world) value = resolveUnitPrice(world, { productId: pid, basePrice: price, listId: l.id, termId: "none" }).price;
      return { id: l.id, name: l.name, rule: describeListRule(l, lists, { hasItem: items.has(l.id), pro }), value };
    });
  }, [active, lists, snap.data, overview.data, productId, price, costs]);

  if (priceMode === "open") {
    return (
      <p className="rounded-xl bg-muted p-3.5 text-xs text-muted-foreground">
        Precio libre: se define al cobrar. Las listas no cambian lo que se cobra.
      </p>
    );
  }
  if (active.length === 0) {
    return (
      <p className="rounded-xl bg-muted p-3.5 text-xs text-muted-foreground">
        No tenés listas de precios activas. Las armás en Configuración, en Listas de precios.
      </p>
    );
  }
  return (
    <div className="divide-y divide-border rounded-lg bg-muted">
      {rows.map((r) => (
        <div key={r.id} className="flex items-center justify-between gap-3 px-3.5 py-3 text-sm">
          <span className="min-w-0">
            <span className="block truncate font-medium text-foreground">{r.name}</span>
            <span className="block text-xs text-muted-foreground">{r.rule}</span>
          </span>
          <span className="shrink-0 font-semibold tabular-nums text-foreground">
            {r.value != null ? formatCurrency(r.value) : snap.isLoading ? "…" : "Sin dato"}
          </span>
        </div>
      ))}
    </div>
  );
}
