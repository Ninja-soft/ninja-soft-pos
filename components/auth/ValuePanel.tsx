"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { CalendarClock, Check, Store } from "lucide-react";
import { LogoNinjaPos } from "@/components/brand/Logo";
import { TechBackground } from "@/components/brand/TechBackground";
import { signupTrialDays, trialCopy, useSignupPlans } from "@/modules/saas/signupPlans";
import { cn } from "@/lib/utils/cn";
import s from "./ValuePanel.module.css";

// Panel de marca de las pantallas de auth (sólo desktop, columna izquierda del
// layout). Superficie plana noche violeta, siempre oscura (data-theme fijo) para
// que el logo oficial con "Ninja" en blanco se lea igual en tema claro.
// La pieza central es un collage del producto armado en HTML/CSS: el ticket de
// una venta de retail cobrada (con fotos de producto y variantes), las ventas
// del día, la factura de ARCA y un aviso de stock bajo. Capas planas y bordes de
// 1px: sin degradados, sin sombras, sin glow. Es decorativo (aria-hidden); el
// mensaje real vive en el titular y el párrafo.
// Fotos: public/images/demo-products (Unsplash, ver LICENSE.txt ahí).

const MAX_SCALE = 1.25;
// Por debajo de esta escala el collage ya no se lee: se oculta.
const MIN_SCALE = 0.62;
// Cambios de escala menores a esto (relativos) no se aplican: evita saltos por
// reacomodos de un par de px una vez que el collage ya está en pantalla.
const SCALE_EPSILON = 0.02;

// Dos composiciones del escenario (px de diseño): "wide" con el ticket al
// frente, las ventas detrás y una columna derecha con ARCA y stock alineada al
// borde del gráfico; "narrow" (panel angosto, p. ej. signup a 1024) con ventas
// y ticket, más apilados.
type Box = { left: number; top: number; width: number };
interface StageLayout {
  w: number;
  h: number;
  sales: Box;
  ticket: Box;
  arca: Box | null;
  stock: Box | null;
}
const WIDE: StageLayout = {
  w: 560,
  h: 352,
  sales: { left: 256, top: 0, width: 304 },
  ticket: { left: 0, top: 22, width: 270 },
  arca: { left: 290, top: 210, width: 270 },
  stock: { left: 290, top: 282, width: 270 },
};
const NARROW: StageLayout = {
  w: 404,
  h: 444,
  sales: { left: 100, top: 0, width: 304 },
  ticket: { left: 0, top: 140, width: 270 },
  arca: null,
  stock: null,
};
// El "wide" se usa mientras no haya que achicarlo por debajo de esto.
const WIDE_MIN_SCALE = 0.8;

const TICKET_ITEMS = [
  { img: "/images/demo-products/jean.webp", name: "Jean mom tiro alto", variant: "Talle 38 · Celeste", qty: 1, unit: 45900 },
  { img: "/images/demo-products/tshirt.webp", name: "Remera de algodón", variant: "Talle L · Blanco", qty: 2, unit: 18500 },
  { img: "/images/demo-products/headphones.webp", name: "Auriculares", variant: "Bluetooth · Negro", qty: 1, unit: 54900 },
];
const TICKET_TOTAL = TICKET_ITEMS.reduce((acc, i) => acc + i.qty * i.unit, 0);
const TICKET_UNITS = TICKET_ITEMS.reduce((acc, i) => acc + i.qty, 0);

// Ventas por hora (relativas). La última es la hora en curso.
const BARS = [28, 44, 36, 58, 50, 72, 64, 86, 70, 94];
const BAR_HOURS = ["10", "", "12", "", "14", "", "16", "", "18", ""];

const PAYMENT_LOGOS = [
  { src: "/images/payments/mercado-pago-wordmark-on-dark.webp", alt: "Mercado Pago", w: 512, hpx: 152, h: "h-6", f: "grayscale brightness-[1.15]" },
  { src: "/images/payments/modo-wordmark.webp", alt: "MODO", w: 512, hpx: 140, h: "h-4", f: "brightness-0 invert" },
  { src: "/images/payments/payway-wordmark-on-dark.webp", alt: "Payway", w: 512, hpx: 98, h: "h-[1.1rem]", f: "brightness-0 invert" },
  { src: "/images/payments/getnet-wordmark-on-dark.webp", alt: "Getnet", w: 512, hpx: 130, h: "h-[1.15rem]", f: "brightness-0 invert" },
  { src: "/images/payments/nave-wordmark-on-dark.webp", alt: "Nave", w: 512, hpx: 213, h: "h-6", f: "brightness-0 invert" },
];

const num = (n: number) => Math.round(n).toLocaleString("es-AR");
const money = (n: number) => `$ ${num(n)}`;

