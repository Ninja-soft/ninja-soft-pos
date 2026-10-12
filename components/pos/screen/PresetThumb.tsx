import type { PosPreset } from "@/lib/pos/layout";
import { cn } from "@/lib/utils/cn";

// Miniatura en vivo de cada preset (selector rápido y Configuración). Dibuja
// el esqueleto real de la pantalla: dónde va la grilla, el carrito y el cobro.

const cell = "rounded-[3px] bg-white/20";
const fire = "rounded-[3px] bg-[linear-gradient(135deg,var(--pos-from,#FF4B22),var(--pos-to,#FFD21F))]";

export function PresetThumb({ preset, className }: { preset: PosPreset; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex gap-[3px] overflow-hidden rounded-xl bg-[linear-gradient(160deg,#160E3A,#0B0720)] p-[5px]",
        className,
      )}
    >
      {preset === "mostrador" && (
        <>
          <span className="flex flex-1 flex-col gap-[3px]">
            <span className="h-[7px] rounded-full bg-white/25" />
            <span className="grid flex-1 grid-cols-6 gap-[2px]">
              {Array.from({ length: 24 }, (_, i) => (
                <span key={i} className={i < 3 ? "rounded-[3px] bg-[#FF8A1F]/70" : cell} />
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
              <span key={i} className={cn("h-[6px] rounded-full", i === 1 ? "bg-white/70" : "bg-white/20")} />
            ))}
          </span>
          <span className="grid flex-1 grid-cols-4 gap-[3px]">
            {Array.from({ length: 8 }, (_, i) => (
              <span key={i} className="flex flex-col gap-[2px]">
                <span
                  className={cn(
                    "flex-1 rounded-[3px] bg-gradient-to-br",
                    ["from-[#FF4B22] to-[#FFB21F]", "from-[#5B2EFF] to-[#B79CFF]", "from-[#0369A1] to-[#67E8F9]", "from-[#047857] to-[#6EE7B7]"][i % 4],
                  )}
                />
                <span className="h-[3px] rounded-full bg-white/25" />
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
              <span
                key={i}
                className={cn(
                  "aspect-square rounded-[4px]",
                  i === 4 ? "bg-white/80" : i % 3 === 0 ? "bg-amber-400/50" : i === 7 ? "bg-sky-400/50" : "bg-white/20",
                )}
              />
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
            <span className="h-[9px] rounded-[4px] bg-white/35" />
            {Array.from({ length: 6 }, (_, i) => (
              <span key={i} className="flex gap-[3px]">
                <span className="h-[4px] flex-1 rounded-full bg-white/20" />
                <span className="h-[4px] w-[18%] rounded-full bg-white/30" />
              </span>
            ))}
          </span>
          <span className="flex w-[34%] flex-col gap-[3px]">
            <span className="h-[8px] rounded-[3px] bg-white/30" />
            <span className="grid flex-1 grid-cols-3 gap-[2px]">
              {Array.from({ length: 12 }, (_, i) => (
                <span key={i} className={cell} />
              ))}
            </span>
            <span className={cn(fire, "h-[8px]")} />
          </span>
        </>
      )}
    </span>
  );
}

function Cart() {
  return (
    <span className="flex w-[26%] flex-col gap-[3px] rounded-[5px] bg-white/[0.07] p-[3px]">
      {Array.from({ length: 4 }, (_, i) => (
        <span key={i} className="h-[4px] rounded-full bg-white/25" />
      ))}
      <span className="flex-1" />
      <span className="h-[6px] rounded-[3px] bg-white/30" />
      <span className={cn(fire, "h-[8px]")} />
    </span>
  );
}
