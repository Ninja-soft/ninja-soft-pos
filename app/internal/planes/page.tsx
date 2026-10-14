import { PlansManager } from "@/components/internal/plans/PlansManager";
import { InviteCodesCard } from "@/components/internal/plans/InviteCodesCard";
import { Tag } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";

export default function InternalPlanesPage() {
  return (
    <>
      <PageHeader
        eyebrow="Comercial"
        title="Planes"
        icon={Tag}
        description={
          <>
            Creá y editá los planes globales: ícono, precio, prueba gratis, límites
            y funcionalidades incluidas. Los planes a medida por negocio se
            gestionan desde la ficha del tenant.
          </>
        }
      />

      <div className="mt-8">
        <PlansManager />
      </div>

      <div className="mt-10">
        <InviteCodesCard />
      </div>
    </>
  );
}
