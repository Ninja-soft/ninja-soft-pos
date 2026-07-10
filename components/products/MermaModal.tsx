"use client";

import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import {
  WASTE_REASONS,
  WASTE_REASON_LABELS,
  MermaSchema,
  type MermaInput,
} from "@/modules/products/schemas";
import type { Product } from "@/modules/products/api";
import { useProductMutations } from "@/modules/products/hooks";
import { formatQty } from "@/lib/utils/format";

// F13 · H50 — Registrar merma (pérdida de stock) de un producto, con su motivo
// (vencido/roto/preparación fallida/devolución/otro). Siempre es un EGRESO:
// se ingresa la cantidad PERDIDA (positiva) y la RPC la descuenta del stock e
// inserta el movimiento con reason='loss' + loss_reason. Espeja StockAdjustModal,
// pero acotado a merma (no pide signo: la cantidad siempre resta).
interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: Product | null;
}

export function MermaModal({ open, onOpenChange, product }: Props) {
  const { toast } = useToast();
  const { registerWaste } = useProductMutations();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<MermaInput>({
    resolver: zodResolver(MermaSchema),
  });

  useEffect(() => {
    if (open) reset({ qty: 1, reason: "vencido", notes: "" });
  }, [open, reset]);

  async function onSubmit(values: MermaInput) {
    if (!product) return;
    try {
      const newStock = await registerWaste.mutateAsync({ id: product.id, input: values });
      toast({
        title: "Merma registrada",
        description: `Nuevo stock: ${formatQty(newStock)}`,
        variant: "success",
      });
      onOpenChange(false);
    } catch (e) {
      toast({
        title: "No se pudo registrar la merma",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Registrar merma"
      description={
        product
          ? `${product.name} · stock actual ${formatQty(product.stock)}`
          : undefined
      }
    >
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <Input
          label="Cantidad perdida"
          type="number"
          step="0.001"
          min="0"
          error={errors.qty?.message}
          {...register("qty")}
        />
        <div>
          <label className="mb-2 block text-sm font-medium text-muted-foreground">
            Motivo de la merma
          </label>
          <select
            className="h-11 w-full rounded-lg border border-input bg-background px-4 text-sm text-foreground outline-none transition focus:border-ninja-flameSoft focus:ring-4 focus:ring-ninja-flameSoft/15"
            {...register("reason")}
          >
            {WASTE_REASONS.map((r) => (
              <option key={r} value={r} className="bg-popover text-popover-foreground">
                {WASTE_REASON_LABELS[r]}
              </option>
            ))}
          </select>
        </div>
        <Input label="Notas (opcional)" {...register("notes")} />
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button type="submit" loading={registerWaste.isPending}>
            Registrar merma
          </Button>
        </div>
      </form>
    </Modal>
  );
}
