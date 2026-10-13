import { cn } from "@/lib/utils/cn";

// Placeholder de carga (TX-3). Bloque tonal con pulso suave, sin sombras ni
// gradientes. Decorativo: el contenedor que carga lleva aria-busy y la
// etiqueta accesible; cada bloque queda oculto para lectores de pantalla.
// Respeta prefers-reduced-motion (motion-safe).
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn("rounded-md bg-muted motion-safe:animate-pulse", className)}
    />
  );
}
Skeleton.displayName = "Skeleton";

/** Varias líneas de texto en carga (listas, tablas chicas). */
export function SkeletonLines({
  lines = 3,
  className,
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <div aria-hidden className={cn("space-y-2", className)}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton
          key={i}
          className={cn("h-3.5", i === lines - 1 ? "w-2/3" : "w-full")}
        />
      ))}
    </div>
  );
}
SkeletonLines.displayName = "SkeletonLines";
