"use client";

// Ficha pública del producto (H24 · ADR-148), la que abre el QR de la
// etiqueta. Siempre clara (es del cliente final), con la marca del negocio
// igual que el catálogo público (H10). Muestra fotos, descripción, precio de
// la lista del catálogo y un simulador de medios de pago con las cuotas y
// recargos del negocio. No vende: si el negocio toma pedidos por el catálogo
// (carrito activo) ofrece ir al catálogo; si no, sólo informa.

import { useMemo, useState } from "react";
import { CreditCard, MapPin, Phone, ShoppingBag } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import { parseNetContent, normalizeNetUnit, unitPriceOf } from "@/lib/labels/items";
import { bestInstallmentText, simulatePayments } from "@/lib/labels/paymentSim";
import type { PublicProductSheet } from "@/lib/labels/publicSheet";

export function ProductPublicSheet({
  sheet,
  business,
  palette,
}: {
  sheet: PublicProductSheet;
  business: string;
  palette: { accent: string; accentInk: string; accentText: string };
}) {
  const p = sheet.product;
  const [img, setImg] = useState(0);
  const [variant, setVariant] = useState(0);
  const variants = p.variants?.length ? p.variants : null;
  const price = variants ? variants[Math.min(variant, variants.length - 1)]!.price : p.price;

  const groups = useMemo(() => simulatePayments(price, sheet.payments.methods, sheet.payments.plans), [price, sheet.payments]);
  const best = bestInstallmentText(groups, formatCurrency);
  const [group, setGroup] = useState<string | null>(null);
  const activeGroup = groups.find((g) => g.key === group) ?? groups[0] ?? null;

  const content =
    p.net_content && normalizeNetUnit(p.net_content_unit) ? { qty: p.net_content, unit: normalizeNetUnit(p.net_content_unit)! } : parseNetContent(p.name);
  const unitPrice = unitPriceOf(price, content, p.unit);
  const contact = [sheet.branding?.address, sheet.branding?.phone].filter(Boolean);
  const catalogUrl = `/c/${encodeURIComponent(sheet.tenant.slug)}`;

  return (
    <main className="min-h-dvh bg-neutral-50 text-neutral-900">
      <header className="border-b-4 bg-[#15111f] px-4 py-5 text-white sm:px-6" style={{ borderColor: palette.accent }}>
        <div className="mx-auto flex max-w-4xl items-center gap-3">
          {sheet.branding?.logo_url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={sheet.branding.logo_url} alt="" className="h-11 w-11 shrink-0 rounded-lg bg-white/10 object-contain p-1" />
          )}
          <div className="min-w-0">
            <p className="truncate text-lg font-extrabold tracking-tight">{business}</p>
            {contact.length > 0 && <p className="truncate text-xs opacity-80">{contact.join(" · ")}</p>}
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-4xl gap-6 px-4 pb-[calc(2.5rem+env(safe-area-inset-bottom))] pt-5 sm:px-6 md:grid-cols-2 md:pt-8">
        {/* Fotos */}
        <section aria-label="Fotos del producto" className="min-w-0">
          <div className="aspect-square w-full overflow-hidden rounded-xl border border-neutral-200 bg-white">
            {p.images.length > 0 ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={p.images[img]} alt={p.name} className="h-full w-full object-contain" />
            ) : (
              <div className="grid h-full w-full place-items-center text-sm text-neutral-400">Sin foto</div>
            )}
          </div>
          {p.images.length > 1 && (
            <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
              {p.images.map((u, i) => (
                <button
                  key={u + i}
                  type="button"
                  onClick={() => setImg(i)}
                  aria-label={`Foto ${i + 1}`}
                  aria-pressed={img === i}
                  className={cn("h-16 w-16 shrink-0 overflow-hidden rounded-lg border bg-white", img === i ? "border-neutral-900" : "border-neutral-200")}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={u} alt="" className="h-full w-full object-contain" />
                </button>
              ))}
            </div>
          )}
        </section>

        {/* Datos y precio */}
        <section className="min-w-0 space-y-4">
          <div>
            {(p.brand || p.category) && (
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-neutral-500">{[p.brand, p.category].filter(Boolean).join(" · ")}</p>
            )}
            <h1 className="mt-1 break-words text-2xl font-extrabold leading-tight tracking-tight">{p.name}</h1>
          </div>

          {variants && (
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Variante">
              {variants.map((v, i) => (
                <button
                  key={`${v.label}-${i}`}
                  type="button"
                  role="radio"
                  aria-checked={variant === i}
                  onClick={() => setVariant(i)}
                  className={cn(
                    "min-h-[40px] rounded-md border px-3 text-sm font-medium",
                    variant === i ? "border-neutral-900 bg-neutral-900 text-white" : "border-neutral-200 bg-white text-neutral-700",
                  )}
                >
                  {v.label ?? `Opción ${i + 1}`}
                </button>
              ))}
            </div>
          )}

          <div>
            <p className="text-4xl font-black tabular-nums tracking-tight">{formatCurrency(price)}</p>
            {unitPrice && (
              <p className="mt-1 text-sm text-neutral-600">
                {formatCurrency(unitPrice.value)} x {unitPrice.per}
              </p>
            )}
            {best && (
              <p className="mt-2 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-semibold" style={{ backgroundColor: `${palette.accent}1a`, color: palette.accentText }}>
                <CreditCard size={15} aria-hidden /> {best}
              </p>
            )}
          </div>

          {p.description && <p className="whitespace-pre-line text-sm leading-relaxed text-neutral-700">{p.description}</p>}

          {sheet.catalog.ordering ? (
            <a
              href={catalogUrl}
              className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-lg text-sm font-semibold"
              style={{ backgroundColor: palette.accent, color: palette.accentInk }}
            >
              <ShoppingBag size={18} aria-hidden /> Pedirlo desde el catálogo
            </a>
          ) : sheet.catalog.enabled ? (
            <a href={catalogUrl} className="inline-flex h-11 w-full items-center justify-center rounded-lg border border-neutral-300 bg-white text-sm font-semibold">
              Ver más productos
            </a>
          ) : null}
        </section>

        {/* Simulador de medios de pago */}
        <section className="min-w-0 md:col-span-2" aria-labelledby="sim-title">
          <div className="rounded-xl border border-neutral-200 bg-white p-4 sm:p-5">
            <h2 id="sim-title" className="text-lg font-bold">
              Simulá cómo pagarlo
            </h2>
            {groups.length === 0 ? (
              <p className="mt-2 text-sm text-neutral-600">Consultá los medios de pago y las cuotas en el local.</p>
            ) : (
              <>
                <p className="mt-1 text-sm text-neutral-600">Precio de hoy {formatCurrency(price)}. Los importes son de referencia; se confirman al pagar.</p>
                {groups.length > 1 && (
                  <div className="-mx-1 mt-3 flex gap-2 overflow-x-auto px-1 pb-1" role="tablist" aria-label="Medio de pago">
                    {groups.map((g) => {
                      const on = activeGroup?.key === g.key;
                      return (
                        <button
                          key={g.key}
                          type="button"
                          role="tab"
                          aria-selected={on}
                          onClick={() => setGroup(g.key)}
                          className={cn(
                            "h-10 shrink-0 rounded-md border px-3 text-sm font-medium",
                            on ? "border-neutral-900 bg-neutral-900 text-white" : "border-neutral-200 bg-white text-neutral-700",
                          )}
                        >
                          {g.title}
                        </button>
                      );
                    })}
                  </div>
                )}
                {activeGroup && (
                  <div className="mt-3 overflow-hidden rounded-lg border border-neutral-200">
                    <table className="w-full text-sm">
                      <thead className="bg-neutral-50 text-left text-xs uppercase tracking-[0.12em] text-neutral-500">
                        <tr>
                          <th className="px-3 py-2">Opción</th>
                          <th className="px-3 py-2 text-right">Cuota</th>
                          <th className="px-3 py-2 text-right">Total</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-neutral-200">
                        {activeGroup.rows.map((r) => (
                          <tr key={r.id}>
                            <td className="px-3 py-2.5">
                              <div className="font-medium">{r.label}</div>
                              <div className="text-xs text-neutral-500">
                                {[r.detail, r.pct > 0 ? `recargo ${fmtPct(r.pct)}` : r.pct < 0 ? `descuento ${fmtPct(-r.pct)}` : r.installments > 1 ? "sin interés" : null]
                                  .filter(Boolean)
                                  .join(" · ")}
                              </div>
                            </td>
                            <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums">
                              {r.installments > 1 ? `${r.installments} x ${formatCurrency(r.perInstallment)}` : "1 pago"}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2.5 text-right font-semibold tabular-nums">{formatCurrency(r.total)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </div>
        </section>

        {contact.length > 0 && (
          <footer className="space-y-1 text-sm text-neutral-600 md:col-span-2">
            {sheet.branding?.address && (
              <p className="flex items-center gap-2">
                <MapPin size={15} aria-hidden /> {sheet.branding.address}
              </p>
            )}
            {sheet.branding?.phone && (
              <p className="flex items-center gap-2">
                <Phone size={15} aria-hidden /> {sheet.branding.phone}
              </p>
            )}
          </footer>
        )}
      </div>
    </main>
  );
}

function fmtPct(n: number): string {
  return `${String(Math.round(n * 100) / 100).replace(".", ",")}%`;
}
