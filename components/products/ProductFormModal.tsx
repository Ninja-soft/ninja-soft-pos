"use client";

import { useEffect, useMemo, useState } from "react";
import { useForm, type FieldErrors } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import {
  Barcode as BarcodeIcon,
  Boxes,
  Camera,
  ChevronDown,
  CircleDollarSign,
  Info,
  LayoutGrid,
  Plus,
  Settings2,
  Tag,
  Warehouse,
} from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Switch } from "@/components/ui/Switch";
import { Disclosure } from "@/components/ui/Disclosure";
import { NoData } from "@/components/ui/NoData";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import {
  ProductSchema,
  type ProductInput,
  type ProductOutput,
} from "@/modules/products/schemas";
import { categoriesApi, packagesApi, type Product } from "@/modules/products/api";
import { KDS_STATIONS, KDS_STATION_LABELS } from "@/modules/dining/api";
import { useDiningEnabled } from "@/modules/dining/hooks";
import { usePriceLists } from "@/modules/prices/hooks";
import { useFeature } from "@/modules/saas/gating";
import { ProductImages } from "@/components/products/ProductImages";
import { KitComponentsEditor } from "@/components/products/KitComponentsEditor";
import { SerialsEditor } from "@/components/products/SerialsEditor";
import { VariantsEditor } from "@/components/products/VariantsEditor";
import { ModifiersEditor } from "@/components/products/ModifiersEditor";
import { RecipeEditor } from "@/components/products/RecipeEditor";
import { AttributesEditor } from "@/components/products/AttributesEditor";
import { CategoryPathEditor } from "@/components/products/CategoryPathEditor";
import { PackagesEditor } from "@/components/products/PackagesEditor";
import { Barcode } from "@/components/products/Barcode";
import { FeatureGate } from "@/components/saas/FeatureGate";
import { normalizeAttributes, type ProductAttribute } from "@/lib/products/attributes";
import { diffPackages, type ProductPackage } from "@/lib/products/packages";
import {
  normalizeNodes,
  pathToCategory,
  type CategoryNode,
} from "@/lib/products/categoryPath";
import {
  useCategories,
  useBrands,
  useCreateBrand,
  useProductMutations,
  usePluSettings,
  useProductPackages,
} from "@/modules/products/hooks";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product?: Product | null;
}

type TabKey = "general" | "precios" | "stock" | "codigos" | "atributos" | "fotos" | "medidas" | "mas";

const TABS: { key: TabKey; label: string; icon: typeof Info }[] = [
  { key: "general", label: "General", icon: LayoutGrid },
  { key: "precios", label: "Precios", icon: CircleDollarSign },
  { key: "stock", label: "Stock", icon: Warehouse },
  { key: "codigos", label: "Códigos", icon: BarcodeIcon },
  { key: "atributos", label: "Atributos", icon: Tag },
  { key: "fotos", label: "Fotos", icon: Camera },
  { key: "medidas", label: "Medidas", icon: Boxes },
  { key: "mas", label: "Más", icon: Settings2 },
];

// Campo → pestaña (para llevar al usuario al error si está en otra pestaña).
const FIELD_TAB: Partial<Record<keyof ProductInput, TabKey>> = {
  name: "general",
  description: "general",
  model: "general",
  price: "precios",
  cost: "precios",
  tax_rate: "precios",
  stock: "stock",
  stock_min: "stock",
  unit: "stock",
  sku: "codigos",
  barcode: "codigos",
  plu: "codigos",
  service_duration_min: "mas",
  commission_pct: "mas",
};

const selectCls =
  "h-11 w-full appearance-none rounded-xl border-0 bg-muted px-3.5 pr-9 text-sm text-foreground outline-none transition focus:bg-secondary focus:shadow-[inset_0_0_0_1px_var(--border)]";
const textareaCls =
  "min-h-[110px] w-full resize-y rounded-xl border-0 bg-muted px-3.5 py-3 text-sm leading-relaxed text-foreground outline-none transition placeholder:text-muted-foreground focus:bg-secondary focus:shadow-[inset_0_0_0_1px_var(--border)]";

