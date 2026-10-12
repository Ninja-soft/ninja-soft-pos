"use client";

import { useMemo, useState } from "react";
import { Check, Lock, MapPin, Pencil, Truck, X } from "lucide-react";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { UpgradeModal } from "@/components/saas/UpgradeModal";
import { cn } from "@/lib/utils/cn";
import { formatQty } from "@/lib/utils/format";
import { storeStockLines, type StoreStockLine } from "@/lib/stock/byStore";
import { transferErrorMessage } from "@/lib/stock/transfers";
import { useVariants } from "@/modules/products/hooks";
import { variantLabel } from "@/modules/products/api";
import {
  useCurrentStoreId,
  useMultiStoreStock,
  useStockByStore,
  useStoreStockMutations,
} from "@/modules/stock/hooks";
import { useMyTenant } from "@/modules/tenants/hooks";

interface PanelProduct {
  id: string;
  has_variants: boolean | null;
  stock_min: number | null;
  unit: string;
}

const TONE_CLS: Record<StoreStockLine["tone"], string> = {
  ok: "text-foreground",
  low: "text-warning",
  out: "text-danger",
  negative: "text-danger",
};

// Stock por sucursal en la ficha del producto (F17 · H94). Con una sola
// sucursal no se muestra (la ficha queda igual que siempre).
export function StoreStockPanel({ product }: { product: PanelProduct }) {
  const { multi, enabled, locked, stores } = useMultiStoreStock();
  const currentStoreId = useCurrentStoreId();
  const { data: me } = useMyTenant();
  const hasVariants = Boolean(product.has_variants);
  const { data: variants = [] } = useVariants(
    product.id,
    enabled && hasVariants,
  );
  const [variantId, setVariantId] = useState<string | null>(null);
  const [upgrade, setUpgrade] = useState(false);
  const { data: rows, isLoading } = useStockByStore([product.id], enabled);

  const activeVariant = hasVariants
    ? (variantId ?? variants[0]?.id ?? null)
    : null;
  const lines = useMemo(
    () =>
      storeStockLines(
        stores,
        rows ?? [],
        product.id,
        activeVariant,
        hasVariants ? 0 : product.stock_min,
        currentStoreId,
      ),
    [
      stores,
      rows,
      product.id,
      activeVariant,
      hasVariants,
      product.stock_min,
      currentStoreId,
    ],
  );

  if (!multi) return null;

  if (locked) {
    return (
      <div className="flex items-center gap-3 rounded-lg bg-muted p-3.5 text-xs text-muted-foreground">
        <Lock size={16} className="shrink-0 text-ninja-flameSoft" />
        <span className="flex-1">
          Tenés {stores.length} sucursales. Con <b>Stock por sucursal</b> ves y
          ajustás el stock de cada local.
        </span>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => setUpgrade(true)}
        >
          Ver planes
        </Button>
        <UpgradeModal
          open={upgrade}
          onOpenChange={setUpgrade}
          featureKey="stock_sucursales"
          featureLabel="Stock por sucursal"
        />
      </div>
    );
  }

  const canManage = Boolean(me?.canManage);

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Stock por sucursal
        </h3>
        {hasVariants && variants.length > 0 && (
          <select
            aria-label="Variante"
            value={activeVariant ?? ""}
            onChange={(e) => setVariantId(e.target.value)}
            className="h-9 rounded-lg border border-input bg-background px-3 text-xs text-foreground"
          >
            {variants
              .filter((v) => !v.deleted_at)
              .map((v) => (
                <option
                  key={v.id}
                  value={v.id}
                  className="bg-popover text-popover-foreground"
                >
                  {variantLabel(v)}
                </option>
              ))}
          </select>
        )}
      </div>
      {isLoading ? (
        <SpinnerBlock className="py-4" />
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg bg-muted">
          {lines.map((l) => (
            <StoreLine
              key={l.store.id}
              line={l}
              unit={product.unit}
              canManage={canManage}
              productId={product.id}
              variantId={activeVariant}
            />
          ))}
        </ul>
      )}
      <p className="text-[11px] text-muted-foreground">
        El total del producto es la suma de las sucursales. Lo que está en
        camino se suma al recibirlo.
      </p>
    </section>
  );
}

