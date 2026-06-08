"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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

// Posiciones predefinidas (en %) para esparcir los logos alrededor del título.
// Cada uno entra escalonado (enterDelay) y luego flota con su propio ritmo
// (dur) y deriva (driftX/driftY/rot) para que ninguno se mueva igual que otro.
const POSITIONS = [
  { top: "17%", left: "13%", size: 92, enterDelay: 120, dur: 7.5, driftX: 10, driftY: -22, rot: 3 },
  { top: "23%", left: "73%", size: 104, enterDelay: 320, dur: 8.4, driftX: -12, driftY: -18, rot: -3.5 },
  { top: "61%", left: "9%", size: 84, enterDelay: 520, dur: 8.0, driftX: 8, driftY: -16, rot: 4 },
  { top: "69%", left: "71%", size: 96, enterDelay: 240, dur: 9.0, driftX: -9, driftY: -20, rot: -3 },
  { top: "12%", left: "45%", size: 80, enterDelay: 440, dur: 7.0, driftX: 6, driftY: -14, rot: 2.5 },
  { top: "74%", left: "43%", size: 88, enterDelay: 620, dur: 8.6, driftX: -7, driftY: -18, rot: -4 },
];

// Chispas/orbes de luz que suben de fondo (puro adorno, detrás de los logos).
const SPARKS = [
  { left: "22%", size: 5, delay: 0.0, dur: 5.2 },
  { left: "38%", size: 3, delay: 1.1, dur: 6.0 },
  { left: "54%", size: 6, delay: 0.5, dur: 4.6 },
  { left: "67%", size: 4, delay: 1.6, dur: 5.6 },
  { left: "81%", size: 3, delay: 0.8, dur: 6.4 },
  { left: "12%", size: 4, delay: 2.0, dur: 5.0 },
];

// Duración total de la intro antes de auto-cerrar (ms). Da tiempo a que entren
// los logos escalonados y respire el título.
const AUTO_DISMISS_MS = 3800;
// Espera al fade-out antes de desmontar (debe coincidir con tiendaIntroOut).
const OUT_MS = 520;

