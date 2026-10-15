"use client";

import { useEffect, useMemo, useState } from "react";
import { ExternalLink, Search, Sparkles } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Input } from "@/components/ui/Input";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { ProductThumb } from "@/components/products/ProductThumb";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import { selectCls } from "@/components/stock/transfers/shared";
import { useVariants } from "@/modules/products/hooks";
import { useMlMutations, type MlItem } from "@/modules/mercadolibre/hooks";
import { useMlLinkCandidates, useMlLinkContext, type MlLinkCandidate } from "@/modules/mercadolibre/linkHooks";
import { mlErrorMessage } from "@/lib/mercadolibre/labels";
import {
  LINK_MATCH_LABELS,
  codesLine,
  isStrongMatch,
  linkMatchTone,
  matchVariant,
} from "@/lib/mercadolibre/linkMatch";

// Vincular una publicación (o una variación clásica) con un producto o
// variante del POS (ADR-104, ADR-141). Arriba, la publicación de Mercado
// Libre con su foto, marca y códigos; abajo, los productos con su foto,
// primero los sugeridos por código de barras, SKU o nombre parecido. Desde ahí
// stock y precio se sincronizan solos y las ventas descuentan ese producto.
// Los combos no se vinculan.
export function LinkProductModal({ item, onClose }: { item: MlItem | null; onClose: () => void }) {
  const { toast } = useToast();
  const { link } = useMlMutations();
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<MlLinkCandidate | null>(null);
  const [variantId, setVariantId] = useState<string>("");
  const [variationId, setVariationId] = useState("");

  const ctx = useMlLinkContext(item?.account_id ?? null, item?.id ?? null);
  const ctxSettled = !ctx.isLoading;
  const ids = ctx.data ? { gtins: ctx.data.gtins, skus: ctx.data.skus } : null;
  const cands = useMlLinkCandidates(item?.id ?? null, search, ids, ctxSettled);
  const list = cands.data?.candidates ?? [];
  const { data: variants = [] } = useVariants(picked?.product_id ?? null, Boolean(picked?.has_variants));

  const variations = ctx.data?.variations ?? [];
  const variation = variations.find((v) => v.id === variationId) ?? null;
  const needsVariation = Boolean(item?.has_variations);
  const needsVariant = Boolean(picked?.has_variants);

  // Variante preelegida: la que coincide con la variación de ML o la que
  // encontró el servidor por GTIN o SKU.
  useEffect(() => {
    if (!picked?.has_variants || variants.length === 0) return;
    const byVariation = matchVariant(variation, variants);
    const next = byVariation ?? picked.variant_id ?? "";
    if (next && variants.some((v) => v.id === next)) setVariantId(next);
  }, [picked, variants, variation]);

  const close = () => {
    setSearch("");
    setPicked(null);
    setVariantId("");
    setVariationId("");
    onClose();
  };

  const valid =
    Boolean(item && picked) &&
    (!needsVariant || Boolean(variantId)) &&
    (!needsVariation || /^\d{3,22}$/.test(variationId.trim()));

  const submit = () => {
    if (!item || !picked || !valid) return;
    link.mutate(
      {
        itemId: item.id,
        variationId: needsVariation ? variationId.trim() : null,
        productId: picked.product_id,
        variantId: needsVariant ? variantId : null,
        by: picked.match === "gtin" ? "gtin" : picked.match === "sku" ? "sku" : "manual",
      },
      {
        onSuccess: () => {
          toast({ title: "Publicación vinculada", description: "El stock y el precio se envían en unos segundos.", variant: "success" });
          close();
        },
        onError: (e) => toast({ title: "No se pudo vincular", description: mlErrorMessage(e), variant: "error" }),
      },
    );
  };

  const cover = variation?.picture ?? ctx.data?.pictures[0] ?? item?.thumbnail ?? null;
  const extraPics = useMemo(() => (ctx.data?.pictures ?? []).slice(1, 5), [ctx.data]);
  const searching = search.trim().length > 0;

  return (
    <Modal
      open={item !== null}
      onOpenChange={(o) => !o && close()}
      title="Vincular con un producto"
      description="Elegí el producto del POS que corresponde a esta publicación."
      className="sm:max-w-2xl"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={close}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={!valid} loading={link.isPending}>
            Vincular
          </Button>
        </div>
      }
    >
      {item && (
        <div className="space-y-4">
          {/* La publicación de Mercado Libre. */}
          <section aria-label="Publicación de Mercado Libre" className="flex gap-3 rounded-lg bg-secondary/50 p-3">
            <ProductThumb src={cover} size={72} className="rounded-lg" />
            <div className="min-w-0 flex-1 space-y-1">
              <p className="line-clamp-2 text-sm font-medium">{item.title}</p>
              <p className="text-xs text-muted-foreground">
                <span className="font-mono">{item.ml_item_id}</span>
                {item.price != null && <> · {formatCurrency(item.price)}</>}
                {ctx.data?.brand && <> · Marca {ctx.data.brand}</>}
              </p>
              {ctx.data && (ctx.data.gtins.length > 0 || ctx.data.skus.length > 0) && (
                <p className="truncate font-mono text-xs text-muted-foreground">
                  {[ctx.data.skus[0] ? `SKU ${ctx.data.skus[0]}` : null, ctx.data.gtins[0] ? `EAN ${ctx.data.gtins[0]}` : null]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              )}
              {ctx.isLoading && (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Spinner size={12} label="Leyendo la publicación" /> Leyendo fotos y códigos en Mercado Libre
                </p>
              )}
              {ctx.isError && (
                <p className="text-xs text-muted-foreground">No pudimos leer los códigos en Mercado Libre: sugerimos por el nombre.</p>
              )}
              <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                {extraPics.map((src) => (
                  <ProductThumb key={src} src={src} size={32} />
                ))}
                {item.permalink && (
                  <a
                    href={item.permalink}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline"
                  >
                    <ExternalLink size={12} /> Ver en Mercado Libre
                  </a>
                )}
              </div>
            </div>
          </section>

          {needsVariation &&
            (variations.length > 0 ? (
              <label className="block space-y-1.5">
                <span className="text-sm font-medium">Variación de Mercado Libre</span>
                <select
                  className={selectCls}
                  value={variationId}
                  onChange={(e) => setVariationId(e.target.value)}
                  aria-label="Variación de Mercado Libre"
                >
                  <option value="">Elegí la variación</option>
                  {variations.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                      {v.sku ? ` (SKU ${v.sku})` : ""}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <Input
                label="Id de la variación en Mercado Libre"
                inputMode="numeric"
                hint="La publicación es clásica con variaciones: cada variación se vincula aparte (Importar publicaciones las sugiere por SKU)."
                value={variationId}
                onChange={(e) => setVariationId(e.target.value)}
              />
            ))}

          <div className="relative">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="Buscá por nombre, SKU, código de barras o marca"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Buscar producto"
            />
          </div>

          <div className="space-y-1.5">
            <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              {searching ? (
                "Resultados"
              ) : (
                <>
                  <Sparkles size={13} aria-hidden /> Sugeridos para esta publicación
                </>
              )}
              {cands.isFetching && <Spinner size={12} label="Buscando" />}
            </p>
            <ul className="max-h-72 space-y-1 overflow-y-auto" aria-label={searching ? "Resultados" : "Sugeridos"}>
              {list.map((p) => {
                const active = picked?.product_id === p.product_id;
                return (
                  <li key={p.product_id}>
                    <button
                      type="button"
                      onClick={() => {
                        setPicked(p);
                        setVariantId("");
                      }}
                      aria-pressed={active}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-sm transition-colors",
                        active ? "bg-ninja-flame/10" : "hover:bg-secondary/60",
                      )}
                    >
                      <ProductThumb src={p.image_url} size={44} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{p.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {[p.brand, codesLine(p)].filter(Boolean).join(" · ") || "Sin código"}
                          {p.linked_elsewhere > 0 && ` · ya vinculado a ${p.linked_elsewhere}`}
                        </span>
                        {p.match && p.match !== "search" && (
                          <Badge tone={linkMatchTone(p.match)} className="mt-1">
                            {LINK_MATCH_LABELS[p.match]}
                            {p.variant_label ? ` · ${p.variant_label}` : ""}
                          </Badge>
                        )}
                      </span>
                      {p.price != null && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatCurrency(p.price)}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
            {!cands.isFetching && ctxSettled && list.length === 0 && (
              <p className="px-2 py-4 text-sm text-muted-foreground">
                {searching
                  ? "No hay productos con esa búsqueda."
                  : "No encontramos un producto parecido. Buscalo por nombre, SKU, código de barras o marca."}
              </p>
            )}
            {cands.isError && (
              <p className="px-2 py-2 text-sm text-danger">No se pudieron traer los productos: {mlErrorMessage(cands.error)}</p>
            )}
          </div>

          {picked && isStrongMatch(picked.match) && (
            <p className="text-xs text-muted-foreground">
              {picked.match === "gtin"
                ? "El código de barras del producto es el mismo que el de la publicación."
                : "El SKU del producto es el mismo que el de la publicación."}
            </p>
          )}

          {needsVariant && (
            <select className={selectCls} value={variantId} onChange={(e) => setVariantId(e.target.value)} aria-label="Variante">
              <option value="">Elegí la variante</option>
              {variants.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.option1}
                  {v.option2 ? ` / ${v.option2}` : ""}
                  {v.sku ? ` (${v.sku})` : ""}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
    </Modal>
  );
}
