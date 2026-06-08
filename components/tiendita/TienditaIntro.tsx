"use client";

import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";

// Logos de las tiendas de origen (servidos desde /public/tiendas). Se muestran
// "flotando" para transmitir que el catálogo proviene de todas esas marcas.
// Es una lista visual: si una tienda no está en un catálogo concreto igual
// aporta a la sensación de "todas las marcas en un solo lugar".
const STORE_LOGOS = [
  { src: "/tiendas/carrefour.svg", alt: "Carrefour" },
  { src: "/tiendas/coto.png", alt: "Coto" },
  { src: "/tiendas/dia.png", alt: "Dia" },
  { src: "/tiendas/easy.png", alt: "Easy" },
  { src: "/tiendas/jumbo.png", alt: "Jumbo" },
  { src: "/tiendas/la-anonima.png", alt: "La Anónima" },
];

// Posiciones predefinidas (en %) para esparcir los logos de forma prolija
// alrededor del título central. Cada uno flota con un delay propio.
const POSITIONS = [
  { top: "16%", left: "12%", size: 92, delay: 0, dur: 5.5 },
  { top: "24%", left: "74%", size: 104, delay: 0.5, dur: 6.2 },
  { top: "62%", left: "8%", size: 84, delay: 1.1, dur: 5.9 },
  { top: "70%", left: "70%", size: 96, delay: 0.3, dur: 6.6 },
  { top: "12%", left: "44%", size: 80, delay: 0.8, dur: 5.2 },
  { top: "74%", left: "42%", size: 88, delay: 1.4, dur: 6.0 },
];

const SESSION_KEY = "ninja:tiendita-intro-seen";
// Duración total de la intro antes de auto-cerrar (ms).
const AUTO_DISMISS_MS = 3200;

export function TienditaIntro() {
  // Solo se muestra una vez por sesión del navegador (no molesta en cada visita).
  const [show, setShow] = useState(false);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    let seen = false;
    try {
      seen = sessionStorage.getItem(SESSION_KEY) === "1";
    } catch {
      /* sin storage: la mostramos igual */
    }
    if (seen) return;
    setShow(true);
    const dismiss = setTimeout(() => close(), AUTO_DISMISS_MS);
    return () => clearTimeout(dismiss);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function close() {
    setClosing(true);
    try {
      sessionStorage.setItem(SESSION_KEY, "1");
    } catch {
      /* sin storage */
    }
    // Espera al fade-out antes de desmontar.
    setTimeout(() => setShow(false), 480);
  }

  if (!show) return null;

  return (
    <div
      role="presentation"
      onClick={close}
      className={`fixed inset-0 z-[80] flex items-center justify-center overflow-hidden bg-ninja-dark ${
        closing ? "tiendita-intro-out" : "tiendita-intro-in"
      }`}
    >
      {/* Glow de fondo */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_60%_at_50%_45%,rgba(236,63,23,0.18),transparent_70%)]" />

      {/* Logos flotando */}
      {POSITIONS.map((pos, i) => {
        const logo = STORE_LOGOS[i % STORE_LOGOS.length] ?? STORE_LOGOS[0]!;
        return (
          <span
            key={`${logo.alt}-${i}`}
            className="tiendita-float absolute grid place-items-center rounded-2xl border border-white/10 bg-white/95 shadow-[0_12px_40px_rgba(0,0,0,0.45)] backdrop-blur"
            style={{
              top: pos.top,
              left: pos.left,
              width: pos.size,
              height: pos.size,
              animationDelay: `${pos.delay}s`,
              // La var --dur la consume el keyframe de flotado.
              ["--dur" as string]: `${pos.dur}s`,
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={logo.src}
              alt={logo.alt}
              className="h-3/5 w-3/5 object-contain"
              draggable={false}
            />
          </span>
        );
      })}

      {/* Título central */}
      <div className="tiendita-intro-title relative z-10 px-6 text-center">
        <span className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-ninja-gradient text-ninja-voidViolet shadow-ninjaGlow">
          <Sparkles size={26} />
        </span>
        <h1 className="text-4xl font-black tracking-tight text-white sm:text-5xl">
          Tiendita
        </h1>
        <p className="mx-auto mt-3 max-w-md text-balance text-sm text-white/70 sm:text-base">
          Catálogos de las marcas más grandes, listos para sumar a tu tienda.
        </p>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            close();
          }}
          className="mt-6 rounded-full border border-white/20 bg-white/5 px-5 py-2 text-xs font-medium text-white/80 transition hover:bg-white/10"
        >
          Entrar
        </button>
      </div>

      {/* Animaciones (scoped: no tocamos tailwind.config). */}
      <style>{`
        @keyframes tienditaFloat {
          0%   { transform: translateY(0) rotate(-1deg); }
          50%  { transform: translateY(-16px) rotate(1.5deg); }
          100% { transform: translateY(0) rotate(-1deg); }
        }
        .tiendita-float {
          animation: tienditaFloat var(--dur, 6s) ease-in-out infinite;
          opacity: 0;
          animation-name: tienditaFloat, tienditaPop;
          animation-duration: var(--dur, 6s), 700ms;
          animation-timing-function: ease-in-out, cubic-bezier(0.34, 1.56, 0.64, 1);
          animation-iteration-count: infinite, 1;
          animation-fill-mode: none, forwards;
        }
        @keyframes tienditaPop {
          from { opacity: 0; transform: scale(0.6); }
          to   { opacity: 1; transform: scale(1); }
        }
        .tiendita-intro-title {
          animation: tienditaTitle 700ms cubic-bezier(0.22, 1, 0.36, 1) both;
          animation-delay: 250ms;
        }
        @keyframes tienditaTitle {
          from { opacity: 0; transform: translateY(14px) scale(0.96); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        .tiendita-intro-in { animation: tienditaFadeIn 320ms ease-out both; }
        .tiendita-intro-out { animation: tienditaFadeOut 460ms ease-in forwards; }
        @keyframes tienditaFadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes tienditaFadeOut {
          from { opacity: 1; }
          to   { opacity: 0; transform: scale(1.04); }
        }
        @media (prefers-reduced-motion: reduce) {
          .tiendita-float { animation: tienditaPop 400ms ease-out forwards; }
        }
      `}</style>
    </div>
  );
}
