"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Info, ImagePlus, Star, Trash2, Link2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { createClient } from "@/lib/supabase/client";
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
import { resizeToWebp } from "@/lib/utils/image";
import { formatCurrency } from "@/lib/utils/format";
import { FEATURE_INFO } from "@/lib/saas/featureInfo";
import { PLAN_ICONS, DEFAULT_PLAN_ICON } from "./planIcons";
import { PlanBadge } from "./PlanBadge";

const PLAN_ASSETS_BUCKET = "plan-assets";

const LIMIT_LABELS: Record<LimitKey, string> = {
  max_stores: "Sucursales",
  max_users: "Usuarios",
  max_products: "Productos",
  max_sales_per_month: "Ventas / mes",
};

// Orden y etiqueta legible de los grupos de features.
const GROUP_LABELS: Record<string, string> = {
  ventas: "Ventas",
  pagos: "Pagos",
  catalogo: "Catálogo",
  clientes: "Clientes",
  tickets: "Tickets",
  reportes: "Reportes",
  integraciones: "Integraciones",
  extras: "Extras",
};
const GROUP_ORDER = [
  "ventas",
  "pagos",
  "catalogo",
  "clientes",
  "tickets",
  "reportes",
  "integraciones",
  "extras",
];

function planNumbers(limits: PlanLimits): PlanLimitNumbers {
  return (limits.limits ?? {}) as PlanLimitNumbers;
}

function planModules(limits: PlanLimits): Record<string, boolean> {
  const m = (limits.modules ?? {}) as Record<string, unknown>;
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(m)) out[k] = Boolean(v);
  return out;
}

