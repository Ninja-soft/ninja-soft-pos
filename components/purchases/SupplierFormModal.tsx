"use client";

// Alta y edición de proveedor (F18 · H101, ADR-050). El servidor valida CUIT,
// CBU y alias de nuevo (checks de la tabla) y exige rol y plan (RLS).

import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { purchaseErrorMessage } from "@/lib/purchases/orders";
import {
  CURRENCIES,
  CURRENCY_LABEL,
  PROVINCES,
  SUPPLIER_IVA_LABEL,
  formatCuit,
  isValidAlias,
  isValidCbu,
  isValidCuit,
  normalizeCuit,
  type SupplierIvaCondition,
} from "@/lib/purchases/suppliers";
import type { Supplier, SupplierInput } from "@/modules/purchases/api";
import { usePurchaseMutations, usePurchasesAccess } from "@/modules/purchases/hooks";
import { selectCls, textareaCls } from "./shared";

interface FormState {
  name: string;
  trade_name: string;
  cuit: string;
  foreign_tax_id: string;
  iva_condition: SupplierIvaCondition;
  contact_name: string;
  email: string;
  phone: string;
  whatsapp: string;
  address: string;
  city: string;
  province: string;
  payment_terms_days: string;
  payment_terms_note: string;
  currency: string;
  cbu: string;
  alias: string;
  bank_name: string;
  notes: string;
  is_active: boolean;
}

function fromSupplier(s: Supplier | null | undefined, currency: string): FormState {
  return {
    name: s?.name ?? "",
    trade_name: s?.trade_name ?? "",
    cuit: s?.cuit ? formatCuit(s.cuit) : "",
    foreign_tax_id: s?.foreign_tax_id ?? "",
    iva_condition: s?.iva_condition ?? "responsable_inscripto",
    contact_name: s?.contact_name ?? "",
    email: s?.email ?? "",
    phone: s?.phone ?? "",
    whatsapp: s?.whatsapp ?? "",
    address: s?.address ?? "",
    city: s?.city ?? "",
    province: s?.province ?? "",
    payment_terms_days: String(s?.payment_terms_days ?? 0),
    payment_terms_note: s?.payment_terms_note ?? "",
    currency: s?.currency ?? currency,
    cbu: s?.cbu ?? "",
    alias: s?.alias ?? "",
    bank_name: s?.bank_name ?? "",
    notes: s?.notes ?? "",
    is_active: s?.is_active ?? true,
  };
}

type Errors = Partial<Record<keyof FormState, string>>;

function validate(f: FormState): Errors {
  const e: Errors = {};
  if (!f.name.trim()) e.name = "Escribí la razón social.";
  if (f.cuit.trim() && !isValidCuit(f.cuit)) e.cuit = "CUIT inválido (revisá el dígito verificador).";
  if (f.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim())) e.email = "Email inválido.";
  const days = Number(f.payment_terms_days);
  if (!Number.isInteger(days) || days < 0 || days > 365) e.payment_terms_days = "Entre 0 y 365 días.";
  if (f.cbu.trim() && !isValidCbu(f.cbu)) e.cbu = "CBU / CVU inválido (22 dígitos con verificadores).";
  if (f.alias.trim() && !isValidAlias(f.alias)) e.alias = "Alias de 6 a 20 caracteres (letras, números, punto o guion).";
  return e;
}

