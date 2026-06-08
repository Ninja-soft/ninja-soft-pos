"use client";

import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ShoppingBag } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { formatCurrency, formatQty } from "@/lib/utils/format";
import {
  useCustomerDisplayState,
  idleState,
  EMPTY_BRANDING,
  type DisplayBranding,
  type DisplayState,
} from "@/lib/pos/customerDisplay";

// =============================================================================
// Pantalla del cliente / segunda pantalla (F10 · H25)
// -----------------------------------------------------------------------------
// Ventana de cara al cliente (2do monitor / tablet de la caja). SUSCRIBE el
// estado que publica el POS (carrito, totales, vuelto, QR de cobro) por
// BroadcastChannel/localStorage y lo muestra en vivo, sin recargar.
//
// Cuando todavía no llegó nada del POS (p. ej. la ventana se abrió primero), se
// muestra la pantalla idle con el branding del propio tenant (que esta ruta lee
// por su cuenta vía RLS). Apenas el POS publica, su estado manda.
//
// SEGURIDAD: solo se ve la venta EN CURSO. La ruta exige sesión del tenant (ver
// (display)/layout.tsx) y nunca muestra panel interno, tokens ni datos del
// cajero/otros clientes.
// =============================================================================

const DEFAULT_WELCOME = "¡Bienvenido!";
const DEFAULT_THANKS = "¡Gracias por tu compra!";

export default function CustomerDisplayPage() {
  const live = useCustomerDisplayState();

  // Branding base del tenant para la pantalla idle (antes de que el POS publique).
  // El estado en vivo del POS trae su propio branding y tiene prioridad.
  const { data: ownBranding } = useQuery({
    queryKey: ["customer-display", "branding"],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<DisplayBranding> => {
      const supabase = createClient();
      const [{ data: b }, { data: s }, { data: reg }] = await Promise.all([
        supabase
          .from("tenant_branding")
          .select("legal_name, logo_url, accent")
          .maybeSingle(),
        supabase
          .from("pos_settings")
          // Columnas nuevas (H25) aún no en los tipos generados: select("*") +
          // cast vía unknown.
          .select("*")
          .maybeSingle(),
        supabase
          .from("cash_registers")
          .select("name, stores(name)")
          .eq("is_active", true)
          .order("created_at")
          .limit(1)
          .maybeSingle(),
      ]);
      const settings = (s as unknown as {
        display_show_unit_prices?: boolean;
        display_welcome_message?: string | null;
        display_thanks_message?: string | null;
      } | null) ?? null;
      const branding = b as {
        legal_name?: string | null;
        logo_url?: string | null;
        accent?: string | null;
      } | null;
      const register = reg as {
        name?: string | null;
        stores?: { name?: string | null } | null;
      } | null;
      const regLabel = register
        ? [register.name, register.stores?.name].filter(Boolean).join(" · ") || null
        : null;
      return {
        businessName: branding?.legal_name ?? null,
        logoUrl: branding?.logo_url ?? null,
        accent: branding?.accent ?? null,
        registerLabel: regLabel,
        welcomeMessage: settings?.display_welcome_message ?? null,
        thanksMessage: settings?.display_thanks_message ?? null,
        showUnitPrices: settings?.display_show_unit_prices ?? true,
      };
    },
  });

  // Estado efectivo: el del POS si llegó; si no, idle con el branding propio.
  const state: DisplayState = useMemo(
    () => live ?? idleState(ownBranding ?? EMPTY_BRANDING),
    [live, ownBranding],
  );
  const branding = state.branding;
  const accent = branding.accent || "#FF4B22";

  // Pantalla de cara al cliente: fondo oscuro fijo de alto contraste,
  // independiente del tema del POS (para que se lea bien a distancia). Forzamos
  // el color de acento del tenant vía CSS var local.
  return (
    <main
      className="relative flex h-dvh w-full flex-col overflow-hidden bg-[#09051C] text-white"
      style={{ ["--cd-accent" as string]: accent }}
    >
      {/* Glow de marca de fondo */}
      <div
        className="pointer-events-none absolute -top-1/3 left-1/2 h-[80vh] w-[80vh] -translate-x-1/2 rounded-full opacity-20 blur-3xl"
        style={{ background: accent }}
      />

      {state.phase === "idle" ? (
        <IdleScreen branding={branding} />
      ) : state.phase === "paid" ? (
        <PaidScreen state={state} />
      ) : (
        <SaleScreen state={state} />
      )}
    </main>
  );
}

