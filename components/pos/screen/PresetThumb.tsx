import type { PosPreset } from "@/lib/pos/layout";
import { cn } from "@/lib/utils/cn";

// Miniatura en vivo de cada preset (selector rápido y Configuración). Dibuja
// el esqueleto real de la pantalla: dónde va la grilla, el carrito y el cobro.
// Tonos neutros del tema; el acento sólo marca el botón de cobro.

const cell = "rounded-[2px] bg-foreground/[0.14]";
const soft = "rounded-full bg-foreground/[0.2]";
const cta = "rounded-[2px] bg-[var(--pos-solid,#DB3A14)]";

export function PresetThumb({ preset, className }: { preset: PosPreset; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("flex gap-[3px] overflow-hidden rounded-md bg-fg-4 p-[5px] ring-1 ring-inset ring-border", className)}
    >
      {preset === "mostrador" && (
        <>
          <span className="flex flex-1 flex-col gap-[3px]">
            <span className="h-[7px] rounded-[2px] bg-foreground/[0.2]" />
            <span className="grid flex-1 grid-cols-6 gap-[2px]">
              {Array.from({ length: 24 }, (_, i) => (
                <span key={i} className={cell} />
              ))}
            </span>
          </span>
          <Cart />
        </>
      )}
      {preset === "boutique" && (
        <>
          <span className="flex w-[16%] flex-col gap-[3px]">
            {Array.from({ length: 5 }, (_, i) => (
              <span key={i} className={cn("h-[5px] rounded-full", i === 1 ? "bg-foreground/40" : "bg-foreground/[0.16]")} />
            ))}
          </span>
          <span className="grid flex-1 grid-cols-4 gap-[3px]">
            {Array.from({ length: 8 }, (_, i) => (
              <span key={i} className="flex flex-col gap-[2px]">
                <span className="flex-1 rounded-[2px] bg-foreground/[0.18]" />
                <span className={cn(soft, "h-[3px]")} />
              </span>
            ))}
          </span>
          <Cart />
        </>
      )}
      {preset === "salon" && (
        <>
          <span className="grid w-[30%] grid-cols-3 content-start gap-[3px]">
            {Array.from({ length: 9 }, (_, i) => (
              <span key={i} className="relative aspect-square rounded-[3px] bg-foreground/[0.14]">
                <span
                  className={cn(
                    "absolute right-[2px] top-[2px] h-[3px] w-[3px] rounded-full",
                    i % 3 === 0 ? "bg-warning" : i === 7 ? "bg-info" : "bg-success",
                  )}
                />
              </span>
            ))}
          </span>
          <span className="grid flex-1 grid-cols-3 content-start gap-[2px]">
            {Array.from({ length: 9 }, (_, i) => (
              <span key={i} className={cn(cell, "h-[10px]")} />
            ))}
          </span>
          <Cart />
        </>
      )}
      {preset === "caja_rapida" && (
        <>
          <span className="flex flex-1 flex-col gap-[3px]">
            <span className="h-[9px] rounded-[2px] bg-foreground/[0.22]" />
            {Array.from({ length: 6 }, (_, i) => (
              <span key={i} className="flex gap-[3px]">
                <span className={cn(soft, "h-[4px] flex-1 bg-foreground/[0.14]")} />
                <span className={cn(soft, "h-[4px] w-[18%]")} />
              </span>
            ))}
          </span>
          <span className="flex w-[34%] flex-col gap-[3px]">
            <span className="h-[8px] rounded-[2px] bg-foreground/[0.2]" />
            <span className="grid flex-1 grid-cols-3 gap-[2px]">
              {Array.from({ length: 12 }, (_, i) => (
                <span key={i} className={cell} />
              ))}
            </span>
            <span className={cn(cta, "h-[8px]")} />
          </span>
        </>
      )}
    </span>
  );
}

function Cart() {
  return (
    <span className="flex w-[26%] flex-col gap-[3px] rounded-[3px] bg-foreground/[0.07] p-[3px]">
      {Array.from({ length: 4 }, (_, i) => (
        <span key={i} className={cn(soft, "h-[4px] bg-foreground/[0.18]")} />
      ))}
      <span className="flex-1" />
      <span className="h-[5px] rounded-[2px] bg-foreground/[0.2]" />
      <span className={cn(cta, "h-[8px]")} />
    </span>
  );
}
