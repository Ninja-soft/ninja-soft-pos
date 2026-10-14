"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Sparkles } from "lucide-react";
import { TechBackground } from "@/components/brand/TechBackground";
import { useTienditaIntroShowcase } from "@/modules/tiendita/hooks";
import {
  introCountLabel,
  marqueeRows,
  type IntroStore,
} from "@/modules/tiendita/introShowcase";
import { formatInt } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

// Portada de Tiendita (se muestra CADA vez que se entra a la sección).
// Las tiendas y el contador salen de los datos reales (catalog_stores en
// catálogos activos + product_count de los catálogos, ver introShowcase.ts).
// Composición: cuatro cintas de fichas de tiendas que giran como un cilindro
// alrededor del título (las de arriba inclinadas hacia atrás, las de abajo
// hacia adelante), cada una a su velocidad y sentido, con parallax suave al
// mover el mouse. Todo plano: capas, bordes de 1px y la grilla de puntos de
// soft.ninja; sin degradados ni sombras.

// Duración total antes de auto-cerrar (ms) y del fade-out antes de desmontar.
const AUTO_DISMISS_MS = 3800;
const OUT_MS = 520;

// Cintas: inclinación (rotateX), velocidad (s por vuelta), sentido, escala y
// profundidad del parallax (px). Las exteriores son más chicas, tenues y
// lentas: se leen "más lejos".
const ROWS = [
  { tilt: 34, speed: 70, dir: 1, scale: 0.84, depth: 26, opacity: 0.55 },
  { tilt: 16, speed: 52, dir: -1, scale: 1, depth: 14, opacity: 1 },
  { tilt: -16, speed: 58, dir: 1, scale: 1, depth: 14, opacity: 1 },
  { tilt: -34, speed: 76, dir: -1, scale: 0.84, depth: 26, opacity: 0.55 },
] as const;

export function TienditaIntro() {
  const { data } = useTienditaIntroShowcase();
  return <TienditaIntroScene stores={data?.stores ?? []} productCount={data?.productCount ?? 0} />;
}

