"use client";

import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { DayPicker, type DateRange } from "react-day-picker";
import { es } from "date-fns/locale";
import {
  format,
  startOfMonth,
  endOfMonth,
  subDays,
  subMonths,
  startOfDay,
} from "date-fns";
import { Calendar } from "lucide-react";
import "react-day-picker/style.css";
import { cn } from "@/lib/utils/cn";

export type { DateRange };

type Preset = { label: string; range: () => DateRange };

// new Date() está permitido en código de app (la restricción es solo para workflows).
const PRESETS: Preset[] = [
  { label: "Hoy", range: () => ({ from: startOfDay(new Date()), to: startOfDay(new Date()) }) },
  {
    label: "Ayer",
    range: () => {
      const d = startOfDay(subDays(new Date(), 1));
      return { from: d, to: d };
    },
  },
  { label: "Últimos 7 días", range: () => ({ from: startOfDay(subDays(new Date(), 6)), to: startOfDay(new Date()) }) },
  { label: "Últimos 30 días", range: () => ({ from: startOfDay(subDays(new Date(), 29)), to: startOfDay(new Date()) }) },
  { label: "Este mes", range: () => ({ from: startOfMonth(new Date()), to: startOfDay(new Date()) }) },
  {
    label: "Mes pasado",
    range: () => {
      const last = subMonths(new Date(), 1);
      return { from: startOfMonth(last), to: endOfMonth(last) };
    },
  },
];

function labelFor(value: DateRange | undefined): string {
  if (!value?.from) return "Elegí fechas";
  const f = format(value.from, "dd/MM/yy", { locale: es });
  if (!value.to) return f;
  return `${f} – ${format(value.to, "dd/MM/yy", { locale: es })}`;
}

export function DateRangePicker({
  value,
  onChange,
  className,
}: {
  value: DateRange | undefined;
  onChange: (range: DateRange | undefined) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex h-11 items-center gap-2 rounded-lg border border-input bg-background px-4 text-sm text-foreground outline-none transition hover:border-ninja-flameSoft/50 focus:border-ninja-flameSoft focus:ring-4 focus:ring-ninja-flameSoft/15",
            className,
          )}
        >
          <Calendar size={16} className="text-muted-foreground" />
          {labelFor(value)}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={6}
          avoidCollisions={false}
          className="z-50 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-ninjaSoft outline-none"
        >
          <div className="flex flex-col gap-3 sm:flex-row">
            <div className="flex flex-row flex-wrap gap-1 sm:flex-col sm:border-r sm:border-border sm:pr-3">
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => {
                    onChange(p.range());
                    setOpen(false);
                  }}
                  className="rounded-md px-3 py-1.5 text-left text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
                >
                  {p.label}
                </button>
              ))}
            </div>
            <DayPicker
              className="rdp-ninja"
              mode="range"
              locale={es}
              weekStartsOn={1}
              numberOfMonths={2}
              selected={value}
              onSelect={onChange}
            />
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
