"use client";

import { Suspense, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { Hourglass } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/ui/PageHeader";
import { MountWhenOpened } from "@/components/ui/MountWhenOpened";
import { PendingChargesPanel } from "@/components/pending-charges/PendingChargesPanel";
import { useBranchContext } from "@/modules/branches/hooks";
import { useMyTenant } from "@/modules/tenants/hooks";

const TicketModal = dynamic(() => import("@/components/sales/TicketModal").then((m) => m.TicketModal), {
  ssr: false,
});

// Pestaña "Cobros en espera" del panel (Operación · ADR-048). Respeta el
// filtro global de sucursal; "Editar en el POS" abre el carrito en el POS.
function CobrosEnEsperaInner() {
  const branch = useBranchContext();
  const router = useRouter();
  const params = useSearchParams();
  const { data: me } = useMyTenant();
  const role = me?.role ?? "cashier";
  const [ticketId, setTicketId] = useState<string | null>(null);

  return (
    <PageContainer size="lg">
      <PageHeader
        eyebrow="Operación"
        title="Cobros en espera"
        icon={Hourglass}
        description={
          branch.isMulti
            ? branch.filterStore
              ? `Sucursal ${branch.filterStore.name}. QR y links compartidos que esperan el pago.`
              : "Todas las sucursales. QR y links compartidos que esperan el pago."
            : "QR y links compartidos que esperan el pago. La venta se registra sola cuando el cliente paga."
        }
      />
      <div className="mt-6">
        {/* Sin candado acá: el ítem del menú ya lo tiene, y si el plan baja,
            los cobros que quedaron abiertos se tienen que poder gestionar. */}
        <PendingChargesPanel
          storeId={branch.filterStoreId}
          initialId={params.get("id")}
          onEditInPos={(c) => router.push(`/pos?editar=${c.id}`)}
          onPrint={setTicketId}
          canForce={role === "owner" || role === "manager"}
        />
      </div>
      <MountWhenOpened open={ticketId !== null}>
        <TicketModal open={ticketId !== null} onOpenChange={(o) => !o && setTicketId(null)} saleId={ticketId} />
      </MountWhenOpened>
    </PageContainer>
  );
}

export default function CobrosEnEsperaPage() {
  return (
    <Suspense fallback={null}>
      <CobrosEnEsperaInner />
    </Suspense>
  );
}
