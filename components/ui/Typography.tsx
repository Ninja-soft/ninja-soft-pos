import { cn } from "@/lib/utils/cn";

// Sistema tipográfico NinjaSoft. Ver brandBook §16 (Jerarquía) y §14-15.
// Device de marca: título en Nunito bold (roman) + palabra acento en itálica.
//   - tono "muted"  → lavanda (títulos de sección).
//   - tono "gradient" → degradado flame→gold (énfasis fuerte / hero).

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
        "inline-flex items-center gap-2.5 text-[11px] font-semibold uppercase tracking-[0.24em] text-muted-foreground",
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
  tone = "muted",
  className,
}: {
  children: React.ReactNode;
  tone?: AccentTone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "font-display italic",
        tone === "gradient"
          ? "bg-ninja-gradient bg-clip-text text-transparent"
          : "text-ninja-lavender",
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
        "font-display text-4xl font-black leading-[1.05] tracking-[-0.04em] md:text-6xl",
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
        "font-display text-2xl font-bold tracking-[-0.03em] md:text-3xl",
        className,
      )}
    >
      {children}
    </Tag>
  );
}
