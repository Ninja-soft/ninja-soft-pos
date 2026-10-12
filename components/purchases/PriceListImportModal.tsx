"use client";

// Importar la lista de precios del proveedor (F18 · ADR-059): subir el XLSX,
// mapear columnas (se recuerda el mapeo por proveedor), ver la vista previa
// con la diferencia contra el costo de lista actual y aplicar. Opcionalmente
// pasa el costo al costo de reposición del producto y vincula productos que el
// proveedor todavía no tenía.

import { useEffect, useMemo, useState } from "react";
import { FileUp } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { readXlsxGrid } from "@/lib/utils/xlsxImport";
import { purchaseErrorMessage } from "@/lib/purchases/orders";
import { CURRENCIES } from "@/lib/purchases/suppliers";
import {
  PRICE_LIST_FIELDS,
  PRICE_LIST_FIELD_LABEL,
  guessMapping,
  previewPriceList,
  previewSummary,
  rowsFromGrid,
  rowsToApply,
  type PreviewStatus,
  type PriceListMapping,
} from "@/lib/purchases/priceList";
import {
  useCatalogLookup,
  usePurchaseV2Mutations,
  useSupplierMapping,
  useSupplierProducts,
} from "@/modules/purchases/hooks";
import type { Supplier } from "@/modules/purchases/api";
import { ErrorList, FormField, SectionTitle, formatMoney, inputCls, parseNum, selectCls } from "./shared";

const STATUS: Record<PreviewStatus, { label: string; tone: "brand" | "neutral" | "success" | "warning" | "danger" }> = {
  update: { label: "Actualiza", tone: "brand" },
  same: { label: "Sin cambios", tone: "neutral" },
  link: { label: "Producto nuevo del proveedor", tone: "success" },
  unmatched: { label: "Sin producto", tone: "warning" },
  invalid: { label: "Con error", tone: "danger" },
};

