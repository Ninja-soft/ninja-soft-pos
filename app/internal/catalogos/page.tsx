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
            El addon <strong>Tiendita</strong>: catálogos con cientos de miles de
            productos de supermercados y retailers. Subís el Excel, armás catálogos
            vendibles agrupando tiendas, les ponés precio único y los bonificás a los
            negocios que quieras.
          </>
        }
      />

      <div className="mt-8">
        <CatalogsManager />
      </div>
    </>
  );
}
