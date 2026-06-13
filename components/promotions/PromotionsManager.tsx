"use client";

import { useEffect, useMemo, useState } from "react";
import { BarChart3, LineChart, Pencil, Plus, Tag, Trash2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { PromotionSimModal } from "@/components/promotions/PromotionSimModal";
import { PromotionPerfModal } from "@/components/promotions/PromotionPerfModal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useCategories, useProducts } from "@/modules/products/hooks";
import {
  usePromotions,
  usePromotionMutations,
} from "@/modules/promotions/hooks";
import type { Promotion, PromotionInput } from "@/modules/promotions/api";
import { WEEKDAYS_SHORT, minToTime, timeToMin } from "@/lib/gastro/menuTime";
import { formatCurrency } from "@/lib/utils/format";

// F9 · H53 — Administrador de promociones. El dueño define promos (condiciones →
// acción). El POS las aplicará al carrito cuando se integre el motor (follow-up).
export function PromotionsManager() {
  const { data: promos, isLoading } = usePromotions();
  const { remove } = usePromotionMutations();
  const { toast } = useToast();
  const [editing, setEditing] = useState<Promotion | null>(null);
  const [creating, setCreating] = useState(false);
  const [delTarget, setDelTarget] = useState<Promotion | null>(null);
  const [simPromo, setSimPromo] = useState<Promotion | null>(null);
  const [perfOpen, setPerfOpen] = useState(false);

  async function doDelete() {
    if (!delTarget) return;
    try {
      await remove.mutateAsync(delTarget.id);
      toast({ title: "Promoción eliminada", variant: "success" });
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
        Definí promociones por condiciones (vigencia, día/horario, monto mínimo,
        alcance, medio de pago) y su acción. El POS aplica la que más conviene al
        carrito y suma los regalos; mirá el impacto con “Rendimiento”.
      </p>

      {isLoading ? (
        <p className="py-4 text-center text-sm text-muted-foreground">Cargando…</p>
      ) : (promos ?? []).length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-5 text-center text-sm text-muted-foreground">
          Sin promociones. Creá una (ej. “10% los martes”, “$500 off en Bebidas”).
        </p>
      ) : (
        <div className="space-y-2">
          {(promos ?? []).map((p: Promotion) => (
            <PromoRow
              key={p.id}
              promo={p}
              onSim={() => setSimPromo(p)}
              onEdit={() => setEditing(p)}
              onDelete={() => setDelTarget(p)}
            />
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={() => setCreating(true)}>
          <Plus size={15} /> Nueva promoción
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setPerfOpen(true)}>
          <BarChart3 size={15} /> Rendimiento
        </Button>
      </div>

      <PromotionFormModal
        open={creating || editing !== null}
        promo={editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
      />

      <ConfirmDialog
        open={delTarget !== null}
        onOpenChange={(o) => !o && setDelTarget(null)}
        title={`Eliminar la promoción “${delTarget?.name}”`}
        description="Se da de baja la promoción. No afecta ventas ya cerradas."
        confirmLabel="Eliminar"
        danger
        loading={remove.isPending}
        onConfirm={doDelete}
      />

      <PromotionSimModal promo={simPromo} onClose={() => setSimPromo(null)} />
      <PromotionPerfModal open={perfOpen} onClose={() => setPerfOpen(false)} />
    </div>
  );
}

function PromoRow({
  promo,
  onSim,
  onEdit,
  onDelete,
}: {
  promo: Promotion;
  onSim: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const action =
    promo.action_type === "percent"
      ? `${promo.action_value}% off`
      : promo.action_type === "amount"
        ? `${formatCurrency(promo.action_value)} off`
        : promo.action_type === "nxm"
          ? `${promo.buy_qty}x${promo.pay_qty}`
          : promo.action_type === "second_item"
            ? `2º al ${promo.action_value}%`
            : promo.action_type === "volume_tier"
              ? `por volumen: ${(promo.volume_tiers ?? [])
                  .map((t) => `${t.min_qty}+→${t.pct}%`)
                  .join(", ")}`
              : promo.action_type === "gift"
                ? `regalo ×${promo.gift_qty ?? 1}`
                : `precio ${formatCurrency(promo.action_value)}`;
  const scopeLabel =
    promo.scope === "cart"
      ? "todo el carrito"
      : promo.scope === "category"
        ? "una categoría"
        : "un producto";
  const methodLabel: Record<string, string> = {
    cash: "efectivo",
    transfer: "transferencia",
    debit: "débito",
    credit: "crédito",
    qr: "QR",
  };
  const payCond = promo.payment_method ? methodLabel[promo.payment_method] ?? promo.payment_method : null;
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{promo.name}</span>
          {!promo.is_active && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
              inactiva
            </span>
          )}
        </div>
        <div className="text-xs text-muted-foreground">
          {action} · {scopeLabel}
          {promo.min_amount > 0 ? ` · desde ${formatCurrency(promo.min_amount)}` : ""}
          {payCond ? ` · sólo ${payCond}` : ""}
        </div>
      </div>
      <button
        type="button"
        onClick={onSim}
        className="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-ninja-flameSoft"
        title="Simular impacto"
      >
        <LineChart size={15} />
      </button>
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

// Form de alta/edición. v1: alcance todo el carrito o una categoría (producto
// puntual = follow-up del admin; el motor/DB ya lo soportan).
function PromotionFormModal({
  open,
  promo,
  onClose,
}: {
  open: boolean;
  promo: Promotion | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const { create, update } = usePromotionMutations();
  const { data: categories } = useCategories();
  // Productos para el selector de "regalo por compra" (H54).
  const { data: giftProducts } = useProducts("");

  const [name, setName] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [validFrom, setValidFrom] = useState("");
  const [validTo, setValidTo] = useState("");
  const [days, setDays] = useState<number[]>([]);
  const [timeFrom, setTimeFrom] = useState("");
  const [timeTo, setTimeTo] = useState("");
  const [minAmount, setMinAmount] = useState("0");
  const [scope, setScope] = useState<"cart" | "category">("cart");
  const [categoryId, setCategoryId] = useState("");
  // Condición por medio de pago (H54): "" = cualquiera; si no, exige ese medio.
  const [paymentMethod, setPaymentMethod] = useState("");
  const [actionType, setActionType] = useState<
    "percent" | "amount" | "nxm" | "fixed_price" | "second_item" | "volume_tier" | "gift"
  >("percent");
  const [actionValue, setActionValue] = useState("10");
  // NxM (H54): N (lleva) y M (paga).
  const [buyQty, setBuyQty] = useState("2");
  const [payQty, setPayQty] = useState("1");
  // Regalo por compra (H54): producto a regalar + cantidad.
  const [giftProductId, setGiftProductId] = useState("");
  const [giftQty, setGiftQty] = useState("1");
  // % por volumen escalonado (H54): tramos cantidad → %. Editados como strings
  // para no pelear con el input; se sanitizan al guardar.
  const [tiers, setTiers] = useState<{ minQty: string; pct: string }[]>([
    { minQty: "3", pct: "10" },
    { minQty: "6", pct: "15" },
  ]);

  // Hidrata al abrir (edición) o limpia (alta).
  useEffect(() => {
    if (!open) return;
    if (promo) {
      setName(promo.name);
      setIsActive(promo.is_active);
      setValidFrom(promo.valid_from ?? "");
      setValidTo(promo.valid_to ?? "");
      setDays(promo.days_of_week ?? []);
      setTimeFrom(promo.time_from != null ? minToTime(promo.time_from) : "");
      setTimeTo(promo.time_to != null ? minToTime(promo.time_to) : "");
      setMinAmount(String(promo.min_amount));
      setScope(promo.scope === "category" ? "category" : "cart");
      setCategoryId(promo.scope_category_id ?? "");
      setPaymentMethod(promo.payment_method ?? "");
      setActionType(promo.action_type);
      setActionValue(String(promo.action_value));
      setBuyQty(String(promo.buy_qty ?? 2));
      setPayQty(String(promo.pay_qty ?? 1));
      setGiftProductId(promo.gift_product_id ?? "");
      setGiftQty(String(promo.gift_qty ?? 1));
      setTiers(
        promo.volume_tiers && promo.volume_tiers.length > 0
          ? promo.volume_tiers.map((t) => ({
              minQty: String(t.min_qty),
              pct: String(t.pct),
            }))
          : [{ minQty: "3", pct: "10" }],
      );
    } else {
      setName("");
      setIsActive(true);
      setValidFrom("");
      setValidTo("");
      setDays([]);
      setTimeFrom("");
      setTimeTo("");
      setMinAmount("0");
      setScope("cart");
      setCategoryId("");
      setPaymentMethod("");
      setActionType("percent");
      setActionValue("10");
      setBuyQty("2");
      setPayQty("1");
      setGiftProductId("");
      setGiftQty("1");
      setTiers([
        { minQty: "3", pct: "10" },
        { minQty: "6", pct: "15" },
      ]);
    }
  }, [open, promo]);

  const catList = useMemo(() => categories ?? [], [categories]);
  const giftList = useMemo(() => giftProducts ?? [], [giftProducts]);

  function toggleDay(d: number) {
    setDays((ds) => (ds.includes(d) ? ds.filter((x) => x !== d) : [...ds, d]));
  }

  // ── Tramos de % por volumen ──────────────────────────────────────────────
  function setTier(i: number, patch: Partial<{ minQty: string; pct: string }>) {
    setTiers((ts) => ts.map((t, idx) => (idx === i ? { ...t, ...patch } : t)));
  }
  function addTier() {
    setTiers((ts) => [...ts, { minQty: "", pct: "" }]);
  }
  function removeTier(i: number) {
    setTiers((ts) => (ts.length > 1 ? ts.filter((_, idx) => idx !== i) : ts));
  }
  // Tramos válidos y ordenados por cantidad (lo que viaja al input/DB).
  function cleanTiers() {
    return tiers
      .map((t) => ({ min_qty: Math.trunc(Number(t.minQty) || 0), pct: Number(t.pct) || 0 }))
      .filter((t) => t.min_qty >= 1 && t.pct > 0 && t.pct <= 100)
      .sort((a, b) => a.min_qty - b.min_qty);
  }

  async function save() {
    const value = Number(actionValue) || 0;
    if (name.trim() === "") {
      toast({ title: "Poné un nombre", variant: "error" });
      return;
    }
    const n = Math.trunc(Number(buyQty) || 0);
    const m = Math.trunc(Number(payQty) || 0);
    if (
      (actionType === "percent" || actionType === "second_item") &&
      (value <= 0 || value > 100)
    ) {
      toast({ title: "El porcentaje debe estar entre 1 y 100", variant: "error" });
      return;
    }
    if ((actionType === "amount" || actionType === "fixed_price") && value <= 0) {
      toast({ title: "El monto debe ser mayor a 0", variant: "error" });
      return;
    }
    if (actionType === "nxm" && !(m >= 1 && n > m)) {
      toast({ title: "En NxM, “lleva” debe ser mayor que “paga” (y paga ≥ 1)", variant: "error" });
      return;
    }
    const validTiers = cleanTiers();
    if (actionType === "volume_tier" && validTiers.length === 0) {
      toast({
        title: "Cargá al menos un tramo (cantidad ≥ 1 y % entre 1 y 100)",
        variant: "error",
      });
      return;
    }
    if (actionType === "gift" && !giftProductId) {
      toast({ title: "Elegí el producto a regalar", variant: "error" });
      return;
    }
    if (scope === "category" && !categoryId) {
      toast({ title: "Elegí la categoría del alcance", variant: "error" });
      return;
    }
    const input: PromotionInput = {
      name: name.trim(),
      is_active: isActive,
      valid_from: validFrom || null,
      valid_to: validTo || null,
      days_of_week: days.length > 0 ? days : null,
      time_from: timeFrom ? timeToMin(timeFrom) : null,
      time_to: timeTo ? timeToMin(timeTo) : null,
      min_amount: Math.max(0, Number(minAmount) || 0),
      scope,
      scope_category_id: scope === "category" ? categoryId : null,
      action_type: actionType,
      action_value:
        actionType === "nxm" || actionType === "volume_tier" || actionType === "gift"
          ? 0
          : value,
      buy_qty: actionType === "nxm" ? n : null,
      pay_qty: actionType === "nxm" ? m : null,
      volume_tiers: actionType === "volume_tier" ? validTiers : null,
      payment_method: paymentMethod || null,
      gift_product_id: actionType === "gift" ? giftProductId : null,
      gift_qty: actionType === "gift" ? Math.max(1, Math.trunc(Number(giftQty) || 1)) : null,
    };
    try {
      if (promo) await update.mutateAsync({ id: promo.id, input });
      else await create.mutateAsync(input);
      toast({ title: promo ? "Promoción guardada" : "Promoción creada", variant: "success" });
      onClose();
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
      onOpenChange={(o) => !o && onClose()}
      title={promo ? "Editar promoción" : "Nueva promoción"}
    >
      <div className="space-y-4">
        <Input
          label="Nombre"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Ej. 10% los martes"
        />

        {/* Acción */}
        <div className="space-y-2">
          <label className="text-xs font-medium text-muted-foreground">
            Tipo de descuento
            <select
              value={actionType}
              onChange={(e) =>
                setActionType(
                  e.target.value as
                    | "percent"
                    | "amount"
                    | "nxm"
                    | "fixed_price"
                    | "second_item"
                    | "volume_tier"
                    | "gift",
                )
              }
              className="mt-0.5 h-10 w-full rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
            >
              <option value="percent">Porcentaje (%)</option>
              <option value="amount">Monto fijo ($)</option>
              <option value="nxm">NxM (2x1, 3x2…)</option>
              <option value="fixed_price">Precio fijo (combo)</option>
              <option value="second_item">2º ítem al X%</option>
              <option value="volume_tier">% por volumen (escalonado)</option>
              <option value="gift">Regalo por compra</option>
            </select>
          </label>
          {actionType === "gift" ? (
            <div className="space-y-2">
              <div className="text-xs text-muted-foreground">
                Al cumplir las condiciones de abajo (monto mínimo, alcance, día/
                hora…), el cliente se lleva GRATIS este producto. Si no hay stock,
                no se agrega.
              </div>
              <div className="grid grid-cols-[1fr_auto] gap-2">
                <label className="text-xs font-medium text-muted-foreground">
                  Producto de regalo
                  <select
                    value={giftProductId}
                    onChange={(e) => setGiftProductId(e.target.value)}
                    className="mt-0.5 h-10 w-full rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
                  >
                    <option value="">Elegí…</option>
                    {giftList.map((p: { id: string; name: string }) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <Input
                  label="Cantidad"
                  type="number"
                  min="1"
                  step="1"
                  value={giftQty}
                  onChange={(e) => setGiftQty(e.target.value)}
                  className="w-20"
                />
              </div>
            </div>
          ) : actionType === "volume_tier" ? (
            <div className="space-y-2">
              <div className="text-xs text-muted-foreground">
                A más unidades del alcance, mayor descuento. Aplica el % del tramo
                más alto que el carrito alcance.
              </div>
              {tiers.map((t, i) => (
                <div key={i} className="flex items-end gap-2">
                  <Input
                    label={i === 0 ? "Desde (un.)" : undefined}
                    type="number"
                    min="1"
                    step="1"
                    value={t.minQty}
                    onChange={(e) => setTier(i, { minQty: e.target.value })}
                    className="flex-1"
                  />
                  <Input
                    label={i === 0 ? "Descuento (%)" : undefined}
                    type="number"
                    min="0"
                    max="100"
                    step="1"
                    value={t.pct}
                    onChange={(e) => setTier(i, { pct: e.target.value })}
                    className="flex-1"
                  />
                  <button
                    type="button"
                    onClick={() => removeTier(i)}
                    disabled={tiers.length <= 1}
                    className="mb-1 rounded-md p-2 text-muted-foreground transition hover:bg-muted hover:text-destructive disabled:opacity-40"
                    title="Quitar tramo"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={addTier}
                className="text-xs font-medium text-ninja-flameSoft transition hover:underline"
              >
                + Agregar tramo
              </button>
            </div>
          ) : actionType === "nxm" ? (
            <div className="grid grid-cols-2 gap-2">
              <Input
                label="Lleva (N)"
                type="number"
                min="2"
                step="1"
                value={buyQty}
                onChange={(e) => setBuyQty(e.target.value)}
              />
              <Input
                label="Paga (M)"
                type="number"
                min="1"
                step="1"
                value={payQty}
                onChange={(e) => setPayQty(e.target.value)}
              />
            </div>
          ) : (
            <Input
              label={
                actionType === "percent"
                  ? "Valor (%)"
                  : actionType === "second_item"
                    ? "Descuento 2º ítem (%)"
                    : actionType === "fixed_price"
                      ? "Precio del combo ($)"
                      : "Valor ($)"
              }
              type="number"
              min="0"
              step={
                actionType === "percent" || actionType === "second_item" ? "1" : "0.01"
              }
              value={actionValue}
              onChange={(e) => setActionValue(e.target.value)}
            />
          )}
        </div>

        {/* Alcance */}
        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs font-medium text-muted-foreground">
            Aplica a
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value as "cart" | "category")}
              className="mt-0.5 h-10 w-full rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
            >
              <option value="cart">Todo el carrito</option>
              <option value="category">Una categoría</option>
            </select>
          </label>
          {scope === "category" && (
            <label className="text-xs font-medium text-muted-foreground">
              Categoría
              <select
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                className="mt-0.5 h-10 w-full rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
              >
                <option value="">Elegí…</option>
                {catList.map((c: { id: string; name: string }) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        {/* Condición por medio de pago (H54): el descuento se aplica al cobrar con
            ese medio (ej. "10% en efectivo"). "Cualquiera" = sin condición. */}
        <label className="text-xs font-medium text-muted-foreground">
          Sólo con este medio de pago
          <select
            value={paymentMethod}
            onChange={(e) => setPaymentMethod(e.target.value)}
            className="mt-0.5 h-10 w-full rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
          >
            <option value="">Cualquier medio</option>
            <option value="cash">Efectivo</option>
            <option value="transfer">Transferencia</option>
            <option value="debit">Débito</option>
            <option value="credit">Crédito</option>
            <option value="qr">QR / Terminal</option>
          </select>
        </label>

        <Input
          label="Monto mínimo del carrito (0 = sin mínimo)"
          type="number"
          min="0"
          step="0.01"
          value={minAmount}
          onChange={(e) => setMinAmount(e.target.value)}
        />

        {/* Días de la semana */}
        <div>
          <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
            Días (vacío = todos)
          </span>
          <div className="flex flex-wrap gap-1.5">
            {WEEKDAYS_SHORT.map((d, i) => (
              <button
                key={i}
                type="button"
                onClick={() => toggleDay(i)}
                className={
                  days.includes(i)
                    ? "rounded-md bg-ninja-flame/15 px-2.5 py-1 text-xs font-semibold text-ninja-flameSoft"
                    : "rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition hover:text-foreground"
                }
              >
                {d}
              </button>
            ))}
          </div>
        </div>

        {/* Vigencia y franja horaria */}
        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs font-medium text-muted-foreground">
            Desde (fecha)
            <input
              type="date"
              value={validFrom}
              onChange={(e) => setValidFrom(e.target.value)}
              className="mt-0.5 h-10 w-full rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
            />
          </label>
          <label className="text-xs font-medium text-muted-foreground">
            Hasta (fecha)
            <input
              type="date"
              value={validTo}
              onChange={(e) => setValidTo(e.target.value)}
              className="mt-0.5 h-10 w-full rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
            />
          </label>
          <label className="text-xs font-medium text-muted-foreground">
            Hora desde
            <input
              type="time"
              value={timeFrom}
              onChange={(e) => setTimeFrom(e.target.value)}
              className="mt-0.5 h-10 w-full rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
            />
          </label>
          <label className="text-xs font-medium text-muted-foreground">
            Hora hasta
            <input
              type="time"
              value={timeTo}
              onChange={(e) => setTimeTo(e.target.value)}
              className="mt-0.5 h-10 w-full rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
            />
          </label>
        </div>

        <label className="flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            className="accent-ninja-flame"
            checked={isActive}
            onChange={(e) => setIsActive(e.target.checked)}
          />
          Activa
        </label>

        <div className="flex justify-end gap-2 border-t border-border pt-3">
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={save} loading={create.isPending || update.isPending}>
            {promo ? "Guardar" : "Crear"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
