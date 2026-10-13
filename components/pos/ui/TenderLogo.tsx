"use client";

import { ThemedLogo } from "@/components/ui/ThemedLogo";
import type { LogoSource } from "@/lib/pos/tenderLogo";
import { cn } from "@/lib/utils/cn";

export type LogoFallback = "wallet" | "account" | "card";

// Set de íconos de los medios genéricos (Phosphor duotone, MIT; ver
// public/img/medios_de_pago/LICENSES.md). Un solo estilo y grosor para todos.
export type TenderGlyph =
  | "efectivo"
  | "transferencia"
  | "tarjeta"
  | "posnet"
  | "qr"
  | "billetera"
  | "cuenta-corriente"
  | "vale"
  | "sena"
  | "plataforma"
  | "mercado-libre"
  | "otro";

const GLYPH_BASE = "/img/medios_de_pago/iconos";

// brand / tenderId / método → ícono. Las marcas con logo oficial no están acá.
const GENERIC_GLYPH: Record<string, TenderGlyph> = {
  cash: "efectivo",
  transfer: "transferencia",
  card: "tarjeta",
  debit: "tarjeta",
  credit: "tarjeta",
  qr: "qr",
  store_credit: "vale",
  account: "cuenta-corriente",
  sena: "sena",
  platform: "plataforma",
  mercadolibre: "mercado-libre",
  other: "otro",
};

/** Ícono neutro para un medio sin logo (cuenta corriente, tarjeta en posnet). */
export function tenderFallback(t: { flow: string }): LogoFallback {
  return t.flow === "account" ? "account" : t.flow === "card" ? "card" : "wallet";
}

const FALLBACK_GLYPH: Record<LogoFallback, TenderGlyph> = {
  wallet: "billetera",
  account: "cuenta-corriente",
  card: "tarjeta",
};

/**
 * Ícono del set propio para un medio genérico (efectivo, transferencia,
 * tarjeta en posnet, vale, cuenta corriente, seña…). null = usar el logo de
 * marca. La tarjeta en terminal integrada conserva el logo del adquirente.
 */
export function tenderGlyph(t: {
  brand?: string;
  tenderId?: string;
  method?: string | null;
  logo?: string | null;
}): TenderGlyph | null {
  const key = t.brand ?? t.tenderId?.split(":")[0] ?? t.method ?? "";
  const glyph = GENERIC_GLYPH[key];
  if (!glyph) return null;
  if (t.logo && key !== "cash" && key !== "transfer") return null;
  return glyph;
}

function Glyph({ name, size }: { name: TenderGlyph; size: number }) {
  // Máscara sobre currentColor: el duotone (capa al 20 %) toma el color del
  // tema sin variantes por fondo.
  const url = `url(${GLYPH_BASE}/${name}.svg)`;
  return (
    <span
      aria-hidden
      className="block bg-current"
      style={{
        width: size,
        height: size,
        WebkitMaskImage: url,
        maskImage: url,
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
        WebkitMaskSize: "contain",
        maskSize: "contain",
        WebkitMaskPosition: "center",
        maskPosition: "center",
      }}
    />
  );
}

// Logo de un medio de cobro con su fondo transparente, directo sobre la
// superficie (sin placa blanca). ThemedLogo alterna la variante oficial para
// fondo oscuro (lib/payments/logos.ts) según data-theme, sin esperar a la
// hidratación. Medios genéricos (o sin logo): ícono del set propio.
//
// `framed`: contenedor cuadrado neutro con el mismo tamaño para logos e
// íconos (botones de la hoja de cobro), así todos los medios se alinean.
export function TenderLogo({
  source,
  alt,
  size = 32,
  fallback,
  glyph,
  framed = false,
  className,
}: {
  source: LogoSource;
  alt: string;
  size?: number;
  fallback?: LogoFallback;
  /** Ícono del set propio; tiene prioridad sobre el logo. */
  glyph?: TenderGlyph | null;
  framed?: boolean;
  className?: string;
}) {
  const icon = glyph ?? (source.logo ? null : FALLBACK_GLYPH[fallback ?? "wallet"]);
  const inner = framed ? Math.round(size * 0.7) : size;
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center",
        framed && "rounded-md border border-border bg-muted/60",
        icon && (framed ? "text-foreground" : "text-muted-foreground"),
        className,
      )}
      style={{ width: size, height: size }}
    >
      {icon ? (
        <Glyph name={icon} size={framed ? Math.round(size * 0.6) : Math.round(size * 0.8)} />
      ) : framed ? (
        <span className="grid place-items-center" style={{ width: inner, height: inner }}>
          <ThemedLogo src={source.logo!} alt={alt} loading="eager" className="h-full w-full" />
        </span>
      ) : (
        <ThemedLogo src={source.logo!} alt={alt} loading="eager" className="h-full w-full" />
      )}
    </span>
  );
}
