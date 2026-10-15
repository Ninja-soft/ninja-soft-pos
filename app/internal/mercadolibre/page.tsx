import { Handshake } from "lucide-react";
import { MlAppCard } from "@/components/internal/mercadolibre/MlAppCard";
import { PageHeader } from "@/components/ui/PageHeader";

export default function InternalMercadoLibrePage() {
  return (
    <>
      <PageHeader
        eyebrow="Integraciones"
        title="Mercado Libre (app)"
        icon={Handshake}
        description="La app de NinjaSoft en Mercado Libre: credenciales, URLs para DevCenter y uso por los negocios."
      />

      <div className="mt-6">
        <MlAppCard />
      </div>
    </>
  );
}
