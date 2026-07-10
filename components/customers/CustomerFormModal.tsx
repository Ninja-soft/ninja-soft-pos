"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient, useMutation } from "@tanstack/react-query";
import { Plus, ScanLine } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { DniScanModal } from "@/components/customers/DniScanModal";
import type { ParsedDni } from "@/lib/customers/dniParse";
import {
  CustomerSchema,
  DOC_TYPES,
  DOC_TYPE_LABELS,
  IVA_CONDITIONS,
  IVA_LABELS,
  type CustomerFieldKey,
  type CustomerInput,
  type CustomerOutput,
} from "@/modules/customers/schemas";
import { customerGroupsApi, type Customer } from "@/modules/customers/api";
import {
  useCustomerMutations,
  useCustomerGroups,
  useRequiredCustomerFields,
} from "@/modules/customers/hooks";

const selectCls =
  "h-11 w-full rounded-lg border border-input bg-background px-4 text-sm text-foreground outline-none focus:border-ninja-flameSoft focus:ring-4 focus:ring-ninja-flameSoft/15";

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
  const { data: groups } = useCustomerGroups();
  const { data: required } = useRequiredCustomerFields();
  const qc = useQueryClient();
  const [newGroup, setNewGroup] = useState("");
  const [dniOpen, setDniOpen] = useState(false);
  const {
    register,
    handleSubmit,
    reset,
    setValue,
    setError,
    formState: { errors },
  } = useForm<CustomerInput>({ resolver: zodResolver(CustomerSchema) });

  // Autocompleta la ficha con los datos parseados del DNI (H31). El cajero ya
  // los confirmó en la validación visual del DniScanModal; acá solo se vuelcan
  // al form (no guarda). Documento → tipo DNI + número; nombre completo y fecha
  // de nacimiento cuando vengan. shouldValidate revalida los campos tocados.
  function applyDni(d: ParsedDni) {
    setValue("name", d.nombreCompleto, { shouldValidate: true, shouldDirty: true });
    setValue("document_type", "dni", { shouldValidate: true, shouldDirty: true });
    setValue("document_number", d.dni, { shouldValidate: true, shouldDirty: true });
    if (d.fechaNac)
      setValue("birth_date", d.fechaNac, { shouldValidate: true, shouldDirty: true });
    toast({ title: "Datos del DNI cargados", variant: "success" });
  }

  const req = required?.fields ?? {};
  // require_customer_doc (default true): exige tipo + número de documento.
  const requireDoc = required?.requireDoc ?? true;
  // Marca " *" en el label si el campo es obligatorio para este tenant. El
  // documento se marca obligatorio también cuando require_customer_doc está on.
  const star = (key: CustomerFieldKey) =>
    req[key] || (key === "document_number" && requireDoc) ? " *" : "";

  const createGroup = useMutation({
    mutationFn: (name: string) => customerGroupsApi.create(name),
    onSuccess: (g) => {
      qc.invalidateQueries({ queryKey: ["customer-groups"] });
      setValue("group_id", g.id);
      setNewGroup("");
    },
    onError: () => toast({ title: "No se pudo crear el grupo", variant: "error" }),
  });

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
        birth_date: (customer?.birth_date as string | null) ?? "",
        notes: customer?.notes ?? "",
        // preferences (H40): aún no está en el tipo Customer (no se regeneran tipos).
        preferences:
          ((customer as unknown as { preferences?: string | null })?.preferences ??
            "") || "",
        is_active: customer?.is_active ?? true,
        credit_limit: customer?.credit_limit ?? 0,
        group_id: (customer?.group_id as string | null) ?? "",
      });
    }
  }, [open, customer, reset]);

  async function onSubmit(values: CustomerInput) {
    let missing = false;
    // Documento obligatorio (require_customer_doc): exige tipo + número. Es un
    // requisito propio (document_type no está en CUSTOMER_FIELDS).
    if (requireDoc) {
      if (!String(values.document_type ?? "").trim()) {
        setError("document_type", { message: "Requerido" });
        missing = true;
      }
      if (!String(values.document_number ?? "").trim()) {
        setError("document_number", { message: "Requerido" });
        missing = true;
      }
    }
    // Validación de campos obligatorios configurados por el tenant.
    const checks: { key: CustomerFieldKey; val: unknown }[] = [
      { key: "document_number", val: values.document_number },
      { key: "iva_condition", val: values.iva_condition },
      { key: "phone", val: values.phone },
      { key: "email", val: values.email },
      { key: "address", val: values.address },
      { key: "birth_date", val: values.birth_date },
    ];
    for (const c of checks) {
      if (req[c.key] && !String(c.val ?? "").trim()) {
        setError(c.key as keyof CustomerInput, { message: "Requerido" });
        missing = true;
      }
    }
    if (missing) {
      toast({ title: "Completá los campos obligatorios", variant: "error" });
      return;
    }
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
    <>
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? "Editar cliente" : "Nuevo cliente"}
      className="max-w-xl"
    >
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        {/* Alta rápida por DNI (H31): escanea el PDF417 del frente y autocompleta
            nombre, documento y fecha de nacimiento. Validación visual previa. */}
        <Button
          type="button"
          variant="secondary"
          className="w-full"
          onClick={() => setDniOpen(true)}
        >
          <ScanLine size={16} /> Escanear DNI
        </Button>
        <Input label="Nombre / Razón social" error={errors.name?.message} {...register("name")} />
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-2 block text-sm font-medium text-muted-foreground">
              Tipo de documento{requireDoc ? " *" : ""}
            </label>
            {errors.document_type?.message && (
              <p className="mb-1 text-xs text-destructive">{errors.document_type.message}</p>
            )}
            <select className={selectCls} {...register("document_type")}>
              <option value="">—</option>
              {DOC_TYPES.map((d) => (
                <option key={d} value={d} className="bg-popover text-popover-foreground">
                  {DOC_TYPE_LABELS[d]}
                </option>
              ))}
            </select>
          </div>
          <Input
            label={`Número${star("document_number")}`}
            error={errors.document_number?.message}
            {...register("document_number")}
          />
        </div>
        <div>
          <label className="mb-2 block text-sm font-medium text-muted-foreground">
            Condición IVA{star("iva_condition")}
          </label>
          {errors.iva_condition?.message && (
            <p className="mb-1 text-xs text-destructive">{errors.iva_condition.message}</p>
          )}
          <select className={selectCls} {...register("iva_condition")}>
            <option value="">—</option>
            {IVA_CONDITIONS.map((c) => (
              <option key={c} value={c} className="bg-popover text-popover-foreground">
                {IVA_LABELS[c]}
              </option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input
            label={`Email${star("email")}`}
            type="email"
            error={errors.email?.message}
            {...register("email")}
          />
          <Input
            label={`Teléfono${star("phone")}`}
            error={errors.phone?.message}
            {...register("phone")}
          />
        </div>
        <Input
          label={`Dirección${star("address")}`}
          error={errors.address?.message}
          {...register("address")}
        />
        <Input
          label={`Fecha de nacimiento${star("birth_date")}`}
          type="date"
          error={errors.birth_date?.message}
          {...register("birth_date")}
        />
        <Input label="Notas" {...register("notes")} />
        {/* Preferencias / gustos del cliente (H40): texto libre para personalizar
            la atención y la recompra (ej. "corte degradé", "talle M oscuro"). */}
        <div>
          <label className="mb-2 block text-sm font-medium text-muted-foreground">
            Preferencias / gustos
          </label>
          <textarea
            rows={2}
            placeholder="Ej. corte degradé sin máquina · cortado con leche de almendras · talle M, colores oscuros"
            className="w-full resize-none rounded-lg border border-input bg-background px-4 py-3 text-sm text-foreground outline-none transition placeholder:text-muted-foreground focus:border-ninja-flameSoft focus:ring-2 focus:ring-ninja-flameSoft/20"
            {...register("preferences")}
          />
        </div>
        <Input
          label="Límite de cuenta corriente ($, 0 = sin límite)"
          type="number"
          step="0.01"
          min="0"
          {...register("credit_limit")}
        />
        <div>
          <label className="mb-2 block text-sm font-medium text-muted-foreground">
            Grupo
          </label>
          <select className={selectCls} {...register("group_id")}>
            <option value="">Sin grupo</option>
            {(groups ?? []).map((g) => (
              <option key={g.id} value={g.id} className="bg-popover text-popover-foreground">
                {g.name}
              </option>
            ))}
          </select>
          <div className="mt-2 flex gap-2">
            <input
              value={newGroup}
              onChange={(e) => setNewGroup(e.target.value)}
              placeholder="Nuevo grupo (ej. Mayorista, VIP)"
              className="h-9 flex-1 rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-ninja-flameSoft"
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={newGroup.trim().length < 1 || createGroup.isPending}
              onClick={() => createGroup.mutate(newGroup.trim())}
            >
              <Plus size={14} /> Crear
            </Button>
          </div>
        </div>
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
    <DniScanModal open={dniOpen} onOpenChange={setDniOpen} onConfirm={applyDni} />
    </>
  );
}
