"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { CalendarClock, Check, PackageMinus, Store } from "lucide-react";
import { LogoNinjaPos } from "@/components/brand/Logo";
import { TechBackground } from "@/components/brand/TechBackground";
import { signupTrialDays, trialCopy, useSignupPlans } from "@/modules/saas/signupPlans";
import { cn } from "@/lib/utils/cn";
import s from "./ValuePanel.module.css";

// Panel de marca de las pantallas de auth (sólo desktop, columna izquierda del
// layout). Superficie plana noche violeta, siempre oscura (data-theme fijo) para
// que el logo oficial con "Ninja" en blanco se lea igual en tema claro.
// La pieza central es un collage del producto armado en HTML/CSS (ticket de una
// venta cobrada, ventas del día, factura de ARCA y aviso de stock), apilado con
// capas planas y bordes de 1px: sin degradados, sin sombras, sin glow. Es
// decorativo (aria-hidden); el mensaje real vive en el titular y el párrafo.

const MAX_SCALE = 1.25;
// Por debajo de esta escala el collage ya no se lee: se oculta.
const MIN_SCALE = 0.62;

// Dos composiciones del escenario (px de diseño): "wide" con las cuatro piezas
// y "narrow" (panel angosto, p. ej. signup a 1024) con tres, más apiladas.
type Box = { left: number; top: number; width: number };
interface StageLayout {
  w: number;
  h: number;
  sales: Box;
  ticket: Box;
  arca: Box;
  stock: Box | null;
}
const WIDE: StageLayout = {
  w: 540,
  h: 340,
  sales: { left: 208, top: 0, width: 312 },
  ticket: { left: 0, top: 66, width: 236 },
  arca: { left: 262, top: 196, width: 266 },
  stock: { left: 290, top: 270, width: 226 },
};
const NARROW: StageLayout = {
  w: 380,
  h: 376,
  sales: { left: 100, top: 0, width: 280 },
  ticket: { left: 0, top: 90, width: 236 },
  arca: { left: 150, top: 318, width: 230 },
  stock: null,
};
// El "wide" se usa mientras no haya que achicarlo por debajo de esto.
const WIDE_MIN_SCALE = 0.8;

const TICKET_ITEMS = [
  { qty: 2, name: "Yerba Playadito 1 kg", amount: 9800 },
  { qty: 1, name: "Coca-Cola 2,25 L", amount: 3450 },
  { qty: 6, name: "Alfajor Havanna", amount: 7200 },
];
const TICKET_TOTAL = TICKET_ITEMS.reduce((acc, i) => acc + i.amount, 0);

// Ventas por hora (relativas). La última es la hora en curso.
const BARS = [28, 44, 36, 58, 50, 72, 64, 86, 70, 94];
const BAR_HOURS = ["9", "", "11", "", "13", "", "15", "", "17", ""];

const PAYMENT_LOGOS = [
  { src: "/images/payments/mercado-pago-wordmark-on-dark.webp", alt: "Mercado Pago", h: "h-6", f: "grayscale brightness-[1.15]" },
  { src: "/images/payments/modo-wordmark.webp", alt: "MODO", h: "h-4", f: "brightness-0 invert" },
  { src: "/images/payments/payway-wordmark-on-dark.webp", alt: "Payway", h: "h-[1.1rem]", f: "brightness-0 invert" },
  { src: "/images/payments/getnet-wordmark-on-dark.webp", alt: "Getnet", h: "h-[1.15rem]", f: "brightness-0 invert" },
  { src: "/images/payments/nave-wordmark-on-dark.webp", alt: "Nave", h: "h-6", f: "brightness-0 invert" },
];

const money = (n: number) => `$ ${Math.round(n).toLocaleString("es-AR")}`;

function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Total del ticket contando hasta el valor final (instantáneo con reduced motion). */
function useCountUp(target: number, delay: number, duration: number) {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (prefersReducedMotion()) {
      setValue(target);
      return;
    }
    let raf = 0;
    let start = 0;
    const tick = (t: number) => {
      if (!start) start = t;
      const p = Math.min(1, (t - start) / duration);
      setValue(target * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    const timer = window.setTimeout(() => {
      raf = requestAnimationFrame(tick);
    }, delay);
    return () => {
      window.clearTimeout(timer);
      cancelAnimationFrame(raf);
    };
  }, [target, delay, duration]);
  return value;
}

