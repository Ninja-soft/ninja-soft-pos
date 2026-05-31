import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { formatCurrency } from "@/lib/utils/format";

export const dynamic = "force-dynamic";

type Catalog = {
  tenant: { name: string; slug: string };
  branding: {
    logo_url: string | null;
    accent: string | null;
    legal_name: string | null;
    phone: string | null;
    address: string | null;
  } | null;
  products: {
    id: string;
    name: string;
    price: number;
    image_url: string | null;
    category: string | null;
  }[];
};

export default async function PublicCatalogPage({
  params,
}: {
  params: { slug: string };
}) {
  const supabase = createClient();
  const { data } = await supabase.rpc("public_catalog", { p_slug: params.slug });
  const catalog = data as unknown as Catalog | null;
  if (!catalog) notFound();

  const accent = catalog.branding?.accent || "#EC3F17";
  const title = catalog.branding?.legal_name || catalog.tenant.name;

  return (
    <main className="min-h-dvh bg-neutral-50 text-neutral-900">
      <header
        className="px-6 py-10 text-white"
        style={{ background: `linear-gradient(135deg, ${accent}, #15111f)` }}
      >
        <div className="mx-auto flex max-w-5xl items-center gap-4">
          {catalog.branding?.logo_url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={catalog.branding.logo_url}
              alt=""
              className="h-16 w-16 rounded-lg bg-white/10 object-contain p-1"
            />
          )}
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">{title}</h1>
            <p className="text-sm opacity-90">
              {[catalog.branding?.address, catalog.branding?.phone]
                .filter(Boolean)
                .join(" · ") || "Catálogo"}
            </p>
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-5xl px-6 py-8">
        {catalog.products.length === 0 ? (
          <p className="py-16 text-center text-neutral-500">
            Todavía no hay productos publicados.
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {catalog.products.map((p) => (
              <div
                key={p.id}
                className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm"
              >
                <div className="aspect-square w-full bg-neutral-100">
                  {p.image_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={p.image_url}
                      alt={p.name}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="grid h-full place-items-center text-neutral-300">
                      Sin foto
                    </div>
                  )}
                </div>
                <div className="p-3">
                  {p.category && (
                    <div className="text-[11px] uppercase tracking-wide text-neutral-400">
                      {p.category}
                    </div>
                  )}
                  <div className="line-clamp-2 text-sm font-medium">{p.name}</div>
                  <div
                    className="mt-1 font-bold tabular-nums"
                    style={{ color: accent }}
                  >
                    {formatCurrency(p.price)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <footer className="border-t border-neutral-200 py-6 text-center text-xs text-neutral-400">
        Hecho con NinjaPos
      </footer>
    </main>
  );
}