export function TienditaIntroScene({
  stores,
  productCount,
  autoDismissMs = AUTO_DISMISS_MS,
}: {
  stores: IntroStore[];
  productCount: number;
  /** 0 = no se cierra sola (capturas). */
  autoDismissMs?: number;
}) {
  const [show, setShow] = useState(true);
  const [closing, setClosing] = useState(false);
  const closedRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    setClosing(true);
    window.setTimeout(() => setShow(false), OUT_MS);
  }, []);

  useEffect(() => {
    const dismiss = autoDismissMs > 0 ? window.setTimeout(close, autoDismissMs) : 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter" || e.key === " ") close();
    };
    window.addEventListener("keydown", onKey);
    // El foco entra al diálogo (sin anillo): el próximo Tab cae en "Entrar"
    // con foco visible, y Enter/Esc/Espacio ya entran desde acá.
    rootRef.current?.focus({ preventScroll: true });
    return () => {
      if (dismiss) window.clearTimeout(dismiss);
      window.removeEventListener("keydown", onKey);
    };
  }, [close, autoDismissMs]);

  // Parallax: el puntero (sólo mouse/lápiz fino) mueve variables CSS --mx/--my
  // en [-1, 1]; cada capa se desplaza según su profundidad. Un frame por vez.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (!window.matchMedia("(pointer: fine)").matches) return;
    let raf = 0;
    let nx = 0;
    let ny = 0;
    const onMove = (e: PointerEvent) => {
      nx = (e.clientX / window.innerWidth) * 2 - 1;
      ny = (e.clientY / window.innerHeight) * 2 - 1;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        el.style.setProperty("--mx", nx.toFixed(3));
        el.style.setProperty("--my", ny.toFixed(3));
      });
    };
    window.addEventListener("pointermove", onMove);
    return () => {
      window.removeEventListener("pointermove", onMove);
      cancelAnimationFrame(raf);
    };
  }, []);

  const rows = useMemo(() => marqueeRows(stores, ROWS.length, 12), [stores]);
  const label = introCountLabel(productCount, stores.length);
  const counted = useCountUp(label?.value ?? 0);

  if (!show) return null;

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label="Bienvenida a Tiendita"
      tabIndex={-1}
      onClick={close}
      className={cn(
        "ti-root fixed inset-0 z-[80] overflow-hidden bg-background text-foreground outline-none",
        closing ? "ti-out" : "ti-in",
      )}
    >
      <TechBackground dotColor="rgba(128,120,160,0.16)" className="ti-dots" />

      <div className="ti-stage relative flex h-full flex-col justify-center gap-[5vh] py-[4vh] sm:justify-between sm:gap-0 sm:py-[5vh]">
        {/* Cintas de arriba */}
        <div className="flex flex-col gap-3 sm:gap-4">
          {rows.slice(0, 2).map((row, i) => (
            <MarqueeRow key={`top-${i}`} items={row} cfg={ROWS[i]!} index={i} />
          ))}
        </div>

        {/* Centro */}
        <div className="ti-center relative z-10 mx-auto w-full max-w-3xl px-6 text-center">
          <div className="ti-up mx-auto inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground" style={{ ["--d" as string]: "80ms" }}>
            <span className="grid h-5 w-5 place-items-center rounded-full bg-[var(--pos-solid)] text-white">
              <Sparkles size={12} />
            </span>
            NinjaSoft · Catálogos
          </div>
          <h1
            className="ti-up mt-4 font-display text-[4.25rem] font-black leading-[0.9] tracking-[-0.04em] text-foreground sm:text-8xl lg:text-[9rem]"
            style={{ ["--d" as string]: "160ms" }}
          >
            Tiendita<span className="text-ninja-flame">.</span>
          </h1>
          <p
            className="ti-up mx-auto mt-4 max-w-md text-balance text-[15px] text-muted-foreground sm:text-lg"
            style={{ ["--d" as string]: "240ms" }}
          >
            Catálogos de las marcas más grandes, listos para sumar a tu tienda.
          </p>
          <p
            className="ti-up mt-4 min-h-[1.75rem] text-base text-foreground sm:text-xl"
            style={{ ["--d" as string]: "320ms" }}
          >
            {label && (
              <>
                {label.prefix && <span className="text-muted-foreground">{label.prefix} </span>}
                <span className="font-price font-bold tabular-nums">{formatInt(counted)}</span>{" "}
                <span className="text-muted-foreground">{label.suffix}</span>
                <span className="sr-only">: {stores.map((s) => s.name).join(", ")}</span>
              </>
            )}
          </p>
          <div className="ti-up mt-7 flex flex-col items-center gap-3" style={{ ["--d" as string]: "400ms" }}>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                close();
              }}
              className="group inline-flex h-12 items-center gap-2 rounded-lg bg-[var(--pos-solid)] px-8 text-[15px] font-semibold text-white transition hover:bg-[var(--pos-solid-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ninja-flame focus-visible:ring-offset-2 focus-visible:ring-offset-background active:scale-[0.98]"
            >
              Entrar
              <ArrowRight size={18} className="transition-transform group-hover:translate-x-0.5" />
            </button>
            <p className="text-xs text-muted-foreground">Tocá en cualquier lado para entrar</p>
          </div>
        </div>

        {/* Cintas de abajo */}
        <div className="flex flex-col gap-3 sm:gap-4">
          {rows.slice(2, 4).map((row, i) => (
            <MarqueeRow key={`bottom-${i}`} items={row} cfg={ROWS[i + 2]!} index={i + 2} />
          ))}
        </div>
      </div>

      <style>{`
        .ti-root { --mx: 0; --my: 0; }
        .ti-in { animation: tiFadeIn 320ms ease-out both; }
        .ti-out { animation: tiFadeOut ${OUT_MS}ms cubic-bezier(0.4, 0, 1, 1) forwards; }
        @keyframes tiFadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes tiFadeOut { from { opacity: 1; } to { opacity: 0; transform: scale(1.04); } }

        .ti-dots { opacity: 0.9; }

        /* Centro: contra-parallax leve (se mueve al revés que las cintas). */
        .ti-center {
          transform: translate3d(calc(var(--mx) * -8px), calc(var(--my) * -6px), 0);
          transition: transform 500ms cubic-bezier(0.22, 1, 0.36, 1);
        }
        .ti-up { animation: tiUp 720ms cubic-bezier(0.22, 1, 0.36, 1) var(--d, 0ms) both; }
        @keyframes tiUp {
          from { opacity: 0; transform: translateY(22px); }
          to   { opacity: 1; transform: none; }
        }

        /* Cinta: la capa externa lleva la inclinación 3D + parallax; la pista
           interna corre en loop (contenido duplicado, -50%). */
        .ti-row {
          transform:
            perspective(900px)
            translate3d(calc(var(--mx) * var(--depth)), calc(var(--my) * var(--depth) * 0.6), 0)
            rotateX(var(--tilt)) scale(var(--scale));
          transform-origin: 50% var(--origin);
          transition: transform 600ms cubic-bezier(0.22, 1, 0.36, 1);
        }
        .ti-row-inner { animation: tiRowIn 900ms cubic-bezier(0.22, 1, 0.36, 1) var(--d, 0ms) both; }
        @keyframes tiRowIn {
          from { opacity: 0; transform: translateX(calc(var(--dir) * -120px)); }
          to   { opacity: var(--row-opacity); transform: none; }
        }
        .ti-track { animation: tiMarquee var(--speed) linear infinite; }
        .ti-track[data-dir=rev] { animation-direction: reverse; }
        @keyframes tiMarquee {
          from { transform: translate3d(0, 0, 0); }
          to   { transform: translate3d(-50%, 0, 0); }
        }

        /* Fichas. El ícono va sobre una placa del tema; los que se pierden en
           un tema llevan una placa de contraste SOLO en ese tema. Selectores
           sin comillas: el style se hidrata y las comillas se escapan distinto
           en el server. Sin data-theme rige el oscuro. */
        .ti-plate { background: var(--muted); }
        [data-theme=ninja-light] .ti-plate[data-ink=light],
        [data-theme=ninja-sand] .ti-plate[data-ink=light] { background: #1b1528; }
        :root:not([data-theme=ninja-light]):not([data-theme=ninja-sand]) .ti-plate[data-ink=dark] {
          background: #f4f2fb;
        }

        @media (prefers-reduced-motion: reduce) {
          .ti-in, .ti-out, .ti-up, .ti-row-inner, .ti-track { animation: none !important; }
          .ti-row-inner { opacity: var(--row-opacity); }
          .ti-out { opacity: 0; transition: opacity ${OUT_MS}ms ease; }
          .ti-row, .ti-center { transition: none; }
        }
      `}</style>
    </div>
  );
}

