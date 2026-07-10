"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  Layers,
  Package,
  PackagePlus,
  Search,
  ShoppingBag,
  Sparkles,
  Store,
} from "lucide-react";
import { Eyebrow, Display } from "@/components/ui/Typography";
import { Button } from "@/components/ui/Button";
import { Card, CardContent } from "@/components/ui/Card";
import { Spinner, SpinnerBlock } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { formatCurrency, formatInt } from "@/lib/utils/format";
import {
  useStorefrontCatalogs,
  useCatalogSearch,
  useAddCatalogProduct,
} from "@/modules/tiendita/hooks";
import { startCatalogCheckout } from "@/modules/tiendita/storefront";
import type {
  StorefrontCatalog,
  CatalogSearchResult,
} from "@/modules/tiendita/storefront";
import { TienditaIntro } from "./TienditaIntro";

// Mensajes honestos para los códigos de error del checkout.
const CHECKOUT_ERRORS: Record<string, string> = {
  platform_not_configured:
    "El cobro todavía no está habilitado. NinjaSoft tiene que conectar su Mercado Pago.",
  already_owned: "Ya tenés acceso a este catálogo.",
  catalog_unavailable: "Este catálogo no está disponible en este momento.",
  invalid_catalog_price: "Este catálogo no tiene un precio válido para cobrar.",
  forbidden: "Solo el dueño de la cuenta puede comprar catálogos.",
};

// Mensajes honestos para los códigos de error del alta de producto
// (add_catalog_product_to_tenant). Antes se colapsaba todo a un toast genérico
// y un "catalog_not_owned" (catálogo no comprado/bonificado para ESTE negocio)
// era indistinguible de un error real de red.
const ADD_ERRORS: Record<string, string> = {
  catalog_not_owned:
    "Este negocio no tiene el catálogo habilitado (ni comprado ni bonificado). Revisá en Tiendita que figure como tuyo.",
  catalog_product_not_found: "Ese producto ya no está en el catálogo.",
  no_tenant: "Tu sesión no tiene un negocio activo. Cerrá sesión y volvé a entrar.",
};

function addErrorDetail(e: unknown): string | undefined {
  const raw = (e as { message?: string })?.message ?? "";
  return ADD_ERRORS[raw] ?? (raw || undefined);
}

