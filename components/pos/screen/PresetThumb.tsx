import type { CheckoutLayout, PosPreset } from "@/lib/pos/layout";
import { cn } from "@/lib/utils/cn";

// Miniaturas en vivo (selector rápido del POS y Configuración, Diseño del POS).
// Wireframes sobrios con los tonos neutros del tema: superficies, líneas y un
// único acento de marca mínimo para el botón de cobro. Proporciones reales de
// cada pantalla. Sin degradados ni colores por bloque.

const FRAME = "flex overflow-hidden rounded-md border border-border bg-background p-[5px]";
const PANEL = "rounded-[3px] bg-foreground/[0.06]";
const BLOCK = "rounded-[2px] bg-foreground/[0.12]";
const LINE = "rounded-full bg-foreground/[0.16]";
const STRONG = "rounded-full bg-foreground/[0.32]";
// Mismo color sólido que el CTA real del POS (--pos-solid, flame #DB3A14).
const CTA = "rounded-[2px] bg-[var(--pos-solid,#DB3A14)]";

export function PresetThumb({ preset, className }: { preset: PosPreset; className?: string }) {
  return (
    <span aria-hidden className={cn(FRAME, "gap-[4px]", className)}>
      {preset === "mostrador" && (
        <>
          <span className="flex flex-1 flex-col gap-[3px]">
            <span className={cn(PANEL, "h-[7px]")} />
            <span className="flex gap-[2px]">
              {Array.from({ length: 5 }, (_, i) => (
                <span key={i} className={cn("h-[4px] w-[14%]", i === 0 ? STRONG : LINE)} />
              ))}
            </span>
            <span className="grid flex-1 grid-cols-6 gap-[2px]">
              {Array.from({ length: 24 }, (_, i) => (
                <span key={i} className={BLOCK} />
              ))}
            </span>
          </span>
          <Cart />
        </>
      )}
      {preset === "boutique" && (
        <>
          <span className="flex w-[15%] flex-col gap-[3px] pt-[1px]">
            {Array.from({ length: 6 }, (_, i) => (
              <span key={i} className={cn("h-[4px]", i === 1 ? STRONG : LINE)} />
            ))}
          </span>
          <span className="grid flex-1 grid-cols-4 grid-rows-2 gap-[3px]">
            {Array.from({ length: 8 }, (_, i) => (
              <span key={i} className="flex flex-col gap-[2px]">
                <span className={cn(BLOCK, "flex-1")} />
                <span className={cn(LINE, "h-[3px] w-3/4")} />
                <span className={cn(LINE, "h-[3px] w-1/3")} />
              </span>
            ))}
          </span>
          <Cart />
        </>
      )}
      {preset === "salon" && (
        <>
          <span className={cn(PANEL, "relative w-[34%]")}>
            {[
              [10, 12, "rounded-full"],
              [44, 12, "rounded-full"],
              [10, 52, "rounded-[2px]"],
              [44, 52, "rounded-[2px]"],
              [72, 30, "rounded-full"],
            ].map(([l, t, r], i) => (
              <span
                key={i}
                className={cn("absolute h-[22%] w-[20%]", r as string, i === 1 ? "bg-foreground/[0.32]" : "bg-foreground/[0.14]")}
                style={{ left: `${l}%`, top: `${t}%` }}
              />
            ))}
          </span>
          <span className="flex flex-1 flex-col gap-[3px]">
            <span className="flex gap-[2px]">
              {Array.from({ length: 4 }, (_, i) => (
                <span key={i} className={cn("h-[4px] w-[18%]", i === 0 ? STRONG : LINE)} />
              ))}
            </span>
            <span className="grid flex-1 grid-cols-3 gap-[2px]">
              {Array.from({ length: 9 }, (_, i) => (
                <span key={i} className={BLOCK} />
              ))}
            </span>
          </span>
          <Cart />
        </>
      )}
      {preset === "caja_rapida" && (
        <>
          <span className="flex flex-1 flex-col gap-[3px]">
            <span className={cn(PANEL, "h-[8px]")} />
            {Array.from({ length: 7 }, (_, i) => (
              <span key={i} className="flex items-center gap-[3px]">
                <span className={cn(LINE, "h-[3px] flex-1")} />
                <span className={cn(STRONG, "h-[3px] w-[16%]")} />
              </span>
            ))}
          </span>
          <span className={cn(PANEL, "flex w-[34%] flex-col gap-[3px] p-[3px]")}>
            <span className={cn(STRONG, "ml-auto h-[5px] w-1/2")} />
            <span className="grid flex-1 grid-cols-3 gap-[2px]">
              {Array.from({ length: 12 }, (_, i) => (
                <span key={i} className={BLOCK} />
              ))}
            </span>
            <span className={cn(CTA, "h-[7px]")} />
          </span>
        </>
      )}
    </span>
  );
}

