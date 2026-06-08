"use client";

import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, Upload } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { ImportPreview, type PreviewColumn } from "@/components/ui/ImportPreview";
import { customersApi } from "@/modules/customers/api";
import { useRequiredCustomerFields } from "@/modules/customers/hooks";
import {
  CUSTOMER_IMPORT_COLUMNS,
  CUSTOMER_TEMPLATE_ROW,
  parseCustomersXlsx,
  type ParsedCustomer,
} from "@/modules/customers/import";
import {
  DOC_TYPE_LABELS,
  IVA_LABELS,
} from "@/modules/customers/schemas";
import { exportXlsx } from "@/lib/utils/xlsx";
import {
  countRows,
  validRows,
  type ParseXlsxResult,
} from "@/lib/utils/xlsxImport";

const docLabel = (code: string | null) =>
  code ? (DOC_TYPE_LABELS[code as keyof typeof DOC_TYPE_LABELS] ?? code) : "";
const ivaLabel = (code: string | null) =>
  code ? (IVA_LABELS[code as keyof typeof IVA_LABELS] ?? code) : "";

const PREVIEW_COLS: PreviewColumn<ParsedCustomer>[] = [
  { header: "Nombre", cell: (r) => r.name },
  {
    header: "Documento",
    cell: (r) =>
      r.document_number
        ? `${docLabel(r.document_type)} ${r.document_number}`.trim()
        : "",
  },
  { header: "IVA", cell: (r) => ivaLabel(r.iva_condition) },
  { header: "Email", cell: (r) => r.email ?? "" },
  { header: "Teléfono", cell: (r) => r.phone ?? "" },
];

export function ImportCustomersModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: required } = useRequiredCustomerFields();
  const requireDoc = required?.requireDoc ?? false;

  const [result, setResult] = useState<ParseXlsxResult<ParsedCustomer> | null>(
    null,
  );
  const [fileName, setFileName] = useState("");
  const [parsing, setParsing] = useState(false);

  const counts = result ? countRows(result) : { valid: 0, invalid: 0 };
  const okRows = useMemo(() => (result ? validRows(result) : []), [result]);

  const importMut = useMutation({
    mutationFn: () => customersApi.bulkImport(okRows),
    onSuccess: (count) => {
      qc.invalidateQueries({ queryKey: ["customers"] });
      const omitted = counts.invalid;
      toast({
        title: `${count} clientes importados`,
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
      const res = await parseCustomersXlsx(await file.arrayBuffer(), requireDoc);
      setResult(res);
    } catch {
      setResult({
        rows: [],
        fatalError: "No se pudo leer el archivo. ¿Es un .xlsx válido?",
      });
    } finally {
      setParsing(false);
    }
    e.target.value = "";
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
          { header: "Qué poner", key: "help", width: 60 },
        ],
        rows: [
          { col: "name", help: "Obligatorio. Nombre o razón social." },
          {
            col: "document_type",
            help: `${requireDoc ? "Obligatorio" : "Opcional"}. DNI / CUIT / CUIL / Pasaporte / Otro.`,
          },
          {
            col: "document_number",
            help: `${requireDoc ? "Obligatorio" : "Opcional"}. Número (CUIT/CUIL validan dígito verificador).`,
          },
          {
            col: "iva_condition",
            help: "Opcional. Consumidor Final, Responsable Inscripto, Monotributo…",
          },
          { col: "email / phone", help: "Opcionales. Email se valida." },
          { col: "address / notes", help: "Opcionales." },
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
      title="Importar clientes (XLSX)"
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

        {requireDoc && (
          <p className="rounded-lg border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
            Tu configuración exige documento: el tipo y número son obligatorios
            en cada fila.
          </p>
        )}

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
            entityPlural="clientes"
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
