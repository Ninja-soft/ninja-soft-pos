"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils/cn";

// Fondo animado "tecno", copiado de soft.ninja (ninja-soft-web/components/
// TechBackground.tsx) por pedido del dueño, en canvas 2D (sin librerías).
// Adaptado al POS: el color de la grilla base y la máscara llegan por props
// para usarlo sobre superficies oscuras (panel de marca de auth).
// - Grilla de puntos que se revela de arriba hacia abajo al cargar.
// - Cada pocos segundos nace una onda arriba al centro y se expande hacia abajo:
//   los puntos que toca se encienden (fuego a la izquierda, violeta a la derecha).
// - Destellos: puntos al azar que se encienden y se apagan suave ("respira").
// Rendimiento: la grilla base se pinta UNA vez en un canvas aparte y se copia;
// por cuadro sólo se dibujan los puntos dentro de la banda de la onda y los
// destellos. Se pausa fuera de pantalla / pestaña oculta. Con "reducir
// movimiento" queda la grilla quieta.

const GAP = 40;
const DOT = 3; // radio de los puntos
const WAVE_EVERY = 6500;
const WAVE_SPEED = 0.42; // px por ms
const BAND = 80; // ancho de la onda
const SPARK_MS = 2200; // vida de un destello
const FLAME = [255, 106, 26];
const VIOLET = [109, 74, 255]; // ninja.brightViolet

type Spark = { c: number; r: number; born: number };

export function TechBackground({
  dotColor = "rgba(17,12,34,0.09)",
  className,
}: {
  /** Color de la grilla base (en oscuro, un blanco muy tenue). */
  dotColor?: string;
  /** Clases extra del canvas (p. ej. la máscara que lo aleja del texto). */
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const base = document.createElement("canvas");
    const bctx = base.getContext("2d")!;
    let w = 0;
    let h = 0;
    let dpr = 1;
    let cols = 0;
    let rows = 0;
    let raf = 0;
    let running = false;
    let start = performance.now();
    let sparks: Spark[] = [];
    // paleta precalculada por columna (evita armar strings de color por punto)
    let colTint: string[] = [];

    const tint = (x: number) => {
      const t = Math.min(1, Math.max(0, x / w));
      return FLAME.map((v, i) => Math.round(v + ((VIOLET[i] ?? v) - v) * t));
    };

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      w = r.width;
      h = r.height;
      for (const c of [canvas, base]) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.ceil(w / GAP) + 1;
      rows = Math.ceil(h / GAP) + 1;
      colTint = Array.from({ length: cols }, (_, c) => tint(c * GAP + GAP / 2).join(","));
      // grilla base, una sola vez
      bctx.clearRect(0, 0, w, h);
      bctx.fillStyle = dotColor;
      bctx.beginPath();
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) {
          const x = c * GAP + GAP / 2;
          const y = r * GAP + GAP / 2;
          bctx.moveTo(x + DOT, y);
          bctx.arc(x, y, DOT, 0, Math.PI * 2);
        }
      bctx.fill();
    };

    const draw = (now: number) => {
      const t = now - start;
      // canvas sin tamaño (oculto o aún sin layout): nada que dibujar
      if (!w || !h || !base.width || !base.height) return;
      ctx.clearRect(0, 0, w, h);

      // Revelado: la grilla baja desde arriba en 1.6 s (recorte, sin redibujar puntos)
      const reveal = reduce ? h : Math.min(h, (t / 1600) * (h + 200));
      if (reveal > 0) ctx.drawImage(base, 0, 0, base.width, (reveal / h) * base.height, 0, 0, w, reveal);
      if (reduce) return;

      // Onda: sólo los puntos de la banda alrededor del radio actual
      const radius = (t % WAVE_EVERY) * WAVE_SPEED;
      const fade = Math.max(0, 1 - radius / (h * 1.25));
      if (fade > 0 && radius > 0) {
        const cx = w / 2;
        const rMin = Math.max(0, Math.floor((radius - BAND) / GAP));
        const rMax = Math.min(rows - 1, Math.ceil((radius + BAND) / GAP));
        for (let r = rMin; r <= rMax; r++) {
          const y = r * GAP + GAP / 2;
          if (y > reveal) break;
          for (let c = 0; c < cols; c++) {
            const x = c * GAP + GAP / 2;
            const d = Math.abs(Math.hypot(x - cx, y) - radius);
            if (d > BAND) continue;
            const glow = (1 - d / BAND) * fade;
            ctx.fillStyle = `rgba(${colTint[c]},${(glow * 0.55).toFixed(3)})`;
            ctx.beginPath();
            ctx.arc(x, y, DOT + glow * 2.2, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }

      // Destellos: nacen al azar, suben y bajan de intensidad (curva seno) y se apagan.
      if (sparks.length < Math.max(6, cols / 3) && Math.random() < 0.12) {
        sparks.push({ c: Math.floor(Math.random() * cols), r: Math.floor(Math.random() * rows), born: now });
      }
      sparks = sparks.filter((s) => now - s.born < SPARK_MS);
      for (const s of sparks) {
        const y = s.r * GAP + GAP / 2;
        if (y > reveal) continue;
        const k = Math.sin(((now - s.born) / SPARK_MS) * Math.PI); // 0 → 1 → 0
        const x = s.c * GAP + GAP / 2;
        // halo suave + núcleo
        ctx.fillStyle = `rgba(${colTint[s.c]},${(k * 0.18).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(x, y, DOT + k * 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = `rgba(${colTint[s.c]},${(k * 0.75).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(x, y, DOT + k * 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    const loop = (now: number) => {
      draw(now);
      if (running) raf = requestAnimationFrame(loop);
    };
    const play = () => {
      if (running || reduce) return;
      running = true;
      raf = requestAnimationFrame(loop);
    };
    const pause = () => {
      running = false;
      cancelAnimationFrame(raf);
    };

    resize();
    start = performance.now();
    if (reduce) draw(start);

    const ro = new ResizeObserver(() => {
      resize();
      if (reduce) draw(performance.now());
    });
    ro.observe(canvas);
    const io = new IntersectionObserver(([e]) => (e?.isIntersecting ? play() : pause()));
    io.observe(canvas);
    const onVis = () => (document.hidden ? pause() : play());
    document.addEventListener("visibilitychange", onVis);

    return () => {
      pause();
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [dotColor]);

  return (
    <canvas
      ref={ref}
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-0 h-full w-full",
        className ?? "-z-10 [mask-image:radial-gradient(80%_70%_at_50%_30%,#000_35%,transparent_80%)]",
      )}
    />
  );
}
