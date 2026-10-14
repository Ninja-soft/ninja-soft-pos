"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Barcode, ImageOff, ImagePlus, Package, RotateCcw, Ruler } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { CategoryPathEditor } from "@/components/products/CategoryPathEditor";
import { AttributesEditor } from "@/components/products/AttributesEditor";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils/cn";
import { normalizeAttributes, type ProductAttribute } from "@/lib/products/attributes";
import {
  normalizeNodes,
  splitCategoryPath,
  suggestCategoryNodes,
  type CategoryLike,
  type CategoryNode,
} from "@/lib/products/categoryPath";
import { uploadProductImage } from "@/modules/products/images";
import { useCategories } from "@/modules/products/hooks";
import { useImportCatalogProduct } from "@/modules/tiendita/hooks";
import { MarketReferencePanel } from "@/components/catalog/MarketReferencePanel";
import { isValidGtin, measureLines } from "@/lib/catalog/importInfo";
import type { CatalogSearchResult } from "@/modules/tiendita/storefront";

const ADD_ERRORS: Record<string, string> = {
  catalog_not_owned:
    "Este negocio no tiene el catálogo habilitado (ni comprado ni bonificado). Revisá en Tiendita que figure como tuyo.",
  catalog_product_not_found: "Ese producto ya no está en el catálogo.",
  no_tenant: "Tu sesión no tiene un negocio activo. Cerrá sesión y volvé a entrar.",
  forbidden: "Sólo el dueño o un encargado pueden agregar productos.",
  sku_taken: "Ese SKU ya lo usa otro de tus productos. Cambialo o dejalo vacío.",
};

export function importErrorDetail(e: unknown): string | undefined {
  const raw = (e as { message?: string })?.message ?? "";
  return ADD_ERRORS[raw] ?? (raw || undefined);
}

const textarea =
  "min-h-[96px] w-full resize-y rounded-xl border-0 bg-muted px-3.5 py-3 text-sm leading-relaxed text-foreground outline-none transition placeholder:text-muted-foreground focus:bg-secondary focus:shadow-[inset_0_0_0_1px_var(--border)]";

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {title}
        </h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

