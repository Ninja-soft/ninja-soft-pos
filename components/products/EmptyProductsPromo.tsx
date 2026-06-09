"use client";

import Link from "next/link";
import { ArrowRight, Package, Sparkles, Store } from "lucide-react";

// Logos de las marcas servidos desde /public/tiendas. Refuerzan el mensaje
// "cientos de miles de productos de las marcas más grandes, ya cargados".
const STORE_LOGOS = [
  { src: "/tiendas/carrefour.svg", alt: "Carrefour" },
  { src: "/tiendas/coto.png", alt: "Coto" },
  { src: "/tiendas/dia.png", alt: "Dia" },
  { src: "/tiendas/jumbo.png", alt: "Jumbo" },
  { src: "/tiendas/easy.png", alt: "Easy" },
  { src: "/tiendas/la-anonima.png", alt: "La Anónima" },
];

// Banner comercial que aparece SOLO cuando el tenant todavía no cargó ningún
// producto. Invita a comprar un catálogo en Tiendita (pago único) para sumar
// productos en un clic, con foto, marca y categoría ya armadas.
export function EmptyProductsPromo() {
  return (
    <section className="relative mt-6 overflow-hidden rounded-2xl border border-border bg-card">
      <div className="relative z-10 grid items-center gap-8 p-8 md:grid-cols-[1.15fr_1fr] md:p-10">
        {/* Copy + CTA */}
        <div>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-ninja-flame/30 bg-ninja-flame/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-ninja-flame">
            <Sparkles size={13} />
            Empezá sin cargar nada a mano
          </span>

          <h2 className="mt-4 text-2xl font-black leading-tight tracking-tight text-foreground sm:text-3xl">
            Sumá{" "}
            <span className="bg-ninja-gradient bg-clip-text text-transparent">
              cientos de miles de productos
            </span>{" "}
            en un clic
          </h2>

          <p className="mt-3 max-w-md text-sm leading-relaxed text-muted-foreground">
            Comprá un catálogo en la Tiendita (pago único) y agregá productos de
            las marcas más grandes con foto, marca y categoría ya armadas. Cada
            producto que sumás pasa a ser 100% tuyo: lo editás, ponés tu precio y
            tu stock.
          </p>

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Link
              href="/tiendita"
              className="inline-flex items-center gap-2 rounded-xl bg-ninja-gradient px-5 py-3 text-sm font-bold text-ninja-void transition hover:brightness-110"
            >
              <Store size={17} />
              Ir a la Tiendita
              <ArrowRight size={16} />
            </Link>
            <span className="text-xs text-muted-foreground">
              O creá tu primer producto a mano con “Nuevo producto”.
            </span>
          </div>
        </div>

        {/* Mural de logos de marcas */}
        <div className="grid grid-cols-3 gap-3">
          {STORE_LOGOS.map((logo) => (
            <span
              key={logo.alt}
              className="grid aspect-[3/2] place-items-center rounded-xl border border-border bg-white p-3"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={logo.src}
                alt={logo.alt}
                className="max-h-9 w-full object-contain"
                draggable={false}
              />
            </span>
          ))}
          <span className="col-span-3 mt-1 flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
            <Package size={13} className="text-ninja-flame" />
            Catálogos precargados de marcas líderes de Argentina
          </span>
        </div>
      </div>
    </section>
  );
}
