import { FileCheck2 } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { ArcaPlatformCard } from "@/components/internal/ArcaPlatformCard";

// Facturación electrónica ARCA (F3 · ADR-072): configuración de la plataforma
// para el camino "Delegar en NinjaSoft".
export default function InternalArcaPage() {
  return (
    <>
      <PageHeader
        eyebrow="Plataforma"
        title="ARCA"
        icon={FileCheck2}
        description="CUIT y certificado de NinjaSoft para que los negocios deleguen la facturación electrónica. Cada negocio puede usar igual su certificado propio."
      />
      <div className="mt-8">
        <ArcaPlatformCard />
      </div>
    </>
  );
}