const num = (v: string): number | null => {
  if (!v.trim()) return null;
  const n = Number(v.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const toInput = (n: number | null | undefined) =>
  n == null ? "" : String(n).replace(".", ",");

interface Draft {
  name: string;
  description: string;
  brand: string;
  model: string;
  barcode: string;
  sku: string;
  price: string;
  cost: string;
  trackStock: boolean;
  stock: string;
  attributes: ProductAttribute[];
  keepImage: boolean;
  nodes: CategoryNode[];
}

function initialDraft(p: CatalogSearchResult, cats: CategoryLike[]): Draft {
  return {
    name: p.titulo,
    description: p.descripcion ?? "",
    brand: p.marca ?? "",
    model: "",
    barcode: p.ean ?? "",
    // Sin EAN (ADR-118): el código de la tienda queda como SKU de referencia.
    sku: p.ean ? "" : (p.codigoTienda ?? ""),
    // Precio de venta SIEMPRE vacío: lo pone el negocio. El de las tiendas se
    // muestra abajo como referencia de mercado, nunca se copia (ADR-109).
    price: "",
    cost: "",
    trackStock: false,
    stock: "",
    attributes: normalizeAttributes(p.atributos),
    keepImage: Boolean(p.fotoUrl),
    nodes: suggestCategoryNodes(splitCategoryPath(p.categoriaPath), cats),
  };
}

// Editor previo al import: todo lo del catálogo se puede revisar y cambiar
// antes de que el producto pase a ser del negocio.
export function ImportProductModal({
  open,
  onOpenChange,
  catalogId,
  product,
  onImported,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  catalogId: string;
  product: CatalogSearchResult | null;
  onImported: (catalogProductId: number, existing: boolean) => void;
}) {
  const { toast } = useToast();
  const { data: categories = [], isLoading: catsLoading } = useCategories();
  const imp = useImportCatalogProduct(catalogId);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Arma el borrador cuando abre (y cuando llegan las categorías del negocio,
  // para sugerir el mapeo del árbol).
  useEffect(() => {
    if (!open || !product || catsLoading) return;
    setDraft(initialDraft(product, categories));
    setPhoto(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, product?.catalogProductId, catsLoading]);

  useEffect(() => {
    if (!photo) {
      setPhotoPreview(null);
      return;
    }
    const url = URL.createObjectURL(photo);
    setPhotoPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) =>
    setDraft((d) => (d ? { ...d, [k]: v } : d));

  const price = num(draft?.price ?? "");
  const cost = num(draft?.cost ?? "");
  const margin = useMemo(() => {
    if (price == null || cost == null || cost <= 0) return null;
    return ((price - cost) / cost) * 100;
  }, [price, cost]);

  const shownPhoto = photoPreview ?? (draft?.keepImage ? product?.fotoUrl ?? null : null);
  const measures = useMemo(() => measureLines(product?.medidas), [product?.medidas]);
  const typedBarcode = draft?.barcode.trim() ?? "";
  const barcodeLooksWrong = typedBarcode !== "" && !isValidGtin(typedBarcode);

  async function submit() {
    if (!product || !draft) return;
    if (!draft.name.trim()) {
      toast({ title: "Poné un nombre al producto", variant: "error" });
      return;
    }
    setSaving(true);
    try {
      const res = await imp.mutateAsync({
        catalogProductId: product.catalogProductId,
        overrides: {
          name: draft.name.trim(),
          description: draft.description.trim() || null,
          brand: draft.brand.trim() || null,
          model: draft.model.trim() || null,
          barcode: draft.barcode.trim() || null,
          sku: draft.sku.trim() || null,
          price: price ?? 0,
          cost,
          track_stock: draft.trackStock,
          stock: draft.trackStock ? num(draft.stock) ?? 0 : 0,
          attributes: normalizeAttributes(draft.attributes),
          keep_image: draft.keepImage && !photo,
          category_path: normalizeNodes(draft.nodes, categories),
        },
      });
      if (photo && res.productId && !res.existing) {
        try {
          const { data: row } = await createClient()
            .from("products")
            .select("tenant_id")
            .eq("id", res.productId)
            .single();
          if (row?.tenant_id) {
            await uploadProductImage({
              tenantId: row.tenant_id,
              productId: res.productId,
              file: photo,
              primary: true,
              sort: 0,
            });
          }
        } catch {
          toast({
            title: "El producto se importó, pero la foto no se pudo subir",
            description: "Subila desde Productos, en la ficha del producto.",
            variant: "error",
          });
        }
      }
      onImported(product.catalogProductId, res.existing);
      toast(
        res.existing
          ? {
              title: "Ya lo tenías en tus productos",
              description: draft.barcode.trim()
                ? "Hay un producto con ese código de barras; no se duplicó."
                : "Ya habías importado este producto del catálogo; no se duplicó.",
              variant: "success",
            }
          : {
              title: "Producto importado",
              description: `"${draft.name.trim()}" ya está en tus productos.`,
              variant: "success",
            },
      );
      onOpenChange(false);
    } catch (e) {
      toast({
        title: "No se pudo importar el producto",
        description: importErrorDetail(e),
        variant: "error",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Revisar antes de importar"
      description="Editá lo que quieras: al importarlo pasa a ser 100% tuyo."
      className="sm:max-w-2xl"
      footer={
        <>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button type="button" loading={saving} disabled={!draft} onClick={submit}>
            <Package size={16} /> Importar producto
          </Button>
        </>
      }
    >
      {!draft || !product ? (
        <div className="grid h-60 place-items-center">
          <Spinner size={24} />
        </div>
      ) : (
        <div className="space-y-7">
          {/* Foto + identidad */}
          <div className="flex gap-4">
            <div className="relative h-28 w-28 shrink-0 overflow-hidden rounded-lg bg-white sm:h-32 sm:w-32">
              {shownPhoto ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={shownPhoto} alt="" className="h-full w-full object-contain p-2" />
              ) : (
                <div className="grid h-full w-full place-items-center bg-muted text-muted-foreground">
                  <ImageOff size={24} />
                </div>
              )}
              {photo && (
                <span className="absolute left-1.5 top-1.5 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-semibold text-white">
                  Nueva
                </span>
              )}
            </div>
            <div className="min-w-0 flex-1 space-y-2.5">
              {product.fotoUrl && !photo && (
                <label className="flex items-center justify-between gap-3 rounded-xl bg-muted px-3 py-2.5 text-sm">
                  <span className="min-w-0">
                    <span className="block font-medium text-foreground">Foto del catálogo</span>
                    <span className="block text-xs text-muted-foreground">
                      Se copia a tus fotos como WebP.
                    </span>
                  </span>
                  <Switch
                    checked={draft.keepImage}
                    onCheckedChange={(v) => set("keepImage", v)}
                    label="Usar la foto del catálogo"
                  />
                </label>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="border-0"
                  onClick={() => fileRef.current?.click()}
                >
                  <ImagePlus size={15} /> {photo ? "Cambiar foto" : "Subir otra"}
                </Button>
                {photo && (
                  <Button type="button" size="sm" variant="ghost" onClick={() => setPhoto(null)}>
                    <RotateCcw size={14} /> Usar la del catálogo
                  </Button>
                )}
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) setPhoto(f);
                  e.target.value = "";
                }}
              />
            </div>
          </div>

          <Section title="Lo que trae del catálogo">
            <div className="grid gap-2.5 sm:grid-cols-2" data-testid="import-catalog-info">
              {product.ean ? (
                <div className="flex items-start gap-2.5 rounded-xl bg-muted px-3 py-2.5 text-sm" data-testid="import-ean">
                  <Barcode size={16} className="mt-0.5 shrink-0 text-success" aria-hidden />
                  <span className="min-w-0">
                    <span className="block font-medium text-foreground">Con EAN</span>
                    <span className="block font-mono text-xs tabular-nums text-muted-foreground">{product.ean}</span>
                  </span>
                </div>
              ) : (
                <div
                  className="space-y-2 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2.5 text-sm sm:col-span-2"
                  data-testid="import-sin-ean"
                >
                  <p className="flex items-start gap-2 text-foreground">
                    <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" aria-hidden />
                    <span>
                      <span className="font-medium">Sin EAN:</span> se carga con el código de la tienda
                      {product.codigoTienda ? (
                        <>
                          {" "}
                          (<span className="font-mono">{product.codigoTienda}</span>, como SKU)
                        </>
                      ) : null}
                      ; podés agregar el código de barras después.
                    </span>
                  </p>
                  <Input
                    variant="filled"
                    className="bg-card"
                    label="Código de barras (EAN), si lo tenés"
                    placeholder="Opcional"
                    inputMode="numeric"
                    value={draft.barcode}
                    onChange={(e) => set("barcode", e.target.value)}
                  />
                  {barcodeLooksWrong && (
                    <p className="text-xs text-muted-foreground">
                      No parece un EAN válido (revisá los dígitos). Se guarda igual.
                    </p>
                  )}
                </div>
              )}
              <div
                className={cn("flex items-start gap-2.5 rounded-xl bg-muted px-3 py-2.5 text-sm", !product.ean && "sm:col-span-2")}
                data-testid={measures.length ? "import-medidas" : "import-sin-medidas"}
              >
                <Ruler
                  size={16}
                  className={cn("mt-0.5 shrink-0", measures.length ? "text-success" : "text-muted-foreground")}
                  aria-hidden
                />
                {measures.length ? (
                  <span className="min-w-0">
                    <span className="block font-medium text-foreground">Con medidas</span>
                    <span className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                      {measures.map((m) => (
                        <span key={m.key}>
                          {m.label}: <span className="tabular-nums text-foreground">{m.value}</span>
                        </span>
                      ))}
                    </span>
                  </span>
                ) : (
                  <span className="min-w-0">
                    <span className="block font-medium text-foreground">Sin medidas</span>
                    <span className="block text-xs text-muted-foreground">
                      El catálogo no trae peso, volumen ni dimensiones. Podés cargarlas en la ficha después.
                    </span>
                  </span>
                )}
              </div>
            </div>
          </Section>

          <Section title="Datos">
            <Input
              variant="filled"
              label="Nombre"
              value={draft.name}
              maxLength={120}
              onChange={(e) => set("name", e.target.value)}
            />
            <div className="grid grid-cols-2 gap-3">
              <Input
                variant="filled"
                label="Marca"
                value={draft.brand}
                onChange={(e) => set("brand", e.target.value)}
              />
              <Input
                variant="filled"
                label="Modelo"
                placeholder="Opcional"
                value={draft.model}
                onChange={(e) => set("model", e.target.value)}
              />
            </div>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Descripción</span>
              <textarea
                className={textarea}
                value={draft.description}
                maxLength={4000}
                placeholder="Contá qué es, para qué sirve, presentación..."
                onChange={(e) => set("description", e.target.value)}
              />
            </label>
          </Section>

          <Section
            title="Árbol de jerarquía"
            aside={
              <span className="text-xs text-muted-foreground">Rubro, categoría y subcategoría</span>
            }
          >
            <CategoryPathEditor
              value={draft.nodes}
              onChange={(nodes) => set("nodes", nodes)}
              categories={categories}
              source={product.categoriaPath}
              onRestore={() =>
                set("nodes", suggestCategoryNodes(splitCategoryPath(product.categoriaPath), categories))
              }
            />
          </Section>

          <Section
            title="Precio y stock"
            aside={
              margin != null ? (
                <Badge tone={margin >= 0 ? "success" : "danger"}>
                  Margen {margin.toFixed(0)}%
                </Badge>
              ) : undefined
            }
          >
            <div className="grid grid-cols-2 gap-3">
              <Input
                variant="filled"
                label="Precio de venta"
                inputMode="decimal"
                placeholder="Poné tu precio"
                value={draft.price}
                onChange={(e) => set("price", e.target.value)}
              />
              <Input
                variant="filled"
                label="Costo"
                inputMode="decimal"
                placeholder="Opcional"
                value={draft.cost}
                onChange={(e) => set("cost", e.target.value)}
              />
            </div>
            <MarketReferencePanel ean={product.ean} myPrice={price} />
            <div className={cn("rounded-xl bg-muted px-3 py-2.5", draft.trackStock && "space-y-3 pb-3")}>
              <label className="flex items-center justify-between gap-3 text-sm">
                <span>
                  <span className="block font-medium text-foreground">Controlar stock</span>
                  <span className="block text-xs text-muted-foreground">
                    El catálogo no trae stock real: cargá el tuyo.
                  </span>
                </span>
                <Switch
                  checked={draft.trackStock}
                  onCheckedChange={(v) => set("trackStock", v)}
                  label="Controlar stock"
                />
              </label>
              {draft.trackStock && (
                <Input
                  label="Stock inicial"
                  inputMode="decimal"
                  placeholder="0"
                  value={draft.stock}
                  onChange={(e) => set("stock", e.target.value)}
                  variant="filled"
                  className="bg-card"
                />
              )}
            </div>
          </Section>

          <Section title="Códigos">
            <div className="grid grid-cols-2 gap-3">
              {product.ean && (
                <Input
                  variant="filled"
                  label="Código de barras (EAN)"
                  inputMode="numeric"
                  value={draft.barcode}
                  onChange={(e) => set("barcode", e.target.value)}
                />
              )}
              <Input
                variant="filled"
                label={product.ean ? "SKU" : "SKU (código de la tienda)"}
                placeholder="Opcional"
                value={draft.sku}
                onChange={(e) => set("sku", e.target.value)}
              />
            </div>
            {product.ean && barcodeLooksWrong && (
              <p className="text-xs text-muted-foreground">No parece un EAN válido (revisá los dígitos).</p>
            )}
            {product.ean && draft.barcode.trim() && draft.barcode.trim() !== product.ean && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Barcode size={13} /> Cambiaste el EAN del catálogo ({product.ean}).
              </p>
            )}
          </Section>

          <Section
            title="Atributos"
            aside={
              <span className="text-xs text-muted-foreground">
                Medidas primero; las del catálogo también se cargan como bultos
              </span>
            }
          >
            <AttributesEditor
              value={draft.attributes}
              onChange={(a) => set("attributes", a)}
              compact
            />
          </Section>
        </div>
      )}
    </Modal>
  );
}
