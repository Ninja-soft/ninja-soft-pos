import { cn } from "@/lib/utils/cn";

// Sistema tipográfico NinjaSoft.
//   - Texto y títulos: Inter (font-sans) → lectura clara en todo el dashboard.
//   - Destacados (eyebrows, acentos, nombres): Space Grotesk (font-display, tech).
//   - Precios/números: ver componente <Money> (font-mono tabular-nums).

export function Eyebrow({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2.5 font-display text-[11px] font-medium uppercase tracking-[0.24em] text-muted-foreground",
        className,
      )}
    >
      <span className="h-px w-6 bg-ninja-flame" aria-hidden />
      {children}
    </span>
  );
}

type AccentTone = "muted" | "gradient";

export function Accent({
  children,
  tone = "gradient",
  className,
}: {
  children: React.ReactNode;
  tone?: AccentTone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "font-display",
        tone === "gradient"
          ? "bg-ninja-gradient bg-clip-text text-transparent"
          : "text-ninja-flameSoft",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Display({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <h1
      className={cn(
        "font-sans text-3xl font-extrabold leading-[1.1] tracking-[-0.02em] md:text-5xl",
        className,
      )}
    >
      {children}
    </h1>
  );
}

export function Heading({
  as: Tag = "h2",
  children,
  className,
}: {
  as?: "h1" | "h2" | "h3";
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Tag
      className={cn(
        "font-sans text-xl font-bold tracking-[-0.01em] md:text-2xl",
        className,
      )}
    >
      {children}
    </Tag>
  );
}

/** Monto/precio con fuente mono tabular (alineación de dígitos). */
export function Money({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("font-mono tabular-nums", className)}>{children}</span>
  );
}
