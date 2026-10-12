"use client";

import { useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Segmented";
import { useToast } from "@/components/ui/Toast";
import { formatQty } from "@/lib/utils/format";
import { transferErrorMessage } from "@/lib/stock/transfers";
import {
  ADJUST_REASONS,
  ADJUST_REASON_LABELS,
} from "@/modules/products/schemas";
import { variantLabel, type Product } from "@/modules/products/api";
import { useVariants } from "@/modules/products/hooks";
import {
  useCurrentStoreId,
  useStockByStore,
  useStoreStockMutations,
} from "@/modules/stock/hooks";
import type { StoreRef } from "@/lib/stock/byStore";

type Mode = "delta" | "set";

const selectCls =
  "h-11 w-full rounded-lg border border-input bg-background px-4 text-sm text-foreground outline-none transition focus:border-ninja-flameSoft focus:ring-4 focus:ring-ninja-flameSoft/15";

// Ajuste o conteo de stock en UNA sucursal (F17 · H94). Lo usa el modal de
// ajuste cuando el negocio tiene varias sucursales y stock por sucursal.
export function StoreStockAdjustForm({
  product,
  stores,
  onDone,
  onCancel,
}: {
  product: Product;
  stores: StoreRef[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const { toast } = useToast();
  const { adjust } = useStoreStockMutations();
  const currentStoreId = useCurrentStoreId();
  const hasVariants = Boolean(product.has_variants);
  const { data: variants = [] } = useVariants(product.id, hasVariants);
  const { data: rows } = useStockByStore([product.id]);

  const [storeId, setStoreId] = useState<string>("");
  const [variantId, setVariantId] = useState<string>("");
  const [mode, setMode] = useState<Mode>("delta");
  const [qty, setQty] = useState("");
  // Motivos del ajuste; los de traslado van por la pantalla de Traslados.
  const reasons = ADJUST_REASONS.filter((r) => r !== "transfer");
  const [reason, setReason] = useState<(typeof reasons)[number]>("purchase");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    setStoreId(currentStoreId ?? stores[0]?.id ?? "");
  }, [currentStoreId, stores]);
  useEffect(() => {
    if (hasVariants && !variantId && variants[0]) setVariantId(variants[0].id);
  }, [hasVariants, variantId, variants]);

  const current = useMemo(() => {
    const r = (rows ?? []).find(
      (x) =>
        x.store_id === storeId &&
        (x.variant_id ?? "") === (hasVariants ? variantId : ""),
    );
    return Number(r?.qty ?? 0);
  }, [rows, storeId, variantId, hasVariants]);

  const n = Number(qty);
  const valid =
    qty.trim() !== "" &&
    Number.isFinite(n) &&
    (mode === "set" ? n >= 0 : n !== 0);
  const preview = mode === "set" ? n : current + n;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || !storeId) return;
    try {
      const next = await adjust.mutateAsync({
        storeId,
        productId: product.id,
        variantId: hasVariants ? variantId || null : null,
        qty: n,
        mode,
        reason,
        notes: notes.trim() || null,
      });
      const store = stores.find((s) => s.id === storeId)?.name ?? "la sucursal";
      toast({
        title: mode === "set" ? "Conteo registrado" : "Stock ajustado",
        description: `${store}: ${formatQty(next)}`,
        variant: "success",
      });
      onDone();
    } catch (err) {
      toast({
        title: "No se pudo ajustar",
        description: transferErrorMessage(err),
        variant: "error",
      });
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-2 block text-sm font-medium text-muted-foreground">
            Sucursal
          </label>
          <select
            className={selectCls}
            value={storeId}
            onChange={(e) => setStoreId(e.target.value)}
          >
            {stores.map((s) => (
              <option
                key={s.id}
                value={s.id}
                className="bg-popover text-popover-foreground"
              >
                {s.name}
              </option>
            ))}
          </select>
        </div>
        {hasVariants && (
          <div>
            <label className="mb-2 block text-sm font-medium text-muted-foreground">
              Variante
            </label>
            <select
              className={selectCls}
              value={variantId}
              onChange={(e) => setVariantId(e.target.value)}
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
          </div>
        )}
      </div>

      <Segmented<Mode>
        aria-label="Tipo de ajuste"
        value={mode}
        onChange={setMode}
        fill
        size="sm"
        options={[
          { value: "delta", label: "Ingreso o egreso" },
          { value: "set", label: "Conteo (dejar en)" },
        ]}
      />

      <Input
        label={
          mode === "set"
            ? "Cantidad contada"
            : "Cantidad (+ ingreso / − egreso)"
        }
        type="number"
        step="0.001"
        value={qty}
        onChange={(e) => setQty(e.target.value)}
        hint={`Hoy en esta sucursal: ${formatQty(current)}${valid ? ` · queda en ${formatQty(preview)}` : ""}`}
      />

      {mode === "delta" && (
        <div>
          <label className="mb-2 block text-sm font-medium text-muted-foreground">
            Motivo
          </label>
          <select
            className={selectCls}
            value={reason}
            onChange={(e) => setReason(e.target.value as typeof reason)}
          >
            {reasons.map((r) => (
              <option
                key={r}
                value={r}
                className="bg-popover text-popover-foreground"
              >
                {ADJUST_REASON_LABELS[r]}
              </option>
            ))}
          </select>
        </div>
      )}
      <Input
        label="Notas (opcional)"
        maxLength={200}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />
      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancelar
        </Button>
        <Button
          type="submit"
          loading={adjust.isPending}
          disabled={!valid || !storeId}
        >
          {mode === "set" ? "Registrar conteo" : "Ajustar"}
        </Button>
      </div>
    </form>
  );
}