export function PriceListImportModal({
  open,
  onOpenChange,
  supplier,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  supplier: Supplier;
}) {
  const { toast } = useToast();
  const m = usePurchaseV2Mutations();
  const { data: supplierProducts = [] } = useSupplierProducts({ supplierId: supplier.id }, open);
  const { data: catalog = [] } = useCatalogLookup(open);
  const { data: savedMapping } = useSupplierMapping(open ? supplier.id : null);

  const [fileName, setFileName] = useState("");
  const [grid, setGrid] = useState<string[][]>([]);
  const [fatal, setFatal] = useState<string | null>(null);
  const [mapping, setMapping] = useState<PriceListMapping>({});
  const [currency, setCurrency] = useState(supplier.currency || "ARS");
  const [fx, setFx] = useState("1");
  const [discount, setDiscount] = useState("");
  const [updateReplacement, setUpdateReplacement] = useState(true);
  const [linkNew, setLinkNew] = useState(false);
  const [filter, setFilter] = useState<PreviewStatus | "all">("all");

  useEffect(() => {
    if (!open) return;
    setFileName("");
    setGrid([]);
    setFatal(null);
    setMapping({});
    setCurrency(supplier.currency || "ARS");
    setFx("1");
    setDiscount("");
    setUpdateReplacement(true);
    setLinkNew(false);
    setFilter("all");
  }, [open, supplier.currency]);

  async function onFile(f: File | null) {
    if (!f) return;
    setFileName(f.name);
    const res = await readXlsxGrid(await f.arrayBuffer());
    setFatal(res.fatalError);
    setGrid(res.grid);
    const headers = res.grid[0] ?? [];
    const saved = savedMapping && Object.values(savedMapping).every((i) => i == null || i < headers.length);
    setMapping(saved ? savedMapping! : guessMapping(headers));
  }

  const headers = grid[0] ?? [];
  const rows = useMemo(() => (grid.length > 1 ? rowsFromGrid(grid, mapping) : []), [grid, mapping]);
  const preview = useMemo(
    () =>
      previewPriceList(
        rows,
        supplierProducts.map((sp) => ({
          id: sp.id,
          product_id: sp.product_id,
          variant_id: sp.variant_id,
          supplier_sku: sp.supplier_sku,
          list_cost: sp.list_cost,
          currency: sp.currency,
          units_per_purchase: sp.units_per_purchase,
          product_name: sp.product_name,
        })),
        catalog,
        { currency, discountPct: parseNum(discount) },
      ),
    [rows, supplierProducts, catalog, currency, discount],
  );
  const summary = previewSummary(preview);
  const toApply = rowsToApply(preview, linkNew);
  const foreign = currency !== "ARS";
  const shown = filter === "all" ? preview : preview.filter((r) => r.status === filter);

  const errors = [
    ...(mapping.cost == null ? ["Elegí la columna del costo."] : []),
    ...(mapping.supplier_sku == null && mapping.sku == null && mapping.barcode == null
      ? ["Elegí al menos una columna de código (del proveedor, SKU o código de barras)."]
      : []),
    ...(foreign && !(parseNum(fx) > 0) ? ["Cargá el tipo de cambio para pasar a pesos."] : []),
    ...(grid.length > 1 && toApply.length === 0 ? ["No hay costos para actualizar."] : []),
  ];

  async function apply() {
    if (errors.length > 0) return;
    try {
      await m.applyPriceList.mutateAsync({
        supplierId: supplier.id,
        rows: toApply,
        options: {
          file_name: fileName || null,
          currency,
          fx_rate: foreign ? parseNum(fx) : 1,
          update_replacement: updateReplacement,
          link_new: linkNew,
          mapping,
        },
      });
      toast({
        title: "Lista importada",
        description: `${summary.update} costos actualizados${linkNew && summary.link ? ` y ${summary.link} productos vinculados` : ""}.`,
        variant: "success",
      });
      onOpenChange(false);
    } catch (e) {
      toast({ title: "No se pudo importar", description: purchaseErrorMessage(e), variant: "error" });
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`Lista de precios de ${supplier.name}`}
      description="Subí el XLSX del proveedor, elegí qué columna es cada dato y revisá los cambios antes de aplicar."
      className="sm:max-w-4xl"
      footer={
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-sm text-muted-foreground">
            {grid.length > 1 ? `${toApply.length} filas para aplicar` : "Elegí un archivo"}
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button
              onClick={() => void apply()}
              loading={m.applyPriceList.isPending}
              disabled={grid.length <= 1 || errors.length > 0}
            >
              Aplicar lista
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-6">
        <label className="flex cursor-pointer items-center gap-3 rounded-md border border-dashed border-border px-4 py-4 text-sm hover:bg-muted/40">
          <FileUp size={18} className="text-muted-foreground" />
          <span className="flex-1">{fileName || "Elegí el archivo .xlsx de la lista"}</span>
          <input
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="sr-only"
            onChange={(e) => void onFile(e.target.files?.[0] ?? null)}
          />
        </label>
        {fatal && <p className="text-sm text-danger">{fatal}</p>}

        {headers.length > 0 && (
          <>
            <section className="space-y-2">
              <SectionTitle>Columnas</SectionTitle>
              <div className="grid gap-3 sm:grid-cols-3">
                {PRICE_LIST_FIELDS.map((f) => (
                  <FormField key={f} label={PRICE_LIST_FIELD_LABEL[f]}>
                    <select
                      className={cn(selectCls, "h-10")}
                      value={mapping[f] ?? ""}
                      onChange={(e) =>
                        setMapping((p) => ({ ...p, [f]: e.target.value === "" ? null : Number(e.target.value) }))
                      }
                    >
                      <option value="" className="bg-popover text-popover-foreground">
                        No está en la lista
                      </option>
                      {headers.map((h, i) => (
                        <option key={i} value={i} className="bg-popover text-popover-foreground">
                          {h || `Columna ${i + 1}`}
                        </option>
                      ))}
                    </select>
                  </FormField>
                ))}
              </div>
            </section>

            <section className="grid gap-3 sm:grid-cols-4">
              <FormField label="Moneda de la lista">
                <select className={cn(selectCls, "h-10")} value={currency} onChange={(e) => setCurrency(e.target.value)}>
                  {CURRENCIES.map((c) => (
                    <option key={c} value={c} className="bg-popover text-popover-foreground">
                      {c}
                    </option>
                  ))}
                </select>
              </FormField>
              {foreign && (
                <FormField label="Tipo de cambio">
                  <input inputMode="decimal" className={inputCls} value={fx} onChange={(e) => setFx(e.target.value)} />
                </FormField>
              )}
              <FormField label="Bonificación de la lista (%)">
                <input
                  inputMode="decimal"
                  className={inputCls}
                  value={discount}
                  placeholder="0"
                  onChange={(e) => setDiscount(e.target.value)}
                />
              </FormField>
              <div className="space-y-2 text-sm sm:col-span-4">
                <label className="flex items-center gap-2">
                  <Switch
                    checked={updateReplacement}
                    onCheckedChange={setUpdateReplacement}
                    label="Actualizar costo de reposición"
                  />
                  Pasar el costo al costo de reposición del producto (en pesos y por unidad)
                </label>
                <label className="flex items-center gap-2">
                  <Switch checked={linkNew} onCheckedChange={setLinkNew} label="Vincular productos nuevos" />
                  Vincular al proveedor los productos del catálogo que encontré por SKU o código de barras
                </label>
              </div>
            </section>

            <section className="space-y-2">
              <SectionTitle>Vista previa</SectionTitle>
              <div className="flex flex-wrap gap-2 text-xs">
                {(["all", "update", "link", "same", "unmatched", "invalid"] as const).map((k) => {
                  const count = k === "all" ? preview.length : summary[k];
                  return (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setFilter(k)}
                      className={cn(
                        "rounded-md px-2.5 py-1 font-medium",
                        filter === k ? "bg-ninja-flame/[0.12] text-ninja-flameSoft" : "bg-muted text-muted-foreground",
                      )}
                    >
                      {k === "all" ? "Todas" : STATUS[k].label} ({count})
                    </button>
                  );
                })}
                {summary.avgChange != null && (
                  <span className="ml-auto self-center text-muted-foreground">
                    Variación promedio {summary.avgChange > 0 ? "+" : ""}
                    {String(summary.avgChange).replace(".", ",")} %
                  </span>
                )}
              </div>
              <div className="max-h-80 overflow-auto rounded-md border border-border">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-muted text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left">Fila</th>
                      <th className="px-3 py-2 text-left">Producto</th>
                      <th className="px-3 py-2 text-right">Antes</th>
                      <th className="px-3 py-2 text-right">Ahora</th>
                      <th className="px-3 py-2 text-right">Cambio</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {shown.slice(0, 500).map((r) => (
                      <tr key={r.line}>
                        <td className="px-3 py-2 tabular-nums text-muted-foreground">{r.line}</td>
                        <td className="px-3 py-2">
                          <div className="font-medium">{r.product_name ?? r.name ?? r.supplier_sku ?? r.sku ?? r.barcode}</div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                            <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
                            {r.supplier_sku && <span>Cód. {r.supplier_sku}</span>}
                            {r.error && <span className="text-danger">{r.error}</span>}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {r.old_cost == null ? "" : formatMoney(r.old_cost, currency)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {r.new_cost == null ? "" : formatMoney(r.new_cost, currency)}
                        </td>
                        <td
                          className={cn(
                            "px-3 py-2 text-right tabular-nums",
                            (r.change_pct ?? 0) > 0 && "text-danger",
                            (r.change_pct ?? 0) < 0 && "text-success",
                          )}
                        >
                          {r.change_pct == null ? "" : `${r.change_pct > 0 ? "+" : ""}${String(r.change_pct).replace(".", ",")} %`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {shown.length > 500 && (
                <p className="text-xs text-muted-foreground">Se muestran las primeras 500 filas de {shown.length}.</p>
              )}
            </section>
            <ErrorList errors={errors} />
          </>
        )}
      </div>
    </Modal>
  );
}
