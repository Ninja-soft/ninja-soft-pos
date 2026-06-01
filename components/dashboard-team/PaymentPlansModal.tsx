"use client";

import Image from "next/image";
import { useState } from "react";
import { Pencil, Plus, Trash2, X, Check, Sparkles } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { usePaymentPlans, usePaymentPlanMutations } from "@/modules/pos/hooks";
import { TYPICAL_AR_PLANS } from "@/modules/pos/api";

const BASES = [
  { value: "efectivo", label: "Efectivo" },
  { value: "transferencia", label: "Transferencia" },
  { value: "debito", label: "Débito" },
  { value: "credito", label: "Crédito" },
  { value: "qr", label: "QR" },
  { value: "otro", label: "Otro" },
] as const;

const BRANDS = [
  { value: "", label: "Sin marca" },
  { value: "visa", label: "Visa" },
  { value: "master", label: "Mastercard" },
  { value: "maestro", label: "Maestro" },
  { value: "cabal", label: "Cabal" },
  { value: "amex", label: "Amex" },
  { value: "naranja", label: "Naranja" },
  { value: "diners", label: "Diners" },
] as const;

const BASE_LABEL: Record<string, string> = Object.fromEntries(
  BASES.map((b) => [b.value, b.label]),
);
const BRAND_LABEL: Record<string, string> = Object.fromEntries(
  BRANDS.filter((b) => b.value).map((b) => [b.value, b.label]),
);

// Logo de la marca según base (débito/crédito). Devuelve null si no hay.
function brandLogo(brand: string | null, base: string): string | null {
  if (!brand) return null;
  const isDebit = base === "debito";
  const map: Record<string, { credito?: string; debito?: string }> = {
    visa: { credito: "visa_credito", debito: "visa_debito" },
    master: { credito: "martercard_credito", debito: "mastercard_debito" },
    maestro: { debito: "maestro_debito" },
    cabal: { credito: "cabal_credito", debito: "cabal_debito" },
    amex: { credito: "amex_credito" },
    naranja: { credito: "naranja_credito" },
    diners: { credito: "dinners_credito" },
  };
  const m = map[brand];
  if (!m) return null;
  const file = (isDebit ? m.debito : m.credito) ?? m.credito ?? m.debito;
  return file ? `/img/medios_de_pago/cards/${file}.svg` : null;
}

interface FormState {
  label: string;
  base: string;
  brand: string;
  installments: string;
  surcharge_pct: string;
  sort: string;
}
const EMPTY: FormState = {
  label: "",
  base: "credito",
  brand: "",
  installments: "1",
  surcharge_pct: "0",
  sort: "0",
};

