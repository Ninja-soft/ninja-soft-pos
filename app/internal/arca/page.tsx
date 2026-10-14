import { FileCheck2 } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { ArcaPlatformCard } from "@/components/internal/ArcaPlatformCard";
import { PlatformIssuerCard } from "@/components/internal/PlatformIssuerCard";

// Facturación electrónica ARCA (F3 · ADR-072): configuración de la plataforma
// para el camino "Delegar en NinjaSoft", y emisor de las facturas de la
// plataforma (F20-3).
export default function InternalArcaPage() {
  return (
    <>
      <PageHeader
        eyebrow="Plataforma"
        title="ARCA"
        icon={FileCheck2}
        description="CUIT y certificado de NinjaSoft para que los negocios deleguen la facturación electrónica. Cada negocio puede usar igual su certificado propio."
      />
      <div className="mt-8 space-y-8">
        <ArcaPlatformCard />
        {/* F20-3 (ADR-115): NinjaSoft como emisora de sus propias facturas. */}
        <PlatformIssuerCard />
      </div>
    </>
  );
}
