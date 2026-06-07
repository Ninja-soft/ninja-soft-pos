"use client";

import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import {
  LIMIT_KEYS,
  type LimitKey,
  type Feature,
  type PlanLimitNumbers,
  type PlanLimits,
  type PlanWithCount,
  type SavePlanInput,
} from "@/modules/internal/api";
import {
  useFeatures,
  usePlanAddons,
  useSavePlan,
} from "@/modules/internal/hooks";
import { formatCurrency } from "@/lib/utils/format";
import { PLAN_ICONS, DEFAULT_PLAN_ICON } from "./planIcons";

const LIMIT_LABELS: Record<LimitKey, string> = {
  max_stores: "Sucursales",
  max_users: "Usuarios",
  max_products: "Productos",
  max_sales_per_month: "Ventas / mes",
};

function planNumbers(limits: PlanLimits): PlanLimitNumbers {
  return (limits.limits ?? {}) as PlanLimitNumbers;
}

function planModules(limits: PlanLimits): Record<string, boolean> {
  const m = (limits.modules ?? {}) as Record<string, unknown>;
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(m)) out[k] = Boolean(v);
  return out;
}

// Matriz de features agrupada por `grupo` con checkboxes.
function FeatureMatrix({
  features,
  selected,
  onToggle,
}: {
  features: Feature[];
  selected: Record<string, boolean>;
  onToggle: (key: string, value: boolean) => void;
}) {
  const groups = useMemo(() => {
    const map = new Map<string, Feature[]>();
    for (const f of features) {
      const list = map.get(f.grupo) ?? [];
      list.push(f);
      map.set(f.grupo, list);
    }
    return Array.from(map.entries());
  }, [features]);

  return (
    <div className="space-y-3">
      {groups.map(([grupo, items]) => (
        <div key={grupo} className="rounded-lg border border-border p-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {grupo}
          </div>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {items.map((f) => {
              const checked = selected[f.key] ?? false;
              return (
                <label
                  key={f.key}
                  className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-sm transition hover:bg-muted/50"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => onToggle(f.key, e.target.checked)}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-ninja-flame"
                  />
                  <span className="min-w-0">
                    <span className="text-foreground">{f.label}</span>
                    {f.is_basic && (
                      <span className="ml-1.5 rounded bg-muted px-1 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
                        básica
                      </span>
                    )}
                    {f.description && (
                      <span className="block text-xs text-muted-foreground">
                        {f.description}
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

export function PlanEditorModal({
  open,
  onOpenChange,
  plan,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  // null = crear; objeto = editar.
  plan: PlanWithCount | null;
}) {
  const { toast } = useToast();
  const { data: features } = useFeatures();
  const { data: addons } = usePlanAddons();
  const save = useSavePlan();

  const isEdit = plan !== null;

  const [icon, setIcon] = useState(DEFAULT_PLAN_ICON);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");
  const [trialOn, setTrialOn] = useState(true);
  const [trialDays, setTrialDays] = useState("14");
  const [limits, setLimits] = useState<Record<LimitKey, string>>({
    max_stores: "",
    max_users: "",
    max_products: "",
    max_sales_per_month: "",
  });
  const [modules, setModules] = useState<Record<string, boolean>>({});
  const [active, setActive] = useState(true);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Inicializa el form al abrir (crear → básicas preseleccionadas).
  useEffect(() => {
    if (!open) return;
    if (plan) {
      const nums = planNumbers(plan.limits);
      setIcon(plan.icon ?? DEFAULT_PLAN_ICON);
      setName(plan.name);
      setDescription(plan.description ?? "");
      setPrice(String(plan.monthlyPrice));
      setTrialOn(plan.trialDays > 0);
      setTrialDays(plan.trialDays > 0 ? String(plan.trialDays) : "14");
      setLimits({
        max_stores: nums.max_stores != null ? String(nums.max_stores) : "",
        max_users: nums.max_users != null ? String(nums.max_users) : "",
        max_products: nums.max_products != null ? String(nums.max_products) : "",
        max_sales_per_month:
          nums.max_sales_per_month != null
            ? String(nums.max_sales_per_month)
            : "",
      });
      setModules(planModules(plan.limits));
      setActive(plan.isActive);
    } else {
      setIcon(DEFAULT_PLAN_ICON);
      setName("");
      setDescription("");
      setPrice("");
      setTrialOn(true);
      setTrialDays("14");
      setLimits({
        max_stores: "",
        max_users: "",
        max_products: "",
        max_sales_per_month: "",
      });
      // Al crear: básicas preseleccionadas (se setea cuando features carga).
      setModules({});
      setActive(true);
    }
  }, [open, plan]);

  // Preselección de features básicas al crear (cuando llega el catálogo).
  useEffect(() => {
    if (!open || plan || !features) return;
    setModules((prev) => {
      if (Object.keys(prev).length > 0) return prev;
      const next: Record<string, boolean> = {};
      for (const f of features) if (f.is_basic) next[f.key] = true;
      return next;
    });
  }, [open, plan, features]);

  function buildLimits(): PlanLimits {
    const nums: PlanLimitNumbers = {};
    for (const k of LIMIT_KEYS) {
      const raw = limits[k].trim();
      // 0 o vacío = ilimitado → no se escribe la clave (null efectivo).
      if (raw !== "" && Number(raw) > 0) nums[k] = Number(raw);
    }
    const mods: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(modules)) if (v) mods[k] = true;
    return {
      // Preserva support existente al editar.
      ...(plan?.limits.support ? { support: plan.limits.support } : {}),
      limits: nums,
      modules: mods,
    };
  }

  function validate(): SavePlanInput | null {
    const p = Number(price);
    if (!name.trim()) {
      toast({ title: "Ingresá un nombre", variant: "error" });
      return null;
    }
    if (!Number.isFinite(p) || p < 0) {
      toast({ title: "Precio inválido", variant: "error" });
      return null;
    }
    const days = trialOn ? Number(trialDays) : 0;
    if (trialOn && (!Number.isFinite(days) || days < 0)) {
      toast({ title: "Días de prueba inválidos", variant: "error" });
      return null;
    }
    return {
      id: plan?.id ?? null,
      key: plan?.key ?? null,
      name: name.trim(),
      description: description.trim(),
      icon,
      monthlyPrice: p,
      trialDays: trialOn ? days : 0,
      limits: buildLimits(),
      isActive: active,
    };
  }

  async function doSave(input: SavePlanInput) {
    try {
      await save.mutateAsync(input);
      toast({
        title: isEdit ? "Plan actualizado" : "Plan creado",
        variant: "success",
      });
      onOpenChange(false);
    } catch (e) {
      toast({
        title: "No se pudo guardar",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  function handleSave() {
    const input = validate();
    if (!input) return;
    // Si edita el PRECIO de un plan con suscriptos → confirmación.
    const priceChanged = plan != null && plan.monthlyPrice !== input.monthlyPrice;
    if (priceChanged && (plan?.subscriberCount ?? 0) > 0) {
      setConfirmOpen(true);
      return;
    }
    void doSave(input);
  }

  const subscriberCount = plan?.subscriberCount ?? 0;

  return (
    <>
      <Modal
        open={open}
        onOpenChange={onOpenChange}
        title={isEdit ? "Editar plan" : "Nuevo plan"}
        className="max-w-2xl"
      >
        <div className="space-y-5">
          {/* Ícono */}
          <div>
            <label className="mb-2 block text-sm font-medium text-muted-foreground">
              Ícono
            </label>
            <div className="flex flex-wrap gap-2">
              {PLAN_ICONS.map(({ key, Icon }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setIcon(key)}
                  aria-label={key}
                  aria-pressed={icon === key}
                  className={cn(
                    "grid h-10 w-10 place-items-center rounded-lg border transition",
                    icon === key
                      ? "border-ninja-flameSoft bg-ninja-flame/15 text-ninja-flameSoft"
                      : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  <Icon size={18} />
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label="Nombre comercial"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Input
              label="Precio mensual (ARS)"
              type="number"
              min="0"
              step="0.01"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
          </div>

          <Input
            label="Descripción"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />

          {/* Trial */}
          <div className="rounded-lg border border-border p-3">
            <label className="flex items-center gap-2 text-sm font-medium text-foreground">
              <input
                type="checkbox"
                checked={trialOn}
                onChange={(e) => setTrialOn(e.target.checked)}
                className="h-4 w-4 accent-ninja-flame"
              />
              Días de prueba
            </label>
            {trialOn && (
              <div className="mt-3 max-w-[180px]">
                <Input
                  type="number"
                  min="0"
                  value={trialDays}
                  onChange={(e) => setTrialDays(e.target.value)}
                  hint="0 = sin prueba"
                />
              </div>
            )}
          </div>

          {/* Límites */}
          <div>
            <div className="mb-2 text-sm font-medium text-muted-foreground">
              Límites
              <span className="ml-2 text-xs font-normal">
                (0 o vacío = ilimitado)
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {LIMIT_KEYS.map((k) => (
                <Input
                  key={k}
                  label={LIMIT_LABELS[k]}
                  type="number"
                  min="0"
                  placeholder="∞"
                  value={limits[k]}
                  onChange={(e) =>
                    setLimits((s) => ({ ...s, [k]: e.target.value }))
                  }
                />
              ))}
            </div>
          </div>

          {/* Features */}
          <div>
            <div className="mb-2 text-sm font-medium text-muted-foreground">
              Funcionalidades incluidas
            </div>
            <FeatureMatrix
              features={features ?? []}
              selected={modules}
              onToggle={(key, value) =>
                setModules((s) => ({ ...s, [key]: value }))
              }
            />
          </div>

          {/* Addons (read-only) */}
          {(addons?.length ?? 0) > 0 && (
            <div>
              <div className="mb-2 text-sm font-medium text-muted-foreground">
                Addons disponibles
              </div>
              <div className="rounded-lg border border-border bg-muted/30 p-3">
                <p className="mb-2 text-xs text-muted-foreground">
                  Los addons se gestionan por negocio desde su ficha.
                </p>
                <ul className="space-y-1.5">
                  {(addons ?? []).map((a) => (
                    <li
                      key={a.key}
                      className="flex items-center justify-between gap-3 text-sm"
                    >
                      <span className="text-foreground">{a.label}</span>
                      <span className="text-muted-foreground">
                        {formatCurrency(a.monthlyPrice)}/mes
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {/* Activo */}
          <label className="flex items-center gap-2 text-sm font-medium text-foreground">
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
              className="h-4 w-4 accent-ninja-flame"
            />
            Plan activo (visible para nuevos negocios)
          </label>

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button loading={save.isPending} onClick={handleSave}>
              {isEdit ? "Guardar cambios" : "Crear plan"}
            </Button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Cambio de precio con negocios suscriptos"
        description={`Hay ${subscriberCount} negocio${subscriberCount === 1 ? "" : "s"} suscripto${subscriberCount === 1 ? "" : "s"}. El aviso de aumento se enviará en la Fase E (próximamente).`}
        confirmLabel="Guardar igual"
        loading={save.isPending}
        onConfirm={() => {
          const input = validate();
          if (input) void doSave(input).then(() => setConfirmOpen(false));
        }}
      />
    </>
  );
}
