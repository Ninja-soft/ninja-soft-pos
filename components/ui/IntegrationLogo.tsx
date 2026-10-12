import Image from "next/image";
import { cn } from "@/lib/utils/cn";

// Logos oficiales de apps de terceros (public/images/integrations/*.webp).
// Se muestran como "ícono de app": baldosa clara redondeada para que el logo
// conserve sus colores en cualquier tema.
const LOGOS = {
  gmail: { src: "/images/integrations/gmail.webp", label: "Gmail" },
  outlook: { src: "/images/integrations/outlook.webp", label: "Outlook" },
  resend: { src: "/images/integrations/resend.webp", label: "Resend", bleed: true },
  whatsapp: { src: "/images/integrations/whatsapp.webp", label: "WhatsApp" },
  telegram: { src: "/images/integrations/telegram.webp", label: "Telegram" },
  google: { src: "/images/integrations/google.webp", label: "Google" },
  mercadolibre: { src: "/images/integrations/mercadolibre.webp", label: "Mercado Libre" },
  arca: { src: "/images/integrations/arca.webp", label: "ARCA (ex AFIP)", wide: true },
} as const satisfies Record<
  string,
  { src: string; label: string; bleed?: boolean; wide?: boolean }
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
}: {
  name: IntegrationKey;
  size?: number;
  className?: string;
  title?: string;
}) {
  const logo: { src: string; label: string; bleed?: boolean; wide?: boolean } = LOGOS[name];
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
      <Image
        src={logo.src}
        alt={logo.label}
        width={size * 2}
        height={size * 2}
        className={cn(
          "h-full w-full",
          logo.bleed ? "object-cover" : "object-contain",
        )}
      />
    </span>
  );
}
IntegrationLogo.displayName = "IntegrationLogo";
