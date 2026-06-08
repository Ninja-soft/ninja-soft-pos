"use client";

import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, Upload } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { ImportPreview, type PreviewColumn } from "@/components/ui/ImportPreview";
import { productsImportApi } from "@/modules/products/api";
import {
  PRODUCT_IMPORT_COLUMNS,
  PRODUCT_TEMPLATE_ROW,
  parseProductsXlsx,
  type ParsedProduct,
} from "@/modules/products/import";
import { exportXlsx } from "@/lib/utils/xlsx";
import {
  countRows,
  validRows,
  type ParseXlsxResult,
} from "@/lib/utils/xlsxImport";
import { formatCurrency } from "@/lib/utils/format";

// Columnas mostradas en la tabla de preview (subset legible).
const PREVIEW_COLS: PreviewColumn<ParsedProduct>[] = [
  { header: "Nombre", cell: (r) => r.name },
  { header: "Código", cell: (r) => r.barcode ?? r.sku ?? "" },
  { header: "Precio", align: "right", cell: (r) => formatCurrency(r.price) },
  { header: "Categoría", cell: (r) => r.category ?? "" },
  { header: "Marca", cell: (r) => r.brand ?? "" },
  { header: "Stock", align: "right", cell: (r) => String(r.stock) },
];

export function ImportProductsModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [result, setResult] = useState<ParseXlsxResult<ParsedProduct> | null>(
    null,
  );
  const [fileName, setFileName] = useState("");
  const [parsing, setParsing] = useState(false);

  const counts = result ? countRows(result) : { valid: 0, invalid: 0 };
  const okRows = useMemo(() => (result ? validRows(result) : []), [result]);

  const importMut = useMutation({
    mutationFn: () => productsImportApi.bulkImport(okRows),
    onSuccess: (count) => {
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["categories"] });
      qc.invalidateQueries({ queryKey: ["brands"] });
      const omitted = counts.invalid;
      toast({
        title: `${count} productos importados`,
        description:
          omitted > 0 ? `${omitted} omitidos por errores.` : undefined,
        variant: "success",
      });
      reset();
      onOpenChange(false);
    },
    onError: (e) =>
      toast({
        title: "Error al importar",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      }),
  });

  function reset() {
    setResult(null);
    setFileName("");
    setParsing(false);
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setParsing(true);
    try {
      const res = await parseProductsXlsx(await file.arrayBuffer());
      setResult(res);
    } catch {
      setResult({
        rows: [],
        fatalError: "No se pudo leer el archivo. ¿Es un .xlsx válido?",
      });
    } finally {
      setParsing(false);
    }
    // Permite volver a elegir el mismo archivo.
    e.target.value = "";
  }

  async function downloadTemplate() {
    await exportXlsx("plantilla-productos", [
      {
        name: "Productos",
        title: "Plantilla de productos • NinjaPos",
        columns: PRODUCT_IMPORT_COLUMNS,
        rows: [PRODUCT_TEMPLATE_ROW],
      },
      {
        name: "Ayuda",
        columns: [
          { header: "Columna", key: "col", width: 16 },
          { header: "Qué poner", key: "help", width: 64 },
        ],
        rows: [
          { col: "name", help: "Obligatorio. Nombre del producto." },
          { col: "price", help: "Obligatorio. Precio de venta (número)." },
          {
            col: "barcode",
            help: "Opcional. Código de barras (EAN). Se controlan duplicados.",
          },
          {
            col: "sku",
            help: "Opcional. Código interno. Si lo dejás vacío, queda sin SKU.",
          },
          { col: "cost", help: "Opcional. Costo." },
          { col: "category", help: "Opcional. Si no existe, se crea." },
          { col: "brand", help: "Opcional. Marca. Si no existe, se crea." },
          { col: "tax_rate", help: "Opcional. IVA en %. Default 21." },
          {
            col: "unit",
            help: "Opcional. Unidad (un, kg, lt…). Default 'un'.",
          },
          {
            col: "stock / stock_min",
            help: "Opcionales. Stock actual y mínimo. Default 0.",
          },
          {
            col: "track_stock",
            help: "Opcional. ¿Controla stock? si/no. Default 'si'.",
          },
        ],
      },
    ]);
  }

  const fatal = result?.fatalError ?? null;
  const hasPreview = !!result && result.rows.length > 0;

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
      title="Importar productos (XLSX)"
      description="Descargá la plantilla, completala y subila. Te mostramos qué entra y qué no antes de confirmar."
      className={hasPreview ? "max-w-3xl" : undefined}
    >
      <div className="space-y-4">
        <button
          onClick={downloadTemplate}
          className="inline-flex items-center gap-1.5 text-sm text-ninja-flameSoft hover:underline"
        >
          <Download size={15} /> Descargar plantilla XLSX
        </button>

        <label className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-input bg-background px-4 py-6 text-sm text-muted-foreground transition hover:border-ninja-flameSoft">
          <Upload size={16} />
          {parsing ? "Leyendo archivo…" : fileName || "Elegí un archivo .xlsx"}
          <input
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="hidden"
            onChange={onFile}
          />
        </label>

        {fatal && (
          <div className="rounded-lg border border-red-400/20 bg-red-400/10 p-3 text-sm text-red-200">
            {fatal}
          </div>
        )}

        {hasPreview && (
          <ImportPreview
            rows={result!.rows}
            columns={PREVIEW_COLS}
            validCount={counts.valid}
            invalidCount={counts.invalid}
            entityPlural="productos"
          />
        )}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            onClick={() => importMut.mutate()}
            loading={importMut.isPending}
            disabled={counts.valid === 0}
          >
            Importar {counts.valid > 0 ? `(${counts.valid})` : ""}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
