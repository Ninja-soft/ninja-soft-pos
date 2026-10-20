"use client";

import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/components/ui/Toast";
import type { CheckoutSnapshot, LiveIntent } from "@/components/pos/checkout/types";
import { formatCurrency } from "@/lib/utils/format";
import { usePricingContext } from "@/lib/prices/pricingContext";
import { cancelAtProvider, syncProviderStatus } from "@/modules/pending-charges/api";
import { pausedSalesApi, isNetworkFailure, normalizePaused } from "@/modules/paused-sales/api";
import { pausedSalesKey, usePausedSales } from "@/modules/paused-sales/hooks";
import {
  buildPausedCart,
  clearRule,
  defaultPausedLabel,
  paymentsFromCheckout,
  pausedErrorCopy,
  pausedTitle,
  priceChanges,
  restorePlan,
  totalChangeNotice,
  type PauseInput,
  type PausedCart,
  type PausedSale,
} from "@/modules/paused-sales/logic";
import { useCartStore } from "@/modules/pos/store";
import { saleErrorTitle } from "./usePosSale";
import { guardCartRemoval } from "@/modules/pos/cartGuard";

// "Pausar venta" en el POS (ADR-106): guarda la venta en curso (carrito, hoja
// de cobro y pagos) en el servidor o, sin conexión, en este equipo; deja el
// POS limpio al instante y la retoma con el criterio del servidor. También
// "Limpiar" con confirmación y "Deshacer".

export interface ResumedSale {
  id: string;
  version: number | null;
  label: string;
  total: number;
  /** Pausada sin conexión: sólo existe en este equipo. */
  local: boolean;
}

export interface PosPauseCtx {
  storeId: string | null;
  registerId: string | null;
  /** Turno propio abierto (null = sin caja abierta). */
  shiftId: string | null;
  tenantId: string | null;
  userId: string | null;
  offline: boolean;
  /** Mesa, delivery, turno, reserva o cobro en espera: no se pausa (motivo). */
  blockedReason: string | null;
  cartInput: () => PauseInput;
  saleArgs: () => Record<string, unknown>;
  total: number;
  itemCount: number;
  /** Vacía la venta en curso (carrito, cliente, cupón, garantía, lista, hoja). */
  resetSale: () => void;
  /** Carga un carrito guardado en el POS. */
  applyCart: (cart: PausedCart) => void;
  priceFor: (productId: string, variantId: string | null, current: number, qty: number) => number | null;
  handlePriceMismatch: (err: unknown) => boolean;
  /** Abre la hoja de cobro (al retomar una venta con pagos). */
  openCheckout: () => void;
}

