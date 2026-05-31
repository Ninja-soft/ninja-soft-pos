"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Plus } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import {
  ProductSchema,
  type ProductInput,
  type ProductOutput,
} from "@/modules/products/schemas";
import type { Product } from "@/modules/products/api";
import { ProductImages } from "@/components/products/ProductImages";
import { KitComponentsEditor } from "@/components/products/KitComponentsEditor";
import {
  useCategories,
  useCreateCategory,
  useBrands,
  useCreateBrand,
  useProductMutations,
} from "@/modules/products/hooks";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product?: Product | null;
}

export function ProductFormModal({ open, onOpenChange, product }: Props) {
  const isEdit = Boolean(product);
  const { toast } = useToast();
  const { data: categories } = useCategories();
  const createCategory = useCreateCategory();
  const { data: brands } = useBrands();
  const createBrand = useCreateBrand();
  const { create, update } = useProductMutations();
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

  useEffect(() => {
    if (open) {
      reset({
        name: product?.name ?? "",
        sku: product?.sku ?? "",
        barcode: product?.barcode ?? "",
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
        description: product?.description ?? "",
        is_active: product?.is_active ?? true,
        is_kit: product?.is_kit ?? false,
        track_stock: product?.track_stock ?? true,
      });
    }
  }, [open, product, reset]);

  async function onSubmit(values: ProductInput) {
    const parsed = values as unknown as ProductOutput;
    try {
      if (isEdit && product) {
        await update.mutateAsync({ id: product.id, input: parsed });
        toast({ title: "Producto actualizado", variant: "success" });
      } else {
        await create.mutateAsync(parsed);
        toast({ title: "Producto creado", variant: "success" });
      }
      onOpenChange(false);
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

        <div>
          <label className="mb-2 block text-sm font-medium text-muted-foreground">
            Categoría
          </label>
          <select
            className="h-11 w-full rounded-lg border border-input bg-background px-4 text-sm text-foreground outline-none transition focus:border-ninja-flameSoft focus:ring-4 focus:ring-ninja-flameSoft/15"
            {...register("category_id")}
          >
            <option value="">Sin categoría</option>
            {categories?.map((c) => (
              <option key={c.id} value={c.id} className="bg-ninja-deepViolet">
                {c.name}
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
            <Input label="Stock inicial" type="number" step="0.001" {...register("stock")} />
          )}
          <Input label="Stock mínimo" type="number" step="0.001" {...register("stock_min")} />
          <Input label="Unidad (un, kg, lt…)" {...register("unit")} />
          <Input label="IVA %" type="number" step="0.5" {...register("tax_rate")} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Input label="Temporada" placeholder="Verano 2026" {...register("season")} />
          <Input label="Tags (separados por coma)" placeholder="oferta, premium" {...register("tags")} />
        </div>

        <Input label="Descripción" {...register("description")} />

        {isEdit && product && (
          <ProductImages productId={product.id} tenantId={product.tenant_id} />
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

        <label className="flex items-start gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            className="mt-0.5 accent-ninja-flame"
            {...register("is_kit")}
          />
          <span>
            Es un kit / combo
            <span className="block text-xs text-muted-foreground">
              No tiene stock propio; al venderse descuenta el stock de sus componentes.
            </span>
          </span>
        </label>

        {isEdit && product && isKit && <KitComponentsEditor kitId={product.id} />}
        {!isEdit && isKit && (
          <p className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
            Guardá el combo primero; después podés cargar sus componentes editándolo.
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
