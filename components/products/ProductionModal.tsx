"use client";

import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import {
  ProductionSchema,
  type ProductionInput,
} from "@/modules/products/schemas";
import type { Product } from "@/modules/products/api";
import { useProductMutations } from "@/modules/products/hooks";
import { formatQty } from "@/lib/utils/format";

// F13 · H50 — Registrar producción / batch (preparación previa) de un producto:
// helado, masa, prep de barra. SIEMPRE es un INGRESO: se ingresa la cantidad
// PRODUCIDA (positiva) y la RPC la suma al stock con reason='production'. Espeja
// MermaModal, pero como ingreso.
interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: Product | null;
}

export function ProductionModal({ open, onOpenChange, product }: Props) {
  const { toast } = useToast();
  const { registerProduction } = useProductMutations();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<ProductionInput>({
    resolver: zodResolver(ProductionSchema),
  });

  useEffect(() => {
    if (open) reset({ qty: 1, notes: "" });
  }, [open, reset]);

  async function onSubmit(values: ProductionInput) {
    if (!product) return;
    try {
      const newStock = await registerProduction.mutateAsync({
        id: product.id,
        input: values,
      });
      toast({
        title: "Producción registrada",
        description: `Nuevo stock: ${formatQty(newStock)}`,
        variant: "success",
      });
      onOpenChange(false);
    } catch (e) {
      toast({
        title: "No se pudo registrar la producción",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Registrar producción"
      description={
        product
          ? `${product.name} · stock actual ${formatQty(product.stock)}`
          : undefined
      }
    >
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <Input
          label="Cantidad producida"
          type="number"
          step="0.001"
          min="0"
          error={errors.qty?.message}
          {...register("qty")}
        />
        <p className="text-xs text-muted-foreground">
          Preparación previa (batch de helado, tanda de masa, prep de barra…). Se
          suma al stock del producto. El descuento de insumos llega después.
        </p>
        <Input label="Notas (opcional)" {...register("notes")} />
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button type="submit" loading={registerProduction.isPending}>
            Registrar producción
          </Button>
        </div>
      </form>
    </Modal>
  );
}
