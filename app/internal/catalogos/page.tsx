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
            El complemento Tiendita: catálogos con cientos de miles de productos de
            supermercados y comercios. Armás catálogos agrupando tiendas, les ponés
            un precio y los bonificás a los negocios que quieras.
          </>
        }
      />

      <div className="mt-8">
        <CatalogsManager />
      </div>
    </>
  );
}