function Group({
  title,
  description,
  aside,
  children,
}: {
  title?: string;
  description?: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      {(title || aside) && (
        <div className="flex items-end justify-between gap-2">
          <div className="min-w-0">
            {title && (
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                {title}
              </h3>
            )}
            {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
          </div>
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

// Fila de ajuste estilo iOS: título + bajada a la izquierda, control a la derecha.
function SettingRow({
  title,
  description,
  control,
  disabled,
  hint,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  control: React.ReactNode;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <div
      className={cn("flex items-center justify-between gap-4 px-3.5 py-3", disabled && "opacity-50")}
      title={hint}
    >
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{title}</p>
        {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
      </div>
      {control}
    </div>
  );
}

function SaveFirst({ children }: { children: React.ReactNode }) {
  return <p className="rounded-xl bg-muted p-3.5 text-xs text-muted-foreground">{children}</p>;
}

export function ProductFormModal({ open, onOpenChange, product }: Props) {
  // Tras crear, seguimos en modo edición (fotos / componentes / seriales).
  const [created, setCreated] = useState<Product | null>(null);
  const active = product ?? created;
  const isEdit = Boolean(active);
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: categories = [] } = useCategories();
  const { data: brands } = useBrands();
  const createBrand = useCreateBrand();
  const { create, update } = useProductMutations();
  const { data: plu } = usePluSettings();
  const pluEnabled = plu?.enabled ?? false;
  const { data: diningEnabled } = useDiningEnabled();
  const { data: priceLists = [] } = usePriceLists();
  const packagesAllowed = useFeature("medidas_bultos") !== false;
  const { data: savedPackages = [], isLoading: packagesLoading } = useProductPackages(
    active?.id ?? null,
  );

  const [tab, setTab] = useState<TabKey>("general");
  const [newBrand, setNewBrand] = useState("");
  const [addingBrand, setAddingBrand] = useState(false);
  const [nodes, setNodes] = useState<CategoryNode[]>([]);
  const [attributes, setAttributes] = useState<ProductAttribute[]>([]);
  const [packages, setPackages] = useState<ProductPackage[]>([]);
  const [marginDraft, setMarginDraft] = useState<string | null>(null);
  const [savingExtras, setSavingExtras] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors },
  } = useForm<ProductInput>({ resolver: zodResolver(ProductSchema) });
  const isKit = watch("is_kit");
  const isSerialized = watch("is_serialized");
  const hasVariants = watch("has_variants");
  const trackStock = watch("track_stock");
  const isActive = watch("is_active");
  const isFavorite = watch("is_favorite");
  const priceRaw = watch("price");
  const costRaw = watch("cost");
  const barcodeVal = watch("barcode");
  const nameVal = watch("name");

  // Tipos de producto mutuamente excluyentes (constraint también en DB).
  const kitDisabled = Boolean(isSerialized || hasVariants);
  const serializedDisabled = Boolean(isKit || hasVariants);
  const variantsDisabled = Boolean(isKit || isSerialized);
  const exclusiveHint =
    "Incompatible con kit / serializado / variantes. Desmarcá el otro tipo primero.";

  useEffect(() => {
    if (!open) return;
    setCreated(null);
    setTab("general");
    setMarginDraft(null);
    setAddingBrand(false);
    setAttributes(normalizeAttributes(product?.attributes));
    setNodes(pathToCategory(product?.category_id ?? null, categories));
    reset({
      name: product?.name ?? "",
      sku: product?.sku ?? "",
      barcode: product?.barcode ?? "",
      plu: product?.plu ?? "",
      category_id: product?.category_id ?? null,
      brand_id: product?.brand_id ?? null,
      price: product?.price ?? 0,
      cost: product?.cost ?? undefined,
      stock: product?.stock ?? 0,
      stock_min: product?.stock_min ?? 0,
      unit: product?.unit ?? "un",
      tax_rate: product?.tax_rate ?? 21,
      season: product?.season ?? "",
      tags: product?.tags?.join(", ") ?? "",
      image_url: product?.image_url ?? "",
      description: product?.description ?? "",
      model: product?.model ?? "",
      attributes: [],
      is_active: product?.is_active ?? true,
      is_kit: product?.is_kit ?? false,
      is_serialized: product?.is_serialized ?? false,
      has_variants: product?.has_variants ?? false,
      track_stock: product?.track_stock ?? true,
      allow_negative:
        product?.allow_negative == null ? "inherit" : product.allow_negative ? "yes" : "no",
      warranty_months: product?.warranty_months ?? 0,
      is_favorite: product?.is_favorite ?? false,
      favorite_order: product?.favorite_order ?? 0,
      service_duration_min: product?.service_duration_min ?? "",
      commission_pct: product?.commission_pct ?? "",
      station: product?.station ?? "",
    });
    // categories entra aparte (abajo) para no resetear el form al llegar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, product, reset]);

  // Las categorías pueden llegar después de abrir: completamos la ruta.
  useEffect(() => {
    if (open && product?.category_id && nodes.length === 0 && categories.length > 0) {
      setNodes(pathToCategory(product.category_id, categories));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, categories.length]);

  // Bultos guardados → estado editable (cuando abre o cambia el producto).
  useEffect(() => {
    if (open) setPackages(savedPackages);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active?.id, packagesLoading]);

  useEffect(() => {
    if (created?.plu) setValue("plu", created.plu);
  }, [created, setValue]);

  const price = Number(priceRaw ?? 0) || 0;
  const cost =
    costRaw == null || (costRaw as unknown) === "" ? null : Number(costRaw);
  const margin = cost && cost > 0 ? ((price - cost) / cost) * 100 : null;
  const profit = cost != null ? price - cost : null;

  function onMarginChange(v: string) {
    setMarginDraft(v);
    const m = Number(v.replace(",", "."));
    if (cost && cost > 0 && Number.isFinite(m)) {
      setValue("price", Math.round(cost * (1 + m / 100) * 100) / 100, { shouldDirty: true });
    }
  }

  const listPreview = useMemo(
    () =>
      priceLists
        .filter((l) => l.is_active)
        .map((l) => ({
          id: l.id,
          name: l.name,
          pct: l.adjustment_pct,
          price: l.adjustment_pct == null ? null : price * (1 + Number(l.adjustment_pct) / 100),
        })),
    [priceLists, price],
  );

  function onInvalid(errs: FieldErrors<ProductInput>) {
    const first = Object.keys(errs)[0] as keyof ProductInput | undefined;
    const t = first ? FIELD_TAB[first] : undefined;
    if (t) setTab(t);
    toast({ title: "Revisá los datos marcados", variant: "error" });
  }

  async function saveExtras(productId: string) {
    if (!packagesAllowed) return;
    const d = diffPackages(savedPackages, packages);
    if (d.insert.length + d.update.length + d.remove.length === 0) return;
    await packagesApi.save(productId, savedPackages, packages);
    await qc.invalidateQueries({ queryKey: ["product-packages", productId] });
  }

  async function onSubmit(values: ProductInput) {
    const parsed = values as unknown as ProductOutput;
    const exclusive = [parsed.is_kit, parsed.is_serialized, parsed.has_variants].filter(Boolean);
    if (exclusive.length > 1) {
      toast({
        title: "Un producto no puede ser kit, serializado y con variantes a la vez",
        variant: "error",
      });
      return;
    }
    setSavingExtras(true);
    try {
      // Árbol de categorías: crea los niveles nuevos y usa la hoja.
      const path = normalizeNodes(nodes, categories);
      const categoryId = path.length === 0 ? null : await categoriesApi.ensurePath(path);
      if (path.some((n) => !n.id)) qc.invalidateQueries({ queryKey: ["categories"] });
      const input: ProductOutput = {
        ...parsed,
        category_id: categoryId,
        attributes: normalizeAttributes(attributes),
      };
      if (active) {
        await update.mutateAsync({ id: active.id, input });
        await saveExtras(active.id);
        toast({ title: "Producto actualizado", variant: "success" });
        onOpenChange(false);
        return;
      }
      const nuevo = await create.mutateAsync(input);
      await saveExtras(nuevo.id);
      setCreated(nuevo);
      toast({
        title: "Producto creado",
        description: "Ahora podés subir fotos o cargar componentes.",
        variant: "success",
      });
    } catch (e) {
      toast({
        title: "No se pudo guardar",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    } finally {
      setSavingExtras(false);
    }
  }

  async function addBrand() {
    if (newBrand.trim().length < 1) return;
    try {
      const b = await createBrand.mutateAsync(newBrand.trim());
      setValue("brand_id", b.id);
      setNewBrand("");
      setAddingBrand(false);
      toast({ title: "Marca creada", variant: "success" });
    } catch {
      toast({ title: "No se pudo crear la marca", variant: "error" });
    }
  }

  const saving = create.isPending || update.isPending || savingExtras;
  const show = (k: TabKey) => (tab === k ? "space-y-6" : "hidden");

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? "Editar producto" : "Nuevo producto"}
      className="sm:max-w-3xl"
      footer={
        <>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            {created ? "Cerrar" : "Cancelar"}
          </Button>
          <Button type="submit" form="product-form" loading={saving}>
            {isEdit ? "Guardar" : "Crear producto"}
          </Button>
        </>
      }
    >
      {/* Pestañas de secciones (relleno en la activa, sin bordes de color). */}
      <div className="sticky -top-5 z-10 -mx-5 -mt-5 mb-5 bg-popover px-5 pb-3 pt-4 backdrop-blur sm:-top-6 sm:-mx-6 sm:-mt-6 sm:px-6">
        <div className="-mx-1 flex [scrollbar-width:none] [&::-webkit-scrollbar]:hidden gap-1 overflow-x-auto px-1">
          {TABS.map((t) => {
            const on = tab === t.key;
            const Icon = t.icon;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={cn(
                  "inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold outline-none transition focus-visible:bg-muted",
                  on
                    ? "bg-ninja-flame/[0.12] text-ninja-flameSoft"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <Icon size={14} /> {t.label}
              </button>
            );
          })}
        </div>
      </div>

      <form id="product-form" onSubmit={handleSubmit(onSubmit, onInvalid)} noValidate>
        {/* ── General ─────────────────────────────────────────────── */}
        <div className={show("general")}>
          <Group>
            <Input variant="filled" label="Nombre" error={errors.name?.message} {...register("name")} />
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Marca</label>
                <div className="relative">
                  <select className={selectCls} {...register("brand_id")}>
                    <option value="" className="bg-popover text-popover-foreground">
                      Sin marca
                    </option>
                    {brands?.map((b) => (
                      <option key={b.id} value={b.id} className="bg-popover text-popover-foreground">
                        {b.name}
                      </option>
                    ))}
                  </select>
                  <ChevronDown
                    size={15}
                    className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                  />
                </div>
              </div>
              <Input variant="filled" label="Modelo" placeholder="Opcional" {...register("model")} />
            </div>
            {addingBrand ? (
              <div className="flex gap-2">
                <Input
                  variant="filled"
                  value={newBrand}
                  onChange={(e) => setNewBrand(e.target.value)}
                  placeholder="Nombre de la marca"
                  autoFocus
                  className="h-10"
                />
                <Button type="button" size="sm" className="h-10" onClick={addBrand} loading={createBrand.isPending}>
                  Crear
                </Button>
                <Button type="button" size="sm" variant="ghost" className="h-10" onClick={() => setAddingBrand(false)}>
                  Cancelar
                </Button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setAddingBrand(true)}
                className="-mt-1 inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition hover:text-foreground"
              >
                <Plus size={13} /> Nueva marca
              </button>
            )}
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Descripción</span>
              <textarea
                className={textareaCls}
                placeholder="Qué es, para qué sirve, presentación, cuidados..."
                maxLength={4000}
                {...register("description")}
              />
              {errors.description?.message && (
                <span className="mt-1 block text-xs text-destructive">{errors.description.message}</span>
              )}
            </label>
          </Group>

          <Group title="Árbol de jerarquía" description="Rubro, categoría y subcategoría. Elegí existentes o creá nuevas acá mismo.">
            <CategoryPathEditor value={nodes} onChange={setNodes} categories={categories} />
          </Group>

          <Group title="Visibilidad">
            <div className="divide-y divide-border rounded-2xl bg-muted">
              <SettingRow
                title="Activo"
                description="Se puede vender y aparece en el POS."
                control={
                  <Switch
                    checked={Boolean(isActive)}
                    onCheckedChange={(v) => setValue("is_active", v, { shouldDirty: true })}
                    label="Activo"
                  />
                }
              />
              <SettingRow
                title="Favorito (botón rápido del POS)"
                description="Aparece como botón grande para cobrarlo sin buscar."
                control={
                  <Switch
                    checked={Boolean(isFavorite)}
                    onCheckedChange={(v) => setValue("is_favorite", v, { shouldDirty: true })}
                    label="Favorito"
                  />
                }
              />
            </div>
          </Group>
        </div>

        {/* ── Precios ─────────────────────────────────────────────── */}
        <div className={show("precios")}>
          <Group
            title="Precio"
            aside={
              margin != null ? (
                <Badge tone={margin >= 0 ? "success" : "danger"}>
                  Ganás {profit != null ? formatCurrency(profit) : ""}
                </Badge>
              ) : undefined
            }
          >
            <div className="grid grid-cols-3 gap-3">
              <Input
                variant="filled"
                label="Costo"
                type="number"
                step="0.01"
                inputMode="decimal"
                placeholder="0"
                error={errors.cost?.message}
                {...register("cost", { onChange: () => setMarginDraft(null) })}
              />
              <Input
                variant="filled"
                label="Margen %"
                inputMode="decimal"
                placeholder={cost ? "0" : "Cargá el costo"}
                disabled={!cost}
                value={marginDraft ?? (margin != null ? String(Math.round(margin * 10) / 10).replace(".", ",") : "")}
                onChange={(e) => onMarginChange(e.target.value)}
                onBlur={() => setMarginDraft(null)}
              />
              <Input
                variant="filled"
                label="Precio de venta"
                type="number"
                step="0.01"
                inputMode="decimal"
                error={errors.price?.message}
                {...register("price", { onChange: () => setMarginDraft(null) })}
              />
            </div>
            <Input
              variant="filled"
              label="IVA %"
              type="number"
              step="0.5"
              className="max-w-[140px]"
              {...register("tax_rate")}
            />
          </Group>

          <Group title="Listas de precios" description="Cómo queda este precio en cada lista activa.">
            {listPreview.length === 0 ? (
              <SaveFirst>
                No tenés listas de precios activas. Las armás en Productos, en Listas de precios.
              </SaveFirst>
            ) : (
              <div className="divide-y divide-border rounded-2xl bg-muted">
                {listPreview.map((l) => (
                  <div key={l.id} className="flex items-center justify-between gap-3 px-3.5 py-3 text-sm">
                    <span className="min-w-0 truncate font-medium text-foreground">{l.name}</span>
                    <span className="flex items-center gap-2 tabular-nums">
                      {l.pct != null && (
                        <span className="text-xs text-muted-foreground">
                          {Number(l.pct) > 0 ? "+" : ""}
                          {Number(l.pct)}%
                        </span>
                      )}
                      <span className="font-semibold text-foreground">
                        {l.price != null ? formatCurrency(l.price) : <NoData />}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Group>
        </div>

        {/* ── Stock ───────────────────────────────────────────────── */}
        <div className={show("stock")}>
          <Group>
            <div className="divide-y divide-border rounded-2xl bg-muted">
              <SettingRow
                title="Controla stock"
                description="Si está apagado, no descuenta stock al venderse (ej. servicios)."
                control={
                  <Switch
                    checked={Boolean(trackStock)}
                    onCheckedChange={(v) => setValue("track_stock", v, { shouldDirty: true })}
                    label="Controla stock"
                  />
                }
              />
            </div>
            <div className="grid grid-cols-3 gap-3">
              {!isEdit && (
                <Input
                  variant="filled"
                  label="Stock inicial"
                  type="number"
                  step="0.001"
                  disabled={Boolean(hasVariants)}
                  {...register("stock")}
                />
              )}
              <Input
                variant="filled"
                label="Stock mínimo"
                type="number"
                step="0.001"
                disabled={Boolean(hasVariants)}
                {...register("stock_min")}
              />
              <Input variant="filled" label="Unidad" placeholder="un, kg, lt" {...register("unit")} />
            </div>
            {hasVariants && (
              <p className="text-xs text-muted-foreground">
                Este producto tiene variantes: el stock vive en cada combinación, no en el producto padre.
              </p>
            )}
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Venta sin stock</label>
              <div className="relative">
                <select className={selectCls} {...register("allow_negative")}>
                  <option value="inherit" className="bg-popover text-popover-foreground">
                    Según configuración general
                  </option>
                  <option value="yes" className="bg-popover text-popover-foreground">
                    Permitir igual (vende en negativo)
                  </option>
                  <option value="no" className="bg-popover text-popover-foreground">
                    No permitir
                  </option>
                </select>
                <ChevronDown
                  size={15}
                  className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                />
              </div>
            </div>
          </Group>
        </div>

        {/* ── Códigos ─────────────────────────────────────────────── */}
        <div className={show("codigos")}>
          <Group>
            <div className="grid grid-cols-2 gap-3">
              <Input variant="filled" label="SKU" placeholder="Código interno" {...register("sku")} />
              <Input
                variant="filled"
                label="Código de barras (EAN)"
                inputMode="numeric"
                {...register("barcode")}
              />
            </div>
            {barcodeVal?.trim() ? (
              <div className="flex flex-col items-center gap-1.5 rounded-2xl bg-white px-4 py-4 text-black">
                <Barcode value={barcodeVal.trim().toUpperCase()} height={44} />
                <span className="font-mono text-xs tracking-widest">{barcodeVal.trim()}</span>
              </div>
            ) : null}
            {pluEnabled && (
              <Input
                variant="filled"
                label="PLU (código corto)"
                inputMode="numeric"
                maxLength={6}
                placeholder={
                  active?.plu
                    ? undefined
                    : plu?.mode === "incremental"
                      ? "Se asigna solo (correlativo)"
                      : "Se asigna solo (aleatorio)"
                }
                hint="6 dígitos para tipear el producto en el POS. Vacío = automático."
                error={errors.plu?.message}
                {...register("plu")}
              />
            )}
          </Group>
        </div>

        {/* ── Atributos ───────────────────────────────────────────── */}
        <div className={show("atributos")}>
          <Group title="Atributos" description="Color, talle, material, contenido: lo que describa al producto.">
            <AttributesEditor value={attributes} onChange={setAttributes} />
          </Group>
          <Group title="Etiquetas y garantía">
            <div className="grid grid-cols-2 gap-3">
              <Input variant="filled" label="Temporada" placeholder="Verano 2026" {...register("season")} />
              <Input variant="filled" label="Tags" placeholder="oferta, premium" {...register("tags")} />
            </div>
            <Input
              variant="filled"
              label="Garantía de fábrica (meses)"
              type="number"
              step="1"
              min="0"
              className="max-w-[200px]"
              {...register("warranty_months")}
            />
          </Group>
        </div>

        {/* ── Fotos ───────────────────────────────────────────────── */}
        <div className={show("fotos")}>
          {active ? (
            <ProductImages productId={active.id} tenantId={active.tenant_id} legacyUrl={active.image_url} />
          ) : (
            <Group>
              <SaveFirst>Creá el producto y después subí las fotos acá mismo (se guardan como WebP).</SaveFirst>
              <Input
                variant="filled"
                label="O pegá la URL de una imagen"
                placeholder="https://"
                {...register("image_url")}
              />
            </Group>
          )}
        </div>

        {/* ── Medidas y bultos ────────────────────────────────────── */}
        <div className={show("medidas")}>
          <Group
            title="Medidas y bultos"
            description="Cada bulto con sus medidas, peso y unidades. Calcula volumen, m³ y peso volumétrico."
          >
            <FeatureGate feature="medidas_bultos" featureLabel="Medidas por bulto">
              {active && packagesLoading ? (
                <div className="grid h-32 place-items-center">
                  <Spinner />
                </div>
              ) : (
                <PackagesEditor value={packages} onChange={setPackages} productName={nameVal || undefined} />
              )}
            </FeatureGate>
          </Group>
        </div>

        {/* ── Más (tipo de producto, servicio, cocina) ────────────── */}
        <div className={show("mas")}>
          <Group title="Tipo de producto">
            <div className="divide-y divide-border rounded-2xl bg-muted">
              <SettingRow
                title="Es un kit / combo"
                description="Sin stock propio; descuenta el de sus componentes."
                disabled={kitDisabled}
                hint={kitDisabled ? exclusiveHint : undefined}
                control={
                  <Switch
                    checked={Boolean(isKit)}
                    disabled={kitDisabled}
                    onCheckedChange={(v) => setValue("is_kit", v, { shouldDirty: true })}
                    label="Kit"
                  />
                }
              />
              <SettingRow
                title="Serializado (IMEI / N° de serie)"
                description="Cada unidad tiene un serial único."
                disabled={serializedDisabled}
                hint={serializedDisabled ? exclusiveHint : undefined}
                control={
                  <Switch
                    checked={Boolean(isSerialized)}
                    disabled={serializedDisabled}
                    onCheckedChange={(v) => setValue("is_serialized", v, { shouldDirty: true })}
                    label="Serializado"
                  />
                }
              />
              <FeatureGate feature="variantes" featureLabel="Variantes">
                <SettingRow
                  title="Tiene variantes (talle / color)"
                  description="Combinaciones con SKU, precio y stock propios."
                  disabled={variantsDisabled}
                  hint={variantsDisabled ? exclusiveHint : undefined}
                  control={
                    <Switch
                      checked={Boolean(hasVariants)}
                      disabled={variantsDisabled}
                      onCheckedChange={(v) => setValue("has_variants", v, { shouldDirty: true })}
                      label="Variantes"
                    />
                  }
                />
              </FeatureGate>
            </div>
            {isKit && (active ? <KitComponentsEditor kitId={active.id} /> : <SaveFirst>Guardá el combo primero; después cargás sus componentes acá mismo.</SaveFirst>)}
            {isSerialized && (active ? <SerialsEditor productId={active.id} /> : <SaveFirst>Guardá el producto primero; después cargás los seriales acá mismo.</SaveFirst>)}
            {hasVariants &&
              (active ? (
                <VariantsEditor
                  productId={active.id}
                  tenantId={active.tenant_id}
                  parentSku={active.sku}
                  parentPrice={active.price}
                />
              ) : (
                <SaveFirst>Guardá el producto primero; después definís los ejes y generás las combinaciones.</SaveFirst>
              ))}
          </Group>

          <Disclosure title="Servicio para agenda (duración y comisión)">
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Para peluquería, estética y servicios con turnos. Dejalo vacío si es un producto común.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <Input
                  variant="filled"
                  label="Duración (min)"
                  type="number"
                  step="5"
                  min="0"
                  placeholder="Ej. 45"
                  error={errors.service_duration_min?.message}
                  {...register("service_duration_min")}
                />
                <Input
                  variant="filled"
                  label="Comisión (%)"
                  type="number"
                  step="1"
                  min="0"
                  max="100"
                  placeholder="Ej. 30"
                  error={errors.commission_pct?.message}
                  {...register("commission_pct")}
                />
              </div>
            </div>
          </Disclosure>

          {diningEnabled && (
            <Disclosure title="Estación de cocina (KDS)">
              <div className="relative">
                <select className={selectCls} {...register("station")}>
                  <option value="" className="bg-popover text-popover-foreground">
                    Sin estación
                  </option>
                  {KDS_STATIONS.map((s) => (
                    <option key={s} value={s} className="bg-popover text-popover-foreground">
                      {KDS_STATION_LABELS[s]}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  size={15}
                  className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                />
              </div>
            </Disclosure>
          )}

          <Disclosure title="Modificadores (tamaños / sabores / toppings)">
            {active ? (
              <ModifiersEditor productId={active.id} />
            ) : (
              <SaveFirst>Guardá el producto primero; después cargás los grupos de modificadores.</SaveFirst>
            )}
          </Disclosure>

          <Disclosure title="Receta / escandallo (costo y margen)">
            {active ? (
              <RecipeEditor productId={active.id} salePrice={active.price} />
            ) : (
              <SaveFirst>Guardá el producto primero; después cargás la receta (insumos y costos).</SaveFirst>
            )}
          </Disclosure>
        </div>
      </form>
    </Modal>
  );
}
