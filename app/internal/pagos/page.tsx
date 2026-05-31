import { Eyebrow, Display } from "@/components/ui/Typography";
import { PlatformMpCard } from "@/components/internal/PlatformMpCard";

export default function InternalPagosPage() {
  return (
    <>
      <Eyebrow>Cobros</Eyebrow>
      <Display className="mt-3 text-3xl md:text-4xl">Pagos de plataforma</Display>
      <p className="mt-2 max-w-2xl text-muted-foreground">
        Configurá la cuenta de Mercado Pago de NinjaSoft: habilita el OAuth de los
        clientes y el cobro de las suscripciones.
      </p>

      <div className="mt-8">
        <PlatformMpCard />
      </div>
    </>
  );
}