export function usePosPause(ctx: PosPauseCtx) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const paused = usePausedSales({
    storeId: ctx.storeId,
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    offline: ctx.offline,
  });
  const [resumed, setResumed] = useState<ResumedSale | null>(null);
  const [checkoutRestore, setCheckoutRestore] = useState<CheckoutSnapshot | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Diálogos
  const [clearConfirm, setClearConfirmState] = useState<{ total: number; cash: number; pendingIntents: number } | null>(
    null,
  );
  const setClearConfirm = (o: boolean) => {
    if (!o) setClearConfirmState(null);
  };
  const [clearBlocked, setClearBlocked] = useState<{ credited: number } | null>(null);
  const [intentWait, setIntentWait] = useState<PausedSale | null>(null);
  const [switchTarget, setSwitchTarget] = useState<PausedSale | null>(null);
  const clearSnap = useRef<CheckoutSnapshot | null>(null);
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  const listKey = pausedSalesKey(ctx.storeId);
  // La que se está cobrando no se muestra como pausada.
  const list = paused.list.filter((s) => s.id !== resumed?.id);

  function optimistic(update: (old: PausedSale[]) => PausedSale[]) {
    qc.setQueryData<PausedSale[]>(listKey, (old) => update(old ?? []));
  }

  // ── Pausar ─────────────────────────────────────────────────────────────────
  async function pause(snap?: CheckoutSnapshot | null, live?: LiveIntent | null): Promise<boolean> {
    const c = ctxRef.current;
    const input = c.cartInput();
    if (input.lines.length === 0) {
      toast({ title: "No hay una venta para pausar", variant: "info" });
      return false;
    }
    if (c.blockedReason) {
      toast({ title: c.blockedReason, variant: "error" });
      return false;
    }
    if (!c.storeId) {
      toast({ title: "Elegí la sucursal y la caja del POS para pausar", variant: "error" });
      return false;
    }
    const checkout = snap ?? checkoutRestore ?? null;
    const payments = paymentsFromCheckout(checkout, live ?? null);
    const cart = buildPausedCart(input);
    const id = resumed?.id ?? crypto.randomUUID();
    const label = resumed?.label ?? defaultPausedLabel(input.customer?.name ?? null);
    const prevResumed = resumed;
    const draft: PausedSale = {
      id,
      tenant_id: c.tenantId ?? "",
      store_id: c.storeId,
      register_id: c.registerId,
      cash_shift_id: c.shiftId,
      created_by: c.userId,
      resumed_by: null,
      customer_id: input.customer?.id ?? null,
      customer_name: input.customer?.name ?? null,
      label,
      cart,
      checkout,
      total: Math.round(c.total * 100) / 100,
      paid_amount: payments.filter((p) => p.kind === "line").reduce((a, p) => a + p.amount, 0),
      item_count: c.itemCount,
      status: "paused",
      carry_over: false,
      needs_review: false,
      source: c.offline ? "offline" : "online",
      paused_at: new Date().toISOString(),
      resumed_at: null,
      version: prevResumed?.version ?? 1,
      payments,
    };
    const saleArgs = c.saleArgs();

    // El POS queda limpio para el siguiente cliente al instante.
    c.resetSale();
    setResumed(null);
    setCheckoutRestore(null);
    const localPause = c.offline || prevResumed?.local === true;
    if (!localPause) optimistic((old) => [draft, ...old.filter((x) => x.id !== id)]);

    const done = (where: "server" | "local") =>
      toast({
        title: `Venta pausada: ${label}`,
        description:
          where === "local"
            ? "Quedó guardada en este equipo y se sube sola cuando vuelva la conexión."
            : `${formatCurrency(draft.total)}${payments.length > 0 ? `, con ${payments.length === 1 ? "1 pago" : `${payments.length} pagos`} guardados` : ""}. Retomala desde "Pausadas".`,
        variant: "success",
      });

    if (localPause) {
      paused.saveLocal(draft);
      done("local");
      return true;
    }
    try {
      await pausedSalesApi.pause({
        id,
        storeId: c.storeId,
        registerId: c.registerId,
        cashShiftId: c.shiftId,
        customerId: draft.customer_id,
        customerName: draft.customer_name,
        label,
        cart,
        checkout,
        saleArgs,
        total: draft.total,
        itemCount: draft.item_count,
        payments,
        source: "online",
      });
      done("server");
      void paused.refresh();
      return true;
    } catch (e) {
      if (isNetworkFailure(e)) {
        paused.saveLocal({ ...draft, source: "offline" });
        optimistic((old) => old.filter((x) => x.id !== id));
        done("local");
        return true;
      }
      // El servidor la rechazó: la venta vuelve al POS tal cual (nada se pierde).
      optimistic((old) => old.filter((x) => x.id !== id));
      c.applyCart(cart);
      setCheckoutRestore(checkout);
      setResumed(prevResumed);
      toast({ title: pausedErrorCopy(e instanceof Error ? e.message : ""), variant: "error" });
      return false;
    }
  }

  // ── Retomar ────────────────────────────────────────────────────────────────
  async function applyResumed(sale: PausedSale, check: ResumeCheck | null, version: number | null) {
    const c = ctxRef.current;
    const plan = restorePlan(sale);
    if (!plan) {
      toast({ title: "Esta venta no guardó el carrito: descartala y cargala de nuevo", variant: "error" });
      return;
    }
    c.applyCart(plan.cart);
    setCheckoutRestore(plan.checkout);
    const title = pausedTitle(sale);
    setResumed({ id: sale.id, version, label: title, total: sale.total, local: Boolean(sale.localOnly) });

    const notices = [...plan.notices];
    // Precio de lista vigente (mismo resolver que el servidor, ADR-058).
    const changes = priceChanges(plan.cart.lines, c.priceFor);
    if (changes.length > 0) {
      useCartStore.getState().applyServerPrices(changes.map((x) => ({ lineId: x.lineId, to: x.to })));
      notices.push(
        changes.length === 1
          ? `El precio de ${changes[0]!.name} cambió a ${formatCurrency(changes[0]!.to)}.`
          : `Cambió el precio de ${changes.length} productos.`,
      );
    }
    if (check && !check.ok) {
      // El ensayo del servidor (stock, precio, cupón, topes) no pasó.
      if (!c.handlePriceMismatch(new Error(check.error))) {
        const t = saleErrorTitle(check.error);
        notices.push(t === "No se pudo cobrar" ? "Revisá la venta antes de cobrar: algo cambió desde que se pausó." : `${t}.`);
      }
    } else if (check?.ok && changes.length === 0) {
      const n = totalChangeNotice(sale.total, Number(check.total) || 0);
      if (n) notices.push(n);
    }
    toast({
      title: `Retomaste "${title}"`,
      description: notices.length > 0 ? notices.join(" ") : undefined,
      variant: notices.length > 0 ? "warning" : "success",
      duration: notices.length > 0 ? 9000 : undefined,
    });
    if ((plan.checkout?.lines.length ?? 0) > 0 && c.shiftId) c.openCheckout();
  }

  async function resume(sale: PausedSale, opts: { cancelPending?: boolean; force?: boolean } = {}) {
    const c = ctxRef.current;
    if (busyId) return;
    if (resumed?.id === sale.id) {
      toast({ title: "Ya estás cobrando esta venta", variant: "info" });
      return;
    }
    if (!opts.force && useCartStore.getState().lines.length > 0) {
      setSwitchTarget(sale);
      return;
    }
    setSwitchTarget(null);
    setIntentWait(null);
    if (sale.localOnly) {
      // Pausada sin conexión: se restaura desde este equipo.
      paused.removeLocal(sale.id);
      await applyResumed({ ...sale, localOnly: true }, null, null);
      return;
    }
    if (c.offline) {
      toast({ title: "Sin conexión no se puede retomar una venta guardada en el servidor", variant: "error" });
      return;
    }
    setBusyId(sale.id);
    const pricing = usePricingContext.getState();
    const prevPricing = { listId: pricing.listId, termId: pricing.termId };
    try {
      // QR o link esperando: se consulta al proveedor antes (el webhook pudo no llegar).
      for (const p of sale.payments.filter((x) => x.kind === "intent" && x.status === "pending")) {
        if (p.intent_id && p.provider_key) await syncProviderStatus(p.provider_key, p.channel ?? "link", p.intent_id);
      }
      // El ensayo del servidor resuelve precios con la lista y condición de la venta.
      pricing.setList(sale.cart.pricing.listId);
      pricing.setTerm(sale.cart.pricing.termId);
      const res = await pausedSalesApi.resume(sale.id, c.shiftId, Boolean(opts.cancelPending));
      if (res.status === "completed") {
        pricing.setList(prevPricing.listId);
        pricing.setTerm(prevPricing.termId);
        toast({ title: "Esta venta ya se registró con su QR", description: "La encontrás en Ventas.", variant: "info" });
        void paused.refresh();
        return;
      }
      for (const ci of res.cancelled_intents ?? []) {
        if (ci.intent_id && ci.provider_key) void cancelAtProvider(ci.provider_key, ci.channel ?? "link", ci.intent_id);
      }
      const fresh = normalizePaused(res.sale ?? {}, res.payments ?? []);
      optimistic((old) => old.filter((x) => x.id !== sale.id));
      await applyResumed(fresh, (res.check as ResumeCheck | null) ?? null, res.version ?? null);
      void paused.refresh();
    } catch (e) {
      pricing.setList(prevPricing.listId);
      pricing.setTerm(prevPricing.termId);
      const msg = e instanceof Error ? e.message : "";
      if (msg.includes("paused_sale_intent_pending")) {
        setIntentWait(sale);
      } else {
        toast({ title: pausedErrorCopy(msg), variant: "error" });
        void paused.refresh();
      }
    } finally {
      setBusyId(null);
    }
  }

  /** "Pausar la actual y retomar esta". */
  async function switchTo(sale: PausedSale) {
    setSwitchTarget(null);
    const ok = await pause();
    if (ok) await resume(sale, { force: true });
  }

  // ── Descartar y renombrar ──────────────────────────────────────────────────
  async function discard(sale: PausedSale, reason: string | null, refundConfirmed: boolean): Promise<boolean> {
    if (sale.localOnly) {
      paused.removeLocal(sale.id);
      toast({ title: `Descartaste "${pausedTitle(sale)}"`, variant: "success" });
      return true;
    }
    try {
      const r = await pausedSalesApi.discard(sale.id, reason, refundConfirmed);
      for (const ci of r.cancelled_intents ?? []) {
        if (ci.intent_id && ci.provider_key) void cancelAtProvider(ci.provider_key, ci.channel ?? "link", ci.intent_id);
      }
      optimistic((old) => old.filter((x) => x.id !== sale.id));
      toast({ title: `Descartaste "${pausedTitle(sale)}"`, variant: "success" });
      void paused.refresh();
      return true;
    } catch (e) {
      toast({ title: pausedErrorCopy(e instanceof Error ? e.message : ""), variant: "error" });
      return false;
    }
  }

  async function rename(sale: PausedSale, label: string) {
    const next = label.trim().slice(0, 60);
    if (next === (sale.label ?? "")) return;
    if (sale.localOnly) {
      paused.saveLocal({ ...sale, label: next || null });
      return;
    }
    optimistic((old) => old.map((x) => (x.id === sale.id ? { ...x, label: next || null } : x)));
    try {
      await pausedSalesApi.rename(sale.id, next);
    } catch (e) {
      toast({ title: pausedErrorCopy(e instanceof Error ? e.message : ""), variant: "error" });
    }
    void paused.refresh();
  }

  // ── Limpiar (con confirmación y "Deshacer") ───────────────────────────────
  function requestClear(snap?: CheckoutSnapshot | null) {
    const c = ctxRef.current;
    if (c.cartInput().lines.length === 0 && !resumed) return;
    const checkout = snap ?? checkoutRestore ?? null;
    const rule = clearRule(paymentsFromCheckout(checkout, null));
    if (rule.kind === "blocked") {
      setClearBlocked({ credited: rule.credited });
      return;
    }
    clearSnap.current = checkout;
    setClearConfirmState({
      total: c.total,
      cash: rule.kind === "audit" ? rule.cash : 0,
      pendingIntents: rule.kind === "audit" ? rule.pendingIntents : 0,
    });
  }

  async function confirmClear() {
    const c = ctxRef.current;
    setClearConfirmState(null);
    // H159: limpiar queda registrado (con PIN si el negocio lo pide).
    const guard = await guardCartRemoval("clear", useCartStore.getState().lines, c.registerId);
    if (guard === "denied") toast({ title: "No se autorizó limpiar la venta", variant: "error" });
    if (guard !== "ok") return;
    const checkout = clearSnap.current ?? checkoutRestore ?? null;
    clearSnap.current = null;
    const payments = paymentsFromCheckout(checkout, null);
    const rule = clearRule(payments);
    if (rule.kind === "blocked") {
      setClearBlocked({ credited: rule.credited });
      return;
    }
    const before = { cart: buildPausedCart(c.cartInput()), checkout, resumed, total: c.total, items: c.itemCount };
    const where = { storeId: c.storeId, shiftId: c.shiftId };
    c.resetSale();
    setResumed(null);
    setCheckoutRestore(null);
    let undone = false;
    const UNDO_MS = 7000;
    const timer = setTimeout(() => {
      if (undone) return;
      // Pasado el "Deshacer": rastro en audit_logs si había pagos en curso y,
      // si era una venta pausada retomada, se descarta.
      if (rule.kind === "audit" && where.storeId) {
        void pausedSalesApi
          .logCleared({
            storeId: where.storeId,
            cashShiftId: where.shiftId,
            total: before.total,
            itemCount: before.items,
            payments: payments.map((p) => ({ kind: p.kind, method: p.method, amount: p.amount, status: p.status })),
          })
          .catch(() => null);
      }
      if (before.resumed && !before.resumed.local) {
        void pausedSalesApi
          .discard(before.resumed.id, "Limpiada en el POS", false)
          .then(() => paused.refresh())
          .catch((e) => toast({ title: pausedErrorCopy(e instanceof Error ? e.message : ""), variant: "error" }));
      }
    }, UNDO_MS);
    toast({
      title: "Venta limpiada",
      description:
        rule.kind === "audit" && rule.cash > 0
          ? `Devolvé ${formatCurrency(rule.cash)} en efectivo al cliente.`
          : "Podés deshacerlo unos segundos.",
      variant: rule.kind === "audit" ? "warning" : "info",
      duration: UNDO_MS,
      actions: [
        {
          label: "Deshacer",
          onClick: () => {
            if (undone) return;
            undone = true;
            clearTimeout(timer);
            ctxRef.current.applyCart(before.cart);
            setCheckoutRestore(before.checkout);
            setResumed(before.resumed);
            toast({ title: "Venta restaurada", variant: "success" });
          },
        },
      ],
    });
  }

  // ── Después de cobrar ──────────────────────────────────────────────────────
  function onSaleDone(saleId: string | null) {
    const r = resumed;
    setResumed(null);
    setCheckoutRestore(null);
    if (!r) return;
    if (r.local) return;
    void pausedSalesApi
      .complete(r.id, saleId)
      .then(() => paused.refresh())
      .catch(() => null);
  }

  /** Salir de una venta retomada sin cobrar ni pausar (se cambió de modo). */
  function forget() {
    setResumed(null);
    setCheckoutRestore(null);
  }

  return {
    list,
    all: paused.list,
    loading: paused.loading,
    resumed,
    checkoutRestore,
    busyId,
    pause,
    resume,
    switchTo,
    discard,
    rename,
    requestClear,
    confirmClear,
    onSaleDone,
    forget,
    refresh: paused.refresh,
    dialogs: {
      clearConfirm,
      setClearConfirm,
      clearBlocked,
      setClearBlocked,
      intentWait,
      setIntentWait,
      switchTarget,
      setSwitchTarget,
    },
  };
}

type ResumeCheck = { ok: true; total: number; tip: number | null } | { ok: false; error: string };
