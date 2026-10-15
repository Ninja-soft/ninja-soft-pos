"use client";

// Alta de un ajuste de stock (ADR-137). Un solo formulario en orden de cómo
// se piensa: qué producto, dónde, qué pasó (motivo), cuánto (sumar, restar o
// fijar) y, si hace falta, nota y foto. Muestra cómo queda el stock y avisa si
// el ajuste va a quedar esperando aprobación. El servidor
// (stock_adjustment_request) vuelve a validar todo.

import { useEffect, useMemo, useRef, useState } from "react";
import { Camera, ShieldCheck, X } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Input } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/Toast";
import { choiceClass } from "@/components/ui/ChoiceCard";
import { ProductThumb } from "@/components/products/ProductThumb";
import { ProductSearchCombobox } from "@/components/products/ProductSearchCombobox";
import { cn } from "@/lib/utils/cn";
import { formatCurrency, formatQty } from "@/lib/utils/format";
import {
  ADJUST_MODES,
  ADJUST_REASONS,
  adjustDraftError,
  adjustmentDelta,
  adjustmentErrorMessage,
  adjustmentValue,
  needsApproval,
  parseQty,
  type AdjustMode,
  type AdjustReason,
} from "@/lib/stock/adjustments";
import type { StockSheetRow } from "@/lib/stock/inventorySheet";
import { variantLabel, type Product, type ProductVariant } from "@/modules/products/api";
import { inventoryApi, useAdjustmentMutations, useAdjustmentPolicy } from "@/modules/stock/adjustments";
import { useStockByStore } from "@/modules/stock/hooks";
import { useWarehouses } from "@/modules/stock/warehouses";
import { DeltaText } from "./shared";

interface Item {
  productId: string;
  variantId: string | null;
  name: string;
  variantLabel: string | null;
  sku: string | null;
  imageUrl: string | null;
  unit: string;
  cost: number | null;
}

const WHOLE = "__store__";

function itemFromRow(r: StockSheetRow): Item {
  return {
    productId: r.product_id,
    variantId: r.variant_id,
    name: r.product_name,
    variantLabel: r.variant_label,
    sku: r.sku,
    imageUrl: r.image_url,
    unit: r.unit,
    cost: r.cost,
  };
}