export function TienditaView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: catalogs, isLoading } = useStorefrontCatalogs();
  // Catálogo abierto (vista de acceso/buscador). null = grilla de catálogos.
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
    // Reintento suave: el webhook puede tardar; refrescamos un par de veces.
    const t1 = setTimeout(
      () => qc.invalidateQueries({ queryKey: ["tiendita", "catalogs"] }),
      4000,
    );
    const t2 = setTimeout(
      () => qc.invalidateQueries({ queryKey: ["tiendita", "catalogs"] }),
      9000,
    );
    router.replace("/tiendita");
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // Si el catálogo abierto se actualiza (p. ej. pasó a owned), reflejarlo.
  const openCatalogFresh = useMemo(
    () => catalogs?.find((c) => c.id === openCatalog?.id) ?? openCatalog,
    [catalogs, openCatalog],
  );

  const buy = useMutation({
    mutationFn: async (catalog: StorefrontCatalog) => {
      const backUrl = `${window.location.origin}/tiendita?bought=ok`;
      return startCatalogCheckout(catalog.id, backUrl);
    },
    onSuccess: (initPoint) => {
      window.location.href = initPoint;
    },
    onError: (e: Error) => {
      // already_owned: refrescamos para mostrar "Acceder".
      if (e.message === "already_owned") {
        qc.invalidateQueries({ queryKey: ["tiendita", "catalogs"] });
      }
      toast({
        title: CHECKOUT_ERRORS[e.message] ?? "No se pudo iniciar la compra",
        variant: "error",
      });
    },
  });

  return (
    <>
      <TienditaIntro />

      <div className="mx-auto max-w-6xl px-6 py-8">
        {openCatalogFresh && openCatalogFresh.owned ? (
          <CatalogAccess
            catalog={openCatalogFresh}
            onBack={() => setOpenCatalog(null)}
          />
        ) : (
          <>
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <Eyebrow>NinjaSoft</Eyebrow>
                <Display className="mt-3 flex items-center gap-2 text-3xl md:text-4xl">
                  <ShoppingBag size={30} className="text-ninja-flameSoft" />
                  Tiendita
                </Display>
                <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
                  Catálogos precargados de las marcas más grandes. Comprá uno
                  (pago único) y sumá sus productos a tu tienda en un clic, con
                  foto, marca y categoría ya armadas.
                </p>
              </div>
            </div>

            {/* Grilla de catálogos */}
            <div className="mt-8">
              {isLoading ? (
                <SpinnerBlock />
              ) : (catalogs?.length ?? 0) === 0 ? (
                <Card>
                  <CardContent className="p-10 text-center text-sm text-muted-foreground">
                    Todavía no hay catálogos disponibles. Volvé pronto: estamos
                    sumando marcas.
                  </CardContent>
                </Card>
              ) : (
                <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                  {(catalogs ?? []).map((c) => (
                    <CatalogCard
                      key={c.id}
                      catalog={c}
                      buying={buy.isPending && buy.variables?.id === c.id}
                      onBuy={() => buy.mutate(c)}
                      onAccess={() => setOpenCatalog(c)}
                    />
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}

// ── Tarjeta de catálogo en la grilla ────────────────────────────────────────
function CatalogCard({
  catalog,
  buying,
  onBuy,
  onAccess,
}: {
  catalog: StorefrontCatalog;
  buying: boolean;
  onBuy: () => void;
  onAccess: () => void;
}) {
  return (
    <Card className="group flex flex-col overflow-hidden transition hover:border-ninja-flameSoft/50">
      {/* Carátula */}
      <div className="relative aspect-[16/10] w-full overflow-hidden bg-ninja-dark">
        {catalog.coverUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={catalog.coverUrl}
            alt={catalog.name}
            className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.03]"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-[radial-gradient(70%_70%_at_50%_30%,rgba(236,63,23,0.22),transparent_70%)]">
            <Package size={40} className="text-white/40" />
          </div>
        )}
        {catalog.owned && (
          <span className="absolute right-3 top-3 inline-flex items-center gap-1 rounded-full border border-emerald-400/40 bg-emerald-500/20 px-2.5 py-1 text-[11px] font-semibold text-success backdrop-blur">
            <Check size={12} />
            {catalog.source === "granted" ? "Acceso de regalo" : "Comprado"}
          </span>
        )}
        {/* Tamaño del catálogo: info comercial (visible antes de comprar). */}
        {catalog.productCount > 0 && (
          <span className="absolute bottom-3 left-3 inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-black/55 px-2.5 py-1 text-[11px] font-semibold text-white backdrop-blur-sm">
            <Layers size={12} className="text-ninja-flameSoft" />
            Incluye {formatInt(catalog.productCount)} productos
          </span>
        )}
      </div>

      <CardContent className="flex flex-1 flex-col p-5">
        <h3 className="text-base font-bold text-foreground">{catalog.name}</h3>
        {catalog.description && (
          // Descripción completa: scroll interno cuando es larga (no se trunca).
          <p className="slim-scrollbar mt-1 max-h-24 overflow-y-auto whitespace-pre-line pr-1 text-sm leading-relaxed text-muted-foreground">
            {catalog.description}
          </p>
        )}

        <div className="mt-4 flex items-end justify-between gap-3 pt-1">
          {catalog.owned ? (
            <>
              <span className="inline-flex items-center gap-1.5 text-sm font-medium text-success">
                <Check size={15} /> Ya tenés acceso
              </span>
              <Button size="sm" onClick={onAccess}>
                <Search size={15} /> Acceder
              </Button>
            </>
          ) : (
            <>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Pago único
                </div>
                <div className="font-price text-xl font-black text-foreground">
                  {formatCurrency(catalog.priceArs)}
                </div>
              </div>
              <Button size="sm" loading={buying} onClick={onBuy}>
                <ShoppingBag size={15} /> Comprar
              </Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Vista de acceso a un catálogo comprado: buscar + agregar ────────────────
function CatalogAccess({
  catalog,
  onBack,
}: {
  catalog: StorefrontCatalog;
  onBack: () => void;
}) {
  const { toast } = useToast();
  const [query, setQuery] = useState("");
  const debounced = useDebouncedValue(query.trim(), 350);
  // Productos ya agregados en esta sesión (para mostrar el check sin re-fetch).
  const [added, setAdded] = useState<Set<number>>(new Set());

  const { data: results, isFetching, isError } = useCatalogSearch(
    catalog.id,
    debounced,
    true,
  );

  const add = useAddCatalogProduct(catalog.id);

  function onAdd(p: CatalogSearchResult) {
    if (added.has(p.catalogProductId)) return;
    add.mutate(p.catalogProductId, {
      onSuccess: () => {
        setAdded((prev) => new Set(prev).add(p.catalogProductId));
        toast({
          title: "Producto agregado",
          description: `"${p.titulo}" ya está en tus productos.`,
          variant: "success",
        });
      },
      onError: (e) =>
        toast({
          title: "No se pudo agregar el producto",
          description: addErrorDetail(e),
          variant: "error",
        }),
    });
  }

  const hasQuery = debounced.length > 0;
  const empty = !isFetching && (results?.length ?? 0) === 0;

  return (
    <div>
      <button
        type="button"
        onClick={onBack}
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-foreground"
      >
        <ArrowLeft size={16} /> Volver a Tiendita
      </button>

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Eyebrow>Catálogo</Eyebrow>
          <Display className="mt-3 flex items-center gap-2 text-2xl md:text-3xl">
            <Store size={26} className="text-ninja-flameSoft" />
            {catalog.name}
          </Display>
        </div>
      </div>

      {/* Aclaración: el producto pasa a ser 100% del cliente; no hay export masivo. */}
      <div className="mt-5 flex items-start gap-2.5 rounded-xl border border-ninja-flame/25 bg-ninja-flame/[0.06] p-4 text-sm text-muted-foreground">
        <Sparkles size={16} className="mt-0.5 shrink-0 text-ninja-flameSoft" />
        <p>
          Buscá un producto y agregalo: pasa a ser{" "}
          <strong className="text-foreground">100% tuyo</strong> (lo editás,
          ponés tu precio y tu stock). Podés volver a este maestro cuando
          quieras. Se agrega <strong className="text-foreground">de a uno</strong>{" "}
          o por código/escaneo; no se exporta todo el catálogo a Excel.
        </p>
      </div>

      {/* Buscador */}
      <div className="relative mt-5 max-w-xl">
        <Search
          size={18}
          className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar por nombre o código de barras (EAN)…"
          className="h-12 w-full rounded-xl border border-input bg-background pl-11 pr-11 text-sm text-foreground outline-none transition focus:border-ninja-flameSoft focus:ring-4 focus:ring-ninja-flameSoft/15"
        />
        {isFetching && (
          <span className="absolute right-3.5 top-1/2 -translate-y-1/2">
            <Spinner size={18} />
          </span>
        )}
      </div>

      {/* Resultados */}
      <div className="mt-6">
        {isError ? (
          <Card>
            <CardContent className="p-8 text-center text-sm text-danger">
              No se pudo buscar en el catálogo. Reintentá en un momento.
            </CardContent>
          </Card>
        ) : empty ? (
          <Card>
            <CardContent className="p-8 text-center text-sm text-muted-foreground">
              {hasQuery ? (
                <>
                  Lamentablemente ese producto no existe en el catálogo. Probá
                  con otro nombre o código.
                </>
              ) : (
                "Empezá a escribir para buscar productos en el catálogo."
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {(results ?? []).map((p) => {
              const isAdded = added.has(p.catalogProductId);
              const adding = add.isPending && add.variables === p.catalogProductId;
              return (
                <Card key={p.catalogProductId} className="overflow-hidden">
                  <CardContent className="flex gap-3 p-3.5">
                    <span className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-lg border border-border bg-background">
                      {p.fotoUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={p.fotoUrl}
                          alt={p.titulo}
                          className="h-full w-full object-contain p-1"
                          loading="lazy"
                        />
                      ) : (
                        <Package size={20} className="text-muted-foreground" />
                      )}
                    </span>

                    <div className="min-w-0 flex-1">
                      {/* Nombre del producto completo: scroll interno si es muy largo. */}
                      <div className="slim-scrollbar max-h-16 overflow-y-auto break-words pr-1 text-sm font-medium leading-relaxed text-foreground">
                        {p.titulo}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                        {p.marca && (
                          <span className="font-medium text-ninja-flameSoft">
                            {p.marca}
                          </span>
                        )}
                        {p.categoriaPath && (
                          <span className="break-words">{p.categoriaPath}</span>
                        )}
                      </div>
                      <div className="mt-1 flex items-center gap-2">
                        {p.precio != null && (
                          <span className="font-price text-sm font-bold text-foreground">
                            {formatCurrency(p.precio)}
                          </span>
                        )}
                        {p.precioLista != null &&
                          p.precioLista !== p.precio && (
                            <span className="text-xs text-muted-foreground line-through">
                              {formatCurrency(p.precioLista)}
                            </span>
                          )}
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center">
                      {isAdded ? (
                        <span className="inline-flex items-center gap-1 rounded-lg border border-emerald-400/40 bg-emerald-500/10 px-2.5 py-1.5 text-xs font-semibold text-success">
                          <Check size={14} /> Agregado
                        </span>
                      ) : (
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={adding}
                          onClick={() => onAdd(p)}
                        >
                          <PackagePlus size={15} /> Agregar
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
