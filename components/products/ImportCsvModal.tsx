"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, Upload } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { productsImportApi } from "@/modules/products/api";
import {
  CSV_TEMPLATE,
  parseProductsCsv,
  type ParsedProduct,
} from "@/modules/products/import";

export function ImportCsvModal({
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
    const text = await file.text();
    const res = parseProductsCsv(text);
    setRows(res.rows);
    setErrors(res.errors);
  }

  function downloadTemplate() {
    const blob = new Blob([CSV_TEMPLATE], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "plantilla-productos.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
      title="Importar productos (CSV)"
      description="Columnas: name, sku, barcode, price, cost, stock, stock_min, unit, category."
    >
      <div className="space-y-4">
        <button
          onClick={downloadTemplate}
          className="inline-flex items-center gap-1.5 text-sm text-ninja-flameSoft hover:underline"
        >
          <Download size={15} /> Descargar plantilla
        </button>

        <label className="flex cursor-pointer items-center justify-center gap-2 rounded-ninjaLg border border-dashed border-input bg-background px-4 py-6 text-sm text-muted-foreground transition hover:border-ninja-flameSoft">
          <Upload size={16} />
          {fileName || "Elegí un archivo .csv"}
          <input type="file" accept=".csv,text/csv" className="hidden" onChange={onFile} />
        </label>

        {rows.length > 0 && (
          <p className="text-sm text-emerald-300">
            {rows.length} productos listos para importar.
          </p>
        )}
        {errors.length > 0 && (
          <div className="max-h-32 overflow-y-auto rounded-ninjaMd border border-red-400/20 bg-red-400/10 p-3 text-xs text-red-200">
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
