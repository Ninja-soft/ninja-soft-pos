"use client";

// Carrito y confirmación del pedido del catálogo público (ADR-130). Dos pasos
// en la misma hoja: el carrito (cantidades con el tope del disponible) y los
// datos (entrega, contacto y pago). El servidor recalcula todo al confirmar.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Store, Trash2, Truck } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils/cn";
import { formatCurrency, formatQty } from "@/lib/utils/format";
import {
  DELIVERY_LABEL,
  buildOrderPayload,
  cartKey,
  cartTotals,
  catalogOrderErrorMessage,
  enabledCatalogDeliveryTypes,
  errorNeedsRefresh,
  newTrackingToken,
  paymentLabel,
  trackingPath,
  validateCheckout,
  type CartItem,
  type CatalogOrdering,
  type CheckoutErrors,
  type CheckoutForm,
  type CreateOrderResult,
} from "@/lib/catalog/publicOrder";
import { Sheet } from "./Sheet";
import { QtyStepper } from "./QtyStepper";
import { pickupCodeKey } from "./TrackingClient";

const field =
  "h-12 w-full rounded-lg border border-neutral-300 bg-white px-3 text-[16px] text-neutral-900 outline-none transition-colors placeholder:text-neutral-400 focus:border-neutral-900 sm:text-sm";

function Field({ label, error, hint, htmlFor, children }: { label: string; error?: string; hint?: string; htmlFor: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      {children}
      {error ? (
        <p className="mt-1 text-xs font-medium text-red-700" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="mt-1 text-xs text-neutral-500">{hint}</p>
      ) : null}
    </div>
  );
}

