"use client";

import { useState } from "react";
import {
  Sparkles,
  Pencil,
  SlidersHorizontal,
  Infinity as InfinityIcon,
  Gift,
  Crown,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import {
  useGlobalPlans,
  useTenantPlanDetail,
  usePlanMutations,
  useInternalMutations,
  usePlanAddons,
  useTenantAddons,
  useSetAddon,
} from "@/modules/internal/hooks";
import {
  LIMIT_KEYS,
  type LimitKey,
  type PlanLimitNumbers,
  type PlanLimits,
} from "@/modules/internal/api";
import { formatCurrency } from "@/lib/utils/format";

const LIMIT_LABELS: Record<LimitKey, string> = {
  max_stores: "Sucursales",
  max_users: "Usuarios",
  max_products: "Productos",
  max_sales_per_month: "Ventas / mes",
};

const selectCls =
  "h-11 w-full rounded-lg border border-input bg-background px-4 text-sm text-foreground outline-none focus:border-ninja-flameSoft focus:ring-4 focus:ring-ninja-flameSoft/15";

function planNumbers(limits: PlanLimits): PlanLimitNumbers {
  return (limits.limits ?? {}) as PlanLimitNumbers;
}

export function PlanCard({ tenantId }: { tenantId: string }) {
  const { toast } = useToast();
  const { data: detail, isLoading } = useTenantPlanDetail(tenantId);
  const { data: globalPlans } = useGlobalPlans();
  const { setPlan } = useInternalMutations(tenantId);
  const { clone, update, setOverride, grantAccess } = usePlanMutations(tenantId);
  const { data: addons } = usePlanAddons();
  const { data: tenantAddons } = useTenantAddons(tenantId);
  const setAddon = useSetAddon(tenantId);

  const [cloneOpen, setCloneOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  // Grant access (vitalicio / regalar días).
  const [lifetimeOpen, setLifetimeOpen] = useState(false);
  const [giftOpen, setGiftOpen] = useState(false);
  const [lifetimeConfirm, setLifetimeConfirm] = useState(false);
  const [grantPlan, setGrantPlan] = useState("");
  const [grantReason, setGrantReason] = useState("");
  const [giftDays, setGiftDays] = useState("30");

  // Estado del modal clonar.
  const [cloneName, setCloneName] = useState("");
  const [clonePrice, setClonePrice] = useState("");

  // Estado del modal editar.
  const [editName, setEditName] = useState("");
  const [editPrice, setEditPrice] = useState("");
  const [editLimits, setEditLimits] = useState<Record<LimitKey, string>>({
    max_stores: "",
    max_users: "",
    max_products: "",
    max_sales_per_month: "",
  });
  const [editReason, setEditReason] = useState("");

  // Estado de las filas de override (input + motivo por clave).
  const [ovInputs, setOvInputs] = useState<Record<string, string>>({});
  const [ovReasons, setOvReasons] = useState<Record<string, string>>({});

  if (isLoading || !detail) {
    return (
      <Card>
        <CardContent className="p-5">
          <p className="text-sm text-muted-foreground">Cargando plan…</p>
        </CardContent>
      </Card>
    );
  }

  const numbers = planNumbers(detail.limits);
  const isCustom = detail.isCustom;

  // Opciones del selector global: planes globales + el custom actual si aplica.
  const planOptions = [
    ...(globalPlans ?? []),
    ...(isCustom ? [{ key: detail.planKey, name: detail.name }] : []),
  ];

  function openClone() {
    if (!detail) return;
    setCloneName(`${detail.name} (custom)`);
    setClonePrice(String(detail.monthlyPrice));
    setCloneOpen(true);
  }

  function openEdit() {
    if (!detail) return;
    setEditName(detail.name);
    setEditPrice(String(detail.monthlyPrice));
    setEditLimits({
      max_stores: String(numbers.max_stores ?? ""),
      max_users: String(numbers.max_users ?? ""),
      max_products: String(numbers.max_products ?? ""),
      max_sales_per_month: String(numbers.max_sales_per_month ?? ""),
    });
    setEditReason("");
    setEditOpen(true);
  }

  function openLifetime() {
    setGrantPlan(globalPlans?.[0]?.key ?? detail?.planKey ?? "");
    setGrantReason("");
    setLifetimeOpen(true);
  }

  function openGift() {
    setGrantPlan(globalPlans?.[0]?.key ?? detail?.planKey ?? "");
    setGrantReason("");
    setGiftDays("30");
    setGiftOpen(true);
  }

  async function handleGrantLifetime() {
    if (!grantReason.trim()) {
      toast({ title: "Ingresá un motivo", variant: "error" });
      return;
    }
    try {
      await grantAccess.mutateAsync({
        planKey: grantPlan,
        lifetime: true,
        freeDays: null,
        reason: grantReason.trim(),
      });
      toast({ title: "Acceso vitalicio otorgado", variant: "success" });
      setLifetimeConfirm(false);
      setLifetimeOpen(false);
    } catch (e) {
      toast({
        title: "No se pudo otorgar",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  async function handleGiftDays() {
    const days = Number(giftDays);
    if (!Number.isFinite(days) || days <= 0) {
      toast({ title: "Días inválidos", variant: "error" });
      return;
    }
    if (!grantReason.trim()) {
      toast({ title: "Ingresá un motivo", variant: "error" });
      return;
    }
    try {
      await grantAccess.mutateAsync({
        planKey: grantPlan,
        lifetime: false,
        freeDays: days,
        reason: grantReason.trim(),
      });
      toast({ title: `${days} días regalados`, variant: "success" });
      setGiftOpen(false);
    } catch (e) {
      toast({
        title: "No se pudo regalar",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  function toggleAddon(key: string, active: boolean) {
    setAddon
      .mutateAsync({ addonKey: key, active })
      .then(() =>
        toast({
          title: active ? "Addon activado" : "Addon desactivado",
          variant: "success",
        }),
      )
      .catch((e) =>
        toast({
          title: "Error",
          description: e instanceof Error ? e.message : undefined,
          variant: "error",
        }),
      );
  }

  async function handleClone() {
    const price = Number(clonePrice);
    if (!cloneName.trim()) {
      toast({ title: "Ingresá un nombre", variant: "error" });
      return;
    }
    if (!Number.isFinite(price) || price < 0) {
      toast({ title: "Precio inválido", variant: "error" });
      return;
    }
    try {
      await clone.mutateAsync({
        basePlanKey: detail!.planKey,
        name: cloneName.trim(),
        monthlyPrice: price,
      });
      toast({ title: "Plan custom creado", variant: "success" });
      setCloneOpen(false);
    } catch (e) {
      toast({
        title: "No se pudo crear",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  async function handleUpdate() {
    const price = Number(editPrice);
    if (!editName.trim()) {
      toast({ title: "Ingresá un nombre", variant: "error" });
      return;
    }
    if (!Number.isFinite(price) || price < 0) {
      toast({ title: "Precio inválido", variant: "error" });
      return;
    }
    const newNumbers: PlanLimitNumbers = {};
    for (const k of LIMIT_KEYS) {
      const raw = editLimits[k];
      if (raw.trim() !== "") newNumbers[k] = Number(raw);
    }
    // Preserva modules/support, reemplaza el bloque de límites numéricos.
    const merged: PlanLimits = {
      ...detail!.limits,
      limits: { ...numbers, ...newNumbers },
    };
    try {
      await update.mutateAsync({
        planId: detail!.planId,
        name: editName.trim(),
        monthlyPrice: price,
        limits: merged,
        reason: editReason.trim() || null,
      });
      toast({ title: "Plan actualizado", variant: "success" });
      setEditOpen(false);
    } catch (e) {
      toast({
        title: "No se pudo actualizar",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  async function handleSaveOverride(key: LimitKey) {
    const raw = (ovInputs[key] ?? "").trim();
    const value = raw === "" ? null : Number(raw);
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      toast({ title: "Valor inválido", variant: "error" });
      return;
    }
    try {
      await setOverride.mutateAsync({
        key,
        value,
        reason: (ovReasons[key] ?? "").trim() || null,
      });
      toast({
        title: value === null ? "Override quitado" : "Override guardado",
        variant: "success",
      });
      setOvInputs((s) => ({ ...s, [key]: "" }));
      setOvReasons((s) => ({ ...s, [key]: "" }));
    } catch (e) {
      toast({
        title: "No se pudo guardar",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  async function handleClearOverride(key: LimitKey) {
    try {
      await setOverride.mutateAsync({ key, value: null, reason: null });
      toast({ title: "Override quitado", variant: "success" });
      setOvInputs((s) => ({ ...s, [key]: "" }));
      setOvReasons((s) => ({ ...s, [key]: "" }));
    } catch (e) {
      toast({
        title: "No se pudo quitar",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  return (
    <>
      <Card>
        <CardContent className="space-y-4 p-5">
          {/* Encabezado: plan actual */}
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-display text-base font-bold text-foreground">
                  {detail.name}
                </h3>
                {isCustom && (
                  <span className="rounded-md bg-ninja-flame/12 px-2 py-0.5 text-xs font-semibold text-ninja-flameSoft">
                    Custom{detail.basePlanKey ? ` (base ${detail.basePlanKey})` : ""}
                  </span>
                )}
                {detail.isLifetime && (
                  <span className="inline-flex items-center gap-1 rounded-md border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-xs font-semibold text-amber-300">
                    <InfinityIcon size={12} /> Vitalicio
                  </span>
                )}
              </div>
              <div className="mt-0.5 text-sm text-muted-foreground">
                {formatCurrency(detail.monthlyPrice)}/mes
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {!isCustom && (
                <Button size="sm" variant="secondary" onClick={openClone}>
                  <Sparkles size={14} /> Crear plan custom
                </Button>
              )}
              {isCustom && (
                <Button size="sm" variant="secondary" onClick={openEdit}>
                  <Pencil size={14} /> Editar plan
                </Button>
              )}
              <Button size="sm" variant="secondary" onClick={openLifetime}>
                <Crown size={14} /> Acceso vitalicio…
              </Button>
              <Button size="sm" variant="secondary" onClick={openGift}>
                <Gift size={14} /> Regalar días…
              </Button>
            </div>
          </div>

          {/* Selector de plan global */}
          <div>
            <label className="mb-2 block text-sm font-medium text-muted-foreground">
              Plan asignado
            </label>
            <select
              className={selectCls}
              value={detail.planKey}
              onChange={(e) => {
                const v = e.target.value;
                if (v === detail.planKey) return;
                setPlan
                  .mutateAsync(v)
                  .then(() => toast({ title: "Plan actualizado", variant: "success" }))
                  .catch((err) =>
                    toast({
                      title: "Error",
                      description:
                        err instanceof Error ? err.message : undefined,
                      variant: "error",
                    }),
                  );
              }}
            >
              {planOptions.map((p) => (
                <option key={p.key} value={p.key} className="bg-ninja-deepViolet">
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          {/* Límites efectivos (override ?? plan) */}
          <div>
            <div className="mb-2 text-sm font-medium text-muted-foreground">
              Límites efectivos
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {LIMIT_KEYS.map((k) => {
                const planVal = numbers[k];
                const ov = detail.overrides[k];
                const eff = ov ?? planVal;
                const hasOv = ov !== undefined && ov !== null;
                return (
                  <div
                    key={k}
                    className="rounded-lg border border-border bg-muted/30 px-3 py-2"
                  >
                    <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      {LIMIT_LABELS[k]}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-base font-semibold text-foreground">
                      {eff ?? "—"}
                      {hasOv && (
                        <span
                          title="Override activo"
                          className="inline-block h-1.5 w-1.5 rounded-full bg-ninja-flameSoft"
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Overrides de límites */}
          <div>
            <div className="mb-2 flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
              <SlidersHorizontal size={14} /> Overrides de límites
            </div>
            <div className="space-y-2">
              {LIMIT_KEYS.map((k) => {
                const planVal = numbers[k];
                const ov = detail.overrides[k];
                const hasOv = ov !== undefined && ov !== null;
                const inputVal = ovInputs[k] ?? "";
                const dirty = inputVal.trim() !== "";
                return (
                  <div
                    key={k}
                    className="rounded-lg border border-border p-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="min-w-[120px] flex-1">
                        <div className="text-sm font-medium text-foreground">
                          {LIMIT_LABELS[k]}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          Plan: {planVal ?? "—"}
                          {hasOv && (
                            <span className="ml-2 text-ninja-flameSoft">
                              Override: {ov}
                            </span>
                          )}
                        </div>
                      </div>
                      <Input
                        type="number"
                        min="0"
                        placeholder={hasOv ? String(ov) : "sin override"}
                        value={inputVal}
                        onChange={(e) =>
                          setOvInputs((s) => ({ ...s, [k]: e.target.value }))
                        }
                        className="h-9 w-28"
                      />
                      <Button
                        size="sm"
                        disabled={!dirty || setOverride.isPending}
                        onClick={() => handleSaveOverride(k)}
                      >
                        Guardar
                      </Button>
                      {hasOv && (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={setOverride.isPending}
                          onClick={() => handleClearOverride(k)}
                        >
                          Quitar
                        </Button>
                      )}
                    </div>
                    {dirty && (
                      <Input
                        placeholder="Motivo (opcional)"
                        value={ovReasons[k] ?? ""}
                        onChange={(e) =>
                          setOvReasons((s) => ({ ...s, [k]: e.target.value }))
                        }
                        className="mt-2 h-9"
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Addons contratables (toggle por tenant) */}
          {(addons?.length ?? 0) > 0 && (
            <div>
              <div className="mb-2 text-sm font-medium text-muted-foreground">
                Addons
              </div>
              <div className="space-y-2">
                {(addons ?? []).map((a) => {
                  const enabled = tenantAddons?.has(a.key) ?? false;
                  return (
                    <div
                      key={a.key}
                      className="flex items-center justify-between gap-3 rounded-lg border border-border p-3"
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-foreground">
                          {a.label}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {formatCurrency(a.monthlyPrice)}/mes
                          {a.description ? ` · ${a.description}` : ""}
                        </div>
                      </div>
                      <button
                        onClick={() => toggleAddon(a.key, !enabled)}
                        disabled={setAddon.isPending}
                        aria-label={`Toggle ${a.label}`}
                        className={
                          enabled
                            ? "h-6 w-11 shrink-0 rounded-full bg-ninja-flame px-0.5 transition disabled:opacity-60"
                            : "h-6 w-11 shrink-0 rounded-full bg-muted px-0.5 transition disabled:opacity-60"
                        }
                      >
                        <span
                          className={
                            enabled
                              ? "block h-5 w-5 translate-x-5 rounded-full bg-white transition"
                              : "block h-5 w-5 translate-x-0 rounded-full bg-white transition"
                          }
                        />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Modal: crear plan custom */}
      <Modal
        open={cloneOpen}
        onOpenChange={setCloneOpen}
        title="Crear plan custom"
        className="max-w-sm"
      >
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Clona <b>{detail.name}</b> y lo asigna sólo a este negocio. Los demás
            tenants no se ven afectados.
          </p>
          <Input
            label="Nombre comercial"
            value={cloneName}
            onChange={(e) => setCloneName(e.target.value)}
          />
          <Input
            label="Precio mensual (ARS)"
            type="number"
            min="0"
            step="0.01"
            value={clonePrice}
            onChange={(e) => setClonePrice(e.target.value)}
          />
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" onClick={() => setCloneOpen(false)}>
              Cancelar
            </Button>
            <Button loading={clone.isPending} onClick={handleClone}>
              Crear
            </Button>
          </div>
        </div>
      </Modal>

      {/* Modal: editar plan custom */}
      <Modal
        open={editOpen}
        onOpenChange={setEditOpen}
        title="Editar plan custom"
        className="max-w-md"
      >
        <div className="space-y-3">
          <Input
            label="Nombre comercial"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
          />
          <Input
            label="Precio mensual (ARS)"
            type="number"
            min="0"
            step="0.01"
            value={editPrice}
            onChange={(e) => setEditPrice(e.target.value)}
          />
          <div className="grid grid-cols-2 gap-2">
            {LIMIT_KEYS.map((k) => (
              <Input
                key={k}
                label={LIMIT_LABELS[k]}
                type="number"
                min="0"
                value={editLimits[k]}
                onChange={(e) =>
                  setEditLimits((s) => ({ ...s, [k]: e.target.value }))
                }
              />
            ))}
          </div>
          <Input
            label="Motivo (opcional)"
            value={editReason}
            onChange={(e) => setEditReason(e.target.value)}
          />
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" onClick={() => setEditOpen(false)}>
              Cancelar
            </Button>
            <Button loading={update.isPending} onClick={handleUpdate}>
              Guardar
            </Button>
          </div>
        </div>
      </Modal>

      {/* Modal: acceso vitalicio */}
      <Modal
        open={lifetimeOpen}
        onOpenChange={setLifetimeOpen}
        title="Acceso vitalicio"
        className="max-w-sm"
      >
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Marca la suscripción como <b>vitalicia</b>: queda activa sin
            vencimiento y el motor de cobros la saltea. Es un regalo permanente.
          </p>
          <div>
            <label className="mb-2 block text-sm font-medium text-muted-foreground">
              Plan
            </label>
            <select
              className={selectCls}
              value={grantPlan}
              onChange={(e) => setGrantPlan(e.target.value)}
            >
              {(globalPlans ?? []).map((p) => (
                <option key={p.key} value={p.key} className="bg-ninja-deepViolet">
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <Input
            label="Motivo"
            value={grantReason}
            onChange={(e) => setGrantReason(e.target.value)}
            placeholder="Ej. socio fundador, acuerdo comercial…"
          />
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" onClick={() => setLifetimeOpen(false)}>
              Cancelar
            </Button>
            <Button
              onClick={() => {
                if (!grantReason.trim()) {
                  toast({ title: "Ingresá un motivo", variant: "error" });
                  return;
                }
                setLifetimeConfirm(true);
              }}
            >
              Otorgar
            </Button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={lifetimeConfirm}
        onOpenChange={setLifetimeConfirm}
        title="¿Otorgar acceso vitalicio?"
        description="El negocio dejará de pagar para siempre por este plan. Esta acción queda auditada."
        confirmLabel="Sí, otorgar vitalicio"
        danger
        loading={grantAccess.isPending}
        onConfirm={() => void handleGrantLifetime()}
      />

      {/* Modal: regalar días */}
      <Modal
        open={giftOpen}
        onOpenChange={setGiftOpen}
        title="Regalar días"
        className="max-w-sm"
      >
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Extiende la prueba del plan elegido por la cantidad de días indicada.
          </p>
          <div>
            <label className="mb-2 block text-sm font-medium text-muted-foreground">
              Plan
            </label>
            <select
              className={selectCls}
              value={grantPlan}
              onChange={(e) => setGrantPlan(e.target.value)}
            >
              {(globalPlans ?? []).map((p) => (
                <option key={p.key} value={p.key} className="bg-ninja-deepViolet">
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <Input
            label="Días"
            type="number"
            min="1"
            value={giftDays}
            onChange={(e) => setGiftDays(e.target.value)}
          />
          <Input
            label="Motivo"
            value={grantReason}
            onChange={(e) => setGrantReason(e.target.value)}
            placeholder="Ej. compensación por incidente…"
          />
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" onClick={() => setGiftOpen(false)}>
              Cancelar
            </Button>
            <Button loading={grantAccess.isPending} onClick={handleGiftDays}>
              Regalar
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
