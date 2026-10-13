"use client";

import { ImportWizard } from "@/components/import/ImportWizard";
import { productImportDefinition } from "@/modules/products/import";

// Importación de productos por XLSX (TX-4, ADR-078): usa el asistente único
// (subir → revisar en el servidor → confirmar) con la definición de productos.
export function ImportProductsModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  return <ImportWizard definition={productImportDefinition} open={open} onOpenChange={onOpenChange} />;
}