// Popover de información de una feature (Info icon → explicación).
//
// IMPORTANTE: este Popover vive DENTRO del Modal (Radix Dialog). Un Popover de
// Radix *no controlado* anidado en un Dialog se cierra solo: al abrir, su
// contenido (portaleado fuera del DOM del Dialog) intenta tomar el foco y el
// FocusScope del Dialog lo reclama de inmediato, por lo que el popover nunca
// llega a verse. La solución (mismo patrón que `InfoHint`, que sí funciona) es:
//   1) controlar el `open` nosotros (useState) y abrir en click/hover,
//   2) `onOpenAutoFocus` → preventDefault: el popover NO roba el foco, así el
//      Dialog no pelea por recuperarlo y el contenido permanece visible.
function FeatureInfoButton({ featureKey }: { featureKey: string }) {
  const [open, setOpen] = useState(false);
  const info = FEATURE_INFO[featureKey];
  if (!info) return null;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label="Más información"
          className="shrink-0 rounded p-0.5 text-muted-foreground transition hover:text-ninja-flameSoft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={(e) => {
            // El botón vive junto a un <label>; evitamos que el click togglee
            // el checkbox vecino, pero toggleamos el popover nosotros.
            e.preventDefault();
            setOpen((v) => !v);
          }}
          onMouseEnter={() => setOpen(true)}
        >
          <Info size={14} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="center"
          sideOffset={6}
          collisionPadding={12}
          onMouseLeave={() => setOpen(false)}
          onOpenAutoFocus={(e) => e.preventDefault()}
          className="z-[60] w-64 rounded-lg border border-border bg-popover p-3 text-xs text-popover-foreground shadow-ninjaSoft backdrop-blur-xl data-[state=open]:animate-modal-in"
        >
          <p className="text-foreground">{info.desc}</p>
          <p className="mt-2 text-muted-foreground">
            <span className="font-semibold text-foreground">Si lo desactivás: </span>
            {info.impact}
          </p>
          <p className="mt-2 text-[11px] uppercase tracking-wide text-ninja-flameSoft">
            Desde plan: {info.minPlan}
          </p>
          <Popover.Arrow className="fill-border" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// Matriz de features agrupada por `grupo` con checkboxes + info por fila.
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
    // Orden estable: GROUP_ORDER primero, luego cualquier grupo nuevo.
    const ordered = [
      ...GROUP_ORDER.filter((g) => map.has(g)),
      ...Array.from(map.keys()).filter((g) => !GROUP_ORDER.includes(g)),
    ];
    return ordered.map((g) => [g, map.get(g)!] as const);
  }, [features]);

  return (
    <div className="space-y-3">
      {groups.map(([grupo, items]) => (
        <div key={grupo} className="rounded-lg border border-border p-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {GROUP_LABELS[grupo] ?? grupo}
          </div>
          <div className="grid gap-1 sm:grid-cols-2">
            {items.map((f) => {
              const checked = selected[f.key] ?? false;
              const isAddon = f.key === "asistente_ia";
              return (
                <div
                  key={f.key}
                  className="flex items-start gap-2 rounded-md px-2 py-1.5 text-sm transition hover:bg-muted/50"
                >
                  <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-2">
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
                      {isAddon && (
                        <span className="ml-1.5 rounded bg-ninja-flame/15 px-1 py-0.5 text-[10px] font-medium uppercase text-ninja-flameSoft">
                          add-on
                        </span>
                      )}
                      {isAddon && (
                        <span className="block text-[11px] text-muted-foreground">
                          Se gestiona como add-on (se contrata por negocio).
                        </span>
                      )}
                    </span>
                  </label>
                  <FeatureInfoButton featureKey={f.key} />
                </div>
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
  const fileRef = useRef<HTMLInputElement>(null);

  const isEdit = plan !== null;

  const [icon, setIcon] = useState(DEFAULT_PLAN_ICON);
  const [name, setName] = useState("");
  const [secondaryName, setSecondaryName] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");
  const [trialOn, setTrialOn] = useState(true);
  const [trialDays, setTrialDays] = useState("14");
  const [imageUrl, setImageUrl] = useState("");
  const [recommended, setRecommended] = useState(false);
  const [uploading, setUploading] = useState(false);
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
      setSecondaryName(plan.secondaryName ?? "");
      setDescription(plan.description ?? "");
      setPrice(String(plan.monthlyPrice));
      setTrialOn(plan.trialDays > 0);
      setTrialDays(plan.trialDays > 0 ? String(plan.trialDays) : "14");
      setImageUrl(plan.imageUrl ?? "");
      setRecommended(plan.isRecommended);
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
      setSecondaryName("");
      setDescription("");
      setPrice("");
      setTrialOn(true);
      setTrialDays("14");
      setImageUrl("");
      setRecommended(false);
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

  async function onPickImage(file: File | undefined) {
    if (!file) return;
    setUploading(true);
    try {
      const supabase = createClient();
      const webp = await resizeToWebp(file, 600, 0.9);
      const path = `plans/plan-${crypto.randomUUID()}.webp`;
      const up = await supabase.storage
        .from(PLAN_ASSETS_BUCKET)
        .upload(path, webp, { contentType: "image/webp", upsert: false });
      if (up.error) throw up.error;
      const { data: pub } = supabase.storage
        .from(PLAN_ASSETS_BUCKET)
        .getPublicUrl(path);
      setImageUrl(pub.publicUrl);
      toast({ title: "Imagen cargada", variant: "success" });
    } catch (e) {
      toast({
        title: "No se pudo subir la imagen",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

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
      secondaryName: secondaryName.trim(),
      description: description.trim(),
      icon,
      imageUrl: imageUrl.trim(),
      isRecommended: recommended,
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

  // Plan "virtual" para el preview (refleja el estado actual del form).
  const previewPlan = {
    name: name.trim() || "Plan",
    secondaryName: secondaryName.trim() || null,
    imageUrl: imageUrl.trim() || null,
    icon,
  };

  return (
    <>
      <Modal
        open={open}
        onOpenChange={onOpenChange}
        title={isEdit ? "Editar plan" : "Nuevo plan"}
        className="max-w-2xl"
      >
        <div className="space-y-5">
          {/* Preview del plan (PlanBadge) */}
          <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-muted/30 p-4">
            <PlanBadge plan={previewPlan} size="md" />
            <div className="flex flex-col items-end gap-1 text-right">
              <span className="font-price text-lg font-bold text-foreground">
                {price.trim() !== "" && Number.isFinite(Number(price))
                  ? formatCurrency(Number(price))
                  : "—"}
                <span className="text-xs font-normal text-muted-foreground">
                  /mes
                </span>
              </span>
              {recommended && (
                <span className="inline-flex items-center gap-1 rounded-full border border-ninja-gold/40 bg-ninja-gold/10 px-2 py-0.5 text-[11px] font-semibold text-ninja-gold">
                  <Star size={11} className="fill-ninja-gold" /> Recomendado
                </span>
              )}
            </div>
          </div>

          {/* Nombre + secundario */}
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label="Nombre"
              placeholder="PRO"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Input
              label="Nombre comercial secundario"
              placeholder="Discípulo"
              hint="Ej. Aprendiz, Discípulo, Maestro, Sensei"
              value={secondaryName}
              onChange={(e) => setSecondaryName(e.target.value)}
            />
          </div>

          {/* Precio + descripción */}
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label="Precio mensual (ARS)"
              type="number"
              min="0"
              step="0.01"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
            <Input
              label="Descripción"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          {/* Imagen del plan (opcional) */}
          <div className="rounded-lg border border-border p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium text-muted-foreground">
                Imagen del plan (opcional, rectangular)
              </span>
              {imageUrl && (
                <button
                  type="button"
                  onClick={() => setImageUrl("")}
                  className="inline-flex items-center gap-1 text-xs text-destructive transition hover:underline"
                >
                  <Trash2 size={12} /> Quitar
                </button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <div className="grid h-14 w-40 place-items-center overflow-hidden rounded-md border border-border bg-background">
                {imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={imageUrl}
                    alt="Imagen del plan"
                    className="h-full w-full object-contain"
                  />
                ) : (
                  <ImagePlus size={20} className="text-muted-foreground" />
                )}
              </div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                loading={uploading}
                onClick={() => fileRef.current?.click()}
              >
                {imageUrl ? "Cambiar" : "Subir imagen"}
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => onPickImage(e.target.files?.[0])}
              />
            </div>
            <div className="mt-3 flex items-center gap-2">
              <Link2 size={14} className="shrink-0 text-muted-foreground" />
              <Input
                placeholder="…o pegá una URL de imagen"
                value={imageUrl}
                onChange={(e) => setImageUrl(e.target.value)}
                className="h-9"
              />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Se usa como logo del plan. Si la cargás, reemplaza al nombre en la
              tarjeta. Se convierte a WebP (máx. 600px).
            </p>
          </div>

          {/* Ícono (fallback cuando no hay imagen) */}
          <div>
            <label className="mb-2 block text-sm font-medium text-muted-foreground">
              Ícono <span className="text-xs font-normal">(si no hay imagen)</span>
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

          {/* Recomendado + Trial */}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex items-start gap-2 rounded-lg border border-border p-3 text-sm">
              <input
                type="checkbox"
                checked={recommended}
                onChange={(e) => setRecommended(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-ninja-flame"
              />
              <span>
                <span className="font-medium text-foreground">
                  Plan recomendado
                </span>
                <span className="block text-xs text-muted-foreground">
                  Se destaca como sugerido. Sólo un plan puede estar recomendado.
                </span>
              </span>
            </label>

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
                  Los addons se contratan por negocio desde su ficha.
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
        description={`Hay ${subscriberCount} negocio${subscriberCount === 1 ? "" : "s"} suscripto${subscriberCount === 1 ? "" : "s"}. Si el precio sube, se les enviará el aviso de aumento de tarifa.`}
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
