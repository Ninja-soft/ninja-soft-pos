"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronLeft,
  Gift,
  Layers,
  Package,
  PackageSearch,
  Plus,
  SearchX,
  ShoppingBag,
  Sparkles,
} from "lucide-react";
import { PageContainer, PageHeader, SectionHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { SearchField } from "@/components/ui/SearchField";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { formatCurrency, formatInt } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";
import { splitCategoryPath } from "@/lib/products/categoryPath";
import { useStorefrontCatalogs, useCatalogSearch } from "@/modules/tiendita/hooks";
import { startCatalogCheckout } from "@/modules/tiendita/storefront";
import type { StorefrontCatalog, CatalogSearchResult } from "@/modules/tiendita/storefront";
import { TienditaIntro } from "./TienditaIntro";
import { ImportProductModal } from "./ImportProductModal";
import { appOrigin } from "@/lib/site";
import { useCatalogHintsActive } from "@/modules/catalog/hooks";
import { StoreLogo } from "@/components/catalog/StoreLogo";

// Mensajes honestos para los códigos de error del checkout.
const CHECKOUT_ERRORS: Record<string, string> = {
  platform_not_configured:
    "El cobro todavía no está habilitado. NinjaSoft tiene que conectar su Mercado Pago.",
  already_owned: "Ya tenés acceso a este catálogo.",
  catalog_unavailable: "Este catálogo no está disponible en este momento.",
  invalid_catalog_price: "Este catálogo no tiene un precio válido para cobrar.",
  forbidden: "Solo el dueño de la cuenta puede comprar catálogos.",
};

export function TienditaView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: catalogs, isLoading } = useStorefrontCatalogs();
  const [openCatalog, setOpenCatalog] = useState<StorefrontCatalog | null>(null);

  // Vuelta desde Mercado Pago (?bought=ok): feedback + refresco del acceso (el
  // alta real la confirma el webhook; puede tardar unos segundos).
  useEffect(() => {
    if (searchParams.get("bought") !== "ok") return;
    toast({
      title: "Estamos confirmando tu compra",
      description:
        "Mercado Pago está procesando el pago. En unos segundos vas a ver el catálogo desbloqueado.",
      variant: "success",
    });
    qc.invalidateQueries({ queryKey: ["tiendita", "catalogs"] });
    const t1 = setTimeout(() => qc.invalidateQueries({ queryKey: ["tiendita", "catalogs"] }), 4000);
    const t2 = setTimeout(() => qc.invalidateQueries({ queryKey: ["tiendita", "catalogs"] }), 9000);
    router.replace("/tiendita");
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const openCatalogFresh = useMemo(
    () => catalogs?.find((c) => c.id === openCatalog?.id) ?? openCatalog,
    [catalogs, openCatalog],
  );

  const buy = useMutation({
    mutationFn: async (catalog: StorefrontCatalog) => {
      const backUrl = `${appOrigin()}/tiendita?bought=ok`;
      return startCatalogCheckout(catalog.id, backUrl);
    },
    onSuccess: (initPoint) => {
      window.location.href = initPoint;
    },
    onError: (e: Error) => {
      if (e.message === "already_owned") {
        qc.invalidateQueries({ queryKey: ["tiendita", "catalogs"] });
      }
      toast({ title: CHECKOUT_ERRORS[e.message] ?? "No se pudo iniciar la compra", variant: "error" });
    },
  });

  const owned = (catalogs ?? []).filter((c) => c.owned);
  const available = (catalogs ?? []).filter((c) => !c.owned);

  return (
    <>
      <TienditaIntro />
      <PageContainer>
        {openCatalogFresh && openCatalogFresh.owned ? (
          <CatalogAccess catalog={openCatalogFresh} onBack={() => setOpenCatalog(null)} />
        ) : (
          <>
            <PageHeader
              eyebrow="NinjaSoft"
              title="Tiendita"
              icon={ShoppingBag}
              description="Catálogos de las marcas más grandes, con foto, marca y categoría. Comprá uno (pago único) y sumá productos a tu tienda."
            />

            {isLoading ? (
              <SpinnerBlock className="py-20" />
            ) : (catalogs?.length ?? 0) === 0 ? (
              <div className="mt-8 rounded-lg border border-border bg-card">
                <EmptyState
                  icon={ShoppingBag}
                  title="Todavía no hay catálogos"
                  description="Estamos sumando marcas. Volvé pronto."
                />
              </div>
            ) : (
              <div className="mt-8 space-y-10">
                {owned.length > 0 && (
                  <section>
                    <SectionHeader title="Tus catálogos" description="Entrá, buscá y sumá productos." />
                    <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                      {owned.map((c) => (
                        <CatalogCard key={c.id} catalog={c} onAccess={() => setOpenCatalog(c)} />
                      ))}
                    </div>
                  </section>
                )}
                {available.length > 0 && (
                  <section>
                    <SectionHeader
                      title={owned.length > 0 ? "Más catálogos" : "Catálogos disponibles"}
                      description="Pago único: el catálogo queda tuyo para siempre."
                    />
                    <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                      {available.map((c) => (
                        <CatalogCard
                          key={c.id}
                          catalog={c}
                          buying={buy.isPending && buy.variables?.id === c.id}
                          onBuy={() => buy.mutate(c)}
                        />
                      ))}
                    </div>
                  </section>
                )}
              </div>
            )}
          </>
        )}
      </PageContainer>
    </>
  );
}

// ── Carátula del catálogo ───────────────────────────────────────────────────
function Cover({ catalog, className }: { catalog: StorefrontCatalog; className?: string }) {
  return (
    <div className={cn("relative overflow-hidden bg-ninja-dark", className)}>
      {catalog.coverUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={catalog.coverUrl}
          alt=""
          className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.03]"
        />
      ) : (
        <div className="grid h-full w-full place-items-center bg-ninja-deepViolet">
          <Package size={34} className="text-white/50" />
        </div>
      )}
    </div>
  );
}

