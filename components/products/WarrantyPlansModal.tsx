"use client";

import { Modal } from "@/components/ui/Modal";
import { WarrantyTypesManager } from "@/components/warranty/WarrantyTypesManager";

// Acceso rápido a las garantías extendidas desde Productos. La gestión completa
// vive también en Configuración → Garantías extendidas (mismo componente).
export function WarrantyPlansModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Garantías extendidas" className="sm:max-w-4xl">
      <WarrantyTypesManager />
    </Modal>
  );
}
