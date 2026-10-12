import { cn } from "@/lib/utils/cn";
import { POS_PANEL } from "../ui/posStyles";

// Marco neutro del POS mientras no se sabe qué diseño usar (primera carga en el
// dispositivo, sin foto guardada). No tiene estructura de ningún preset: barra
// superior, área principal y panel lateral genéricos. Mide lo mismo que
// PosShell para que el cambio al diseño real no mueva la página.

const bar = "animate-pulse rounded-lg bg-fg-4";

export function PosBootSkeleton() {
  return (
    <div
      data-pos-skeleton=""
      aria-busy="true"
      className="pos-root relative flex h-[calc(100dvh-3.5rem-env(safe-area-inset-top))] flex-col overflow-hidden lg:h-dvh"
    >
      <span className="sr-only" role="status">
        Cargando el punto de venta
      </span>
      <div className="flex shrink-0 items-center gap-2 px-3 pb-3 pt-2 sm:pt-3 md:px-4" aria-hidden>
        <span className="hidden font-display text-lg font-semibold tracking-tight sm:block">Punto de venta</span>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 sm:ml-auto sm:flex-none">
          <span className={cn(bar, "h-11 w-32 sm:w-44")} />
          <span className={cn(bar, "mr-auto h-11 w-24 sm:mr-0")} />
          <span className={cn(bar, "h-11 w-11")} />
          <span className={cn(bar, "h-11 w-11")} />
        </div>
      </div>
      <div className="flex min-h-0 flex-1 gap-3 px-3 pb-3 md:px-4 md:pb-4" aria-hidden>
        <div className="min-w-0 flex-1">
          <span className={cn(bar, "block h-11 w-full")} />
        </div>
        <div className={cn("hidden w-[330px] shrink-0 md:block lg:w-[380px]", POS_PANEL)} />
      </div>
    </div>
  );
}
