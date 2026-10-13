import Link from "next/link";
import { AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils/cn";

// Piezas compartidas de las pantallas de auth (login, recuperar, blanquear,
// login interno) para que todas tengan la misma jerarquía.

export function AuthHeading({
  title,
  description,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("mb-8", className)}>
      <h1 className="font-sans text-[1.75rem] font-bold leading-tight tracking-[-0.02em] text-foreground">
        {title}
      </h1>
      {description && (
        <p className="mt-2 text-[0.9375rem] leading-relaxed text-muted-foreground">
          {description}
        </p>
      )}
    </header>
  );
}

/** Aviso de error del servidor (credenciales, OAuth, enlace vencido). */
export function AuthAlert({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-2.5 rounded-lg bg-destructive/10 p-3 text-sm text-danger",
        className,
      )}
    >
      <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden />
      <div>{children}</div>
    </div>
  );
}

export function AuthDivider({ label }: { label: string }) {
  return (
    <div className="my-6 flex items-center gap-3" role="separator" aria-label={label}>
      <span className="h-px flex-1 bg-border" aria-hidden />
      <span className="text-xs text-muted-foreground" aria-hidden>
        {label}
      </span>
      <span className="h-px flex-1 bg-border" aria-hidden />
    </div>
  );
}

/** Link de texto de auth con foco visible. */
export function AuthLink({
  href,
  children,
  className,
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href as never}
      className={cn(
        "rounded-sm font-medium text-ninja-flameSoft underline-offset-4 outline-none hover:underline focus-visible:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        className,
      )}
    >
      {children}
    </Link>
  );
}
