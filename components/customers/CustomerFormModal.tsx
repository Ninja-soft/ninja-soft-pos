"use client";

import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import {
  CustomerSchema,
  DOC_TYPES,
  DOC_TYPE_LABELS,
  IVA_CONDITIONS,
  IVA_LABELS,
  type CustomerInput,
  type CustomerOutput,
} from "@/modules/customers/schemas";
import type { Customer } from "@/modules/customers/api";
import { useCustomerMutations } from "@/modules/customers/hooks";

const selectCls =
  "h-11 w-full rounded-ninjaLg border border-input bg-background px-4 text-sm text-foreground outline-none focus:border-ninja-flameSoft focus:ring-4 focus:ring-ninja-flameSoft/15";

export function CustomerFormModal({
  open,
  onOpenChange,
  customer,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  customer?: Customer | null;
}) {
  const isEdit = Boolean(customer);
  const { toast } = useToast();
  const { create, update } = useCustomerMutations();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<CustomerInput>({ resolver: zodResolver(CustomerSchema) });

  useEffect(() => {
    if (open) {
      reset({
        name: customer?.name ?? "",
        document_type: (customer?.document_type as CustomerInput["document_type"]) ?? undefined,
        document_number: customer?.document_number ?? "",
        iva_condition: (customer?.iva_condition as CustomerInput["iva_condition"]) ?? undefined,
        email: customer?.email ?? "",
        phone: customer?.phone ?? "",
        address: customer?.address ?? "",
        notes: customer?.notes ?? "",
        is_active: customer?.is_active ?? true,
      });
    }
  }, [open, customer, reset]);

  async function onSubmit(values: CustomerInput) {
    const parsed = values as unknown as CustomerOutput;
    try {
      if (isEdit && customer) {
        await update.mutateAsync({ id: customer.id, input: parsed });
        toast({ title: "Cliente actualizado", variant: "success" });
      } else {
        await create.mutateAsync(parsed);
        toast({ title: "Cliente creado", variant: "success" });
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

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? "Editar cliente" : "Nuevo cliente"}
      className="max-w-xl"
    >
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <Input label="Nombre / Razón social" error={errors.name?.message} {...register("name")} />
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-2 block text-sm font-medium text-muted-foreground">
              Tipo de documento
            </label>
            <select className={selectCls} {...register("document_type")}>
              <option value="">—</option>
              {DOC_TYPES.map((d) => (
                <option key={d} value={d} className="bg-ninja-deepViolet">
                  {DOC_TYPE_LABELS[d]}
                </option>
              ))}
            </select>
          </div>
          <Input
            label="Número"
            error={errors.document_number?.message}
            {...register("document_number")}
          />
        </div>
        <div>
          <label className="mb-2 block text-sm font-medium text-muted-foreground">
            Condición IVA
          </label>
          <select className={selectCls} {...register("iva_condition")}>
            <option value="">—</option>
            {IVA_CONDITIONS.map((c) => (
              <option key={c} value={c} className="bg-ninja-deepViolet">
                {IVA_LABELS[c]}
              </option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input label="Email" type="email" error={errors.email?.message} {...register("email")} />
          <Input label="Teléfono" {...register("phone")} />
        </div>
        <Input label="Dirección" {...register("address")} />
        <Input label="Notas" {...register("notes")} />
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button type="submit" loading={create.isPending || update.isPending}>
            {isEdit ? "Guardar" : "Crear"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
