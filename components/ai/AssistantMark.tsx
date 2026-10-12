"use client";

import { useId } from "react";
import Image from "next/image";
import { cn } from "@/lib/utils/cn";

// Marca del Asistente IA: el isotipo oficial de Ninja (public/brand) dentro de
// un squircle "noche violeta" con un resplandor de fuego desde abajo y un
// destello dorado arriba a la derecha. Es la identidad del asistente en todo el
// chat (launcher, header, avatar de respuestas, estado vacío). Se ve igual en
// temas oscuros y claros: funciona como un ícono de app, no depende del fondo.
//
// `animated` activa la animación de reposo (solo transform/opacity, apagada con
// prefers-reduced-motion vía las clases .ai-* de globals.css).
export function AssistantMark({
  size = 40,
  animated = false,
  sparkle = true,
  className,
}: {
  size?: number;
  animated?: boolean;
  sparkle?: boolean;
  className?: string;
}) {
  // Radio del squircle proporcional al tamaño (≈ ícono de iOS).
  // id único por instancia: varios gradientes con el mismo id se pisan y, si
  // la primera instancia está oculta, algunos navegadores no pintan el resto.
  const gradId = `ai-star-${useId().replace(/:/g, "")}`;
  const radius = Math.round(size * 0.3);
  const glyph = Math.round(size * 0.58);
  const star = Math.max(8, Math.round(size * 0.24));

  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-grid shrink-0 place-items-center",
        className,
      )}
      style={{ width: size, height: size }}
    >
      <span
        className="absolute inset-0 overflow-hidden"
        style={{
          borderRadius: radius,
          background:
            "radial-gradient(120% 80% at 50% 115%, rgba(255,75,34,0.55) 0%, rgba(255,138,31,0.18) 38%, rgba(255,138,31,0) 62%), linear-gradient(160deg, #24145E 0%, #140B3A 45%, #0B0720 100%)",
          boxShadow:
            "inset 0 1px 0 rgba(255,255,255,0.14), inset 0 -1px 0 rgba(0,0,0,0.35)",
        }}
      >
        {/* Brillo de vidrio en la mitad superior (efecto ícono iOS). */}
        <span
          className="absolute inset-x-0 top-0 h-1/2"
          style={{
            background:
              "linear-gradient(180deg, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0) 100%)",
          }}
        />
      </span>
      <Image
        src="/brand/ninja-isotype.webp"
        alt=""
        width={Math.round(glyph * 0.815)}
        height={glyph}
        className={cn(
          "relative h-auto drop-shadow-[0_2px_6px_rgba(255,75,34,0.45)]",
          animated && "ai-mark-float",
        )}
        style={{ width: Math.round(glyph * 0.815) }}
      />
      {sparkle && (
        <svg
          viewBox="0 0 24 24"
          width={star}
          height={star}
          className={cn("absolute", animated && "ai-mark-twinkle")}
          style={{ top: size * 0.08, right: size * 0.08 }}
        >
          <path
            d="M12 1.5c.5 4.9 1.9 7.9 4.2 9.3 1.5.9 3.6 1.3 6.3 1.2-2.7.1-4.8.6-6.3 1.5-2.3 1.4-3.7 4.4-4.2 9-.5-4.6-1.9-7.6-4.2-9-1.5-.9-3.6-1.4-6.3-1.5 2.7.1 4.8-.3 6.3-1.2C10.1 9.4 11.5 6.4 12 1.5Z"
            fill={`url(#${gradId})`}
          />
          <defs>
            <linearGradient id={gradId} x1="4" y1="2" x2="20" y2="22">
              <stop offset="0" stopColor="#FFF4B8" />
              <stop offset="0.5" stopColor="#FFD21F" />
              <stop offset="1" stopColor="#FF8A1F" />
            </linearGradient>
          </defs>
        </svg>
      )}
    </span>
  );
}
