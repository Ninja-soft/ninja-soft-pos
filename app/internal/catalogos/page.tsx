import { CatalogsManager } from "@/components/internal/catalogs/CatalogsManager";
import { Boxes } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";

export default function InternalCatalogosPage() {
  return (
    <>
      <PageHeader
        eyebrow="Complementos"
        title="Catálogos precargados"
        icon={Boxes}
        description={
          <>
            El addon <strong>Tiendita</strong>: cientos de miles de productos de
            supermercados y retailers que llegan solos del scraper. Armás catálogos
            vendibles agrupando tiendas, les ponés precio único y los bonificás a los
            negocios que quieras.
          </>
        }
      />

      <div className="mt-6">
        <CatalogsManager />
      </div>
    </>
  );
}
