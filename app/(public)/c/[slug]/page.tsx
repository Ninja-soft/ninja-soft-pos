import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { businessDisplayName } from "@/lib/branding/businessName";
import { accentPalette } from "@/lib/invoices/style";
import type { Catalog } from "@/lib/catalog/publicOrder";
import { CatalogStorefront } from "@/components/catalog/public/CatalogStorefront";
import type { Metadata } from "next";

export const dynamic = "force-dynamic";

// ADR-124: el catálogo se presenta con el nombre de fantasía (si no, el de la cuenta).
function catalogTitle(c: Catalog): string {
  return businessDisplayName(
    { tradeName: c.branding?.trade_name, tenantName: c.tenant.name, legalName: c.branding?.legal_name },
    "Catálogo",
  );
}

export async function generateMetadata({ params }: { params: { slug: string } }): Promise<Metadata> {
  try {
    const { data } = await createClient().rpc("public_catalog", { p_slug: params.slug });
    const catalog = data as unknown as Catalog | null;
    return catalog ? { title: `${catalogTitle(catalog)} · Catálogo` } : {};
  } catch {
    return {};
  }
}

// Catálogo público (H10). El carrito y el pedido (ADR-130) viven en el
// componente cliente; acá sólo se trae el catálogo (precios, disponible y si
// el negocio toma pedidos, todo resuelto por el servidor).
export default async function PublicCatalogPage({ params }: { params: { slug: string } }) {
  const supabase = createClient();
  const { data } = await supabase.rpc("public_catalog", { p_slug: params.slug });
  const catalog = data as unknown as Catalog | null;
  if (!catalog) notFound();

  const pal = accentPalette(catalog.branding?.accent || "#EC3F17");
  return (
    <CatalogStorefront
      catalog={catalog}
      title={catalogTitle(catalog)}
      palette={{ accent: pal.accent, accentInk: pal.accentInk, accentText: pal.accentText }}
    />
  );
}