function Cart() {
  return (
    <span className={cn(PANEL, "flex w-[26%] flex-col gap-[3px] p-[3px]")}>
      {Array.from({ length: 4 }, (_, i) => (
        <span key={i} className="flex gap-[2px]">
          <span className={cn(LINE, "h-[3px] flex-1")} />
          <span className={cn(LINE, "h-[3px] w-[24%]")} />
        </span>
      ))}
      <span className="flex-1" />
      <span className={cn(STRONG, "ml-auto h-[4px] w-1/2")} />
      <span className={cn(CTA, "h-[7px]")} />
    </span>
  );
}

// Miniatura de cada distribución de la hoja de cobro.
export function CheckoutThumb({ layout, className }: { layout: CheckoutLayout; className?: string }) {
  const tile = (key: number, on = false, h = "h-[9px]") => (
    <span
      key={key}
      className={cn("flex items-center gap-[2px] rounded-[2px] px-[2px]", h, on ? "bg-foreground/[0.2]" : "bg-foreground/[0.08]")}
    >
      <span className="h-[4px] w-[4px] rounded-[1px] bg-foreground/[0.3]" />
      <span className={cn(LINE, "h-[2px] flex-1")} />
    </span>
  );
  return (
    <span aria-hidden className={cn(FRAME, "gap-[4px]", className)}>
      {layout === "two_columns" && (
        <>
          <span className="flex flex-1 flex-col gap-[3px]">
            <span className={cn(STRONG, "h-[4px] w-1/3")} />
            <span className="grid grid-cols-3 gap-[2px]">{[0, 1, 2, 3, 4, 5].map((i) => tile(i, i === 0))}</span>
            <span className="grid grid-cols-3 gap-[2px]">{[6, 7, 8].map((i) => tile(i))}</span>
          </span>
          <span className={cn(PANEL, "flex w-[38%] flex-col gap-[3px] p-[3px]")}>
            <span className={cn(LINE, "h-[2px] w-1/3")} />
            <span className={cn(STRONG, "h-[6px] w-2/3")} />
            <span className={cn(BLOCK, "flex-1")} />
            <span className={cn(CTA, "h-[7px]")} />
          </span>
        </>
      )}
      {layout === "compact_list" && (
        <span className="mx-auto flex w-[56%] flex-col gap-[3px]">
          <span className={cn(STRONG, "h-[6px] w-1/2")} />
          {[0, 1, 2, 3].map((i) => tile(i, i === 1, "h-[8px]"))}
          <span className="flex-1" />
          <span className={cn(CTA, "h-[7px]")} />
        </span>
      )}
      {layout === "keypad_first" && (
        <>
          <span className="flex flex-1 flex-col gap-[3px]">
            <span className={cn(STRONG, "h-[6px] w-1/2")} />
            <span className="grid flex-1 grid-cols-3 gap-[2px]">
              {Array.from({ length: 12 }, (_, i) => (
                <span key={i} className={BLOCK} />
              ))}
            </span>
          </span>
          <span className={cn(PANEL, "flex w-[36%] flex-col gap-[3px] p-[3px]")}>
            <span className="grid grid-cols-2 gap-[2px]">{[0, 1, 2, 3].map((i) => tile(i, i === 0, "h-[7px]"))}</span>
            <span className="flex-1" />
            <span className={cn(CTA, "h-[7px]")} />
          </span>
        </>
      )}
      {layout === "big_buttons" && (
        <>
          <span className="grid flex-1 grid-cols-2 gap-[3px]">
            {[0, 1, 2, 3].map((i) => (
              <span
                key={i}
                className={cn("flex flex-col justify-end gap-[2px] rounded-[3px] p-[3px]", i === 0 ? "bg-foreground/[0.2]" : "bg-foreground/[0.08]")}
              >
                <span className="h-[6px] w-[6px] rounded-[1px] bg-foreground/[0.3]" />
                <span className={cn(LINE, "h-[3px] w-2/3")} />
              </span>
            ))}
          </span>
          <span className={cn(PANEL, "flex w-[36%] flex-col gap-[3px] p-[3px]")}>
            <span className={cn(STRONG, "h-[6px] w-2/3")} />
            <span className={cn(BLOCK, "flex-1")} />
            <span className={cn(CTA, "h-[10px]")} />
          </span>
        </>
      )}
    </span>
  );
}
