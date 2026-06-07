"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, Upload } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { customersApi } from "@/modules/customers/api";
import {
  CUSTOMER_IMPORT_COLUMNS,
  CUSTOMER_TEMPLATE_ROW,
  parseCustomersXlsx,
  type ParsedCustomer,
} from "@/modules/customers/import";
import { exportXlsx } from "@/lib/utils/xlsx";

export function ImportCustomersModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [rows, setRows] = useState<ParsedCustomer[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [fileName, setFileName] = useState("");

  const importMut = useMutation({
    mutationFn: () => customersApi.bulkImport(rows),
    onSuccess: (count) => {
      qc.invalidateQueries({ queryKey: ["customers"] });
      toast({ title: `${count} clientes importados`, variant: "success" });
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
      const res = await parseCustomersXlsx(await file.arrayBuffer());
      setRows(res.rows);
      setErrors(res.errors);
    } catch {
      setRows([]);
      setErrors(["No se pudo leer el archivo. ¿Es un .xlsx válido?"]);
    }
  }

  async function downloadTemplate() {
    await exportXlsx("plantilla-clientes", [
      {
        name: "Clientes",
        title: "Plantilla de clientes • NinjaPos",
        columns: CUSTOMER_IMPORT_COLUMNS,
        rows: [CUSTOMER_TEMPLATE_ROW],
      },
      {
        name: "Ayuda",
        columns: [
          { header: "Columna", key: "col", width: 18 },
          { header: "Qué poner", key: "help", width: 56 },
        ],
        rows: [
          { col: "name", help: "Obligatorio. Nombre o razón social." },
          { col: "document_type", help: "Opcional. DNI / CUIT / CUIL." },
          { col: "document_number", help: "Opcional. Número de documento." },
          { col: "iva_condition", help: "Opcional. Consumidor Final, Resp. Inscripto…" },
          { col: "email / phone", help: "Opcionales. Contacto." },
          { col: "address / notes", help: "Opcionales." },
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
      title="Importar clientes (XLSX)"
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
            {rows.length} clientes listos para importar.
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
