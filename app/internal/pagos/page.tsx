import { PlatformMpCard } from "@/components/internal/PlatformMpCard";
import { CreditCard } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";

export default function InternalPagosPage() {
  return (
    <>
      <PageHeader
        eyebrow="Cobros"
        title="Pagos de plataforma"
        icon={CreditCard}
        description={
          <>
            Configurá la cuenta de Mercado Pago de NinjaSoft: habilita el OAuth de los
            clientes y el cobro de las suscripciones.
          </>
        }
      />

      <div className="mt-8">
        <PlatformMpCard />
      </div>
    </>
  );
}