export function AdjustmentFormModal({
  open,
  onOpenChange,
  stores,
  storeId: initialStoreId,
  row,
  role,
  showCost,
  withWarehouses,
  reasonPreset,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stores: { id: string; name: string }[];
  storeId: string | null;
  /** Fila de la planilla de stock (viene desde "Ajustar"). */
  row: StockSheetRow | null;
  role: string | null;
  showCost: boolean;
  withWarehouses: boolean;
  /** Motivo inicial (p. ej. "conteo" desde la pestaña Conteo). */
  reasonPreset?: AdjustReason | null;
}) {
  const { toast } = useToast();
  const m = useAdjustmentMutations();
  const { data: policy } = useAdjustmentPolicy();
  const [item, setItem] = useState<Item | null>(null);
  const [storeId, setStoreId] = useState<string | null>(initialStoreId);
  const [warehouseId, setWarehouseId] = useState<string>(WHOLE);
  const [reason, setReason] = useState<AdjustReason | null>(null);
  const [mode, setMode] = useState<AdjustMode>("remove");
  const [qty, setQty] = useState("");
  const [notes, setNotes] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Cada vez que se abre, arranca limpio con lo que trae.
  useEffect(() => {
    if (!open) return;
    setItem(row ? itemFromRow(row) : null);
    setStoreId(initialStoreId);
    setWarehouseId(WHOLE);
    const preset = reasonPreset ?? null;
    setReason(preset);
    setMode(preset ? (ADJUST_REASONS.find((r) => r.value === preset)?.defaultMode ?? "remove") : "remove");
    setQty("");
    setNotes("");
    setPhoto(null);
    setError(null);
  }, [open, row, initialStoreId, reasonPreset]);

  useEffect(() => {
    if (!photo) {
      setPhotoPreview(null);
      return;
    }
    const url = URL.createObjectURL(photo);
    setPhotoPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);

  const { data: warehouses = [] } = useWarehouses(withWarehouses && storeId ? storeId : null);
  const { data: byStore, isSuccess: byStoreReady } = useStockByStore(item ? [item.productId] : [], Boolean(item && open));

  // Lo que hay hoy en el lugar elegido (si se sabe).
  const systemQty = useMemo<number | null>(() => {
    if (!item || !storeId) return null;
    const wh = warehouses.find((w) => w.id === warehouseId) ?? null;
    if (row && row.product_id === item.productId && row.variant_id === item.variantId && storeId === initialStoreId) {
      if (!wh) return row.store_qty;
      if (wh.kind === "principal") return row.principal_qty ?? row.store_qty;
      return row.by_warehouse[wh.id] ?? 0;
    }
    if (wh || !byStoreReady) return null;
    const s = (byStore ?? []).find((b) => b.store_id === storeId && b.variant_id === item.variantId);
    return s ? s.qty : 0;
  }, [item, storeId, warehouseId, warehouses, row, initialStoreId, byStore, byStoreReady]);

  const n = parseQty(qty);
  const validQty = qty.trim() !== "" && Number.isFinite(n) && n >= 0;
  const delta = validQty && systemQty != null ? adjustmentDelta(mode, n, systemQty) : validQty && mode !== "set" ? adjustmentDelta(mode, n, 0) : null;
  const value = delta != null ? adjustmentValue(delta, item?.cost) : null;
  const pending =
    policy && delta != null
      ? needsApproval(policy, { role, units: delta, value: value ?? 0 })
      : false;
  const photoRequired = Boolean(policy?.require_photo && pending);

  function pick(p: Product, v: ProductVariant | null) {
    setItem({
      productId: p.id,
      variantId: v?.id ?? null,
      name: p.name,
      variantLabel: v ? variantLabel(v) : null,
      sku: v?.sku ?? p.sku ?? null,
      imageUrl: p.image_url ?? null,
      unit: p.unit ?? "un",
      cost: showCost ? (p.cost ?? null) : null,
    });
  }

  function chooseReason(r: AdjustReason) {
    setReason(r);
    setMode(ADJUST_REASONS.find((x) => x.value === r)?.defaultMode ?? mode);
  }

  async function submit() {
    setError(null);
    if (!item) return setError("Elegí el producto.");
    if (!storeId) return setError("Elegí la sucursal.");
    const problem = adjustDraftError({ mode, qty, reason, notes, hasPhoto: Boolean(photo) }, { photoRequired });
    if (problem) return setError(problem);
    setBusy(true);
    try {
      const photoPath = photo ? await inventoryApi.uploadPhoto(photo) : null;
      const res = await m.request.mutateAsync({
        storeId,
        warehouseId: warehouseId === WHOLE ? null : warehouseId,
        productId: item.productId,
        variantId: item.variantId,
        mode,
        qty: n,
        reason: reason!,
        notes: notes.trim() || null,
        photoPath,
      });
      if (res.status === "pending") {
        toast({
          title: "Ajuste enviado a aprobación",
          description: "El stock cambia cuando lo apruebe el dueño o un auditor.",
          variant: "info",
        });
      } else if (res.status === "unchanged") {
        toast({ title: "No hubo cambios", description: "El sistema ya tenía esa cantidad.", variant: "info" });
      } else {
        toast({
          title: "Stock ajustado",
          description: res.new_qty != null ? `Ahora hay ${formatQty(Number(res.new_qty))} en la sucursal.` : undefined,
          variant: "success",
        });
      }
      onOpenChange(false);
    } catch (e) {
      setError(
        e instanceof Error && e.message === "photo_upload_failed"
          ? "No pudimos subir la foto. Probá con otra imagen (JPG, PNG o WebP de hasta 5 MB)."
          : adjustmentErrorMessage(e),
      );
    } finally {
      setBusy(false);
    }
  }

  const unitLabel = item?.unit && item.unit !== "un" ? item.unit : "unidades";

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Nuevo ajuste de stock"
      description="Corregí el stock con un motivo. Queda registrado quién lo hizo y por qué."
      className="sm:max-w-xl"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancelar
          </Button>
          <Button onClick={submit} loading={busy}>
            {pending ? "Enviar a aprobación" : "Guardar ajuste"}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {/* 1. Producto */}
        <section>
          <p className="mb-2 text-sm font-medium">Producto</p>
          {item ? (
            <div className="flex items-center gap-3 rounded-lg bg-muted/50 p-2.5">
              <ProductThumb src={item.imageUrl} size={44} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">
                  {item.name}
                  {item.variantLabel ? <span className="text-muted-foreground"> · {item.variantLabel}</span> : null}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {item.sku ?? "Sin SKU"}
                  {systemQty != null ? ` · hoy hay ${formatQty(systemQty)}` : ""}
                </p>
              </div>
              {!row && (
                <button
                  type="button"
                  onClick={() => setItem(null)}
                  className="grid h-11 w-11 place-items-center rounded-md text-muted-foreground hover:bg-muted"
                  aria-label="Cambiar producto"
                >
                  <X size={16} />
                </button>
              )}
            </div>
          ) : (
            <ProductSearchCombobox
              onPick={pick}
              enabled={open}
              autoFocus
              filter={(p) => !p.is_kit && p.track_stock !== false}
              rejectMessage={(p) => `${p.name} no controla stock`}
              emptyHint="Los kits y los productos sin control de stock no se ajustan."
            />
          )}
        </section>

        {/* 2. Dónde */}
        {(stores.length > 1 || warehouses.length > 1) && (
          <section className="grid gap-3 sm:grid-cols-2">
            {stores.length > 1 && (
              <Select
                label="Sucursal"
                value={storeId}
                options={stores.map((s) => ({ value: s.id, label: s.name }))}
                onChange={(v) => {
                  setStoreId(v);
                  setWarehouseId(WHOLE);
                }}
              />
            )}
            {warehouses.length > 1 && (
              <Select
                label="Depósito"
                value={warehouseId}
                options={[
                  { value: WHOLE, label: "Toda la sucursal" },
                  ...warehouses.map((w) => ({ value: w.id, label: w.name })),
                ]}
                onChange={setWarehouseId}
              />
            )}
          </section>
        )}

        {/* 3. Qué pasó */}
        <section>
          <p className="mb-2 text-sm font-medium">¿Qué pasó?</p>
          <div role="radiogroup" aria-label="Motivo" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {ADJUST_REASONS.map((r) => (
              <button
                key={r.value}
                type="button"
                role="radio"
                aria-checked={reason === r.value}
                title={r.hint}
                onClick={() => chooseReason(r.value)}
                className={choiceClass(reason === r.value, "min-h-[44px] px-3 py-2 text-left text-sm font-medium")}
              >
                {r.label}
              </button>
            ))}
          </div>
          {reason && (
            <p className="mt-1.5 text-xs text-muted-foreground">
              {ADJUST_REASONS.find((r) => r.value === reason)?.hint}
            </p>
          )}
        </section>

        {/* 4. Cuánto */}
        <section className="space-y-2">
          <Segmented<AdjustMode>
            aria-label="Operación"
            fill
            value={mode}
            onChange={setMode}
            options={ADJUST_MODES.map((x) => ({ value: x.value, label: x.label }))}
          />
          <label className="block text-sm">
            <span className="mb-1 block font-medium">
              {mode === "set" ? `Cantidad que contaste (${unitLabel})` : `Cantidad a ${mode === "add" ? "sumar" : "restar"} (${unitLabel})`}
            </span>
            <Input
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              placeholder={mode === "set" && systemQty != null ? formatQty(systemQty) : "0"}
              className="h-12 text-lg tabular-nums"
            />
          </label>
          {delta != null && (
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {systemQty != null ? (
                <>
                  Queda en <span className="font-semibold text-foreground">{formatQty(systemQty + delta)}</span> (
                  <DeltaText value={delta} />
                  {showCost && value != null && item?.cost != null ? `, ${formatCurrency(value)} al costo` : ""})
                </>
              ) : (
                "El sistema calcula la diferencia con el stock del depósito al guardar."
              )}
            </p>
          )}
        </section>

        {/* 5. Nota y foto */}
        <section className="space-y-3">
          <label className="block text-sm">
            <span className="mb-1 block font-medium">
              Nota {reason === "otro" ? "(obligatoria)" : "(opcional)"}
            </span>
            <Input
              value={notes}
              maxLength={300}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Ej.: se cayó una caja en el depósito"
            />
          </label>
          <div>
            <p className="mb-1 text-sm font-medium">Foto de respaldo {photoRequired ? "(obligatoria)" : "(opcional)"}</p>
            {photoPreview ? (
              <div className="flex items-center gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={photoPreview} alt="Foto elegida" className="h-16 w-16 rounded-md object-cover" />
                <Button variant="ghost" size="sm" onClick={() => setPhoto(null)}>
                  Quitar foto
                </Button>
              </div>
            ) : (
              <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>
                <Camera size={15} /> Sacar o elegir foto
              </Button>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              capture="environment"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                e.target.value = "";
                if (f && f.size > 5 * 1024 * 1024) {
                  setError("La foto pesa más de 5 MB.");
                  return;
                }
                setPhoto(f);
              }}
            />
          </div>
        </section>

        {pending && (
          <Callout tone="warning" icon={ShieldCheck} title="Este ajuste va a aprobación">
            Supera el umbral que fijó el dueño. Queda pendiente y el stock cambia cuando lo apruebe{" "}
            {policy?.approver === "auditor" ? "el dueño o un auditor" : "el dueño"}.
          </Callout>
        )}

        {error && (
          <p role="alert" className={cn("text-sm font-medium text-danger")}>
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
