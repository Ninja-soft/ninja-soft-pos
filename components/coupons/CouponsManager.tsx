"use client";

import { useEffect, useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useCoupons, useCouponMutations } from "@/modules/coupons/hooks";
import type { Coupon, CouponInput } from "@/modules/coupons/api";
import { formatCurrency } from "@/lib/utils/format";

// F9 · H54 — Administrador de cupones. El dueño define códigos con % o monto fijo,
// monto mínimo, vigencia y topes de uso. El límite de uso lo enforce create_sale
// de forma atómica al cobrar (lock + registro de canje).
export function CouponsManager() {
  const { data: coupons, isLoading } = useCoupons();
  const { remove } = useCouponMutations();
  const { toast } = useToast();
  const [editing, setEditing] = useState<Coupon | null>(null);
  const [creating, setCreating] = useState(false);
  const [delTarget, setDelTarget] = useState<Coupon | null>(null);

  async function doDelete() {
    if (!delTarget) return;
    try {
      await remove.mutateAsync(delTarget.id);
      toast({ title: "Cupón eliminado", variant: "success" });
      setDelTarget(null);
    } catch (e) {
      toast({
        title: "No se pudo eliminar",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Códigos de descuento que el cajero ingresa al cobrar. El límite de usos se
        controla server-side de forma atómica (no se puede reusar de más).
      </p>

      {isLoading ? (
        <p className="py-4 text-center text-sm text-muted-foreground">Cargando…</p>
      ) : (coupons ?? []).length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-5 text-center text-sm text-muted-foreground">
          Sin cupones. Creá uno (ej. “BIENVENIDO10”, 10% con monto mínimo).
        </p>
      ) : (
        <div className="space-y-2">
          {(coupons ?? []).map((c: Coupon) => (
            <CouponRow
              key={c.id}
              coupon={c}
              onEdit={() => setEditing(c)}
              onDelete={() => setDelTarget(c)}
            />
          ))}
        </div>
      )}

      <Button variant="secondary" size="sm" onClick={() => setCreating(true)}>
        <Plus size={15} /> Nuevo cupón
      </Button>

      <CouponFormModal
        open={creating || editing !== null}
        coupon={editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
      />

      <ConfirmDialog
        open={delTarget !== null}
        onOpenChange={(o) => !o && setDelTarget(null)}
        title={`Eliminar el cupón “${delTarget?.code}”`}
        description="Se da de baja el cupón. No afecta ventas ya cerradas ni canjes registrados."
        confirmLabel="Eliminar"
        danger
        loading={remove.isPending}
        onConfirm={doDelete}
      />
    </div>
  );
}

function CouponRow({
  coupon,
  onEdit,
  onDelete,
}: {
  coupon: Coupon;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const action =
    coupon.discount_type === "percent"
      ? `${coupon.discount_value}% off`
      : `${formatCurrency(coupon.discount_value)} off`;
  const uses =
    coupon.max_uses != null
      ? `${coupon.used_count}/${coupon.max_uses} usos`
      : `${coupon.used_count} usos`;
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-mono text-sm font-semibold text-foreground">
            {coupon.code}
          </span>
          {!coupon.is_active && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
              inactivo
            </span>
          )}
        </div>
        <div className="text-xs text-muted-foreground">
          {action}
          {coupon.min_amount > 0 ? ` · desde ${formatCurrency(coupon.min_amount)}` : ""} · {uses}
          {coupon.max_per_customer != null ? ` · máx ${coupon.max_per_customer}/cliente` : ""}
        </div>
      </div>
      <button
        type="button"
        onClick={onEdit}
        className="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
        title="Editar"
      >
        <Pencil size={15} />
      </button>
      <button
        type="button"
        onClick={onDelete}
        className="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-destructive"
        title="Eliminar"
      >
        <Trash2 size={15} />
      </button>
    </div>
  );
}

function CouponFormModal({
  open,
  coupon,
  onClose,
}: {
  open: boolean;
  coupon: Coupon | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const { create, update } = useCouponMutations();

  const [code, setCode] = useState("");
  const [type, setType] = useState<"percent" | "amount">("percent");
  const [value, setValue] = useState("10");
  const [minAmount, setMinAmount] = useState("0");
  const [validFrom, setValidFrom] = useState("");
  const [validTo, setValidTo] = useState("");
  const [maxUses, setMaxUses] = useState("");
  const [maxPerCustomer, setMaxPerCustomer] = useState("");
  const [isActive, setIsActive] = useState(true);

  useEffect(() => {
    if (!open) return;
    if (coupon) {
      setCode(coupon.code);
      setType(coupon.discount_type);
      setValue(String(coupon.discount_value));
      setMinAmount(String(coupon.min_amount));
      setValidFrom(coupon.valid_from ?? "");
      setValidTo(coupon.valid_to ?? "");
      setMaxUses(coupon.max_uses != null ? String(coupon.max_uses) : "");
      setMaxPerCustomer(coupon.max_per_customer != null ? String(coupon.max_per_customer) : "");
      setIsActive(coupon.is_active);
    } else {
      setCode("");
      setType("percent");
      setValue("10");
      setMinAmount("0");
      setValidFrom("");
      setValidTo("");
      setMaxUses("");
      setMaxPerCustomer("");
      setIsActive(true);
    }
  }, [open, coupon]);

  async function save() {
    const v = Number(value) || 0;
    if (code.trim() === "") {
      toast({ title: "Poné un código", variant: "error" });
      return;
    }
    if (type === "percent" && (v <= 0 || v > 100)) {
      toast({ title: "El porcentaje debe estar entre 1 y 100", variant: "error" });
      return;
    }
    if (type === "amount" && v <= 0) {
      toast({ title: "El monto debe ser mayor a 0", variant: "error" });
      return;
    }
    const input: CouponInput = {
      code: code.trim(),
      discount_type: type,
      discount_value: v,
      min_amount: Math.max(0, Number(minAmount) || 0),
      valid_from: validFrom || null,
      valid_to: validTo || null,
      max_uses: maxUses ? Math.trunc(Number(maxUses) || 0) : null,
      max_per_customer: maxPerCustomer ? Math.trunc(Number(maxPerCustomer) || 0) : null,
      is_active: isActive,
    };
    try {
      if (coupon) await update.mutateAsync({ id: coupon.id, input });
      else await create.mutateAsync(input);
      toast({ title: coupon ? "Cupón guardado" : "Cupón creado", variant: "success" });
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      toast({
        title: msg.includes("duplicate") || msg.includes("coupons_code_uq")
          ? "Ya existe un cupón con ese código"
          : "No se pudo guardar",
        description: !msg.includes("duplicate") ? msg || undefined : undefined,
        variant: "error",
      });
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={coupon ? "Editar cupón" : "Nuevo cupón"}
    >
      <div className="space-y-4">
        <Input
          label="Código"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="BIENVENIDO10"
          className="font-mono uppercase"
        />

        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs font-medium text-muted-foreground">
            Tipo de descuento
            <select
              value={type}
              onChange={(e) => setType(e.target.value as "percent" | "amount")}
              className="mt-0.5 h-10 w-full rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
            >
              <option value="percent">Porcentaje (%)</option>
              <option value="amount">Monto fijo ($)</option>
            </select>
          </label>
          <Input
            label={type === "percent" ? "Valor (%)" : "Valor ($)"}
            type="number"
            min="0"
            step={type === "percent" ? "1" : "0.01"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </div>

        <Input
          label="Monto mínimo del carrito (0 = sin mínimo)"
          type="number"
          min="0"
          step="0.01"
          value={minAmount}
          onChange={(e) => setMinAmount(e.target.value)}
        />

        <div className="grid grid-cols-2 gap-2">
          <Input
            label="Vigente desde (opcional)"
            type="date"
            value={validFrom}
            onChange={(e) => setValidFrom(e.target.value)}
          />
          <Input
            label="Vigente hasta (opcional)"
            type="date"
            value={validTo}
            onChange={(e) => setValidTo(e.target.value)}
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Input
            label="Tope total de usos (vacío = sin tope)"
            type="number"
            min="1"
            step="1"
            value={maxUses}
            onChange={(e) => setMaxUses(e.target.value)}
          />
          <Input
            label="Tope por cliente (vacío = sin tope)"
            type="number"
            min="1"
            step="1"
            value={maxPerCustomer}
            onChange={(e) => setMaxPerCustomer(e.target.value)}
          />
        </div>

        <label className="flex items-center justify-between gap-2 text-sm">
          <span className="text-muted-foreground">Activo</span>
          <Switch checked={isActive} onCheckedChange={setIsActive} />
        </label>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button loading={create.isPending || update.isPending} onClick={save}>
            {coupon ? "Guardar" : "Crear"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
