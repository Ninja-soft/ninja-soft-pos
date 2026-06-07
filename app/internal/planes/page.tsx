import { Eyebrow, Display } from "@/components/ui/Typography";
import { PlansManager } from "@/components/internal/plans/PlansManager";
import { InviteCodesCard } from "@/components/internal/plans/InviteCodesCard";

export default function InternalPlanesPage() {
  return (
    <>
      <Eyebrow>Comercial</Eyebrow>
      <Display className="mt-3 text-3xl md:text-4xl">Planes</Display>
      <p className="mt-2 max-w-2xl text-muted-foreground">
        Creá y editá los planes globales: ícono, precio, prueba gratis, límites
        y funcionalidades incluidas. Los planes a medida por negocio se
        gestionan desde la ficha del tenant.
      </p>

      <div className="mt-8">
        <PlansManager />
      </div>

      <div className="mt-12">
        <InviteCodesCard />
      </div>
    </>
  );
}
