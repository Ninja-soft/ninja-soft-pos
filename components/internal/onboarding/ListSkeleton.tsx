import { Skeleton } from "@/components/ui/Skeleton";

// Esqueleto de una lista en card (recorridos, sugerencias): mantiene el layout
// mientras carga, sin texto "Cargando".
export function ListSkeleton({ rows = 3, label = "Cargando" }: { rows?: number; label?: string }) {
  return (
    <div
      aria-busy="true"
      aria-label={label}
      className="divide-y divide-border rounded-lg border border-border bg-card"
    >
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-start gap-3 p-4">
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-4 w-48 max-w-full" />
            <Skeleton className="h-3 w-72 max-w-full" />
          </div>
          <Skeleton className="h-9 w-20" />
        </div>
      ))}
    </div>
  );
}
ListSkeleton.displayName = "ListSkeleton";