// Planes de pago con recargo por marca de tarjeta (H27). Cada plan = base
// (débito/crédito/…) + marca + cuotas + recargo %. Al cobrar, el cajero elige
// el plan y el recargo entra como ítem "Recargo …" en la venta.
export function PaymentPlansModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { toast } = useToast();
  const { data: plans } = usePaymentPlans(false);
  const { create, update, seed, setActive, remove } = usePaymentPlanMutations();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const existingCodes = new Set((plans ?? []).map((p) => p.code).filter(Boolean));

  function openNew() {
    setForm(EMPTY);
    setEditingId(null);
    setShowForm(true);
  }

  function openEdit(p: NonNullable<typeof plans>[number]) {
    setForm({
      label: p.label,
      base: p.base ?? "otro",
      brand: p.brand ?? "",
      installments: String(p.installments ?? 1),
      surcharge_pct: String(p.surcharge_pct ?? 0),
      sort: String(p.sort ?? 0),
    });
    setEditingId(p.id);
    setShowForm(true);
  }

  function save() {
    if (form.label.trim().length < 1) {
      toast({ title: "Poné un nombre", variant: "error" });
      return;
    }
    const patch = {
      label: form.label.trim(),
      base: form.base,
      brand: form.brand || null,
      installments: Math.max(1, Number(form.installments) || 1),
      surcharge_pct: Number(form.surcharge_pct) || 0,
      sort: Number(form.sort) || 0,
    };
    const done = {
      onSuccess: () => {
        setShowForm(false);
        setForm(EMPTY);
        setEditingId(null);
      },
      onError: () => toast({ title: "No se pudo guardar", variant: "error" }),
    };
    if (editingId) update.mutate({ id: editingId, patch }, done);
    else create.mutate(patch, done);
  }

  function seedAr() {
    const missing = TYPICAL_AR_PLANS.filter((p) => !existingCodes.has(p.code));
    if (missing.length === 0) {
      toast({ title: "Ya están todos los planes AR", variant: "info" });
      return;
    }
    seed.mutate(missing, {
      onSuccess: (n) =>
        toast({ title: `${n} plan(es) cargado(s)`, variant: "success" }),
      onError: () => toast({ title: "No se pudo cargar", variant: "error" }),
    });
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Medios de pago · planes y recargos"
      className="max-w-2xl"
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="max-w-md text-sm text-muted-foreground">
            Definí un plan por cada tarjeta/cuota que transacciona (ej. “Crédito
            Visa 3 cuotas” +8%). Al cobrar, el cajero elige el plan y el recargo
            se suma al total.
          </p>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={seedAr} loading={seed.isPending}>
              <Sparkles size={15} /> Cargar planes AR
            </Button>
            <Button onClick={openNew}>
              <Plus size={15} /> Nuevo plan
            </Button>
          </div>
        </div>

        {showForm && (
          <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <label className="col-span-2 text-xs text-muted-foreground sm:col-span-3">
                Nombre
                <input
                  value={form.label}
                  onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
                  placeholder="Ej. Crédito Visa 3 cuotas"
                  className="mt-1 h-10 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
                />
              </label>
              <label className="text-xs text-muted-foreground">
                Base
                <select
                  value={form.base}
                  onChange={(e) => setForm((f) => ({ ...f, base: e.target.value }))}
                  className="mt-1 h-10 w-full rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
                >
                  {BASES.map((b) => (
                    <option key={b.value} value={b.value}>
                      {b.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-muted-foreground">
                Marca
                <select
                  value={form.brand}
                  onChange={(e) => setForm((f) => ({ ...f, brand: e.target.value }))}
                  className="mt-1 h-10 w-full rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
                >
                  {BRANDS.map((b) => (
                    <option key={b.value} value={b.value}>
                      {b.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-muted-foreground">
                Cuotas
                <input
                  type="number"
                  min="1"
                  value={form.installments}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, installments: e.target.value }))
                  }
                  className="mt-1 h-10 w-full rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
                />
              </label>
              <label className="text-xs text-muted-foreground">
                Recargo %
                <input
                  type="number"
                  step="0.5"
                  min="0"
                  value={form.surcharge_pct}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, surcharge_pct: e.target.value }))
                  }
                  className="mt-1 h-10 w-full rounded-lg border border-input bg-background px-2 text-right text-sm text-foreground outline-none focus:border-ninja-flameSoft"
                />
              </label>
              <label className="text-xs text-muted-foreground">
                Orden
                <input
                  type="number"
                  value={form.sort}
                  onChange={(e) => setForm((f) => ({ ...f, sort: e.target.value }))}
                  className="mt-1 h-10 w-full rounded-lg border border-input bg-background px-2 text-right text-sm text-foreground outline-none focus:border-ninja-flameSoft"
                />
              </label>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => {
                  setShowForm(false);
                  setEditingId(null);
                }}
              >
                <X size={15} /> Cancelar
              </Button>
              <Button onClick={save} loading={create.isPending || update.isPending}>
                <Check size={15} /> {editingId ? "Guardar" : "Crear plan"}
              </Button>
            </div>
          </div>
        )}

        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Plan</th>
                <th className="px-3 py-2 text-left font-medium">Base</th>
                <th className="px-3 py-2 text-left font-medium">Marca</th>
                <th className="px-3 py-2 text-center font-medium">Cuotas</th>
                <th className="px-3 py-2 text-right font-medium">Recargo</th>
                <th className="px-3 py-2 text-center font-medium">Estado</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {(plans ?? []).length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">
                    Sin planes. Creá uno o usá “Cargar planes AR”.
                  </td>
                </tr>
              )}
              {(plans ?? []).map((p) => {
                const logo = brandLogo(p.brand, p.base ?? "otro");
                return (
                  <tr key={p.id} className="border-t border-border">
                    <td
                      className={
                        p.is_active
                          ? "px-3 py-2 font-medium"
                          : "px-3 py-2 text-muted-foreground line-through"
                      }
                    >
                      {p.label}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {BASE_LABEL[p.base ?? "otro"] ?? p.base}
                    </td>
                    <td className="px-3 py-2">
                      <span className="flex items-center gap-2">
                        {logo && (
                          <Image
                            src={logo}
                            alt={p.brand ?? ""}
                            width={32}
                            height={20}
                            className="h-5 w-auto object-contain"
                          />
                        )}
                        <span className="text-muted-foreground">
                          {p.brand ? BRAND_LABEL[p.brand] ?? p.brand : "—"}
                        </span>
                      </span>
                    </td>
                    <td className="px-3 py-2 text-center tabular-nums">
                      {p.installments ?? 1}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {Number(p.surcharge_pct) ? (
                        <span className="text-ninja-flameSoft">+{p.surcharge_pct}%</span>
                      ) : (
                        <span className="text-muted-foreground">0%</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex justify-center">
                        <Switch
                          checked={p.is_active}
                          onCheckedChange={(v) =>
                            setActive.mutate({ id: p.id, is_active: v })
                          }
                        />
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-2">
                        <button
                          onClick={() => openEdit(p)}
                          title="Editar"
                          className="text-muted-foreground transition hover:text-foreground"
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          onClick={() => remove.mutate(p.id)}
                          title="Eliminar"
                          className="text-muted-foreground transition hover:text-destructive"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </Modal>
  );
}