export function TienditaIntro() {
  // Se muestra CADA vez que se entra a la sección (sin gate de sesión). Sigue
  // siendo skippable: click en cualquier lado, botón "Entrar", o Esc/Enter.
  const [show, setShow] = useState(true);
  const [closing, setClosing] = useState(false);
  const closedRef = useRef(false);

  const close = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    setClosing(true);
    window.setTimeout(() => setShow(false), OUT_MS);
  }, []);

  useEffect(() => {
    const dismiss = window.setTimeout(close, AUTO_DISMISS_MS);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter" || e.key === " ") close();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(dismiss);
      window.removeEventListener("keydown", onKey);
    };
  }, [close]);

  if (!show) return null;

  return (
    <div
      role="presentation"
      onClick={close}
      className={`fixed inset-0 z-[80] flex items-center justify-center overflow-hidden bg-ninja-dark ${
        closing ? "tiendita-intro-out" : "tiendita-intro-in"
      }`}
    >
      {/* Aurora giratoria de fondo: da profundidad y movimiento sutil. */}
      <div className="tiendita-aurora pointer-events-none absolute left-1/2 top-1/2 h-[150vmax] w-[150vmax] -translate-x-1/2 -translate-y-1/2" />
      {/* Glow focal cálido detrás del título. */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(58%_58%_at_50%_46%,rgba(255,75,34,0.20),transparent_70%)]" />
      {/* Viñeta para enfocar el centro. */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_120%_at_50%_50%,transparent_55%,rgba(4,2,13,0.55)_100%)]" />

      {/* Chispas que suben (detrás de los logos). */}
      {SPARKS.map((s, i) => (
        <span
          key={`spark-${i}`}
          className="tiendita-spark pointer-events-none absolute bottom-[-6%] rounded-full bg-ninja-flameSoft"
          style={{
            left: s.left,
            width: s.size,
            height: s.size,
            animationDelay: `${s.delay}s`,
            ["--spark-dur" as string]: `${s.dur}s`,
          }}
        />
      ))}

      {/* Logos flotando */}
      {POSITIONS.map((pos, i) => {
        const logo = STORE_LOGOS[i % STORE_LOGOS.length] ?? STORE_LOGOS[0]!;
        return (
          <span
            key={`${logo.alt}-${i}`}
            className="tiendita-logo absolute grid place-items-center rounded-2xl border border-white/10 bg-white/95 shadow-[0_16px_50px_rgba(4,2,13,0.55)] ring-1 ring-ninja-flame/10 backdrop-blur"
            style={{
              top: pos.top,
              left: pos.left,
              width: pos.size,
              height: pos.size,
              // El pop entra escalonado; el float arranca al terminar el pop.
              ["--enter-delay" as string]: `${pos.enterDelay}ms`,
              ["--float-delay" as string]: `${pos.enterDelay + 720}ms`,
              ["--dur" as string]: `${pos.dur}s`,
              ["--drift-x" as string]: `${pos.driftX}px`,
              ["--drift-y" as string]: `${pos.driftY}px`,
              ["--rot" as string]: `${pos.rot}deg`,
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
        <span className="tiendita-badge relative mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-ninja-gradient text-ninja-voidViolet shadow-ninjaGlow">
          <Sparkles size={28} />
          {/* Anillo que pulsa alrededor del ícono. */}
          <span className="tiendita-ring pointer-events-none absolute inset-0 rounded-2xl ring-2 ring-ninja-flameSoft/50" />
        </span>
        <h1 className="tiendita-shine text-4xl font-black tracking-tight text-white sm:text-5xl">
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
          className="group mt-7 inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/5 px-6 py-2.5 text-xs font-semibold text-white/85 transition hover:border-ninja-flameSoft/60 hover:bg-white/10 hover:text-white"
        >
          Entrar
          <span className="transition-transform group-hover:translate-x-0.5">→</span>
        </button>
        <p className="mt-3 text-[11px] text-white/35">Tocá en cualquier lado para entrar</p>
      </div>

      {/* Animaciones (scoped: no tocamos tailwind.config). */}
      <style>{`
        /* Entrada del overlay completo. */
        .tiendita-intro-in { animation: tienditaFadeIn 360ms ease-out both; }
        .tiendita-intro-out { animation: tienditaFadeOut ${OUT_MS}ms cubic-bezier(0.4, 0, 1, 1) forwards; }
        @keyframes tienditaFadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes tienditaFadeOut {
          from { opacity: 1; filter: blur(0); }
          to   { opacity: 0; transform: scale(1.05); filter: blur(4px); }
        }

        /* Aurora cónica girando muy lento detrás de todo. */
        .tiendita-aurora {
          background: conic-gradient(from 0deg,
            rgba(255,75,34,0.16), rgba(109,74,255,0.10), rgba(255,210,31,0.10),
            rgba(255,75,34,0.16));
          filter: blur(70px);
          opacity: 0.0;
          animation: tienditaAuroraIn 900ms ease-out forwards,
                     tienditaSpin 26s linear infinite;
        }
        @keyframes tienditaAuroraIn { to { opacity: 0.9; } }
        @keyframes tienditaSpin {
          from { transform: translate(-50%, -50%) rotate(0deg); }
          to   { transform: translate(-50%, -50%) rotate(360deg); }
        }

        /* Logos: pop de entrada con rebote + flotado continuo con deriva. */
        .tiendita-logo {
          opacity: 0;
          transform: scale(0.55) translateY(8px);
          animation:
            tienditaPop 760ms cubic-bezier(0.34, 1.56, 0.64, 1) var(--enter-delay, 0ms) forwards,
            tienditaFloat var(--dur, 8s) ease-in-out var(--float-delay, 800ms) infinite;
        }
        @keyframes tienditaPop {
          0%   { opacity: 0; transform: scale(0.55) translateY(10px) rotate(calc(var(--rot, 0deg) * -1)); }
          60%  { opacity: 1; }
          100% { opacity: 1; transform: scale(1) translateY(0) rotate(0deg); }
        }
        @keyframes tienditaFloat {
          0%   { transform: translate(0, 0) rotate(calc(var(--rot, 0deg) * -1)); }
          50%  { transform: translate(var(--drift-x, 8px), var(--drift-y, -18px)) rotate(var(--rot, 2deg)); }
          100% { transform: translate(0, 0) rotate(calc(var(--rot, 0deg) * -1)); }
        }

        /* Chispas: suben y se desvanecen. */
        .tiendita-spark {
          opacity: 0;
          box-shadow: 0 0 10px rgba(255,106,26,0.8);
          animation: tienditaSpark var(--spark-dur, 5s) ease-in infinite;
        }
        @keyframes tienditaSpark {
          0%   { opacity: 0; transform: translateY(0) scale(0.6); }
          15%  { opacity: 0.9; }
          80%  { opacity: 0.5; }
          100% { opacity: 0; transform: translateY(-78vh) scale(1); }
        }

        /* Título: sube con leve overshoot, después de la cortina. */
        .tiendita-intro-title {
          animation: tienditaTitle 780ms cubic-bezier(0.22, 1, 0.36, 1) 180ms both;
        }
        @keyframes tienditaTitle {
          from { opacity: 0; transform: translateY(18px) scale(0.95); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }

        /* Badge del ícono: aparece con un pop y luego respira suave. */
        .tiendita-badge {
          animation: tienditaBadgeIn 700ms cubic-bezier(0.34, 1.56, 0.64, 1) 260ms both,
                     tienditaBreathe 4.5s ease-in-out 1s infinite;
        }
        @keyframes tienditaBadgeIn {
          from { opacity: 0; transform: scale(0.4) rotate(-12deg); }
          to   { opacity: 1; transform: scale(1) rotate(0deg); }
        }
        @keyframes tienditaBreathe {
          0%, 100% { transform: translateY(0) scale(1); }
          50%      { transform: translateY(-3px) scale(1.04); }
        }
        .tiendita-ring { animation: tienditaRing 2.6s ease-out infinite; }
        @keyframes tienditaRing {
          0%   { opacity: 0.6; transform: scale(1); }
          70%  { opacity: 0; transform: scale(1.5); }
          100% { opacity: 0; transform: scale(1.5); }
        }

        /* Brillo que barre el wordmark una vez al entrar. */
        .tiendita-shine {
          background: linear-gradient(100deg,
            #ffffff 0%, #ffffff 40%, #FFD21F 50%, #ffffff 60%, #ffffff 100%);
          background-size: 250% 100%;
          background-position: 120% 0;
          -webkit-background-clip: text;
          background-clip: text;
          -webkit-text-fill-color: transparent;
          animation: tienditaShine 1500ms ease-out 700ms 1 both;
        }
        @keyframes tienditaShine {
          from { background-position: 120% 0; }
          to   { background-position: -40% 0; }
        }

        /* Accesibilidad: sin movimiento, sólo un fade-in limpio del layout. */
        @media (prefers-reduced-motion: reduce) {
          .tiendita-intro-in,
          .tiendita-intro-out,
          .tiendita-aurora,
          .tiendita-logo,
          .tiendita-spark,
          .tiendita-intro-title,
          .tiendita-badge,
          .tiendita-ring,
          .tiendita-shine {
            animation: none !important;
          }
          .tiendita-spark { display: none; }
          .tiendita-aurora { opacity: 0.7; }
          .tiendita-logo { opacity: 1; transform: none; }
          .tiendita-shine {
            -webkit-text-fill-color: #ffffff;
            background: none;
          }
          .tiendita-intro-in { opacity: 1; }
          .tiendita-intro-out { opacity: 0; transition: opacity ${OUT_MS}ms ease; }
        }
      `}</style>
    </div>
  );
}
