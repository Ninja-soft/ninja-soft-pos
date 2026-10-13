"use client";

import { ImportWizard } from "@/components/import/ImportWizard";
import { customerImportDefinition } from "@/modules/customers/import";
import { useRequiredCustomerFields } from "@/modules/customers/hooks";

// Importación de clientes por XLSX (TX-4, ADR-078): usa el asistente único
// (subir → revisar en el servidor → confirmar). Si el negocio exige documento
// (require_customer_doc), el tipo y el número pasan a ser obligatorios.
export function ImportCustomersModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { data: required } = useRequiredCustomerFields();
  return (
    <ImportWizard
      definition={customerImportDefinition}
      open={open}
      onOpenChange={onOpenChange}
      context={{ requireCustomerDoc: required?.requireDoc ?? false }}
    />
  );
}
