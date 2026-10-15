import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { businessDisplayName } from "@/lib/branding/businessName";
import { accentPalette } from "@/lib/invoices/style";
import { shortToUuid } from "@/lib/labels/publicLink";
import { normalizeSheet, type PublicProductSheet } from "@/lib/labels/publicSheet";
import { ProductPublicSheet } from "@/components/labels/public/ProductPublicSheet";

export const dynamic = "force-dynamic";

type Params = { params: { slug: string; code: string } };

// Ficha pública del producto (H24 · ADR-148): la abre el QR de la etiqueta.
// Todo lo resuelve el servidor (public_product_sheet, SECURITY DEFINER): el
// negocio del slug, el producto activo de ESE negocio y el plan con
// etiquetas_pro. El código es el UUID en base64url (22 caracteres).
async function load(p: Params["params"]): Promise<PublicProductSheet | null> {
  const id = shortToUuid(p.code);
  if (!id) return null;
  try {
    const { data } = await createClient().rpc("public_product_sheet" as never, { p_slug: p.slug, p_product: id } as never);
    return normalizeSheet(data);
  } catch {
    return null;
  }
}

function businessName(s: PublicProductSheet): string {
  return businessDisplayName(
    { tradeName: s.branding?.trade_name, tenantName: s.tenant.name, legalName: s.branding?.legal_name },
    "Producto",
  );
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const s = await load(params);
  if (!s) return { title: "Producto", robots: { index: false } };
  return {
    title: `${s.product.name} · ${businessName(s)}`,
    description: s.product.description?.slice(0, 160) ?? undefined,
    robots: { index: false },
    openGraph: s.product.images[0] ? { images: [s.product.images[0]] } : undefined,
  };
}

export default async function ProductSheetPage({ params }: Params) {
  const sheet = await load(params);
  if (!sheet) notFound();
  const pal = accentPalette(sheet.branding?.accent || "#EC3F17");
  return (
    <ProductPublicSheet
      sheet={sheet}
      business={businessName(sheet)}
      palette={{ accent: pal.accent, accentInk: pal.accentInk, accentText: pal.accentText }}
    />
  );
}
