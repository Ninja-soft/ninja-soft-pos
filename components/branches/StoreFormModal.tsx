"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { z } from "zod";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { useBranchContext, useBranchMutations } from "@/modules/branches/hooks";
import { INHERIT_ALL, StoreSetupPicker, useApplySetup, type SetupChoice } from "@/components/branches/StoreSetup";
import { useFeature } from "@/modules/saas/gating";
import type { StoreInput } from "@/modules/branches/api";
import {
  branchErrorMessage,
  normalizeOpeningHours,
  WEEK_DAYS,
  type Branch,
  type OpeningHours,
  type WeekDay,
} from "@/modules/branches/logic";
import { cn } from "@/lib/utils/cn";

// Colores sugeridos para identificar la sucursal (chip, POS, listados).
const COLORS = ["#ff5a2c", "#ffb020", "#22c55e", "#14b8a6", "#3b82f6", "#8b5cf6", "#ec4899", "#64748b"];

const schema = z.object({
  name: z.string().trim().min(2, "Poné un nombre de al menos 2 letras").max(80),
  short_name: z.string().trim().max(20, "Máximo 20 caracteres").optional(),
  code: z
    .string()
    .trim()
    .max(12, "Máximo 12 caracteres")
    .regex(/^[A-Za-z0-9_-]*$/, "Sólo letras, números, guion y guion bajo")
    .optional(),
  email: z.union([z.literal(""), z.string().trim().email("Email inválido")]).optional(),
  afip_pos_number: z
    .union([z.literal(""), z.coerce.number().int().min(1, "Entre 1 y 99998").max(99998, "Entre 1 y 99998")])
    .optional(),
});

type Form = {
  name: string;
  short_name: string;
  code: string;
  color: string | null;
  address: string;
  city: string;
  province: string;
  postal_code: string;
  phone: string;
  email: string;
  afip_pos_number: string;
  notes: string;
  hours: OpeningHours;
};

function toForm(b: Branch | null): Form {
  return {
    name: b?.name ?? "",
    short_name: b?.short_name ?? "",
    code: b?.code ?? "",
    color: b?.color ?? null,
    address: b?.address ?? "",
    city: b?.city ?? "",
    province: b?.province ?? "",
    postal_code: b?.postal_code ?? "",
    phone: b?.phone ?? "",
    email: b?.email ?? "",
    afip_pos_number: b?.afip_pos_number ? String(b.afip_pos_number) : "",
    notes: b?.notes ?? "",
    hours: b?.opening_hours ?? {},
  };
}

const nul = (v: string) => (v.trim() ? v.trim() : null);