/** Escala del escenario para que entre en el espacio libre sin cortarse. */
function useStageScale() {
  const ref = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<{ layout: StageLayout; scale: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const { width, height } = el.getBoundingClientRect();
      const scaleFor = (l: StageLayout) => Math.min(MAX_SCALE, width / l.w, height / l.h);
      const wide = scaleFor(WIDE);
      setFit(wide >= WIDE_MIN_SCALE ? { layout: WIDE, scale: wide } : { layout: NARROW, scale: scaleFor(NARROW) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, fit };
}

type PieceStyle = React.CSSProperties & { "--rot"?: string; "--delay"?: string };

function piece(at: Box, rot: number, delay: number): PieceStyle {
  return { ...at, "--rot": `${rot}deg`, "--delay": `${delay}ms` };
}

function SalesCard({ at }: { at: Box }) {
  return (
    <div
      className={cn(s.piece, "absolute rounded-lg border border-white/10 bg-ninja-midViolet p-4")}
      style={piece(at, 2.5, 120)}
    >
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-medium text-ninja-lavender">Ventas de hoy</span>
        <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-ninja-lavender">
          <span className={cn(s.live, "h-1.5 w-1.5 rounded-full bg-success")} />
          En vivo
        </span>
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="font-price text-[26px] font-bold tabular-nums tracking-tight text-ninja-softWhite">
          $ 384.200
        </span>
        <span className="text-[12px] font-semibold text-success">+18%</span>
      </div>
      <div className="mt-3 flex h-[78px] items-end gap-[7px]">
        {BARS.map((h, i) => (
          <div key={i} className="flex h-full flex-1 flex-col justify-end">
            <div
              className={cn(
                s.bar,
                "w-full rounded-[3px]",
                i === BARS.length - 1 ? "bg-ninja-flame" : "bg-white/[0.16]",
              )}
              style={{ height: `${h}%`, "--delay": `${450 + i * 55}ms` } as PieceStyle}
            />
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex gap-[7px] font-mono text-[10px] text-ninja-lavender">
        {BAR_HOURS.map((label, i) => (
          <span key={i} className="flex-1 text-center">
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}

function TicketCard({ at, total }: { at: Box; total: number }) {
  return (
    <div
      className={cn(s.piece, "absolute rounded-lg bg-ninja-softWhite px-4 pb-4 pt-3.5 text-ninja-deepViolet")}
      style={piece(at, -3, 0)}
    >
      <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.1em] text-ninja-midViolet">
        <span>Venta #0482</span>
        <span>Caja 1 · 18:42</span>
      </div>
      <ul className="mt-3 space-y-1.5 text-[12px]">
        {TICKET_ITEMS.map((item) => (
          <li key={item.name} className="flex items-baseline gap-2">
            <span className="w-5 shrink-0 font-mono text-[11px] text-ninja-midViolet">{item.qty}x</span>
            <span className="min-w-0 flex-1 truncate">{item.name}</span>
            <span className="font-price tabular-nums">{money(item.amount)}</span>
          </li>
        ))}
      </ul>
      <div className="my-3 border-t border-dashed border-ninja-deepViolet/25" />
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-ninja-midViolet">Total</span>
        <span className="font-price text-[24px] font-bold tabular-nums tracking-tight">{money(total)}</span>
      </div>
      <div className="mt-3 flex w-fit items-center gap-2 rounded-md border border-ninja-deepViolet/10 bg-white px-2.5 py-2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/images/payments/mercado-pago-icon.webp" alt="" className="h-5 w-5" />
        <span className="text-[12px] font-medium">QR Mercado Pago</span>
      </div>
      <span
        className={cn(s.stamp, "absolute -right-9 bottom-[10px] inline-flex items-center gap-1 rounded-md border-2 border-[#0E8A5F] bg-ninja-softWhite px-2 py-0.5 text-[13px] font-extrabold uppercase tracking-[0.08em] text-[#0E8A5F]")}
        style={{ "--delay": "1650ms" } as PieceStyle}
      >
        <Check size={14} strokeWidth={3} />
        Cobrado
      </span>
    </div>
  );
}

function ArcaChip({ at }: { at: Box }) {
  return (
    <div
      className={cn(s.piece, "absolute flex items-center gap-3 rounded-lg border border-white/10 bg-ninja-void px-3.5 py-3")}
      style={piece(at, -1.5, 260)}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/images/integrations/arca-logo.png" alt="" className="h-[18px] w-auto shrink-0 brightness-0 invert" />
      <div className="min-w-0 border-l border-white/10 pl-3">
        <p className="text-[12px] font-semibold text-ninja-softWhite">Factura B emitida</p>
        <p className="mt-0.5 font-mono text-[10px] tracking-[0.04em] text-ninja-lavender">CAE 74281930462158</p>
      </div>
    </div>
  );
}

function StockChip({ at }: { at: Box }) {
  return (
    <div
      className={cn(s.piece, "absolute flex items-center gap-3 rounded-lg border border-white/10 bg-ninja-midViolet px-3.5 py-2.5")}
      style={piece(at, 1.5, 380)}
    >
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-warning/15 text-warning">
        <PackageMinus size={16} />
      </span>
      <div className="min-w-0">
        <p className="text-[12px] font-semibold text-ninja-softWhite">Stock bajo</p>
        <p className="mt-0.5 text-[11px] text-ninja-lavender">Yerba 1 kg · quedan 4</p>
      </div>
    </div>
  );
}

function ProductCollage() {
  const { ref, fit } = useStageScale();
  const total = useCountUp(TICKET_TOTAL, 650, 950);
  const visible = fit !== null && fit.scale >= MIN_SCALE;
  return (
    <div ref={ref} aria-hidden className="relative min-h-0 flex-1">
      {visible && (
        <div
          className={cn(s.stage, "absolute left-0 top-1/2")}
          style={{
            width: fit.layout.w,
            height: fit.layout.h,
            "--stage-scale": fit.scale,
            marginTop: `${(-fit.layout.h * fit.scale) / 2}px`,
          } as React.CSSProperties}
        >
          <SalesCard at={fit.layout.sales} />
          {fit.layout.stock ? (
            <>
              <ArcaChip at={fit.layout.arca} />
              <StockChip at={fit.layout.stock} />
              <TicketCard at={fit.layout.ticket} total={total} />
            </>
          ) : (
            <>
              <TicketCard at={fit.layout.ticket} total={total} />
              <ArcaChip at={fit.layout.arca} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function ValuePanel() {
  // Días de prueba según los planes configurados en internal (no hardcodeado).
  const { data: plans } = useSignupPlans();
  const trialDays = signupTrialDays(plans);
  return (
    <aside
      data-theme="ninja-dark"
      className="relative isolate hidden overflow-hidden border-r border-white/10 bg-ninja-deepViolet text-ninja-softWhite lg:sticky lg:top-0 lg:flex lg:h-screen lg:flex-col lg:px-10 lg:py-10 xl:px-14 [@media(max-height:780px)]:lg:py-8"
    >
      {/* Fondo animado de soft.ninja (pedido del dueño). La máscara lo concentra
          detrás del collage y lo apaga bajo el titular y los textos, para que
          conserven el contraste. */}
      <TechBackground
        dotColor="rgba(247,244,255,0.1)"
        className="-z-10 [mask-image:linear-gradient(to_bottom,transparent_42%,#000_58%,#000_78%,transparent_94%)]"
      />
      <Link
        href="/"
        aria-label="Ninja POS, ir al inicio"
        className="w-fit shrink-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-ninja-deepViolet"
      >
        <LogoNinjaPos variant="dark" className="h-8 w-auto xl:h-9" priority />
      </Link>

      <div className="mt-10 shrink-0 [@media(max-height:780px)]:mt-7">
        <h2 className="font-display text-[2.75rem] font-extrabold leading-[1.02] tracking-[-0.035em] xl:text-[3.5rem] 2xl:text-[4rem] [@media(max-height:780px)]:text-[2.5rem]">
          Tu negocio,
          <br />
          <span className="text-ninja-flame">bajo control.</span>
        </h2>
        <p className="mt-4 max-w-md text-base leading-relaxed text-ninja-lavender [@media(max-height:780px)]:mt-3 [@media(max-height:780px)]:text-[15px]">
          Vendé, cobrá, facturá y controlá el stock en un solo lugar, desde la
          compu, la tablet o el celular.
        </p>
        {trialDays > 0 && (
          <p className="mt-5 inline-flex items-center gap-2.5 rounded-lg border border-white/10 bg-white/[0.06] px-3.5 py-2 text-sm font-semibold text-ninja-softWhite [@media(max-height:780px)]:mt-4">
            <CalendarClock size={17} className="text-ninja-flameSoft" aria-hidden />
            {trialCopy(trialDays)}
          </p>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col py-8 [@media(max-height:780px)]:py-6">
        <ProductCollage />
      </div>

      <div className="shrink-0 border-t border-white/10 pt-5 [@media(max-height:820px)]:hidden">
        <p className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-ninja-lavender">
          Cobrá con los medios que ya usás
        </p>
        <ul className="mt-3.5 flex flex-wrap items-center gap-x-6 gap-y-3">
          {PAYMENT_LOGOS.map((logo) => (
            <li key={logo.alt}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={logo.src}
                alt={logo.alt}
                className={cn("w-auto opacity-75", logo.f, logo.h)}
              />
            </li>
          ))}
        </ul>
      </div>

      <p className="mt-5 flex shrink-0 items-center gap-2 text-xs text-ninja-lavender [@media(max-height:820px)]:mt-0">
        <Store size={14} aria-hidden />
        Hecho para kioscos, retail, gastronomía y pymes de Argentina.
      </p>
    </aside>
  );
}
