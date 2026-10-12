import Image from "next/image";
import { cn } from "@/lib/utils/cn";

// Logos oficiales de apps de terceros (public/images/integrations/*.webp).
// Por defecto se muestran como "ícono de app": baldosa clara redondeada para
// que el logo conserve sus colores en cualquier tema. `bare` los muestra sin
// baldosa (en línea con texto). Las marcas monocromas (Resend) se dibujan como
// SVG en currentColor: legibles en claro y oscuro sin placa negra.

// Isotipo oficial de Resend (simple-icons, CC0).
const RESEND_MARK =
  "M2.023 0v24h5.553v-8.434h2.998L15.326 24h6.65l-5.372-9.258a7.652 7.652 0 0 0 3.316-3.016c.709-1.21 1.062-2.57 1.062-4.08 0-1.462-.353-2.767-1.062-3.91-.709-1.165-1.692-2.079-2.95-2.742C15.737.331 14.355 0 12.823 0Zm5.553 4.87h4.219c.731 0 1.349.125 1.851.376.526.252.925.618 1.2 1.098.274.457.412.994.412 1.611S15.132 9.12 14.88 9.6c-.229.48-.572.856-1.03 1.13-.434.252-.948.38-1.542.38H7.576Z";

const LOGOS = {
  gmail: { src: "/images/integrations/gmail.webp", label: "Gmail" },
  outlook: { src: "/images/integrations/outlook.webp", label: "Outlook" },
  resend: { src: "/images/integrations/resend.webp", label: "Resend", mono: RESEND_MARK },
  whatsapp: { src: "/images/integrations/whatsapp.webp", label: "WhatsApp" },
  telegram: { src: "/images/integrations/telegram.webp", label: "Telegram" },
  google: { src: "/images/integrations/google.webp", label: "Google" },
  mercadolibre: { src: "/images/integrations/mercadolibre.webp", label: "Mercado Libre" },
  arca: { src: "/images/integrations/arca.webp", label: "ARCA (ex AFIP)", wide: true },
} as const satisfies Record<
  string,
  { src: string; label: string; bleed?: boolean; wide?: boolean; mono?: string }
>;

export type IntegrationKey = keyof typeof LOGOS;

export function isIntegrationKey(k: string): k is IntegrationKey {
  return k in LOGOS;
}

export function IntegrationLogo({
  name,
  size = 28,
  className,
  title,
  bare = false,
}: {
  name: IntegrationKey;
  size?: number;
  className?: string;
  title?: string;
  /** Sin baldosa: el logo solo, del tamaño pedido (en línea con texto). */
  bare?: boolean;
}) {
  const logo: { src: string; label: string; bleed?: boolean; wide?: boolean; mono?: string } = LOGOS[name];
  if (bare) {
    return (
      <span
        title={title ?? logo.label}
        className={cn("relative inline-grid shrink-0 place-items-center", className)}
        style={{ width: logo.wide ? Math.round(size * 1.7) : size, height: size }}
      >
        {logo.mono ? (
          <svg viewBox="0 0 24 24" width={size * 0.82} height={size * 0.82} fill="currentColor" role="img" aria-label={logo.label}>
            <path d={logo.mono} />
          </svg>
        ) : (
          <Image
            src={logo.src}
            alt={logo.label}
            width={size * 2}
            height={size * 2}
            className="object-contain"
            style={{ width: logo.wide ? Math.round(size * 1.7) : size, height: size }}
          />
        )}
      </span>
    );
  }
  const pad = logo.bleed ? 0 : Math.max(3, Math.round(size * (logo.wide ? 0.1 : 0.16)));
  return (
    <span
      title={title ?? logo.label}
      className={cn(
        "relative inline-grid shrink-0 place-items-center overflow-hidden bg-white shadow-sm ring-1 ring-black/5",
        className,
      )}
      style={{
        width: logo.wide ? Math.round(size * 1.7) : size,
        height: size,
        borderRadius: Math.round(size * 0.26),
        padding: pad,
      }}
    >
      {logo.mono ? (
        <svg viewBox="0 0 24 24" className="h-full w-full text-black" fill="currentColor" role="img" aria-label={logo.label}>
          <path d={logo.mono} />
        </svg>
      ) : (
        <Image
          src={logo.src}
          alt={logo.label}
          width={size * 2}
          height={size * 2}
          className={cn("h-full w-full", logo.bleed ? "object-cover" : "object-contain")}
        />
      )}
    </span>
  );
}
IntegrationLogo.displayName = "IntegrationLogo";