export function StoreFormModal({
  open,
  onOpenChange,
  branch,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  branch: Branch | null; // null = nueva
}) {
  const { toast } = useToast();
  const m = useBranchMutations();
  const [f, setF] = useState<Form>(() => toForm(branch));
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Configuración inicial de una sucursal nueva (F17 · ADR-057).
  const ctx = useBranchContext();
  const multiStore = useFeature("multi_sucursal") === true;
  const [setup, setSetup] = useState<SetupChoice>(INHERIT_ALL);
  const applySetup = useApplySetup();
  const canCopy = !branch && multiStore && ctx.allowed.length > 0;

  useEffect(() => {
    if (open) {
      setF(toForm(branch));
      setErrors({});
      setSetup(INHERIT_ALL);
    }
  }, [open, branch]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((s) => ({ ...s, [k]: v }));

  function setRange(day: WeekDay, idx: number, key: "from" | "to", value: string) {
    setF((s) => {
      const list = [...(s.hours[day] ?? [])];
      list[idx] = { ...(list[idx] ?? { from: "", to: "" }), [key]: value };
      return { ...s, hours: { ...s.hours, [day]: list } };
    });
  }
  function addRange(day: WeekDay) {
    setF((s) => ({ ...s, hours: { ...s.hours, [day]: [...(s.hours[day] ?? []), { from: "09:00", to: "18:00" }] } }));
  }
  function removeRange(day: WeekDay, idx: number) {
    setF((s) => ({ ...s, hours: { ...s.hours, [day]: (s.hours[day] ?? []).filter((_, i) => i !== idx) } }));
  }
  function copyToWeekdays(day: WeekDay) {
    setF((s) => {
      const src = s.hours[day] ?? [];
      const next = { ...s.hours };
      for (const d of ["mon", "tue", "wed", "thu", "fri"] as WeekDay[]) next[d] = src.map((r) => ({ ...r }));
      return { ...s, hours: next };
    });
  }

  async function save() {
    const parsed = schema.safeParse(f);
    const errs: Record<string, string> = {};
    if (!parsed.success) {
      for (const i of parsed.error.issues) errs[String(i.path[0])] = i.message;
    }
    const hours = normalizeOpeningHours(f.hours);
    if (!hours) errs.hours = "Revisá el horario: cada rango va de menor a mayor y no se superponen";
    setErrors(errs);
    if (Object.keys(errs).length) return;

    const input: StoreInput = {
      name: f.name.trim(),
      short_name: nul(f.short_name),
      code: nul(f.code),
      color: f.color,
      address: nul(f.address),
      city: nul(f.city),
      province: nul(f.province),
      postal_code: nul(f.postal_code),
      phone: nul(f.phone),
      email: nul(f.email),
      afip_pos_number: f.afip_pos_number.trim() ? Number(f.afip_pos_number) : null,
      opening_hours: hours ?? {},
      notes: nul(f.notes),
    };
    try {
      if (branch) await m.updateStore.mutateAsync({ id: branch.id, patch: input });
      else {
        const id = await m.createStore.mutateAsync(input);
        if (canCopy) await applySetup.apply(id, setup);
      }
      toast({ title: branch ? "Sucursal actualizada" : "Sucursal creada", variant: "success" });
      onOpenChange(false);
    } catch (e) {
      toast({ title: branchErrorMessage(e), variant: "error" });
    }
  }

  const saving = m.createStore.isPending || m.updateStore.isPending || applySetup.pending;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={branch ? `Editar ${branch.name}` : "Nueva sucursal"}
      description={branch ? undefined : "Después le agregás cajas y asignás personal."}
      className="sm:max-w-2xl"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button loading={saving} onClick={save}>
            {branch ? "Guardar" : "Crear sucursal"}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-[1fr_160px_120px]">
          <Input label="Nombre" value={f.name} onChange={(e) => set("name", e.target.value)} error={errors.name} placeholder="Sucursal Centro" autoFocus />
          <Input label="Nombre corto" value={f.short_name} onChange={(e) => set("short_name", e.target.value)} error={errors.short_name} placeholder="Centro" hint="Se ve en el POS" />
          <Input label="Código" value={f.code} onChange={(e) => set("code", e.target.value.toUpperCase())} error={errors.code} placeholder="CEN" />
        </div>

        <div>
          <div className="mb-2 text-sm font-medium text-muted-foreground">Color</div>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Color de la sucursal">
            <button
              type="button"
              role="radio"
              aria-checked={f.color === null}
              onClick={() => set("color", null)}
              className={cn(
                "h-8 rounded-md border px-3 text-xs font-medium",
                f.color === null ? "border-foreground" : "border-border text-muted-foreground",
              )}
            >
              Sin color
            </button>
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={f.color === c}
                aria-label={`Color ${c}`}
                onClick={() => set("color", c)}
                className={cn(
                  "h-8 w-8 rounded-full border-2 transition",
                  f.color === c ? "border-foreground scale-110" : "border-transparent",
                )}
                style={{ background: c }}
              />
            ))}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Dirección" value={f.address} onChange={(e) => set("address", e.target.value)} placeholder="Av. Siempreviva 742" />
          <Input label="Ciudad" value={f.city} onChange={(e) => set("city", e.target.value)} />
          <Input label="Provincia" value={f.province} onChange={(e) => set("province", e.target.value)} />
          <Input label="Código postal" value={f.postal_code} onChange={(e) => set("postal_code", e.target.value)} />
          <Input label="Teléfono" value={f.phone} onChange={(e) => set("phone", e.target.value)} inputMode="tel" />
          <Input label="Email" value={f.email} onChange={(e) => set("email", e.target.value)} error={errors.email} inputMode="email" />
        </div>

        <Input
          label="Punto de venta fiscal (ARCA)"
          value={f.afip_pos_number}
          onChange={(e) => set("afip_pos_number", e.target.value.replace(/\D/g, ""))}
          error={errors.afip_pos_number}
          inputMode="numeric"
          placeholder="Ej.: 3"
          hint="Lo vas a usar cuando se active la facturación electrónica por sucursal."
        />

        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium text-muted-foreground">Horario de atención</span>
          </div>
          <div className="divide-y divide-border rounded-xl border border-border">
            {WEEK_DAYS.map((d) => {
              const ranges = f.hours[d.key] ?? [];
              return (
                <div key={d.key} className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <span className="w-20 shrink-0 text-sm">{d.label}</span>
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                    {ranges.length === 0 && <span className="text-xs text-muted-foreground">Cerrado</span>}
                    {ranges.map((r, i) => (
                      <span key={i} className="inline-flex items-center gap-1">
                        <input
                          type="time"
                          aria-label={`${d.label} desde`}
                          value={r.from}
                          onChange={(e) => setRange(d.key, i, "from", e.target.value)}
                          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                        />
                        <span className="text-muted-foreground">a</span>
                        <input
                          type="time"
                          aria-label={`${d.label} hasta`}
                          value={r.to}
                          onChange={(e) => setRange(d.key, i, "to", e.target.value)}
                          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                        />
                        <button
                          type="button"
                          onClick={() => removeRange(d.key, i)}
                          className="grid h-9 w-9 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                          aria-label={`Quitar rango del ${d.label}`}
                        >
                          <Trash2 size={14} />
                        </button>
                      </span>
                    ))}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      onClick={() => addRange(d.key)}
                      className="inline-flex h-9 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <Plus size={13} /> Rango
                    </button>
                    {d.key === "mon" && ranges.length > 0 && (
                      <button
                        type="button"
                        onClick={() => copyToWeekdays("mon")}
                        className="inline-flex h-9 items-center rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        Copiar a lunes a viernes
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {errors.hours && <p className="mt-2 text-xs text-danger">{errors.hours}</p>}
        </div>

        <Input label="Notas internas" value={f.notes} onChange={(e) => set("notes", e.target.value)} placeholder="Ej.: llave en la caja fuerte de la oficina" />

        {canCopy && (
          <div>
            <div className="mb-2 text-sm font-medium text-muted-foreground">Configuración inicial</div>
            <StoreSetupPicker value={setup} onChange={setSetup} branches={ctx.allowed} />
          </div>
        )}
      </div>
    </Modal>
  );
}