function CatalogCard({
  catalog,
  buying,
  onBuy,
  onAccess,
}: {
  catalog: StorefrontCatalog;
  buying?: boolean;
  onBuy?: () => void;
  onAccess?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const long = (catalog.description?.length ?? 0) > 140;
  return (
    <article className="group flex flex-col overflow-hidden rounded-lg border border-border bg-card">
      <button
        type="button"
        onClick={catalog.owned ? onAccess : undefined}
        className={cn("relative block text-left", !catalog.owned && "cursor-default")}
        tabIndex={catalog.owned ? 0 : -1}
        aria-label={catalog.owned ? `Entrar a ${catalog.name}` : undefined}
      >
        <Cover catalog={catalog} className="aspect-[16/10] w-full" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-black/80 via-black/30 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 p-4">
          <div className="flex flex-wrap gap-1.5">
            {catalog.productCount > 0 && (
              <span className="inline-flex items-center gap-1 rounded-md bg-white/15 px-2.5 py-1 text-[11px] font-semibold text-white backdrop-blur-md">
                <Layers size={12} /> {formatInt(catalog.productCount)} productos
              </span>
            )}
            {catalog.owned && (
              <span className="inline-flex items-center gap-1 rounded-md bg-white px-2.5 py-1 text-[11px] font-semibold text-[#15111f]">
                {catalog.source === "granted" ? <Gift size={12} /> : <Check size={12} />}
                {catalog.source === "granted" ? "De regalo" : "Comprado"}
              </span>
            )}
          </div>
          <h3 className="mt-2 text-xl font-bold tracking-tight text-white">{catalog.name}</h3>
        </div>
      </button>

      <div className="flex flex-1 flex-col p-4 pt-3.5">
        {catalog.description && (
          <div>
            <p
              className={cn(
                "whitespace-pre-line text-sm leading-relaxed text-muted-foreground",
                !expanded && "line-clamp-3",
              )}
            >
              {catalog.description}
            </p>
            {long && (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="mt-1 text-xs font-semibold text-muted-foreground hover:text-foreground"
              >
                {expanded ? "Ver menos" : "Ver más"}
              </button>
            )}
          </div>
        )}
        <div className="mt-auto flex items-center justify-between gap-3 pt-4">
          {catalog.owned ? (
            <>
              <span className="text-sm text-muted-foreground">Listo para usar</span>
              <Button size="sm" className="rounded-full px-4" onClick={onAccess}>
                Entrar
              </Button>
            </>
          ) : (
            <>
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Pago único
                </p>
                <p className="font-price text-xl font-black tabular-nums text-foreground">
                  {formatCurrency(catalog.priceArs)}
                </p>
              </div>
              <Button size="sm" className="rounded-full px-4" loading={buying} onClick={onBuy}>
                <ShoppingBag size={15} /> Comprar
              </Button>
            </>
          )}
        </div>
      </div>
    </article>
  );
}

// ── Catálogo abierto: buscar + revisar + importar ──────────────────────────
function CatalogAccess({ catalog, onBack }: { catalog: StorefrontCatalog; onBack: () => void }) {
  const [query, setQuery] = useState("");
  const debounced = useDebouncedValue(query.trim(), 350);
  const [added, setAdded] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<CatalogSearchResult | null>(null);

  const { data: results, isFetching, isError, isLoading } = useCatalogSearch(catalog.id, debounced, true);
  // El precio de la tienda es referencia de mercado: respeta el switch del dueño.
  const { active: showMarketPrice } = useCatalogHintsActive();
  const hasQuery = debounced.length > 0;
  const empty = !isFetching && (results?.length ?? 0) === 0;

  return (
    <div>
      <button
        type="button"
        onClick={onBack}
        className="-ml-1 mb-5 inline-flex items-center gap-0.5 rounded-full py-1 pl-1 pr-3 text-sm font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
      >
        <ChevronLeft size={18} /> Tiendita
      </button>

      {/* Encabezado del catálogo */}
      <div className="flex items-center gap-4">
        <Cover catalog={catalog} className="h-16 w-16 shrink-0 rounded-lg sm:h-20 sm:w-20" />
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Catálogo
          </p>
          <h1 className="mt-0.5 break-words font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
            {catalog.name}
          </h1>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {catalog.productCount > 0 && (
              <Badge tone="neutral">
                <Layers size={11} /> {formatInt(catalog.productCount)} productos
              </Badge>
            )}
            <Badge tone="success">
              {catalog.source === "granted" ? <Gift size={11} /> : <Check size={11} />}
              {catalog.source === "granted" ? "De regalo" : "Comprado"}
            </Badge>
          </div>
        </div>
      </div>

      {/* Buscador (sticky en mobile para no perderlo al scrollear) */}
      <div className="sticky top-0 z-10 -mx-4 mt-6 bg-background px-4 py-2 backdrop-blur-xl sm:static sm:mx-0 sm:bg-transparent sm:px-0 sm:py-0 sm:backdrop-blur-none">
        <SearchField
          size="lg"
          autoFocus
          value={query}
          onValueChange={setQuery}
          loading={isFetching}
          placeholder="Buscar por nombre o código de barras"
          className="max-w-2xl"
        />
      </div>
      <p className="mt-2.5 flex items-start gap-1.5 text-xs text-muted-foreground">
        <Sparkles size={13} className="mt-px shrink-0 text-ninja-flameSoft" />
        Revisás y editás cada producto antes de importarlo. Después es 100% tuyo: precio, stock y foto.
      </p>

      {/* Resultados */}
      <div className="mt-6">
        {isLoading ? (
          <SpinnerBlock className="py-16" />
        ) : isError ? (
          <div className="rounded-lg border border-border bg-card">
            <EmptyState
              icon={SearchX}
              title="No se pudo buscar en el catálogo"
              description="Reintentá en un momento."
            />
          </div>
        ) : empty ? (
          <div className="rounded-lg border border-border bg-card">
            <EmptyState
              icon={hasQuery ? SearchX : PackageSearch}
              title={hasQuery ? "No encontramos ese producto" : "Buscá en el catálogo"}
              description={
                hasQuery
                  ? "Probá con otro nombre o con el código de barras."
                  : "Escribí un nombre o escaneá un código para empezar."
              }
            />
          </div>
        ) : (
          <>
            {!hasQuery && (
              <p className="mb-3 text-sm font-semibold text-foreground">Destacados del catálogo</p>
            )}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4">
              {(results ?? []).map((p) => (
                <ProductTile
                  key={p.catalogProductId}
                  product={p}
                  added={added.has(p.catalogProductId)}
                  showMarketPrice={showMarketPrice}
                  onAdd={() => setEditing(p)}
                />
              ))}
            </div>
          </>
        )}
      </div>

      <ImportProductModal
        open={editing != null}
        onOpenChange={(v) => !v && setEditing(null)}
        catalogId={catalog.id}
        product={editing}
        onImported={(id) => setAdded((prev) => new Set(prev).add(id))}
      />
    </div>
  );
}

function ProductTile({
  product: p,
  added,
  showMarketPrice,
  onAdd,
}: {
  product: CatalogSearchResult;
  added: boolean;
  showMarketPrice: boolean;
  onAdd: () => void;
}) {
  const path = splitCategoryPath(p.categoriaPath);
  const leaf = path[path.length - 1];
  const onSale = showMarketPrice && p.precioLista != null && p.precio != null && p.precioLista > p.precio;
  return (
    <article className="flex flex-col overflow-hidden rounded-lg border border-border bg-card">
      <div className="relative aspect-square bg-white">
        {p.fotoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={p.fotoUrl} alt={p.titulo} loading="lazy" className="h-full w-full object-contain p-4" />
        ) : (
          <div className="grid h-full w-full place-items-center bg-muted text-muted-foreground">
            <Package size={28} />
          </div>
        )}
        {onSale && (
          <span className="absolute left-2.5 top-2.5 rounded-md bg-ninja-flame px-2 py-0.5 text-[10px] font-bold text-white">
            Oferta
          </span>
        )}
        {!p.disponible && (
          <span className="absolute right-2.5 top-2.5 rounded-md bg-black/60 px-2 py-0.5 text-[10px] font-semibold text-white">
            Sin stock en origen
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col p-3 sm:p-3.5">
        {p.marca && (
          <p className="truncate text-[11px] font-semibold uppercase tracking-wide text-ninja-flameSoft">
            {p.marca}
          </p>
        )}
        <h3 className="mt-0.5 line-clamp-2 text-[13px] font-semibold leading-snug text-foreground sm:text-sm">
          {p.titulo}
        </h3>
        {leaf && <p className="mt-1 truncate text-xs text-muted-foreground">{leaf}</p>}
        <div className="mt-auto pt-2.5">
          {showMarketPrice && p.precio != null && (
            <div className="flex items-center gap-1.5">
              <StoreLogo storeKey={p.storeKey} name={p.storeKey} size={16} />
              <span className="font-price text-base font-bold tabular-nums text-foreground">
                {formatCurrency(p.precio)}
              </span>
              {onSale && (
                <span className="truncate text-[11px] text-muted-foreground line-through">
                  {formatCurrency(p.precioLista)}
                </span>
              )}
            </div>
          )}
          {showMarketPrice && p.precio != null && (
            <p className="text-[10px] text-muted-foreground">Precio de referencia; al importar ponés el tuyo.</p>
          )}
          {added ? (
            <span className="mt-2.5 flex h-9 w-full items-center justify-center gap-1.5 rounded-full bg-success/15 text-xs font-semibold text-success">
              <Check size={14} /> Importado
            </span>
          ) : (
            <button
              type="button"
              onClick={onAdd}
              className="mt-2.5 flex h-9 w-full items-center justify-center gap-1.5 rounded-full bg-ninja-flame/[0.12] text-xs font-semibold text-ninja-flameSoft transition hover:bg-ninja-flame/20 active:scale-[0.98]"
            >
              <Plus size={14} /> Agregar
            </button>
          )}
        </div>
      </div>
    </article>
  );
}
