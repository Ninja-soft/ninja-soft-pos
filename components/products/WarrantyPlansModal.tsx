"use client";

import { Modal } from "@/components/ui/Modal";
import { WarrantyPlansManager } from "@/components/products/WarrantyPlansManager";

// Acceso rápido a los planes de garantía desde Productos. La gestión completa
// vive también en Configuración → Garantías (mismo componente).
export function WarrantyPlansModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Planes de garantía extendida" className="max-w-lg">
      <WarrantyPlansManager />
    </Modal>
  );
}
