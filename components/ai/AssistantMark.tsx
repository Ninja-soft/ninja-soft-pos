"use client";

import Image from "next/image";
import { cn } from "@/lib/utils/cn";

// Marca del Asistente IA: el isotipo oficial de Ninja (public/brand) sobre una
// placa plana "noche violeta" con borde de 1px y un destello dorado sólido
// arriba a la derecha. Es la identidad del asistente en todo el chat (launcher,
// header, avatar de respuestas, estado vacío) y en el panel del dueño. Plana:
// sin degradados, brillos ni sombras (dirección visual 2026-10). Se ve igual
// en temas oscuros y claros: funciona como un ícono de app, no depende del fondo.
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
  // Radio contenido (≈ rounded-lg en el tamaño del launcher).
  const radius = Math.max(6, Math.round(size * 0.2));
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
        className="absolute inset-0 border border-white/10 bg-[#140B3A]"
        style={{ borderRadius: radius }}
      />
      <Image
        src="/brand/ninja-isotype.webp"
        alt=""
        width={Math.round(glyph * 0.815)}
        height={glyph}
        className={cn("relative h-auto", animated && "ai-mark-float")}
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
            fill="#FFD21F"
          />
        </svg>
      )}
    </span>
  );
}
