"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { selectCls } from "@/components/stock/transfers/shared";
import { formatCurrency } from "@/lib/utils/format";
import { LISTING_TYPE_LABELS, mlErrorMessage } from "@/lib/mercadolibre/labels";
import type { ListingOverride, OverrideMode } from "@/lib/mercadolibre/pricing";
import { usePriceLists } from "@/modules/prices/hooks";
import { useMlMutations, useMlProductOverrides, type MlChannelPreview } from "@/modules/mercadolibre/hooks";

// Precio de este producto por tipo de publicación (H141 · ADR-132): hereda la
// regla de la cuenta o la cambia (recargo, lista, fijo o no publicar en ese
// tipo). El precio que se ve es el que calcula el servidor.

const MODES: Array<{ value: OverrideMode; label: string }> = [
  { value: "inherit", label: "Como la cuenta" },
  { value: "markup", label: "Recargo propio" },
  { value: "price_list", label: "Lista propia" },
  { value: "fixed", label: "Precio fijo" },
  { value: "skip", label: "No publicar en este tipo" },
];

type Draft = { listing_type_id: string; mode: OverrideMode; markup_pct: string; price_list_id: string; fixed_price: string; min_price: string };

export function MlProductListingPrices({ accountId, productId, preview, canManage }: { accountId: string; productId: string; preview: MlChannelPreview; canManage: boolean }) {
  const { toast } = useToast();
  const { data: overrides } = useMlProductOverrides(accountId, productId);
  const { data: lists = [] } = usePriceLists();
  const { saveProductListing } = useMlMutations();
  const [rows, setRows] = useState<Draft[]>([]);

  useEffect(() => {
    if (!overrides) return;
    setRows(
      (preview.listing_prices ?? []).map((l) => {
        const o = overrides.find((x) => x.listing_type_id === l.listing_type_id);
        return {
          listing_type_id: l.listing_type_id,
          mode: o?.mode ?? "inherit",
          markup_pct: o?.markup_pct != null ? String(o.markup_pct) : "",
          price_list_id: o?.price_list_id ?? "",
          fixed_price: o?.fixed_price != null ? String(o.fixed_price) : "",
          min_price: o?.min_price != null ? String(o.min_price) : "",
        };
      }),
    );
  }, [overrides, preview.listing_prices]);

  const set = (i: number, p: Partial<Draft>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const invalid = rows.some(
    (r) => (r.mode === "fixed" && !(Number(r.fixed_price) > 0)) || (r.mode === "price_list" && !r.price_list_id) || (r.mode === "markup" && !Number.isFinite(Number(r.markup_pct || 0))),
  );

  const save = () => {
    const payload: ListingOverride[] = rows
      .filter((r) => r.mode !== "inherit" || r.min_price.trim() !== "")
      .map((r) => ({
        listing_type_id: r.listing_type_id,
        mode: r.mode,
        markup_pct: r.markup_pct.trim() === "" ? null : Number(r.markup_pct),
        price_list_id: r.price_list_id || null,
        fixed_price: r.fixed_price.trim() === "" ? null : Number(r.fixed_price),
        min_price: r.min_price.trim() === "" ? null : Number(r.min_price),
      }));
    saveProductListing.mutate(
      { accountId, productId, overrides: payload },
      {
        onSuccess: () => toast({ title: "Precios por tipo guardados", variant: "success" }),
        onError: (e) => toast({ title: "No se pudo guardar", description: mlErrorMessage(e), variant: "error" }),
      },
    );
  };

  if (rows.length === 0) return null;

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">Precio por tipo de publicación</p>
      {rows.map((r, i) => {
        const server = preview.listing_prices.find((l) => l.listing_type_id === r.listing_type_id);
        return (
          <div key={r.listing_type_id} className="space-y-2 rounded-lg bg-muted px-3 py-2">
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="font-medium">{LISTING_TYPE_LABELS[r.listing_type_id] ?? r.listing_type_id}</span>
              <span className="tabular-nums text-muted-foreground">
                {server?.price != null ? formatCurrency(Number(server.price)) : server?.override?.mode === "skip" ? "No se publica" : "Sin precio"}
              </span>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <select className={selectCls} value={r.mode} disabled={!canManage} aria-label="Cómo se calcula" onChange={(e) => set(i, { mode: e.target.value as OverrideMode })}>
                {MODES.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
              {r.mode === "markup" && (
                <Input aria-label="Recargo %" placeholder="Recargo %" type="number" inputMode="decimal" value={r.markup_pct} disabled={!canManage} onChange={(e) => set(i, { markup_pct: e.target.value })} />
              )}
              {r.mode === "price_list" && (
                <select className={selectCls} value={r.price_list_id} disabled={!canManage} aria-label="Lista" onChange={(e) => set(i, { price_list_id: e.target.value })}>
                  <option value="">Elegí la lista</option>
                  {lists.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              )}
              {r.mode === "fixed" && (
                <Input aria-label="Precio fijo" placeholder="Precio" type="number" inputMode="decimal" value={r.fixed_price} disabled={!canManage} onChange={(e) => set(i, { fixed_price: e.target.value })} />
              )}
              {r.mode !== "skip" && (
                <Input aria-label="Precio mínimo" placeholder="Mínimo (opcional)" type="number" inputMode="decimal" value={r.min_price} disabled={!canManage} onChange={(e) => set(i, { min_price: e.target.value })} />
              )}
            </div>
          </div>
        );
      })}
      {canManage && (
        <div className="flex justify-end">
          <Button size="sm" variant="secondary" onClick={save} disabled={invalid} loading={saveProductListing.isPending}>
            Guardar precios
          </Button>
        </div>
      )}
    </div>
  );
}
