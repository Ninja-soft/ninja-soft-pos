"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Plus } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { useToast } from "@/components/ui/Toast";
import {
  ProductSchema,
  type ProductInput,
  type ProductOutput,
} from "@/modules/products/schemas";
import { flattenCategories, type Product } from "@/modules/products/api";
import { ProductImages } from "@/components/products/ProductImages";
import { KitComponentsEditor } from "@/components/products/KitComponentsEditor";
import { SerialsEditor } from "@/components/products/SerialsEditor";
import { VariantsEditor } from "@/components/products/VariantsEditor";
import { FeatureGate } from "@/components/saas/FeatureGate";
import {
  useCategories,
  useCreateCategory,
  useBrands,
  useCreateBrand,
  useProductMutations,
  usePluSettings,
} from "@/modules/products/hooks";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product?: Product | null;
}

export function ProductFormModal({ open, onOpenChange, product }: Props) {
  // Tras crear, guardamos el producto nuevo para seguir en modo edición
  // (subir fotos / cargar componentes / serial sin reabrir).
  const [created, setCreated] = useState<Product | null>(null);
  const active = product ?? created;
  const isEdit = Boolean(active);
  const { toast } = useToast();
  const { data: categories } = useCategories();
  const createCategory = useCreateCategory();
  const { data: brands } = useBrands();
  const createBrand = useCreateBrand();
  const { create, update } = useProductMutations();
  const { data: plu } = usePluSettings();
  const pluEnabled = plu?.enabled ?? false;
  const [newCat, setNewCat] = useState("");
  const [newBrand, setNewBrand] = useState("");

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors },
  } = useForm<ProductInput>({
    resolver: zodResolver(ProductSchema),
  });
  const isKit = watch("is_kit");
  const isSerialized = watch("is_serialized");
  const hasVariants = watch("has_variants");

  // Tipos de producto mutuamente excluyentes: kit, serializado y con variantes
  // no pueden combinarse (constraint también en DB). Cada checkbox se deshabilita
  // si otro ya está activo.
  const kitDisabled = isSerialized || hasVariants;
  const serializedDisabled = isKit || hasVariants;
  const variantsDisabled = isKit || isSerialized;
  const exclusiveHint =
    "Incompatible con kit / serializado / variantes. Desmarcá el otro tipo primero.";

  useEffect(() => {
    if (open) {
      setCreated(null);
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
        is_active: product?.is_active ?? true,
        is_kit: product?.is_kit ?? false,
        is_serialized: product?.is_serialized ?? false,
        has_variants: product?.has_variants ?? false,
        track_stock: product?.track_stock ?? true,
        allow_negative:
          product?.allow_negative == null
            ? "inherit"
            : product.allow_negative
              ? "yes"
              : "no",
        warranty_months: product?.warranty_months ?? 0,
      });
    }
  }, [open, product, reset]);

  // Tras crear con PLU habilitado, la DB asigna el PLU: lo reflejamos en el
  // campo (el form sigue abierto en modo edición) para que el dueño lo vea.
  useEffect(() => {
    if (created?.plu) setValue("plu", created.plu);
  }, [created, setValue]);

  async function onSubmit(values: ProductInput) {
    const parsed = values as unknown as ProductOutput;
    // Exclusividad kit/serializado/variantes también en submit (la UI los
    // deshabilita, pero esto evita estados mezclados por cualquier vía).
    const exclusive = [parsed.is_kit, parsed.is_serialized, parsed.has_variants].filter(Boolean);
    if (exclusive.length > 1) {
      toast({
        title: "Un producto no puede ser kit, serializado y con variantes a la vez",
        variant: "error",
      });
      return;
    }
    try {
      if (active) {
        await update.mutateAsync({ id: active.id, input: parsed });
        toast({ title: "Producto actualizado", variant: "success" });
        onOpenChange(false);
        return;
      }
      const nuevo = await create.mutateAsync(parsed);
      setCreated(nuevo);
      toast({
        title: "Producto creado",
        description: "Ahora podés subir fotos o cargar componentes.",
        variant: "success",
      });
      return;
    } catch (e) {
      toast({
        title: "No se pudo guardar",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  async function addCategory() {
    if (newCat.trim().length < 1) return;
    try {
      const cat = await createCategory.mutateAsync({ name: newCat.trim() });
      setValue("category_id", cat.id);
      setNewCat("");
      toast({ title: "Categoría creada", variant: "success" });
    } catch {
      toast({ title: "No se pudo crear la categoría", variant: "error" });
    }
  }

  async function addBrand() {
    if (newBrand.trim().length < 1) return;
    try {
      const b = await createBrand.mutateAsync(newBrand.trim());
      setValue("brand_id", b.id);
      setNewBrand("");
      toast({ title: "Marca creada", variant: "success" });
    } catch {
      toast({ title: "No se pudo crear la marca", variant: "error" });
    }
  }

  const saving = create.isPending || update.isPending;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? "Editar producto" : "Nuevo producto"}
      className="max-w-xl"
    >
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <Input label="Nombre" error={errors.name?.message} {...register("name")} />

        <div className="grid grid-cols-2 gap-3">
          <Input label="SKU" {...register("sku")} />
          <Input label="Código de barras" {...register("barcode")} />
        </div>

        {/* PLU: código corto de 6 dígitos para tipear rápido en el POS. Solo se
            muestra si el tenant lo tiene habilitado (Configuración del POS). Si
            se deja vacío al crear, la DB lo genera sola según el modo elegido. */}
        {pluEnabled && (
          <div>
            <Input
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
              error={errors.plu?.message}
              {...register("plu")}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              6 dígitos para tipear el producto en el POS. Dejalo vacío para que
              se genere automáticamente; o escribí uno propio (único).
            </p>
          </div>
        )}

        <div>
          <label className="mb-2 block text-sm font-medium text-muted-foreground">
            Categoría
          </label>
          <select
            className="h-11 w-full rounded-lg border border-input bg-background px-4 text-sm text-foreground outline-none transition focus:border-ninja-flameSoft focus:ring-4 focus:ring-ninja-flameSoft/15"
            {...register("category_id")}
          >
            <option value="">Sin categoría</option>
            {flattenCategories(categories ?? []).map(({ cat, depth }) => (
              <option key={cat.id} value={cat.id} className="bg-ninja-deepViolet">
                {`${"  ".repeat(depth)}${depth > 0 ? "› " : ""}${cat.name}`}
              </option>
            ))}
          </select>
          <div className="mt-2 flex gap-2">
            <input
              value={newCat}
              onChange={(e) => setNewCat(e.target.value)}
              placeholder="Nueva categoría"
              className="h-9 flex-1 rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={addCategory}
              loading={createCategory.isPending}
            >
              <Plus size={15} /> Agregar
            </Button>
          </div>
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium text-muted-foreground">
            Marca
          </label>
          <select
            className="h-11 w-full rounded-lg border border-input bg-background px-4 text-sm text-foreground outline-none transition focus:border-ninja-flameSoft focus:ring-4 focus:ring-ninja-flameSoft/15"
            {...register("brand_id")}
          >
            <option value="">Sin marca</option>
            {brands?.map((b) => (
              <option key={b.id} value={b.id} className="bg-ninja-deepViolet">
                {b.name}
              </option>
            ))}
          </select>
          <div className="mt-2 flex gap-2">
            <input
              value={newBrand}
              onChange={(e) => setNewBrand(e.target.value)}
              placeholder="Nueva marca"
              className="h-9 flex-1 rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={addBrand}
              loading={createBrand.isPending}
            >
              <Plus size={15} /> Agregar
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Precio de venta"
            type="number"
            step="0.01"
            error={errors.price?.message}
            {...register("price")}
          />
          <Input label="Costo" type="number" step="0.01" {...register("cost")} />
        </div>

        <div className="grid grid-cols-3 gap-3">
          {!isEdit && (
            <Input
              label="Stock inicial"
              type="number"
              step="0.001"
              disabled={hasVariants}
              title={
                hasVariants
                  ? "Con variantes, el stock se carga en cada combinación."
                  : undefined
              }
              {...register("stock")}
            />
          )}
          <Input
            label="Stock mínimo"
            type="number"
            step="0.001"
            disabled={hasVariants}
            title={
              hasVariants
                ? "Con variantes, el stock se carga en cada combinación."
                : undefined
            }
            {...register("stock_min")}
          />
          <Input label="Unidad (un, kg, lt…)" {...register("unit")} />
          <Input label="IVA %" type="number" step="0.5" {...register("tax_rate")} />
        </div>
        {hasVariants && (
          <p className="-mt-2 text-xs text-muted-foreground">
            Este producto tiene variantes: el stock vive en cada combinación, no
            en el producto padre.
          </p>
        )}

        {/* Datos adicionales plegables (H10b): todo opcional, colapsado por
            defecto para que el alta rápida sea una sola pantalla corta. */}
        <Disclosure title="Datos adicionales (descripción, tags, temporada, garantía)">
          <div className="space-y-3">
            <Input label="Descripción" {...register("description")} />
            <div className="grid grid-cols-2 gap-3">
              <Input label="Temporada" placeholder="Verano 2026" {...register("season")} />
              <Input label="Tags (separados por coma)" placeholder="oferta, premium" {...register("tags")} />
            </div>
            <Input
              label="Garantía de fábrica (meses)"
              type="number"
              step="1"
              min="0"
              {...register("warranty_months")}
            />
            {!active && (
              <Input
                label="URL de imagen (opcional)"
                placeholder="https://…"
                {...register("image_url")}
              />
            )}
          </div>
        </Disclosure>

        {active && (
          <ProductImages productId={active.id} tenantId={active.tenant_id} />
        )}

        <label className="flex items-center gap-2 text-sm text-foreground">
          <input type="checkbox" className="accent-ninja-flame" {...register("is_active")} />
          Activo
        </label>

        <label className="flex items-start gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            className="mt-0.5 accent-ninja-flame"
            {...register("track_stock")}
          />
          <span>
            Controla stock
            <span className="block text-xs text-muted-foreground">
              Si está apagado, no descuenta stock al venderse (ej. servicios).
            </span>
          </span>
        </label>

        <label className="block text-sm text-foreground">
          Venta sin stock
          <select
            {...register("allow_negative")}
            className="mt-1 h-10 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus:border-ninja-flameSoft"
          >
            <option value="inherit">Según configuración general</option>
            <option value="yes">Permitir igual (vende en negativo)</option>
            <option value="no">No permitir</option>
          </select>
          <span className="mt-1 block text-xs text-muted-foreground">
            Reemplaza, solo para este producto, el ajuste global de
            “vender sin stock”.
          </span>
        </label>

        <label
          className={`flex items-start gap-2 text-sm text-foreground ${
            kitDisabled ? "opacity-50" : ""
          }`}
          title={kitDisabled ? exclusiveHint : undefined}
        >
          <input
            type="checkbox"
            className="mt-0.5 accent-ninja-flame"
            disabled={kitDisabled}
            {...register("is_kit")}
          />
          <span>
            Es un kit / combo
            <span className="block text-xs text-muted-foreground">
              No tiene stock propio; al venderse descuenta el stock de sus componentes.
            </span>
          </span>
        </label>

        {active && isKit && <KitComponentsEditor kitId={active.id} />}
        {!active && isKit && (
          <p className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
            Guardá el combo primero; después podés cargar sus componentes acá mismo.
          </p>
        )}

        <label
          className={`flex items-start gap-2 text-sm text-foreground ${
            serializedDisabled ? "opacity-50" : ""
          }`}
          title={serializedDisabled ? exclusiveHint : undefined}
        >
          <input
            type="checkbox"
            className="mt-0.5 accent-ninja-flame"
            disabled={serializedDisabled}
            {...register("is_serialized")}
          />
          <span>
            Producto serializado (IMEI / N° de serie)
            <span className="block text-xs text-muted-foreground">
              Cada unidad tiene un serial único. Al vender, el cajero elige cuál sale.
            </span>
          </span>
        </label>

        {active && isSerialized && <SerialsEditor productId={active.id} />}
        {!active && isSerialized && (
          <p className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
            Guardá el producto primero; después podés cargar los seriales acá mismo.
          </p>
        )}

        <FeatureGate feature="variantes" featureLabel="Variantes">
          <label
            className={`flex items-start gap-2 text-sm text-foreground ${
              variantsDisabled ? "opacity-50" : ""
            }`}
            title={variantsDisabled ? exclusiveHint : undefined}
          >
            <input
              type="checkbox"
              className="mt-0.5 accent-ninja-flame"
              disabled={variantsDisabled}
              {...register("has_variants")}
            />
            <span>
              Tiene variantes (talle / color…)
              <span className="block text-xs text-muted-foreground">
                Combinaciones con SKU, precio y stock propios. El stock se carga
                en cada variante, no en el producto padre.
              </span>
            </span>
          </label>
        </FeatureGate>

        {active && hasVariants && (
          <VariantsEditor
            productId={active.id}
            tenantId={active.tenant_id}
            parentSku={active.sku}
            parentPrice={active.price}
          />
        )}
        {!active && hasVariants && (
          <p className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
            Guardá el producto primero; después podés definir los ejes y generar
            las combinaciones acá mismo.
          </p>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button type="submit" loading={saving}>
            {isEdit ? "Guardar" : "Crear"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
