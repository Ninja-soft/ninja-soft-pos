"use client";

import { CloudOff } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/ui/PageHeader";
import { OfflineSalesPanel } from "@/components/sales/OfflineSalesPanel";
import { useBranchContext } from "@/modules/branches/hooks";
import { useMyTenant } from "@/modules/tenants/hooks";

// Ventas offline (ADR-077): las que no se pudieron registrar al sincronizar y
// las registradas con diferencias. Respeta el filtro global de sucursal.
export default function VentasOfflinePage() {
  const branch = useBranchContext();
  const { data: me } = useMyTenant();
  const role = me?.role ?? "cashier";
  return (
    <PageContainer size="lg">
      <PageHeader
        eyebrow="Operación"
        title="Ventas offline"
        icon={CloudOff}
        description="Ventas hechas sin conexión que necesitan una decisión: registrarlas en tu caja, marcarlas como resueltas o descartarlas con motivo."
      />
      <div className="mt-6">
        <OfflineSalesPanel storeId={branch.filterStoreId} canResolve={role === "owner" || role === "manager"} />
      </div>
    </PageContainer>
  );
}
