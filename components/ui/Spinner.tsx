import { cn } from "@/lib/utils/cn";

// Spinner de carga reutilizable.
export function Spinner({
  size = 20,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <span
      role="status"
      aria-label="Cargando"
      className={cn(
        "inline-block animate-spin rounded-full border-2 border-muted-foreground/30 border-t-ninja-flameSoft",
        className,
      )}
      style={{ width: size, height: size }}
    />
  );
}

// Spinner centrado para bloques/áreas que están cargando.
export function SpinnerBlock({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center justify-center py-10", className)}>
      <Spinner size={24} />
    </div>
  );
}