export function SupplierFormModal({
  open,
  onOpenChange,
  supplier,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  supplier?: Supplier | null;
  onSaved?: (s: Supplier) => void;
}) {
  const { toast } = useToast();
  const access = usePurchasesAccess();
  const m = usePurchaseMutations();
  const [f, setF] = useState<FormState>(() => fromSupplier(supplier, access.settings.default_currency));
  const [errors, setErrors] = useState<Errors>({});

  useEffect(() => {
    if (!open) return;
    setF(fromSupplier(supplier, access.pro ? access.settings.default_currency : "ARS"));
    setErrors({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, supplier]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((p) => ({ ...p, [k]: v }));
  const isEdit = Boolean(supplier?.id);
  const exterior = f.iva_condition === "exterior";
  const saving = m.createSupplier.isPending || m.updateSupplier.isPending;

  async function save() {
    const e = validate(f);
    setErrors(e);
    if (Object.keys(e).length > 0) {
      toast({ title: "Revisá los datos marcados", variant: "error" });
      return;
    }
    const input: SupplierInput = {
      name: f.name.trim(),
      trade_name: f.trade_name.trim() || null,
      cuit: normalizeCuit(f.cuit) || null,
      foreign_tax_id: exterior ? f.foreign_tax_id.trim() || null : null,
      iva_condition: f.iva_condition,
      contact_name: f.contact_name.trim() || null,
      email: f.email.trim() || null,
      phone: f.phone.trim() || null,
      whatsapp: f.whatsapp.trim() || null,
      address: f.address.trim() || null,
      city: f.city.trim() || null,
      province: f.province.trim() || null,
      country: supplier?.country ?? "AR",
      payment_terms_days: Number(f.payment_terms_days) || 0,
      payment_terms_note: f.payment_terms_note.trim() || null,
      currency: access.pro ? f.currency : (supplier?.currency ?? "ARS"),
      cbu: f.cbu.replace(/\D/g, "") || null,
      alias: f.alias.trim() || null,
      bank_name: f.bank_name.trim() || null,
      notes: f.notes.trim() || null,
      is_active: f.is_active,
    };
    try {
      if (isEdit && supplier) {
        await m.updateSupplier.mutateAsync({ id: supplier.id, input });
        toast({ title: "Proveedor actualizado", variant: "success" });
        onSaved?.({ ...supplier, ...input });
      } else {
        const s = await m.createSupplier.mutateAsync(input);
        toast({ title: "Proveedor creado", variant: "success" });
        onSaved?.(s);
      }
      onOpenChange(false);
    } catch (err) {
      toast({ title: "No se pudo guardar", description: purchaseErrorMessage(err), variant: "error" });
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? "Editar proveedor" : "Nuevo proveedor"}
      className="sm:max-w-2xl"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={() => void save()} loading={saving}>
            {isEdit ? "Guardar" : "Crear proveedor"}
          </Button>
        </>
      }
    >
      <div className="space-y-6">
        <section className="space-y-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Datos fiscales</h4>
          <Input
            label="Razón social"
            value={f.name}
            maxLength={200}
            error={errors.name}
            onChange={(e) => set("name", e.target.value)}
            autoFocus
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label="Nombre de fantasía (opcional)"
              value={f.trade_name}
              maxLength={200}
              onChange={(e) => set("trade_name", e.target.value)}
            />
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Condición frente al IVA</span>
              <select
                className={selectCls}
                value={f.iva_condition}
                onChange={(e) => set("iva_condition", e.target.value as SupplierIvaCondition)}
              >
                {(Object.keys(SUPPLIER_IVA_LABEL) as SupplierIvaCondition[]).map((k) => (
                  <option key={k} value={k} className="bg-popover text-popover-foreground">
                    {SUPPLIER_IVA_LABEL[k]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label={exterior ? "CUIT (opcional)" : "CUIT"}
              value={f.cuit}
              inputMode="numeric"
              placeholder="20-12345678-6"
              error={errors.cuit}
              hint={!exterior && !f.cuit.trim() ? "Recomendado: lo vas a necesitar para registrar sus facturas." : undefined}
              onChange={(e) => set("cuit", e.target.value)}
              onBlur={() => isValidCuit(f.cuit) && set("cuit", formatCuit(f.cuit))}
            />
            {exterior && (
              <Input
                label="Identificación tributaria del exterior"
                value={f.foreign_tax_id}
                maxLength={40}
                placeholder="Tax ID, VAT, RUT"
                onChange={(e) => set("foreign_tax_id", e.target.value)}
              />
            )}
          </div>
        </section>

        <section className="space-y-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Contacto</h4>
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label="Persona de contacto"
              value={f.contact_name}
              maxLength={120}
              onChange={(e) => set("contact_name", e.target.value)}
            />
            <Input
              label="Email"
              type="email"
              value={f.email}
              maxLength={200}
              error={errors.email}
              onChange={(e) => set("email", e.target.value)}
            />
            <Input label="Teléfono" value={f.phone} maxLength={60} onChange={(e) => set("phone", e.target.value)} />
            <Input
              label="WhatsApp (para mandar pedidos)"
              value={f.whatsapp}
              maxLength={60}
              placeholder="11 1234 5678"
              onChange={(e) => set("whatsapp", e.target.value)}
            />
            <Input
              label="Dirección"
              value={f.address}
              maxLength={300}
              onChange={(e) => set("address", e.target.value)}
            />
            <Input label="Localidad" value={f.city} maxLength={120} onChange={(e) => set("city", e.target.value)} />
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Provincia</span>
              <select className={selectCls} value={f.province} onChange={(e) => set("province", e.target.value)}>
                <option value="" className="bg-popover text-popover-foreground">
                  Sin indicar
                </option>
                {PROVINCES.map((p) => (
                  <option key={p} value={p} className="bg-popover text-popover-foreground">
                    {p}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </section>

        <section className="space-y-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Condiciones de pago</h4>
          <div className="grid gap-3 sm:grid-cols-3">
            <Input
              label="Plazo (días)"
              type="number"
              min={0}
              max={365}
              value={f.payment_terms_days}
              error={errors.payment_terms_days}
              hint="0 = contado"
              onChange={(e) => set("payment_terms_days", e.target.value)}
            />
            <div className="sm:col-span-2">
              <Input
                label="Nota de condiciones (opcional)"
                value={f.payment_terms_note}
                maxLength={200}
                placeholder="50% anticipo, saldo a 30 días"
                onChange={(e) => set("payment_terms_note", e.target.value)}
              />
            </div>
            {access.pro && (
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Moneda habitual</span>
                <select className={selectCls} value={f.currency} onChange={(e) => set("currency", e.target.value)}>
                  {CURRENCIES.map((c) => (
                    <option key={c} value={c} className="bg-popover text-popover-foreground">
                      {CURRENCY_LABEL[c] ?? c}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Input
              label="CBU / CVU"
              value={f.cbu}
              inputMode="numeric"
              maxLength={26}
              error={errors.cbu}
              onChange={(e) => set("cbu", e.target.value)}
            />
            <Input
              label="Alias"
              value={f.alias}
              maxLength={20}
              error={errors.alias}
              onChange={(e) => set("alias", e.target.value)}
            />
            <Input label="Banco" value={f.bank_name} maxLength={120} onChange={(e) => set("bank_name", e.target.value)} />
          </div>
        </section>

        <section className="space-y-3">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Notas</span>
            <textarea
              className={textareaCls}
              maxLength={2000}
              value={f.notes}
              onChange={(e) => set("notes", e.target.value)}
              placeholder="Días de visita del preventista, horarios de entrega, observaciones"
            />
          </label>
          <div className="flex items-center justify-between rounded-xl bg-muted px-3.5 py-3">
            <div>
              <div className="text-sm font-medium">Activo</div>
              <div className="text-xs text-muted-foreground">Aparece para armar órdenes de compra.</div>
            </div>
            <Switch checked={f.is_active} onCheckedChange={(v) => set("is_active", v)} label="Activo" />
          </div>
        </section>
      </div>
    </Modal>
  );
}