function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Total del ticket contando hasta el valor final (instantáneo con reduced motion). */
function useCountUp(target: number, delay: number, duration: number, enabled: boolean) {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (!enabled) return;
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
  }, [target, delay, duration, enabled]);
  return value;
}

/**
 * Escala del escenario para que entre en el espacio libre sin cortarse.
 * Estable desde el primer cuadro visible: no mide hasta que cargan las fuentes
 * (el titular y el párrafo cambian de alto al pasar de la fuente de reemplazo a
 * la real) y después ignora reacomodos menores a SCALE_EPSILON. Las piezas no
 * se montan (ni arrancan su animación) hasta tener esa escala final.
 */
function useStageScale() {
  const ref = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<{ layout: StageLayout; scale: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let alive = true;
    let ro: ResizeObserver | null = null;
    const measure = () => {
      const { width, height } = el.getBoundingClientRect();
      const scaleFor = (l: StageLayout) => Math.min(MAX_SCALE, width / l.w, height / l.h);
      const wide = scaleFor(WIDE);
      const next = wide >= WIDE_MIN_SCALE ? { layout: WIDE, scale: wide } : { layout: NARROW, scale: scaleFor(NARROW) };
      setFit((prev) =>
        prev && prev.layout === next.layout && Math.abs(next.scale - prev.scale) / prev.scale < SCALE_EPSILON
          ? prev
          : next,
      );
    };
    const fontsReady = typeof document !== "undefined" && document.fonts ? document.fonts.ready : Promise.resolve();
    fontsReady.then(() => {
      if (!alive) return;
      measure();
      ro = new ResizeObserver(measure);
      ro.observe(el);
    });
    return () => {
      alive = false;
      ro?.disconnect();
    };
  }, []);
  return { ref, fit };
}

type PieceStyle = React.CSSProperties & { "--rot"?: string; "--delay"?: string };

function piece(at: Box, rot: number, delay: number): PieceStyle {
  return { ...at, "--rot": `${rot}deg`, "--delay": `${delay}ms` };
}

// compact: versión baja para la composición angosta (gráfico más corto y sin
// eje de horas, que quedaría detrás del ticket).
function SalesCard({ at, compact }: { at: Box; compact: boolean }) {
  return (
    <div
      className={cn(s.piece, "absolute rounded-lg border border-white/10 bg-ninja-midViolet px-5 pb-3.5 pt-4")}
      style={piece(at, 0, 120)}
    >
      <span className="text-[12px] font-medium text-ninja-lavender">Ventas de hoy</span>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="font-price text-[26px] font-bold tabular-nums tracking-tight text-ninja-softWhite">
          $ 1.284.600
        </span>
        <span className="text-[12px] font-semibold text-success">+18%</span>
      </div>
      <div className={cn("mt-3 flex items-end", compact ? "h-[52px]" : "h-[76px]", "gap-[7px] border-b border-white/10 pb-px")}>
        {BARS.map((h, i) => (
          <div key={i} className="flex h-full flex-1 flex-col justify-end">
            <div
              className={cn(
                s.bar,
                "w-full rounded-t-[3px]",
                i === BARS.length - 1 ? "bg-ninja-flame" : "bg-white/[0.16]",
              )}
              style={{ height: `${h}%`, "--delay": `${450 + i * 55}ms` } as PieceStyle}
            />
          </div>
        ))}
      </div>
      <div className={cn("mt-1.5 flex gap-[7px] font-mono text-[10px] leading-none text-ninja-lavender", compact && "hidden")}>
        {BAR_HOURS.map((label, i) => (
          <span key={i} className={cn("flex-1 text-center", i === BARS.length - 1 && "text-ninja-flameSoft")}>
            {i === BARS.length - 1 ? "ahora" : label}
          </span>
        ))}
      </div>
    </div>
  );
}

function Thumb({ src, size }: { src: string; size: number }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      decoding="async"
      className="shrink-0 rounded-md border border-ninja-deepViolet/10 bg-white object-cover"
      style={{ width: size, height: size }}
    />
  );
}

