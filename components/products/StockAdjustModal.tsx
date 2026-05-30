"use client";

import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import {
  ADJUST_REASONS,
  ADJUST_REASON_LABELS,
  StockAdjustSchema,
  type StockAdjustInput,
} from "@/modules/products/schemas";
import type { Product } from "@/modules/products/api";
import { useProductMutations } from "@/modules/products/hooks";
import { formatQty } from "@/lib/utils/format";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: Product | null;
}

export function StockAdjustModal({ open, onOpenChange, product }: Props) {
  const { toast } = useToast();
  const { adjust } = useProductMutations();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<StockAdjustInput>({
    resolver: zodResolver(StockAdjustSchema),
  });

  useEffect(() => {
    if (open) reset({ delta: 0, reason: "purchase", notes: "" });
  }, [open, reset]);

  async function onSubmit(values: StockAdjustInput) {
    if (!product) return;
    try {
      const newStock = await adjust.mutateAsync({ id: product.id, input: values });
      toast({
        title: "Stock ajustado",
        description: `Nuevo stock: ${formatQty(newStock)}`,
        variant: "success",
      });
      onOpenChange(false);
    } catch (e) {
      toast({
        title: "No se pudo ajustar",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Ajustar stock"
      description={
        product
          ? `${product.name} · stock actual ${formatQty(product.stock)}`
          : undefined
      }
    >
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <Input
          label="Cantidad (+ ingreso / − egreso)"
          type="number"
          step="0.001"
          error={errors.delta?.message}
          {...register("delta")}
        />
        <div>
          <label className="mb-2 block text-sm font-medium text-muted-foreground">
            Motivo
          </label>
          <select
            className="h-11 w-full rounded-lg border border-input bg-background px-4 text-sm text-foreground outline-none transition focus:border-ninja-flameSoft focus:ring-4 focus:ring-ninja-flameSoft/15"
            {...register("reason")}
          >
            {ADJUST_REASONS.map((r) => (
              <option key={r} value={r} className="bg-ninja-deepViolet">
                {ADJUST_REASON_LABELS[r]}
              </option>
            ))}
          </select>
        </div>
        <Input label="Notas (opcional)" {...register("notes")} />
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button type="submit" loading={adjust.isPending}>
            Ajustar
          </Button>
        </div>
      </form>
    </Modal>
  );
}
