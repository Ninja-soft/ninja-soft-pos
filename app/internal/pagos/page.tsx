import { CreditCard } from "lucide-react";
import { PlatformMpCard } from "@/components/internal/PlatformMpCard";
import { PageHeader } from "@/components/ui/PageHeader";

export default function InternalPagosPage() {
  return (
    <>
      <PageHeader
        eyebrow="Cobros"
        title="Pagos de plataforma"
        icon={CreditCard}
        description="Cómo cobra NinjaSoft las suscripciones y cómo conectan los negocios su propio Mercado Pago."
      />

      <div className="mt-6">
        <PlatformMpCard />
      </div>
    </>
  );
}
