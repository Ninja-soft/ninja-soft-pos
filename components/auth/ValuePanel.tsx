"use client";

import Link from "next/link";
import { CalendarClock, Boxes, ReceiptText, Zap } from "lucide-react";
import { LogoNinjaPos } from "@/components/brand/Logo";

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
    desc: "Factura electrónica de ARCA cuando estés listo.",
  },
];

// Panel de marca de las pantallas de auth (sólo desktop, columna izquierda del
// layout). Superficie plana noche violeta, siempre oscura (data-theme fijo) para
// que el logo oficial con "Ninja" en blanco se lea igual en tema claro. Sin
// degradados, sin glow, sin sombras: el degradé vive sólo dentro del logo.
export function ValuePanel({ showTrial = false }: { showTrial?: boolean }) {
  return (
    <aside
      data-theme="ninja-dark"
      className="hidden border-r border-white/10 bg-ninja-deepViolet text-ninja-softWhite lg:sticky lg:top-0 lg:flex lg:h-screen lg:flex-col lg:px-12 lg:py-12 xl:px-16"
    >
      <Link
        href="/"
        aria-label="Ninja POS, ir al inicio"
        className="w-fit rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-ninja-deepViolet"
      >
        <LogoNinjaPos variant="dark" className="h-9 w-auto" priority />
      </Link>

      <div className="my-auto max-w-md py-12">
        <h2 className="font-sans text-4xl font-extrabold leading-[1.08] tracking-[-0.025em] xl:text-[2.75rem]">
          Tu negocio,
          <br />
          <span className="text-ninja-flame">bajo control.</span>
        </h2>
        <p className="mt-4 text-base leading-relaxed text-ninja-lavender">
          Ventas, caja y stock en un solo lugar, desde la compu, la tablet o el
          celular.
        </p>
        {showTrial && (
          <p className="mt-5 flex items-center gap-2 text-sm font-medium text-ninja-softWhite">
            <CalendarClock size={16} className="text-ninja-flameSoft" aria-hidden />
            14 días de prueba gratis. Sin tarjeta.
          </p>
        )}

        <ul className="mt-10 space-y-6">
          {BULLETS.map(({ icon: Icon, title, desc }) => (
            <li key={title} className="flex gap-4">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-white/[0.06] text-ninja-flameSoft">
                <Icon size={18} aria-hidden />
              </span>
              <div>
                <p className="text-sm font-semibold">{title}</p>
                <p className="mt-0.5 text-sm text-ninja-lavender">{desc}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <p className="text-xs text-ninja-lavender">
        Hecho para kioscos, retail, gastronomía y pymes de Argentina.
      </p>
    </aside>
  );
}
