import { FileCheck2, ShieldCheck } from "lucide-react";
import { PageHeader, SectionHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { ArcaCertificateSettings } from "@/components/internal/arca/ArcaCertificateSettings";
import { PlatformIssuerCard } from "@/components/internal/PlatformIssuerCard";

// Facturación electrónica ARCA (F3 · ADR-072): certificado de NinjaSoft
// (producción) para el camino "Delegar en NinjaSoft" y el padrón de los
// negocios (ADR-133), con el mismo panel que Complementos; y emisor de las
// facturas de la plataforma (F20-3 · ADR-117).
export default function InternalArcaPage() {
  return (
    <>
      <PageHeader
        eyebrow="Plataforma"
        title="ARCA"
        icon={FileCheck2}
        description="Certificado de NinjaSoft para que los negocios deleguen la facturación electrónica y verifiquen CUITs en el padrón. Cada negocio puede usar igual su certificado propio."
      />
      <section className="mt-8">
        <SectionHeader
          title="Certificado y padrón"
          icon={ShieldCheck}
          description="Producción. Cargá el certificado, probalo con un CUIT y configurá el padrón para los negocios."
        />
        <Card className="mt-4 p-4 sm:p-5">
          <ArcaCertificateSettings />
        </Card>
      </section>
      <div className="mt-10">
        {/* F20-3 (ADR-117): NinjaSoft como emisora de sus propias facturas. */}
        <PlatformIssuerCard />
      </div>
    </>
  );
}
