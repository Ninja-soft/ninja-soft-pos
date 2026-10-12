import { cn } from "@/lib/utils/cn";

// Spinner de carga reutilizable.
export function Spinner({
  size = 20,
  className,
  label = "Cargando",
}: {
  size?: number;
  className?: string;
  /** Nombre accesible (lo anuncia el lector de pantalla). */
  label?: string;
}) {
  return (
    <span
      role="status"
      aria-label={label}
      className={cn(
        "inline-block animate-spin rounded-full border-2 border-muted-foreground/30 border-t-ninja-flameSoft",
        className,
      )}
      style={{ width: size, height: size }}
    />
  );
}

// Spinner centrado para bloques/áreas que están cargando.
export function SpinnerBlock({ className, label }: { className?: string; label?: string }) {
  return (
    <div className={cn("flex items-center justify-center py-10", className)}>
      <Spinner size={24} label={label} />
    </div>
  );
}