function TicketCard({ at, total }: { at: Box; total: number }) {
  return (
    <div
      className={cn(s.piece, "absolute rounded-lg bg-ninja-softWhite px-4 pb-4 pt-3.5 text-ninja-deepViolet")}
      style={piece(at, -2, 0)}
    >
      <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.1em] text-ninja-midViolet">
        <span>Venta #0482</span>
        <span>Caja 1 · 18:42</span>
      </div>
      <div className="mt-2.5 border-t border-ninja-deepViolet/10" />
      <ul className="mt-3 space-y-2.5">
        {TICKET_ITEMS.map((item) => (
          <li key={item.name} className="flex items-center gap-2.5">
            <Thumb src={item.img} size={36} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12px] font-semibold leading-tight">{item.name}</p>
              <p className="mt-0.5 truncate text-[10.5px] leading-tight text-ninja-midViolet/80">{item.variant}</p>
            </div>
            <div className="shrink-0 text-right font-mono tabular-nums leading-tight">
              <p className="text-[12px] font-medium">{money(item.qty * item.unit)}</p>
              <p className="mt-0.5 text-[10px] text-ninja-midViolet/70">
                {item.qty} x {num(item.unit)}
              </p>
            </div>
          </li>
        ))}
      </ul>
      <div className="mb-2.5 mt-3.5 border-t border-dashed border-ninja-deepViolet/25" />
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ninja-midViolet">
          Total · {TICKET_UNITS} u.
        </span>
        <span className="font-mono text-[23px] font-bold tabular-nums tracking-[-0.02em]">{money(total)}</span>
      </div>
      <div className="mt-3 flex w-fit items-center gap-2 rounded-md border border-ninja-deepViolet/10 bg-white px-2.5 py-1.5">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/images/payments/mercado-pago-icon.webp" alt="" width={20} height={20} className="h-5 w-5" />
        <span className="text-[12px] font-medium">QR Mercado Pago</span>
      </div>
      <span
        className={cn(s.stamp, "absolute -right-7 bottom-[14px] inline-flex items-center gap-1 rounded-md border-2 border-[#0E8A5F] bg-ninja-softWhite px-2 py-0.5 text-[13px] font-extrabold uppercase tracking-[0.08em] text-[#0E8A5F]")}
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
      className={cn(s.piece, "absolute flex h-[60px] items-center gap-3 rounded-lg border border-white/10 bg-ninja-void px-3.5")}
      style={piece(at, 0, 260)}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/images/integrations/arca-logo.png" alt="" className="h-[16px] w-auto shrink-0 brightness-0 invert" />
      <div className="min-w-0 flex-1 border-l border-white/10 pl-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[12px] font-semibold text-ninja-softWhite">Factura B emitida</p>
          <Check size={14} strokeWidth={2.5} className="shrink-0 text-success" />
        </div>
        <p className="mt-0.5 font-mono text-[10px] tracking-[0.04em] text-ninja-lavender">CAE 74281930462158</p>
      </div>
    </div>
  );
}

function StockChip({ at }: { at: Box }) {
  return (
    <div
      className={cn(s.piece, "absolute flex h-[60px] items-center gap-3 rounded-lg border border-white/10 bg-ninja-midViolet px-3")}
      style={piece(at, 0, 380)}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/images/demo-products/jacket.webp"
        alt=""
        width={38}
        height={38}
        decoding="async"
        className="h-[38px] w-[38px] shrink-0 rounded-md border border-white/10 object-cover"
      />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-[12px] font-semibold text-ninja-softWhite">
          <span className="h-1.5 w-1.5 rounded-full bg-warning" />
          Stock bajo
        </p>
        <p className="mt-0.5 truncate text-[11px] text-ninja-lavender">Campera talle M</p>
      </div>
      <span className="shrink-0 rounded-md border border-warning/30 px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-warning">
        Quedan 2
      </span>
    </div>
  );
}

function ProductCollage() {
  const { ref, fit } = useStageScale();
  const visible = fit !== null && fit.scale >= MIN_SCALE;
  const total = useCountUp(TICKET_TOTAL, 650, 950, visible);
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
          <SalesCard at={fit.layout.sales} compact={fit.layout === NARROW} />
          {fit.layout.arca && <ArcaChip at={fit.layout.arca} />}
          {fit.layout.stock && <StockChip at={fit.layout.stock} />}
          <TicketCard at={fit.layout.ticket} total={total} />
        </div>
      )}
    </div>
  );
}

export function ValuePanel() {
  // Días de prueba según los planes configurados en internal (no hardcodeado).
  // Mientras llegan los planes se reserva el alto de la pastilla (invisible),
  // así el espacio del collage no cambia cuando aparece.
  const { data: plans, isPending } = useSignupPlans();
  const trialDays = signupTrialDays(plans);
  const showTrial = trialDays > 0 || isPending;
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
        {showTrial && (
          <p
            aria-hidden={trialDays > 0 ? undefined : true}
            className={cn(
              "mt-5 inline-flex h-10 items-center gap-2.5 whitespace-nowrap rounded-lg border border-white/10 bg-white/[0.06] px-3.5 text-sm font-semibold text-ninja-softWhite [@media(max-height:780px)]:mt-4",
              trialDays > 0 ? s.fadeIn : "invisible",
            )}
          >
            <CalendarClock size={17} className="text-ninja-flameSoft" aria-hidden />
            {trialCopy(trialDays > 0 ? trialDays : 14)}
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
                width={logo.w}
                height={logo.hpx}
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
