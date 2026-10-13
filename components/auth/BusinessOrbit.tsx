"use client";

import { useEffect, useRef, useState } from "react";
import { clearRememberedBusiness, type RememberedBusiness } from "@/lib/auth/rememberedBusiness";
import { cn } from "@/lib/utils/cn";
import s from "./ValuePanel.module.css";

// Logo del negocio recordado (sólo /login) en una composición animada adaptada
// de soft.ninja (ninja-soft-web/components/showcase/SceneIntegrar.tsx: el hub
// central que late, los anillos que se expanden y los trazos que salen
// disparados del centro). Acá: disco claro con el logo (cualquier logo se lee
// sobre blanco, como en el ticket), anillos finos concéntricos, dos puntos que
// orbitan y trazos de colores de marca que irradian del centro hacia afuera.
// Todo en SVG con viewBox fijo, escalado por CSS (container queries): no hay
// medición por JS ni saltos de tamaño; el espacio está reservado desde el
// primer cuadro. Mientras carga la imagen se ve el skeleton con la misma
// silueta. Con prefers-reduced-motion queda quieto.

// Trazos: ángulo (grados), radio inicial, largo (en % del rayo), color,
// duración y demora (ms). Ángulos irregulares a propósito, como la referencia.
const FLAME = "#FF6A1A";
const VIOLET = "#B14DFF";
const LAVENDER = "#B8AEDC";
const RAYS: { a: number; from: number; len: number; color: string; dur: number; delay: number }[] = [
  { a: -78, from: 56, len: 44, color: FLAME, dur: 3600, delay: 0 },
  { a: -52, from: 60, len: 36, color: LAVENDER, dur: 4200, delay: 900 },
  { a: -24, from: 58, len: 40, color: VIOLET, dur: 3900, delay: 300 },
  { a: 4, from: 62, len: 34, color: FLAME, dur: 4500, delay: 1500 },
  { a: 28, from: 56, len: 42, color: LAVENDER, dur: 3700, delay: 600 },
  { a: 57, from: 60, len: 38, color: VIOLET, dur: 4100, delay: 2100 },
  { a: 84, from: 58, len: 36, color: FLAME, dur: 3800, delay: 1200 },
  { a: 112, from: 62, len: 40, color: LAVENDER, dur: 4400, delay: 200 },
  { a: 138, from: 56, len: 44, color: VIOLET, dur: 3600, delay: 1800 },
  { a: 163, from: 60, len: 34, color: FLAME, dur: 4300, delay: 700 },
  { a: 191, from: 58, len: 40, color: LAVENDER, dur: 3900, delay: 2400 },
  { a: 218, from: 62, len: 36, color: VIOLET, dur: 4000, delay: 400 },
  { a: 246, from: 56, len: 42, color: FLAME, dur: 4600, delay: 1600 },
  { a: 272, from: 60, len: 38, color: LAVENDER, dur: 3700, delay: 1000 },
];
// Los trazos corren entre estos radios (viewBox -100..100).
const RAY_IN = 54;
const RAY_OUT = 98;

const round = (v: number) => Math.round(v * 100) / 100;

function rayLine(a: number, from: number) {
  const rad = (a * Math.PI) / 180;
  return {
    x1: round(Math.cos(rad) * from),
    y1: round(Math.sin(rad) * from),
    x2: round(Math.cos(rad) * RAY_OUT),
    y2: round(Math.sin(rad) * RAY_OUT),
  };
}

type Style = React.CSSProperties & Record<`--${string}`, string>;

/** Alto reservado para el nombre y el link debajo de la composición (px). */
const CAPTION_H = 92;

// Cuadrado de la composición + franja del nombre, centrados en el espacio libre.
const FRAME_STYLE: React.CSSProperties = {
  width: `min(100cqw, calc(100cqh - ${CAPTION_H}px), 440px)`,
  height: `calc(min(100cqw, calc(100cqh - ${CAPTION_H}px), 440px) + ${CAPTION_H}px)`,
};

function OrbitDiscSkeleton() {
  return (
    <>
      <div className="absolute inset-[24%] rounded-full border border-white/[0.08]" />
      <div className={cn(s.skel, "absolute inset-[31%] rounded-full")} />
    </>
  );
}

/**
 * Skeleton completo (disco + anillo + nombre + link) para cuando todavía no se
 * sabe qué negocio mostrar: lo usa el panel antes de hidratar (ver ValuePanel).
 */
