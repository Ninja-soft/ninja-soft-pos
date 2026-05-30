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
        "inline-flex items-center gap-2 rounded-full border border-border bg-muted/50 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground",
        className,
      )}
    >
      <span
        className="h-1.5 w-1.5 rounded-full bg-ninja-gradient shadow-ninjaGlow"
        aria-hidden
      />
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
    <span className={cn("font-price tabular-nums", className)}>{children}</span>
  );
}
