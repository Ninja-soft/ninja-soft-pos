"use client";

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils/cn";

// Select con estilo propio sobre Radix Popover. Reemplaza al <select> nativo
// donde la lista tiene que verse del tema (fondo popover opaco, selección
// neutra con check, sin bordes de color). Accesible como listbox: flechas,
// Inicio / Fin, Enter o Espacio eligen y Escape cierra.

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  description?: string;
  icon?: ReactNode;
  disabled?: boolean;
}

interface SelectProps<T extends string> {
  value: T | null;
  options: SelectOption<T>[];
  onChange: (v: T) => void;
  label?: string;
  hint?: string;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
  "aria-label"?: string;
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
  hint,
  placeholder = "Elegí una opción",
  disabled,
  id,
  className,
  "aria-label": ariaLabel,
}: SelectProps<T>) {
  const generated = useId();
  const triggerId = id ?? generated;
  const listId = `${triggerId}-list`;
  const [open, setOpen] = useState(false);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const current = options.find((o) => o.value === value) ?? null;

  const focusAt = (i: number) => {
    const enabled = options.map((o, k) => (o.disabled ? -1 : k)).filter((k) => k >= 0);
    if (enabled.length === 0) return;
    const idx = enabled.includes(i) ? i : enabled[0]!;
    refs.current[idx]?.focus();
  };

  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = refs.current.findIndex((el) => el === document.activeElement);
    const enabled = options.map((o, k) => (o.disabled ? -1 : k)).filter((k) => k >= 0);
    const pos = enabled.indexOf(at);
    let next: number | null = null;
    if (e.key === "ArrowDown") next = enabled[Math.min(enabled.length - 1, pos + 1)] ?? null;
    else if (e.key === "ArrowUp") next = enabled[Math.max(0, pos - 1)] ?? null;
    else if (e.key === "Home") next = enabled[0] ?? null;
    else if (e.key === "End") next = enabled[enabled.length - 1] ?? null;
    if (next !== null) {
      e.preventDefault();
      refs.current[next]?.focus();
    }
  };

  return (
    <div className={cn("w-full", className)}>
      {label && (
        <label htmlFor={triggerId} className="mb-2 block text-sm font-medium text-muted-foreground">
          {label}
        </label>
      )}
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild disabled={disabled}>
          <button
            id={triggerId}
            type="button"
            role="combobox"
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-controls={listId}
            aria-label={ariaLabel}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setOpen(true);
              }
            }}
            className={cn(
              "flex h-11 w-full items-center gap-2 rounded-lg border border-input bg-background px-3.5 text-left text-sm text-foreground outline-none transition",
              "focus-visible:border-ninja-flameSoft focus-visible:ring-2 focus-visible:ring-ninja-flameSoft/20 data-[state=open]:border-ninja-flameSoft",
              "disabled:cursor-not-allowed disabled:opacity-60",
            )}
          >
            {current?.icon && <span className="grid shrink-0 place-items-center">{current.icon}</span>}
            <span className={cn("min-w-0 flex-1 truncate", !current && "text-muted-foreground")}>
              {current?.label ?? placeholder}
            </span>
            <ChevronDown
              size={16}
              aria-hidden
              className={cn("shrink-0 text-muted-foreground transition", open && "rotate-180")}
            />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="start"
            sideOffset={6}
            collisionPadding={12}
            onOpenAutoFocus={(e) => {
              e.preventDefault();
              focusAt(Math.max(0, options.findIndex((o) => o.value === value)));
            }}
            className="z-[60] max-h-[min(320px,var(--radix-popover-content-available-height))] w-[var(--radix-popover-trigger-width)] min-w-44 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground animate-fade-in"
          >
            <div id={listId} role="listbox" aria-label={label ?? ariaLabel} onKeyDown={onListKey}>
              {options.map((o, i) => {
                const selected = o.value === value;
                return (
                  <button
                    key={o.value}
                    ref={(el) => {
                      refs.current[i] = el;
                    }}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    disabled={o.disabled}
                    onClick={() => {
                      onChange(o.value);
                      setOpen(false);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm outline-none transition",
                      "hover:bg-muted focus-visible:bg-muted disabled:cursor-not-allowed disabled:opacity-50",
                      selected && "bg-[var(--choice-fill)] font-semibold",
                    )}
                  >
                    {o.icon && <span className="grid shrink-0 place-items-center">{o.icon}</span>}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{o.label}</span>
                      {o.description && (
                        <span className="block text-xs font-normal text-muted-foreground">{o.description}</span>
                      )}
                    </span>
                    {selected && <Check size={15} aria-hidden className="shrink-0 text-foreground" />}
                  </button>
                );
              })}
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {hint && <p className="mt-2 text-sm text-muted-foreground">{hint}</p>}
    </div>
  );
}