function StoreLine({
  line,
  unit,
  canManage,
  productId,
  variantId,
}: {
  line: StoreStockLine;
  unit: string;
  canManage: boolean;
  productId: string;
  variantId: string | null;
}) {
  const { toast } = useToast();
  const { saveSettings } = useStoreStockMutations();
  const [editing, setEditing] = useState(false);
  const [min, setMin] = useState("");
  const [max, setMax] = useState("");
  const [location, setLocation] = useState("");

  function startEdit() {
    setMin(line.min ? String(line.min) : "");
    setMax(line.max != null ? String(line.max) : "");
    setLocation(line.location ?? "");
    setEditing(true);
  }

  async function save() {
    const toNum = (v: string) => (v.trim() === "" ? null : Number(v));
    try {
      await saveSettings.mutateAsync({
        storeId: line.store.id,
        productId,
        variantId,
        min: toNum(min),
        max: toNum(max),
        location: location.trim() || null,
      });
      setEditing(false);
      toast({ title: `Guardado para ${line.store.name}`, variant: "success" });
    } catch (e) {
      toast({
        title: "No se pudo guardar",
        description: transferErrorMessage(e),
        variant: "error",
      });
    }
  }

  return (
    <li className={cn("px-3.5 py-3", line.current && "bg-ninja-flame/5")}>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">
              {line.store.name}
            </span>
            {line.current && <Badge tone="brand">Esta sucursal</Badge>}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
            <span>Mín. {formatQty(line.min)}</span>
            {line.max != null && <span>Máx. {formatQty(line.max)}</span>}
            {line.location && (
              <span className="inline-flex items-center gap-1">
                <MapPin size={11} /> {line.location}
              </span>
            )}
            {line.inTransitIn > 0 && (
              <span className="inline-flex items-center gap-1 text-info">
                <Truck size={11} /> llegan {formatQty(line.inTransitIn)}
              </span>
            )}
            {line.inTransitOut > 0 && (
              <span className="inline-flex items-center gap-1">
                <Truck size={11} /> salieron {formatQty(line.inTransitOut)}
              </span>
            )}
          </div>
        </div>
        <span
          className={cn(
            "font-mono text-base font-semibold tabular-nums",
            TONE_CLS[line.tone],
          )}
        >
          {formatQty(line.qty)}{" "}
          <span className="text-xs font-normal text-muted-foreground">
            {unit}
          </span>
        </span>
        {canManage && !editing && (
          <button
            type="button"
            onClick={startEdit}
            title="Mínimo, máximo y ubicación"
            className="rounded-md p-2 text-muted-foreground transition hover:bg-background hover:text-foreground"
          >
            <Pencil size={15} />
          </button>
        )}
      </div>
      {editing && (
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-[1fr_1fr_2fr_auto]">
          <Input
            variant="filled"
            label="Mínimo"
            type="number"
            step="0.001"
            min={0}
            value={min}
            onChange={(e) => setMin(e.target.value)}
          />
          <Input
            variant="filled"
            label="Máximo"
            type="number"
            step="0.001"
            min={0}
            value={max}
            onChange={(e) => setMax(e.target.value)}
          />
          <Input
            variant="filled"
            label="Ubicación"
            placeholder="Góndola 3, depósito"
            maxLength={60}
            value={location}
            onChange={(e) => setLocation(e.target.value)}
          />
          <div className="col-span-2 flex items-end justify-end gap-1 sm:col-span-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setEditing(false)}
              aria-label="Cancelar"
            >
              <X size={15} />
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={save}
              loading={saveSettings.isPending}
              aria-label="Guardar"
            >
              <Check size={15} />
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}
