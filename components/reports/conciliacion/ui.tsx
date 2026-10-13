"use client";

// Piezas visuales de la conciliación: logo del procesador en placa, chip de
// estado neutro con ícono, barra de estados y tarjeta de KPI. Reglas del brand
// book: sin degradados ni sombras, sin bordes de color al costado (franja
// arriba o punto), selección neutra.

import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Clock,
  Eye,
  Landmark,
  Receipt,
  ShieldAlert,
  Undo2,
} from "lucide-react";
import { ThemedLogo } from "@/components/ui/ThemedLogo";
import { cn } from "@/lib/utils/cn";
import { paymentIcon, paymentIconFullBleed } from "@/lib/payments/logos";
import { bankIcon, bankBySlug } from "@/lib/payments/banks";
import type { MatchTone } from "@/lib/reports/processorReconciliation";
import type { StatusSegment } from "@/lib/reports/reconciliationHub";

// ── Logos ────────────────────────────────────────────────────────────────────

/** Isotipo de un procesador en una placa neutra (cuadrada, radio chico). */
export function ProviderTile({
  logo,
  label,
  size = 36,
  className,
}: {
  logo: string | null;
  label: string;
  size?: number;
  className?: string;
}) {
  const src = logo ? paymentIcon(logo) : null;
  const bleed = logo ? paymentIconFullBleed(logo) : false;
  return (
    <span
      className={cn(
        "relative grid shrink-0 place-items-center overflow-hidden rounded-md border border-border bg-card",
        className,
      )}
      style={{ width: size, height: size }}
      title={label}
    >
      {src ? (
        <ThemedLogo
          src={src}
          alt={label}
          className={cn("h-full w-full", !bleed && "p-[14%]")}
        />
      ) : (
        <Receipt size={Math.round(size * 0.45)} className="text-muted-foreground" aria-label={label} />
      )}
    </span>
  );
}

/** Logo de un banco (cuentas de transferencia). */
export function BankTile({ slug, size = 22, className }: { slug: string | null; size?: number; className?: string }) {
  const bank = bankBySlug(slug);
  const src = slug ? bankIcon(slug) : null;
  return (
    <span
      className={cn("grid shrink-0 place-items-center overflow-hidden rounded-md border border-border bg-card", className)}
      style={{ width: size, height: size }}
      title={bank?.name ?? "Banco"}
    >
      {src && bank && !bank.fallback ? (
        <ThemedLogo src={src} alt={bank.name} className={cn("h-full w-full", !bank.iconFullBleed && "p-[12%]")} />
      ) : (
        <Landmark size={Math.round(size * 0.55)} className="text-muted-foreground" aria-label={bank?.name ?? "Banco"} />
      )}
    </span>
  );
}

// ── Estados ──────────────────────────────────────────────────────────────────

const TONE_TEXT: Record<MatchTone, string> = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  neutral: "text-muted-foreground",
};

const TONE_BG: Record<MatchTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  neutral: "bg-muted-foreground/40",
};

export type ChipIcon = "ok" | "pending" | "alert" | "review" | "seen" | "refund" | "risk" | "none";

const ICONS: Record<ChipIcon, LucideIcon> = {
  ok: CheckCircle2,
  pending: Clock,
  alert: AlertTriangle,
  review: CircleDashed,
  seen: Eye,
  refund: Undo2,
  risk: ShieldAlert,
  none: CircleDashed,
};

const DEFAULT_ICON: Record<MatchTone, ChipIcon> = {
  success: "ok",
  warning: "pending",
  danger: "alert",
  neutral: "review",
};

/**
 * Chip de estado neutro: relleno gris del tema, texto de primer plano y el
 * color sólo en el ícono (nunca un relleno o borde de color).
 */
export function StatusChip({
  label,
  tone = "neutral",
  icon,
  title,
  className,
}: {
  label: string;
  tone?: MatchTone;
  icon?: ChipIcon;
  title?: string;
  className?: string;
}) {
  const Icon = ICONS[icon ?? DEFAULT_ICON[tone]];
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-foreground",
        className,
      )}
    >
      <Icon size={12} className={cn("shrink-0", TONE_TEXT[tone])} aria-hidden />
      {label}
    </span>
  );
}

/** Punto de color (leyendas, bandeja). */
export function ToneDot({ tone, className }: { tone: MatchTone; className?: string }) {
  return <span aria-hidden className={cn("inline-block h-2 w-2 shrink-0 rounded-full", TONE_BG[tone], className)} />;
}

/** Barra horizontal con la proporción de cada estado (por cantidad). */
export function StatusBar({ segments, className }: { segments: StatusSegment[]; className?: string }) {
  const total = segments.reduce((a, s) => a + s.count, 0);
  if (total === 0) {
    return <div className={cn("h-2 w-full rounded-sm bg-muted", className)} aria-hidden />;
  }
  return (
    <div
      className={cn("flex h-2 w-full gap-px overflow-hidden rounded-sm bg-muted", className)}
      role="img"
      aria-label={segments.map((s) => `${s.label}: ${s.count}`).join(", ")}
    >
      {segments.map((s) => (
        <span
          key={s.key}
          className={cn("h-full", TONE_BG[s.tone], s.tone !== "neutral" && "opacity-80")}
          style={{ width: `${(s.count / total) * 100}%` }}
          title={`${s.label}: ${s.count}`}
        />
      ))}
    </div>
  );
}

// ── KPI ──────────────────────────────────────────────────────────────────────

export function KpiTile({
  icon: Icon,
  label,
  value,
  sub,
  tone,
  strip,
  className,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  sub?: React.ReactNode;
  tone?: "success" | "warning" | "danger";
  /** Franja arriba (alerta) en lugar de un borde al costado. */
  strip?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "min-w-0 rounded-lg border border-border bg-card px-4 py-3.5",
        strip && tone === "danger" && "rounded-t-none border-t-2 border-t-danger",
        strip && tone === "warning" && "rounded-t-none border-t-2 border-t-warning",
        className,
      )}
    >
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-muted text-foreground" aria-hidden>
          <Icon size={13} />
        </span>
        <span className="truncate">{label}</span>
      </div>
      <div
        className={cn(
          "mt-2 truncate font-price text-[22px] font-bold leading-tight tabular-nums",
          tone === "success" && "text-success",
          tone === "warning" && "text-warning",
          tone === "danger" && "text-danger",
        )}
      >
        {value}
      </div>
      {sub && <div className="mt-0.5 truncate text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}
