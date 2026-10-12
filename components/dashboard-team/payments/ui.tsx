"use client";

import {
  BellRing,
  Check,
  ClipboardPaste,
  Code2,
  CreditCard,
  ExternalLink,
  FlaskConical,
  Info,
  KeyRound,
  Link2,
  Lock,
  LogIn,
  Mail,
  MapPin,
  QrCode,
  Settings,
  ShieldCheck,
  Store,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { choiceClass } from "@/components/ui/ChoiceCard";
import { CAP_COPY, type ChannelCap, type ConnectGuide, type GuideIcon } from "./copy";
import { paymentIcon, paymentIconFullBleed, paymentWordmark } from "@/lib/payments/logos";
import { ThemedLogo } from "@/components/ui/ThemedLogo";
import type { Env } from "./types";

// Isotipo del medio, transparente y sin placa (los canales Point usan el de su
// marca). En los temas oscuros usa la variante para fondo oscuro si existe.
export function BrandLogo({
  brandKey,
  name,
  size = 44,
  muted = false,
  className,
}: {
  brandKey: string;
  name: string;
  size?: number;
  muted?: boolean;
  className?: string;
}) {
  const src = paymentIcon(brandKey);
  const fullBleed = paymentIconFullBleed(brandKey);
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center",
        !src && "rounded-[22%] bg-fg-6",
        muted && "opacity-55 grayscale",
        className,
      )}
      style={{ width: size, height: size }}
    >
      {src ? (
        <ThemedLogo
          src={src}
          alt={name}
          className={cn("h-[88%] w-[88%]", fullBleed && "rounded-[22%]")}
        />
      ) : (
        <CreditCard size={size * 0.45} className="text-muted-foreground" />
      )}
    </span>
  );
}

// Logo horizontal completo, transparente y adaptado al tema.
export function BrandWordmark({
  brandKey,
  name,
  className,
}: {
  brandKey: string;
  name: string;
  className?: string;
}) {
  const src = paymentWordmark(brandKey);
  if (!src) return <BrandLogo brandKey={brandKey} name={name} size={56} />;
  return (
    <span className={cn("inline-flex h-14 items-center justify-center", className)}>
      <ThemedLogo src={src} alt={name} className="max-h-10 w-auto max-w-[200px]" />
    </span>
  );
}

export type StatusTone = "ok" | "test" | "idle" | "soon" | "locked";

const TONE: Record<StatusTone, string> = {
  ok: "bg-success/10 text-success",
  test: "bg-warning/15 text-warning",
  idle: "bg-muted text-muted-foreground",
  soon: "bg-muted text-muted-foreground",
  locked: "bg-fg-6 text-foreground",
};

const DOT: Record<StatusTone, string> = {
  ok: "bg-success",
  test: "bg-warning",
  idle: "bg-[color-mix(in_srgb,var(--muted-foreground)_50%,transparent)]",
  soon: "bg-[color-mix(in_srgb,var(--muted-foreground)_40%,transparent)]",
  locked: "bg-muted-foreground",
};

export function StatusChip({
  tone,
  children,
  className,
}: {
  tone: StatusTone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold",
        TONE[tone],
        className,
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", DOT[tone])} aria-hidden />
      {children}
    </span>
  );
}