export function CartSheet({
  open,
  onClose,
  slug,
  cart,
  ordering,
  accent,
  accentInk,
  onQty,
  onOrdered,
}: {
  open: boolean;
  onClose: () => void;
  slug: string;
  cart: CartItem[];
  ordering: CatalogOrdering;
  accent: string;
  accentInk: string;
  onQty: (key: string, qty: number) => void;
  onOrdered: () => void;
}) {
  const router = useRouter();
  const types = enabledCatalogDeliveryTypes(ordering);
  const [step, setStep] = useState<"cart" | "checkout">("cart");
  const [form, setForm] = useState<CheckoutForm>({
    deliveryType: types.length === 1 ? (types[0] ?? null) : null,
    pickupStoreId: ordering.retiro.stores[0]?.id ?? ordering.store?.id ?? null,
    name: "",
    phone: "",
    email: "",
    address: "",
    notes: "",
    payment: "al_retirar",
    website: "",
  });
  const [errors, setErrors] = useState<CheckoutErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Mismo id y token en los reintentos: el servidor devuelve el mismo pedido.
  const attempt = useRef<{ id: string; token: string } | null>(null);
  const { units, total } = cartTotals(cart);

  useEffect(() => {
    if (!open) {
      setStep("cart");
      setServerError(null);
    }
  }, [open]);
  useEffect(() => {
    if (cart.length === 0) setStep("cart");
    attempt.current = null;
  }, [cart]);

  const set = <K extends keyof CheckoutForm>(k: K, v: CheckoutForm[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setErrors((e) => ({ ...e, [k]: undefined }));
  };

  async function submit() {
    setServerError(null);
    const e = validateCheckout(form, cart, ordering);
    setErrors(e);
    if (Object.values(e).some(Boolean)) return;
    attempt.current ??= { id: crypto.randomUUID(), token: newTrackingToken() };
    const { id, token } = attempt.current;
    setBusy(true);
    try {
      const { data, error } = await createClient().rpc(
        "public_catalog_order_create" as never,
        { p_slug: slug, p_order: buildOrderPayload(id, token, form, cart, ordering) } as never,
      );
      if (error) throw error;
      const r = data as unknown as CreateOrderResult;
      if (!r?.ok) throw new Error("order_failed");
      try {
        if (r.pickup_code) sessionStorage.setItem(pickupCodeKey(token), r.pickup_code);
      } catch {
        // Sin almacenamiento: el código igual llega por email si lo dejó.
      }
      onOrdered();
      router.push(trackingPath(slug, token) as never);
    } catch (err) {
      setServerError(catalogOrderErrorMessage(err));
      if (errorNeedsRefresh(err)) {
        attempt.current = null;
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  const accentBtn = "flex h-12 w-full items-center justify-between gap-3 rounded-lg px-4 text-sm font-semibold transition-opacity disabled:opacity-50";

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={step === "cart" ? "Tu carrito" : "Tus datos"}
      footer={
        cart.length === 0 ? undefined : step === "cart" ? (
          <button type="button" onClick={() => setStep("checkout")} className={accentBtn} style={{ backgroundColor: accent, color: accentInk }}>
            <span>Continuar</span>
            <span className="tabular-nums">{formatCurrency(total)}</span>
          </button>
        ) : (
          <div className="space-y-2">
            {serverError && (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
                {serverError}
              </p>
            )}
            <button
              type="button"
              onClick={submit}
              disabled={busy}
              className={accentBtn}
              style={{ backgroundColor: accent, color: accentInk }}
            >
              <span>{busy ? "Enviando pedido…" : "Confirmar pedido"}</span>
              <span className="tabular-nums">{formatCurrency(total)}</span>
            </button>
          </div>
        )
      }
    >
      {cart.length === 0 ? (
        <p className="py-12 text-center text-sm text-neutral-500">Todavía no agregaste productos.</p>
      ) : step === "cart" ? (
        <ul className="divide-y divide-neutral-200">
          {cart.map((c) => {
            const key = cartKey(c.productId, c.variantId);
            return (
              <li key={key} className="flex gap-3 py-3">
                <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-neutral-100">
                  {c.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={c.imageUrl} alt="" className="h-full w-full object-cover" />
                  ) : null}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-sm font-medium">{c.name}</p>
                  {c.variantLabel && <p className="text-xs text-neutral-500">{c.variantLabel}</p>}
                  <p className="text-xs tabular-nums text-neutral-500">{formatCurrency(c.unitPrice)} c/u</p>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <QtyStepper
                      value={c.qty}
                      max={c.max ?? 999}
                      onChange={(n) => onQty(key, n)}
                      label={`Cantidad de ${c.name}`}
                    />
                    <div className="flex items-center gap-1">
                      <span className="text-sm font-semibold tabular-nums">{formatCurrency(c.unitPrice * c.qty)}</span>
                      <button
                        type="button"
                        onClick={() => onQty(key, 0)}
                        aria-label={`Quitar ${c.name}`}
                        className="grid h-10 w-10 place-items-center rounded-lg text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
                      >
                        <Trash2 size={16} aria-hidden />
                      </button>
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
          <li className="flex items-center justify-between py-3 text-sm">
            <span className="text-neutral-500">
              {formatQty(units)} {units === 1 ? "producto" : "productos"}
            </span>
            <span className="text-base font-bold tabular-nums">{formatCurrency(total)}</span>
          </li>
        </ul>
      ) : (
        <form
          className="space-y-4 pt-1"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <button
            type="button"
            onClick={() => setStep("cart")}
            className="-ml-1 inline-flex h-10 items-center gap-1 rounded-lg px-1 text-sm text-neutral-600 hover:text-neutral-900"
          >
            <ArrowLeft size={16} aria-hidden /> Volver al carrito
          </button>

          <fieldset>
            <legend className="mb-2 text-sm font-medium">¿Cómo lo recibís?</legend>
            <div className="grid grid-cols-2 gap-2">
              {types.map((t) => {
                const on = form.deliveryType === t;
                const Icon = t === "envio" ? Truck : Store;
                return (
                  <button
                    key={t}
                    type="button"
                    aria-pressed={on}
                    onClick={() => set("deliveryType", t)}
                    className={cn(
                      "flex min-h-14 flex-col items-start justify-center gap-0.5 rounded-lg border px-3 py-2 text-left text-sm transition-colors",
                      on ? "border-neutral-900 bg-neutral-900 text-white" : "border-neutral-200 bg-white hover:bg-neutral-50",
                    )}
                  >
                    <Icon size={16} aria-hidden />
                    <span className="font-semibold">{DELIVERY_LABEL[t]}</span>
                  </button>
                );
              })}
            </div>
            {errors.deliveryType && (
              <p className="mt-1 text-xs font-medium text-red-700" role="alert">
                {errors.deliveryType}
              </p>
            )}
          </fieldset>

          {form.deliveryType === "retiro" &&
            (ordering.retiro.stores.length > 1 ? (
              <Field label="Sucursal de retiro" htmlFor="co-store">
                <select
                  id="co-store"
                  className={field}
                  value={form.pickupStoreId ?? ""}
                  onChange={(e) => set("pickupStoreId", e.target.value)}
                >
                  {ordering.retiro.stores.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                      {s.address ? ` · ${s.address}` : ""}
                    </option>
                  ))}
                </select>
              </Field>
            ) : ordering.retiro.stores[0] ? (
              <p className="rounded-lg bg-neutral-100 px-3 py-2 text-sm">
                Retirás en <strong>{ordering.retiro.stores[0].name}</strong>
                {ordering.retiro.stores[0].address ? ` · ${ordering.retiro.stores[0].address}` : ""}
              </p>
            ) : null)}

          {form.deliveryType === "envio" && (
            <Field label="Dirección de entrega" htmlFor="co-addr" error={errors.address} hint="Calle, número, piso, localidad.">
              <input
                id="co-addr"
                className={field}
                value={form.address}
                maxLength={300}
                autoComplete="street-address"
                onChange={(e) => set("address", e.target.value)}
              />
            </Field>
          )}

          <Field label="Nombre y apellido" htmlFor="co-name" error={errors.name}>
            <input
              id="co-name"
              className={field}
              value={form.name}
              maxLength={120}
              autoComplete="name"
              onChange={(e) => set("name", e.target.value)}
            />
          </Field>
          <Field label="Teléfono o WhatsApp" htmlFor="co-phone" error={errors.phone} hint="Con código de área, por si el negocio necesita escribirte.">
            <input
              id="co-phone"
              type="tel"
              inputMode="tel"
              className={field}
              value={form.phone}
              maxLength={40}
              autoComplete="tel"
              onChange={(e) => set("phone", e.target.value)}
            />
          </Field>
          <Field label="Email (opcional)" htmlFor="co-email" error={errors.email} hint="Te mandamos la confirmación y el link para seguir el pedido.">
            <input
              id="co-email"
              type="email"
              inputMode="email"
              className={field}
              value={form.email}
              maxLength={160}
              autoComplete="email"
              onChange={(e) => set("email", e.target.value)}
            />
          </Field>
          <Field label="Nota para el negocio (opcional)" htmlFor="co-notes" error={errors.notes}>
            <textarea
              id="co-notes"
              rows={2}
              className={cn(field, "h-auto py-2.5")}
              value={form.notes}
              maxLength={500}
              onChange={(e) => set("notes", e.target.value)}
            />
          </Field>

          {/* Honeypot anti spam: invisible para personas y lectores de pantalla. */}
          <div aria-hidden className="absolute -left-[9999px] h-px w-px overflow-hidden">
            <label htmlFor="co-website">Sitio web</label>
            <input
              id="co-website"
              tabIndex={-1}
              autoComplete="off"
              value={form.website}
              onChange={(e) => set("website", e.target.value)}
            />
          </div>

          <fieldset>
            <legend className="mb-2 text-sm font-medium">Pago</legend>
            {ordering.pay_link ? (
              <div className="grid grid-cols-2 gap-2">
                {(["al_retirar", "link"] as const).map((p) => {
                  const on = form.payment === p;
                  return (
                    <button
                      key={p}
                      type="button"
                      aria-pressed={on}
                      onClick={() => set("payment", p)}
                      className={cn(
                        "min-h-12 rounded-lg border px-3 py-2 text-left text-sm font-semibold transition-colors",
                        on ? "border-neutral-900 bg-neutral-900 text-white" : "border-neutral-200 bg-white hover:bg-neutral-50",
                      )}
                    >
                      {paymentLabel(p, form.deliveryType)}
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="rounded-lg bg-neutral-100 px-3 py-2 text-sm">{paymentLabel("al_retirar", form.deliveryType)}</p>
            )}
            {ordering.pay_link && form.payment === "link" && (
              <p className="mt-1 text-xs text-neutral-500">El negocio te manda el link de pago por WhatsApp o email.</p>
            )}
          </fieldset>

          <p className="text-xs text-neutral-500">
            Te guardamos el stock {ordering.reservation_minutes >= 60
              ? `${Math.round(ordering.reservation_minutes / 60)} h`
              : `${ordering.reservation_minutes} min`} mientras el negocio confirma el pedido. Los precios y el stock se confirman al enviar.
          </p>
        </form>
      )}
    </Sheet>
  );
}