export function OrbitSkeleton() {
  return (
    <div aria-hidden className="relative min-h-0 flex-1 [container-type:size]">
      <div className="absolute inset-0 m-auto flex flex-col items-center" style={FRAME_STYLE}>
        <div className="relative aspect-square w-full">
          <OrbitDiscSkeleton />
        </div>
        <div className="flex w-full flex-col items-center pt-4" style={{ height: CAPTION_H }}>
          <span className={cn(s.skel, "mt-1 block h-6 w-44 rounded-md")} />
          <span className={cn(s.skel, "mt-4 block h-3.5 w-56 rounded-sm")} />
        </div>
      </div>
    </div>
  );
}

export function BusinessOrbit({
  business,
  onError,
}: {
  business: RememberedBusiness;
  /** La imagen no cargó: el panel vuelve al collage normal. */
  onError: () => void;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [loaded, setLoaded] = useState(false);

  // Imagen ya en caché: puede estar completa antes de que React enganche onLoad.
  useEffect(() => {
    const img = imgRef.current;
    if (img?.complete) {
      if (img.naturalWidth > 0) setLoaded(true);
      else onError();
    }
  }, [onError]);

  return (
    <div className="relative min-h-0 flex-1 [container-type:size]">
      <div className="absolute inset-0 m-auto flex flex-col items-center" style={FRAME_STYLE}>
        <div className="relative aspect-square w-full">
          {/* Skeleton: misma silueta (círculo + anillo) hasta que carga el logo. */}
          <div aria-hidden className={cn("absolute inset-0", loaded && s.skelOut)}>
            <OrbitDiscSkeleton />
          </div>

          <div className={cn("absolute inset-0", loaded ? s.orbitIn : "opacity-0")}>
            <svg
              aria-hidden
              viewBox="-100 -100 200 200"
              className="absolute inset-0 h-full w-full overflow-visible"
              fill="none"
            >
              {/* Anillos finos concéntricos. */}
              <circle r="48" stroke="rgba(247,244,255,0.16)" strokeWidth="0.5" />
              <circle
                r="66"
                stroke="rgba(247,244,255,0.1)"
                strokeWidth="0.5"
                strokeDasharray="1.5 3.5"
                className={s.spinSlow}
              />
              <circle r="92" stroke="rgba(247,244,255,0.07)" strokeWidth="0.5" />

              {/* Ondas que salen del disco (como el hub de soft.ninja). */}
              <circle r="38" stroke={FLAME} strokeOpacity="0.45" strokeWidth="0.6" className={s.ping} />
              <circle
                r="38"
                stroke={VIOLET}
                strokeOpacity="0.4"
                strokeWidth="0.6"
                className={s.ping}
                style={{ animationDelay: "1600ms" }}
              />

              {/* Trazos que irradian: cada uno es un segmento que viaja hacia afuera. */}
              <g className={s.raysTurn}>
                {RAYS.map((r, i) => (
                  <line
                    key={i}
                    {...rayLine(r.a, r.from)}
                    pathLength={100}
                    stroke={r.color}
                    strokeWidth="1.75"
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                    className={s.ray}
                    style={
                      {
                        "--len": `${r.len}`,
                        animationDuration: `${r.dur}ms`,
                        animationDelay: `${r.delay}ms`,
                      } as Style
                    }
                  />
                ))}
              </g>

              {/* Dos puntos orbitando el anillo punteado. */}
              <g className={s.orbitA}>
                <circle cx="66" cy="0" r="1.8" fill={FLAME} />
              </g>
              <g className={s.orbitB}>
                <circle cx="-48" cy="0" r="1.4" fill={LAVENDER} />
              </g>
            </svg>

            {/* Disco con el logo: claro para que cualquier logo se lea. */}
            <div className={cn(s.hub, "absolute inset-[31%] flex items-center justify-center rounded-full border border-white/20 bg-ninja-softWhite")}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                ref={imgRef}
                src={business.logoUrl}
                alt={`Logo de ${business.name}`}
                decoding="async"
                referrerPolicy="no-referrer"
                onLoad={() => setLoaded(true)}
                onError={onError}
                className="h-[64%] w-[64%] object-contain"
              />
            </div>
          </div>
        </div>

        <div className="flex w-full flex-col items-center pt-4 text-center" style={{ height: CAPTION_H }}>
          {loaded ? (
            <p className={cn(s.fadeIn, "line-clamp-1 max-w-full font-display text-2xl font-bold tracking-[-0.02em] text-ninja-softWhite")}>
              {business.name}
            </p>
          ) : (
            <span aria-hidden className={cn(s.skel, "mt-1 block h-6 w-44 rounded-md")} />
          )}
          <button
            type="button"
            onClick={() => clearRememberedBusiness()}
            className="mt-3 rounded-sm text-sm text-ninja-lavender underline-offset-4 outline-none transition hover:text-ninja-softWhite hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-ninja-deepViolet"
          >
            ¿No es tu negocio? Usar otra cuenta
          </button>
        </div>
      </div>
    </div>
  );
}
