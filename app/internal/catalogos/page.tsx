import { Eyebrow, Display } from "@/components/ui/Typography";
import { CatalogsManager } from "@/components/internal/catalogs/CatalogsManager";

export default function InternalCatalogosPage() {
  return (
    <>
      <Eyebrow>Complementos</Eyebrow>
      <Display className="mt-3 text-3xl md:text-4xl">
        Catálogos precargados
      </Display>
      <p className="mt-2 max-w-2xl text-muted-foreground">
        El addon <strong>Tiendita</strong>: catálogos con cientos de miles de
        productos de supermercados y retailers. Subís el Excel, armás catálogos
        vendibles agrupando tiendas, les ponés precio único y los bonificás a los
        negocios que quieras.
      </p>

      <div className="mt-8">
        <CatalogsManager />
      </div>
    </>
  );
}