// Encabezado común (carrito / cobro): logo + nombre + caja.
function Header({ branding }: { branding: DisplayBranding }) {
  return (
    <header className="z-10 flex items-center gap-4 border-b border-white/10 px-8 py-5">
      <BrandLogo branding={branding} size={56} />
      <div className="min-w-0">
        <div className="truncate text-2xl font-bold leading-tight">
          {branding.businessName || "NinjaPos"}
        </div>
        {branding.registerLabel && (
          <div className="truncate text-sm text-white/50">{branding.registerLabel}</div>
        )}
      </div>
    </header>
  );
}

function BrandLogo({
  branding,
  size,
}: {
  branding: DisplayBranding;
  size: number;
}) {
  if (branding.logoUrl) {
    return (
      <span
        className="grid shrink-0 place-items-center overflow-hidden rounded-2xl bg-white/95 p-1.5"
        style={{ height: size, width: size }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={branding.logoUrl}
          alt={branding.businessName || "Logo"}
          className="h-full w-full object-contain"
        />
      </span>
    );
  }
  return (
    <span
      className="grid shrink-0 place-items-center rounded-2xl text-[var(--cd-accent)]"
      style={{ height: size, width: size, background: "rgba(255,255,255,0.06)" }}
    >
      <ShoppingBag size={size * 0.5} />
    </span>
  );
}

// ---------------------------------------------------------------------------
// IDLE — sin venta: logo grande + bienvenida.
// ---------------------------------------------------------------------------
function IdleScreen({ branding }: { branding: DisplayBranding }) {
  const welcome = branding.welcomeMessage?.trim() || DEFAULT_WELCOME;
  return (
    <div className="z-10 flex flex-1 flex-col items-center justify-center px-8 text-center">
      <div className="animate-fade-in">
        <BrandLogo branding={branding} size={180} />
      </div>
      <h1 className="mt-10 text-5xl font-black tracking-tight md:text-6xl">{welcome}</h1>
      {branding.businessName && (
        <p className="mt-4 text-xl font-medium text-white/60">{branding.businessName}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SALE — carrito en construcción y/o cobro por QR.
// ---------------------------------------------------------------------------
function SaleScreen({ state }: { state: DisplayState }) {
  const { branding } = state;
  const showUnit = branding.showUnitPrices;
  const paying = state.phase === "paying" && state.qr;

  return (
    <div className="z-10 flex min-h-0 flex-1 flex-col">
      <Header branding={branding} />

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[1fr_minmax(360px,40%)]">
        {/* Ítems */}
        <section className="flex min-h-0 flex-col px-8 py-6">
          <div className="mb-3 text-sm font-semibold uppercase tracking-widest text-white/40">
            Tu compra
          </div>
          <ul className="slim-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
            {state.lines.length === 0 && (
              <li className="py-16 text-center text-2xl text-white/30">
                Esperando productos…
              </li>
            )}
            {state.lines.map((l) => (
              <li
                key={l.lineId}
                className="flex items-center justify-between gap-4 rounded-2xl bg-white/[0.04] px-5 py-4"
              >
                <div className="min-w-0">
                  <div className="truncate text-2xl font-semibold">{l.name}</div>
                  <div className="mt-0.5 text-base text-white/50">
                    {l.unit === "kg"
                      ? `${formatQty(l.quantity)} kg`
                      : `${formatQty(l.quantity)} ${l.quantity === 1 ? "unidad" : "unidades"}`}
                    {l.variantLabel ? ` · ${l.variantLabel}` : ""}
                    {showUnit ? ` · ${formatCurrency(l.unitPrice)}${l.unit === "kg" ? "/kg" : " c/u"}` : ""}
                  </div>
                </div>
                <div className="shrink-0 font-price text-2xl font-bold tabular-nums">
                  {formatCurrency(l.lineTotal)}
                </div>
              </li>
            ))}
          </ul>
        </section>

        {/* Totales + QR */}
        <aside className="flex flex-col justify-between border-t border-white/10 bg-black/20 px-8 py-6 lg:border-l lg:border-t-0">
          {paying ? (
            <QrPanel state={state} />
          ) : (
            <div className="flex flex-1 flex-col justify-end">
              <Totals state={state} />
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function Totals({ state }: { state: DisplayState }) {
  return (
    <div className="space-y-3">
      <Row label="Subtotal" value={formatCurrency(state.subtotal)} muted />
      {state.discountTotal > 0 && (
        <Row
          label="Descuento"
          value={`- ${formatCurrency(state.discountTotal)}`}
          muted
          accent
        />
      )}
      <div className="border-t border-white/15 pt-4">
        <div className="text-sm font-semibold uppercase tracking-widest text-white/40">
          Total
        </div>
        <div className="font-price text-6xl font-black tabular-nums leading-none text-[var(--cd-accent)] md:text-7xl">
          {formatCurrency(state.total)}
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  muted,
  accent,
}: {
  label: string;
  value: string;
  muted?: boolean;
  accent?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className={muted ? "text-lg text-white/50" : "text-lg"}>{label}</span>
      <span
        className={
          "font-price text-2xl font-bold tabular-nums " +
          (accent ? "text-[var(--cd-accent)]" : muted ? "text-white/70" : "")
        }
      >
        {value}
      </span>
    </div>
  );
}

// QR de cobro: imagen grande sobre tarjeta blanca + monto.
function QrPanel({ state }: { state: DisplayState }) {
  const qr = state.qr!;
  const qrSrc = `https://api.qrserver.com/v1/create-qr-code/?size=420x420&margin=0&data=${encodeURIComponent(
    qr.initPoint,
  )}`;
  return (
    <div className="flex flex-1 flex-col items-center justify-center text-center">
      <div className="text-sm font-semibold uppercase tracking-widest text-white/40">
        Escaneá para pagar
      </div>
      <div className="mt-4 rounded-3xl bg-white p-4 shadow-2xl">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={qrSrc}
          alt={`QR de pago ${qr.providerName}`}
          width={300}
          height={300}
          className="h-[clamp(220px,30vh,340px)] w-[clamp(220px,30vh,340px)]"
        />
      </div>
      <div className="mt-5 text-lg text-white/60">{qr.providerName}</div>
      <div className="font-price text-5xl font-black tabular-nums text-[var(--cd-accent)] md:text-6xl">
        {formatCurrency(qr.amount)}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PAID — venta confirmada: “Pago recibido ✓ / ¡Gracias!” + promo + vuelto.
// ---------------------------------------------------------------------------
function PaidScreen({ state }: { state: DisplayState }) {
  const thanks = state.branding.thanksMessage?.trim() || DEFAULT_THANKS;
  return (
    <div className="z-10 flex flex-1 flex-col items-center justify-center px-8 text-center">
      <div
        className="grid h-32 w-32 animate-scale-in place-items-center rounded-full"
        style={{ background: "var(--cd-accent)" }}
      >
        <Check size={72} strokeWidth={3} className="text-[#09051C]" />
      </div>
      <h1 className="mt-8 text-5xl font-black tracking-tight md:text-6xl">Pago recibido</h1>
      <p className="mt-4 text-2xl font-medium text-white/70">{thanks}</p>
      {(state.change ?? 0) > 0 && (
        <div className="mt-8 rounded-2xl bg-white/[0.06] px-8 py-5">
          <div className="text-sm font-semibold uppercase tracking-widest text-white/40">
            Tu vuelto
          </div>
          <div className="font-price text-5xl font-black tabular-nums text-[var(--cd-accent)]">
            {formatCurrency(state.change ?? 0)}
          </div>
        </div>
      )}
    </div>
  );
}
