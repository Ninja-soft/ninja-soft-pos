"use client";

import * as Popover from "@radix-ui/react-popover";
import Link from "next/link";
import { LayoutTemplate, Lock, MonitorSmartphone, Settings2, Undo2 } from "lucide-react";
import { InfoHint } from "@/components/ui/InfoHint";
import { choiceClass } from "@/components/ui/ChoiceCard";
import { POS_PRESETS, PRESET_INFO, type PosPreset } from "@/lib/pos/layout";
import { cn } from "@/lib/utils/cn";
import { PresetThumb } from "./PresetThumb";

// Barra superior del POS: estado de la caja, pantalla del cliente y el
// selector rápido de diseño (override del usuario; el del negocio se define
// en Configuración, Diseño del POS). Todos los controles miden 44px.

const iconBtn =
  "grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-fg-4 text-muted-foreground transition-colors hover:bg-fg-6 hover:text-foreground";

export function PosTopBar({
  hasShift,
  registerName,
  location,
  onOpenShift,
  onCloseShift,
  onCustomerDisplay,
  pendingSlot,
  preset,
  usingOwn,
  diningEnabled,
  onPickPreset,
  onResetPreset,
}: {
  hasShift: boolean;
  registerName: string | null;
  // Sucursal y caja del dispositivo ("Centro · Caja 1", F17 · H90). Con
  // ubicación el botón de estado sólo dice abierta o cerrada.
  location?: React.ReactNode;
  onOpenShift: () => void;
  onCloseShift: () => void;
  onCustomerDisplay: () => void;
  // Botón "Cobros en espera" con su contador (ADR-048).
  pendingSlot?: React.ReactNode;
  preset: PosPreset;
  usingOwn: boolean;
  diningEnabled: boolean;
  onPickPreset: (p: PosPreset) => void;
  onResetPreset: () => void;
}) {
  return (
    // En el celular no hay título: la caja va a la izquierda y la fila arranca
    // pegada al header de la app (sin franja vacía arriba).
    <header className="flex shrink-0 items-center gap-2 px-3 pb-3 pt-2 sm:pt-3 md:px-4">
      <h1 className="hidden items-center gap-1.5 font-display text-lg font-semibold tracking-tight sm:flex">
        Punto de venta
        <InfoHint section="pos" />
      </h1>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 sm:ml-auto sm:flex-none">
        {location}
        {/* Estado de la caja: punto de estado + texto, relleno neutro. */}
        <button
          type="button"
          onClick={hasShift ? onCloseShift : onOpenShift}
          className="mr-auto flex h-11 min-w-0 items-center gap-2.5 rounded-lg bg-fg-4 pl-3 pr-3.5 text-[13px] transition-colors hover:bg-fg-6 sm:mr-0"
          title={hasShift ? "Cerrar caja (arqueo)" : "Abrir caja"}
        >
          <span
            aria-hidden
            className={cn(
              "h-2 w-2 shrink-0 rounded-full",
              hasShift ? "bg-success shadow-[0_0_0_3px_rgb(var(--status-success)/0.18)]" : "bg-muted-foreground/60",
            )}
          />
          <span className="truncate font-medium text-foreground">
            {location
              ? hasShift
                ? "Abierta"
                : "Cerrada"
              : hasShift
                ? registerName
                  ? `${registerName} abierta`
                  : "Caja abierta"
                : "Caja cerrada"}
          </span>
          <span className="hidden shrink-0 border-l border-border pl-2.5 text-xs font-medium text-muted-foreground sm:inline">
            {hasShift ? "Cerrar" : "Abrir"}
          </span>
        </button>
        {pendingSlot}
        <button
          type="button"
          onClick={onCustomerDisplay}
          className={iconBtn}
          aria-label="Abrir la pantalla del cliente"
          title="Pantalla del cliente (arrastrala al segundo monitor)"
        >
          <MonitorSmartphone size={18} aria-hidden />
        </button>
        <Popover.Root>
          <Popover.Trigger asChild>
            <button
              type="button"
              className={cn(iconBtn, "data-[state=open]:bg-fg-10 data-[state=open]:text-foreground")}
              aria-label="Cambiar el diseño del POS"
              title="Diseño del POS"
            >
              <LayoutTemplate size={18} aria-hidden />
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              align="end"
              sideOffset={8}
              className="z-50 w-[min(92vw,360px)] rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-xl animate-fade-in"
            >
              <p className="px-1 text-sm font-semibold">Diseño de esta pantalla</p>
              <p className="px-1 pb-3 text-xs text-muted-foreground">
                {usingOwn ? "Usás un diseño propio en tu usuario." : "Usás el diseño del negocio."}
              </p>
              <div className="grid grid-cols-2 gap-2" role="group" aria-label="Diseño del POS">
                {POS_PRESETS.map((p) => {
                  const info = PRESET_INFO[p];
                  const blocked = info.requiresDining && !diningEnabled;
                  const on = preset === p;
                  return (
                    <Popover.Close asChild key={p}>
                      <button
                        type="button"
                        aria-pressed={on}
                        disabled={blocked}
                        onClick={() => onPickPreset(p)}
                        className={choiceClass(on, "rounded-lg p-1.5")}
                      >
                        <PresetThumb preset={p} className={cn("h-[68px] w-full", blocked && "opacity-50")} />
                        <span className="flex items-center gap-1 px-1 pt-1.5 text-xs font-semibold">
                          {blocked && <Lock size={11} aria-hidden />}
                          {info.name}
                        </span>
                        {blocked && (
                          <span className="block px-1 text-[11px] text-muted-foreground">Activá el modo gastronómico</span>
                        )}
                      </button>
                    </Popover.Close>
                  );
                })}
              </div>
              <div className="mt-3 flex items-center justify-between gap-2 border-t border-border px-1 pt-2.5">
                {usingOwn ? (
                  <Popover.Close asChild>
                    <button
                      type="button"
                      onClick={onResetPreset}
                      className="flex h-8 items-center gap-1.5 rounded-md text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <Undo2 size={14} aria-hidden /> Volver al del negocio
                    </button>
                  </Popover.Close>
                ) : (
                  <span />
                )}
                <Link
                  href="/configuracion?seccion=diseno-pos"
                  className="flex h-8 items-center gap-1.5 rounded-md text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                >
                  <Settings2 size={14} aria-hidden /> Personalizar
                </Link>
              </div>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      </div>
    </header>
  );
}
