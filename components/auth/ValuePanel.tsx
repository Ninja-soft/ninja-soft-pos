"use client";

import { CalendarClock, Boxes, ReceiptText, Zap } from "lucide-react";
import { Isotype, WordmarkPos } from "@/components/brand/Logo";

const BULLETS = [
  {
    icon: Zap,
    title: "Vendé en segundos",
    desc: "Punto de venta rápido, en cualquier pantalla.",
  },
  {
    icon: Boxes,
    title: "Stock y caja al día",
    desc: "Controlá inventario y cierres sin planillas.",
  },
  {
    icon: ReceiptText,
    title: "Facturación cuando quieras",
    desc: "Comprobantes y AFIP cuando estés listo.",
  },
];

// Columna izquierda del wizard (desktop): propuesta de valor sobre el panel
// glass con glow flame. En mobile se colapsa a un header compacto.
export function ValuePanel() {
  return (
    <div className="relative hidden overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-ninja-deepViolet/80 via-ninja-voidViolet/70 to-ninja-void/90 p-8 lg:flex lg:flex-col">
      {/* Glow flame sutil */}
      <div
        className="pointer-events-none absolute -left-16 -top-16 h-56 w-56 rounded-full bg-ninja-flame/25 blur-3xl"
        aria-hidden
      />
      <div className="relative z-10 flex items-center gap-3">
        <Isotype className="h-9 w-auto" priority />
        <WordmarkPos variant="dark" className="h-7 w-auto" priority />
      </div>

      <div className="relative z-10 mt-10">
        <h2 className="font-sans text-3xl font-extrabold leading-[1.1] tracking-[-0.02em] text-ninja-softWhite">
          Tu negocio,{" "}
          <span className="bg-ninja-gradient bg-clip-text text-transparent">
            bajo control
          </span>
        </h2>
        <p className="mt-3 flex items-center gap-2 text-sm text-ninja-lavender">
          <CalendarClock size={15} className="text-ninja-flameSoft" />
          14 días de prueba gratis • Sin tarjeta
        </p>
      </div>

      <ul className="relative z-10 mt-10 space-y-5">
        {BULLETS.map(({ icon: Icon, title, desc }) => (
          <li key={title} className="flex gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-ninja-flame/15 text-ninja-flameSoft">
              <Icon size={18} />
            </span>
            <div>
              <p className="text-sm font-semibold text-ninja-softWhite">
                {title}
              </p>
              <p className="text-sm text-ninja-lavender">{desc}</p>
            </div>
          </li>
        ))}
      </ul>

      <p className="relative z-10 mt-auto pt-10 text-xs text-ninja-lavender/70">
        Hecho para kioscos, retail, gastronomía y pymes de Argentina.
      </p>
    </div>
  );
}
