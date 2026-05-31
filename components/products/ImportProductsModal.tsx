"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, Upload } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { productsImportApi } from "@/modules/products/api";
import {
  PRODUCT_IMPORT_COLUMNS,
  PRODUCT_TEMPLATE_ROW,
  parseProductsXlsx,
  type ParsedProduct,
} from "@/modules/products/import";
import { exportXlsx } from "@/lib/utils/xlsx";

export function ImportProductsModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [rows, setRows] = useState<ParsedProduct[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [fileName, setFileName] = useState("");

  const importMut = useMutation({
    mutationFn: () => productsImportApi.bulkImport(rows),
    onSuccess: (count) => {
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["categories"] });
      toast({ title: `${count} productos importados`, variant: "success" });
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
    setRows([]);
    setErrors([]);
    setFileName("");
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    try {
      const res = await parseProductsXlsx(await file.arrayBuffer());
      setRows(res.rows);
      setErrors(res.errors);
    } catch {
      setRows([]);
      setErrors(["No se pudo leer el archivo. ¿Es un .xlsx válido?"]);
    }
  }

  async function downloadTemplate() {
    await exportXlsx("plantilla-productos", [
      {
        name: "Productos",
        title: "Plantilla de productos — NinjaPos",
        columns: PRODUCT_IMPORT_COLUMNS,
        rows: [PRODUCT_TEMPLATE_ROW],
      },
      {
        name: "Ayuda",
        columns: [
          { header: "Columna", key: "col", width: 16 },
          { header: "Qué poner", key: "help", width: 60 },
        ],
        rows: [
          { col: "name", help: "Obligatorio. Nombre del producto." },
          { col: "price", help: "Obligatorio. Precio de venta (número)." },
          { col: "sku / barcode", help: "Opcionales. Código interno / de barras." },
          { col: "cost", help: "Opcional. Costo." },
          { col: "stock / stock_min", help: "Opcionales. Stock actual y mínimo." },
          { col: "unit", help: "Opcional. Unidad (un, kg, lt…). Default 'un'." },
          { col: "category", help: "Opcional. Si no existe, se crea." },
        ],
      },
    ]);
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
      title="Importar productos (XLSX)"
      description="Descargá la plantilla, completala y subila. Te mostramos qué entra y qué no."
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
          {fileName || "Elegí un archivo .xlsx"}
          <input
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="hidden"
            onChange={onFile}
          />
        </label>

        {rows.length > 0 && (
          <p className="text-sm text-emerald-300">
            {rows.length} productos listos para importar.
          </p>
        )}
        {errors.length > 0 && (
          <div className="max-h-32 overflow-y-auto rounded-lg border border-red-400/20 bg-red-400/10 p-3 text-xs text-red-200">
            {errors.map((e, i) => (
              <div key={i}>{e}</div>
            ))}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            onClick={() => importMut.mutate()}
            loading={importMut.isPending}
            disabled={rows.length === 0}
          >
            Importar {rows.length > 0 ? `(${rows.length})` : ""}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
