import { Package } from "lucide-react";
import { cn } from "@/lib/utils/cn";

// Portada de un catálogo vendible (Tiendita y panel interno).
//
// Las portadas traen su propio arte y texto (título, "Más de N mil productos",
// "PAGO ÚNICO"), así que se muestran completas: contenedor 16:9 con
// object-contain y NADA superpuesto. Si la imagen no es 16:9, el sobrante queda
// en un fondo plano de superficie (sin gradientes). Sin portada: placeholder
// plano con el nombre del catálogo.
export function CatalogCover({
  coverUrl,
  name,
  className,
}: {
  coverUrl: string | null;
  name: string;
  className?: string;
}) {
  return (
    <div className={cn("relative aspect-[16/9] w-full overflow-hidden bg-muted", className)}>
      {coverUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={coverUrl} alt={`Portada de ${name}`} loading="lazy" className="h-full w-full object-contain" />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-6 text-center">
          <Package size={28} strokeWidth={1.5} className="text-muted-foreground" aria-hidden />
          <span className="line-clamp-2 font-display text-xl font-bold tracking-tight text-foreground sm:text-2xl">
            {name}
          </span>
          <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Catálogo</span>
        </div>
      )}
    </div>
  );
}