// Selector de ambiente: dos tarjetas grandes con ícono. La elegida usa la
// selección premium (relleno neutro + check de marca), sin bordes de color.
export function EnvPicker({
  value,
  onChange,
  disabledTest = false,
  testHint,
}: {
  value: Env;
  onChange: (v: Env) => void;
  disabledTest?: boolean;
  testHint?: string;
}) {
  const opts: { v: Env; title: string; sub: string; Icon: LucideIcon; tile: string }[] = [
    { v: "prod", title: "Producción", sub: "Cobros reales", Icon: ShieldCheck, tile: "bg-success/15 text-success" },
    {
      v: "test",
      title: "Prueba",
      sub: testHint ?? "Sin plata real, para probar",
      Icon: FlaskConical,
      tile: "bg-warning/15 text-warning",
    },
  ];
  return (
    <div role="radiogroup" aria-label="Ambiente" className="grid grid-cols-2 gap-2">
      {opts.map(({ v, title, sub, Icon, tile }) => {
        const active = value === v;
        const disabled = v === "test" && disabledTest;
        return (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(v)}
            className={choiceClass(active, "flex flex-col items-start gap-2.5 p-3.5 pr-8")}
          >
            <span className={cn("grid h-10 w-10 place-items-center rounded-xl", disabled ? "bg-muted text-muted-foreground" : tile)}>
              <Icon size={20} strokeWidth={2} />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-foreground">{title}</span>
              <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">{sub}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

// Stepper horizontal: círculos numerados rellenos (sin anillos). Las etiquetas
// son cortas y nunca se recortan (también en 390px).
export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="flex items-center gap-1.5" aria-label="Pasos">
      {steps.map((label, i) => {
        const done = i < current;
        const active = i === current;
        const last = i === steps.length - 1;
        return (
          <li key={label} className={cn("flex items-center gap-1.5", !last && "flex-1")}>
            <span
              className={cn(
                "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold transition-colors",
                done && "bg-success/15 text-success",
                active && "bg-foreground text-background",
                !done && !active && "bg-fg-6 text-muted-foreground",
              )}
              aria-current={active ? "step" : undefined}
            >
              {done ? <Check size={13} strokeWidth={3} /> : i + 1}
            </span>
            <span
              className={cn(
                "whitespace-nowrap text-xs font-medium",
                active ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {label}
            </span>
            {!last && <span aria-hidden className={cn("h-px min-w-2 flex-1", done ? "bg-success/50" : "bg-border")} />}
          </li>
        );
      })}
    </ol>
  );
}

// Capacidad de cobro de un canal: QR, Link de pago o Point (terminal).
export const CAP_ICON: Record<ChannelCap, LucideIcon> = { qr: QrCode, link: Link2, point: CreditCard };

export function CapBadge({ cap, muted = false }: { cap: ChannelCap; muted?: boolean }) {
  const Icon = CAP_ICON[cap];
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 text-[11px] font-semibold",
        muted ? "bg-muted text-muted-foreground" : "bg-fg-6 text-foreground",
      )}
    >
      <Icon size={12} strokeWidth={2.2} aria-hidden />
      {CAP_COPY[cap].label}
    </span>
  );
}

// Leyenda: qué es QR, Link de pago y Point.
export function ChannelLegend() {
  const caps: ChannelCap[] = ["qr", "link", "point"];
  return (
    <div className="grid grid-cols-3 gap-1 rounded-2xl bg-fg-4 p-2">
      {caps.map((c) => {
        const Icon = CAP_ICON[c];
        return (
          <div key={c} className="flex flex-col items-start gap-2 rounded-xl px-1.5 py-1.5 sm:flex-row sm:items-center sm:gap-2.5 sm:px-2">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--seg-thumb)] text-foreground shadow-[var(--seg-thumb-shadow)]">
              <Icon size={16} strokeWidth={2} />
            </span>
            <span className="min-w-0 leading-tight">
              <span className="block text-[13px] font-semibold text-foreground">{CAP_COPY[c].label}</span>
              <span className="block text-xs text-muted-foreground">{CAP_COPY[c].legend}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── Ayuda estructurada del modal Conectar ──────────────────────────────────
const GUIDE_ICON: Record<GuideIcon, LucideIcon> = {
  login: LogIn,
  key: KeyRound,
  paste: ClipboardPaste,
  mail: Mail,
  store: Store,
  settings: Settings,
  code: Code2,
  bell: BellRing,
};

export function GuideSteps({ steps }: { steps: ConnectGuide["steps"] }) {
  return (
    <ol className="space-y-2">
      {steps.map((s, i) => {
        const Icon = GUIDE_ICON[s.icon];
        return (
          <li key={i} className="flex items-center gap-3">
            <span className="relative grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-fg-6 text-foreground">
              <Icon size={15} strokeWidth={2} aria-hidden />
              <span className="absolute -right-1.5 -top-1.5 grid h-4 w-4 place-items-center rounded-full bg-foreground text-[9px] font-bold text-background">
                {i + 1}
              </span>
            </span>
            <span className="text-[13px] leading-snug text-foreground">{s.text}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function WhereRow({ href, label, path }: { href?: string; label?: string; path: string }) {
  const inner = (
    <>
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--seg-thumb)] text-foreground shadow-[var(--seg-thumb-shadow)]">
        <MapPin size={15} />
      </span>
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
          Dónde lo encuentro
        </span>
        <span className="mt-0.5 block text-[13px] font-medium text-foreground">{path}</span>
        {href && label && <span className="mt-0.5 block truncate text-xs text-muted-foreground">{label}</span>}
      </span>
      {href && <ExternalLink size={16} className="shrink-0 text-muted-foreground" aria-hidden />}
    </>
  );
  const cls = "flex items-center gap-3 rounded-xl bg-fg-4 px-3 py-2.5";
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cn(cls, "transition hover:bg-fg-6")}>
      {inner}
    </a>
  ) : (
    <div className={cls}>{inner}</div>
  );
}

export function SecurityNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-center justify-center gap-1.5 text-center text-[11px] text-muted-foreground">
      <Lock size={12} aria-hidden className="shrink-0" /> {children}
    </p>
  );
}

// Aviso relleno (sin borde de color).
export function Notice({
  tone = "neutral",
  title,
  children,
}: {
  tone?: "neutral" | "warning" | "danger";
  title?: React.ReactNode;
  children: React.ReactNode;
}) {
  const Icon = tone === "neutral" ? Info : TriangleAlert;
  return (
    <div
      role={tone === "danger" ? "alert" : undefined}
      className={cn(
        "flex items-start gap-2.5 rounded-xl px-3 py-2.5 text-[13px]",
        tone === "warning" && "bg-warning/15",
        tone === "danger" && "bg-danger/10",
        tone === "neutral" && "bg-fg-4",
      )}
    >
      <Icon
        size={16}
        aria-hidden
        className={cn(
          "mt-px shrink-0",
          tone === "warning" ? "text-warning" : tone === "danger" ? "text-danger" : "text-muted-foreground",
        )}
      />
      <div className="min-w-0 leading-snug">
        {title && <p className={cn("font-semibold", tone === "danger" ? "text-danger" : "text-foreground")}>{title}</p>}
        <div className={cn(tone === "danger" ? "text-danger" : "text-muted-foreground", title && "mt-0.5")}>{children}</div>
      </div>
    </div>
  );
}

// Encabezado de sección dentro de un modal / detalle.
export function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
      {children}
    </div>
  );
}
