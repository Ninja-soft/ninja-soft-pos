import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { ArrowLeft, Check, MessageCircle } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { businessDisplayName } from "@/lib/branding/businessName";
import { accentPalette } from "@/lib/invoices/style";
import { whatsappUrl } from "@/lib/quotes/logic";
import { cn } from "@/lib/utils/cn";
import { formatCurrency, formatQty } from "@/lib/utils/format";
import {
  TOKEN_RE,
  stageIndex,
  trackingHeadline,
  trackingStage,
  trackingSteps,
  whatsappOrderText,
  type PublicOrderStatus,
} from "@/lib/catalog/publicOrder";
import { PickupCode, StatusAutoRefresh } from "@/components/catalog/public/TrackingClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Seguimiento del pedido", robots: { index: false, follow: false } };

const APP_URL = "https://pos.soft.ninja";

// Seguimiento del pedido del catálogo (ADR-130). Sin sesión: todo sale de
// public_catalog_order_status con el token (32 bytes al azar, guardado sólo
// como hash), que devuelve el pedido y la marca del negocio, nunca ids.
export default async function CatalogOrderTrackingPage({ params }: { params: { slug: string; token: string } }) {
  if (!TOKEN_RE.test(params.token)) notFound();
  const { data } = await createClient().rpc("public_catalog_order_status" as never, { p_token: params.token } as never);
  const o = data as unknown as PublicOrderStatus | null;
  if (!o) notFound();

  const b = o.business;
  const name = businessDisplayName({ tradeName: b?.trade_name, tenantName: b?.name, legalName: b?.legal_name }, "el negocio");
  const pal = accentPalette(b?.accent || "#EC3F17");
  const stage = trackingStage(o);
  const steps = trackingSteps(o.delivery_type);
  const current = stageIndex(stage);
  const finalStage = stage === "entregado" || stage === "cancelado";
  const slug = b?.slug ?? params.slug;
  const url = `${APP_URL}/c/${encodeURIComponent(slug)}/pedido/${params.token}`;
  const wa = b?.phone ? whatsappUrl(b.phone, whatsappOrderText(name, o.number, url)) : null;

  return (
    <main className="min-h-dvh bg-neutral-50 text-neutral-900">
      <header className="border-b-4 bg-[#15111f] px-4 py-6 text-white sm:px-6" style={{ borderColor: pal.accent }}>
        <div className="mx-auto flex max-w-xl items-center gap-3">
          {b?.logo_url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={b.logo_url} alt="" className="h-12 w-12 shrink-0 rounded-lg bg-white/10 object-contain p-1" />
          )}
          <div className="min-w-0">
            <p className="truncate text-sm opacity-90">{name}</p>
            <h1 className="text-xl font-extrabold tracking-tight">Pedido N° {o.number}</h1>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-xl space-y-4 px-4 pb-[calc(2.5rem+env(safe-area-inset-bottom))] pt-5 sm:px-6">
        <section className="rounded-xl border border-neutral-200 bg-white p-4">
          <p className="text-base font-semibold">{trackingHeadline(o)}</p>
          {stage !== "cancelado" ? (
            <ol className="mt-4 grid grid-cols-5 gap-1" aria-label="Estado del pedido">
              {steps.map((s, i) => {
                const done = i <= current;
                return (
                  <li key={s.stage} className="flex flex-col items-center gap-1.5 text-center">
                    <span
                      className={cn(
                        "grid h-7 w-7 place-items-center rounded-full text-xs font-bold",
                        done ? "" : "bg-neutral-100 text-neutral-400",
                      )}
                      style={done ? { backgroundColor: pal.accent, color: pal.accentInk } : undefined}
                      aria-hidden
                    >
                      {i < current ? <Check size={14} /> : i + 1}
                    </span>
                    <span className={cn("text-[11px] leading-tight", i === current ? "font-semibold text-neutral-900" : "text-neutral-500")}>
                      {s.label}
                    </span>
                    {i === current && <span className="sr-only">(paso actual)</span>}
                  </li>
                );
              })}
            </ol>
          ) : (
            <span className="mt-3 inline-flex rounded-md bg-neutral-100 px-2 py-0.5 text-xs font-semibold text-neutral-600">Cancelado</span>
          )}
          {o.dispatch?.tracking && (
            <p className="mt-3 text-sm text-neutral-600">
              Seguimiento del envío: <strong className="tabular-nums">{o.dispatch.tracking}</strong>
            </p>
          )}
        </section>

        {o.delivery_type !== "envio" && !finalStage && <PickupCode token={params.token} />}

        <section className="rounded-xl border border-neutral-200 bg-white p-4">
          <h2 className="text-sm font-semibold">{o.delivery_type === "envio" ? "Envío a domicilio" : "Retiro en sucursal"}</h2>
          <p className="mt-1 text-sm text-neutral-600">
            {o.delivery_type === "envio"
              ? o.ship_address
              : [o.pickup_store?.name, o.pickup_store?.address].filter(Boolean).join(" · ")}
          </p>
          <p className="mt-1 text-sm text-neutral-600">
            {o.payment_preference === "link"
              ? "Pago con link: el negocio te lo manda."
              : o.status === "cobrado"
                ? "Pago registrado."
                : o.delivery_type === "envio"
                  ? "Pagás al recibir."
                  : "Pagás al retirar."}
          </p>
        </section>

        <section className="rounded-xl border border-neutral-200 bg-white p-4">
          <h2 className="text-sm font-semibold">Tu pedido</h2>
          <ul className="mt-2 divide-y divide-neutral-100">
            {o.lines.map((l, i) => (
              <li key={i} className="flex items-start justify-between gap-3 py-2 text-sm">
                <span className="min-w-0">
                  <span className="tabular-nums text-neutral-500">{formatQty(Number(l.qty))} × </span>
                  {l.name}
                  {l.variant ? <span className="text-neutral-500"> ({l.variant})</span> : null}
                </span>
                <span className="shrink-0 tabular-nums">{formatCurrency(Number(l.unit_price) * Number(l.qty))}</span>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex items-center justify-between border-t border-neutral-200 pt-3">
            <span className="text-sm text-neutral-500">Total</span>
            <span className="text-lg font-bold tabular-nums">{formatCurrency(Number(o.total))}</span>
          </div>
          <p className="mt-1 text-xs text-neutral-500">El negocio confirma el total al cobrar.</p>
        </section>

        <div className="flex flex-col gap-2 sm:flex-row">
          {wa && (
            <a
              href={wa}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-12 flex-1 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold"
              style={{ backgroundColor: pal.accent, color: pal.accentInk }}
            >
              <MessageCircle size={18} aria-hidden /> Escribirle por WhatsApp
            </a>
          )}
          <Link
            href={`/c/${encodeURIComponent(slug)}`}
            className="inline-flex h-12 flex-1 items-center justify-center gap-2 rounded-lg border border-neutral-300 bg-white px-4 text-sm font-semibold text-neutral-800 hover:bg-neutral-50"
          >
            <ArrowLeft size={16} aria-hidden /> Volver al catálogo
          </Link>
        </div>
        <p className="text-center text-xs text-neutral-500">Guardá este link para ver cómo va tu pedido.</p>
      </div>

      <footer className="border-t border-neutral-200 py-6 text-center text-xs text-neutral-400">Hecho con NinjaPos</footer>
      {!finalStage && <StatusAutoRefresh seconds={30} />}
    </main>
  );
}