function MarqueeRow({
  items,
  cfg,
  index,
}: {
  items: IntroStore[];
  cfg: (typeof ROWS)[number];
  index: number;
}) {
  return (
    <div
      aria-hidden
      className="ti-row pointer-events-none"
      style={{
        ["--tilt" as string]: `${cfg.tilt}deg`,
        ["--scale" as string]: cfg.scale,
        ["--depth" as string]: `${cfg.depth}px`,
        ["--origin" as string]: cfg.tilt > 0 ? "100%" : "0%",
      }}
    >
      <div
        className="ti-row-inner"
        style={{
          ["--d" as string]: `${120 + index * 110}ms`,
          ["--dir" as string]: cfg.dir,
          ["--row-opacity" as string]: cfg.opacity,
          opacity: cfg.opacity,
        }}
      >
        <div
          className="ti-track flex w-max"
          data-dir={cfg.dir < 0 ? "rev" : "fwd"}
          style={{ ["--speed" as string]: `${cfg.speed}s` }}
        >
          {/* Dos copias idénticas: al llegar a -50% el loop no se nota. */}
          {[0, 1].map((copy) => (
            <div key={copy} className="flex shrink-0 gap-3 pr-3 sm:gap-4 sm:pr-4">
              {items.map((s, i) => (
                <StoreChip key={`${copy}-${s.key}-${i}`} store={s} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Ficha de tienda propia de la portada (no reutiliza StoreLogo a propósito:
// necesita tamaño grande y la placa de contraste por tema).
function StoreChip({ store }: { store: IntroStore }) {
  // Cadena de fallback: ícono oficial → logo_url → iniciales.
  const sources = [store.icon, store.logoUrl].filter((x): x is string => Boolean(x));
  const [failed, setFailed] = useState(0);
  const src = sources[failed] ?? null;
  return (
    <div className="flex h-14 shrink-0 items-center gap-2.5 rounded-lg border border-border bg-card pl-2 pr-4 sm:h-[4.5rem] sm:gap-3 sm:pl-2.5 sm:pr-5">
      <span
        className="ti-plate grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-md sm:h-[3.25rem] sm:w-[3.25rem]"
        data-ink={store.ink ?? undefined}
      >
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt=""
            draggable={false}
            className="h-[82%] w-[82%] object-contain"
            onError={() => setFailed((f) => f + 1)}
          />
        ) : (
          <span className="text-xs font-bold text-foreground">{store.initials}</span>
        )}
      </span>
      <span className="whitespace-nowrap text-sm font-semibold text-foreground sm:text-base">
        {store.name}
      </span>
    </div>
  );
}

// Cuenta de 0 al valor (easeOutCubic, ~1,2 s). Con "reducir movimiento" o sin
// requestAnimationFrame muestra el valor final directo.
function useCountUp(target: number, durationMs = 1200): number {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (target <= 0) {
      setValue(0);
      return;
    }
    const reduce =
      typeof window === "undefined" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setValue(target);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      // El timestamp del frame puede ser anterior a "start": se acota a [0, 1].
      const t = Math.max(0, Math.min(1, (now - start) / durationMs));
      const eased = 1 - (1 - t) ** 3;
      setValue(Math.round(target * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);
  return value;
}
