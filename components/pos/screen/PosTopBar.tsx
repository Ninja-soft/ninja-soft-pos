"use client";

import * as Popover from "@radix-ui/react-popover";
import Link from "next/link";
import { LayoutTemplate, Lock, MonitorSmartphone, Settings2, X } from "lucide-react";
import { InfoHint } from "@/components/ui/InfoHint";
import { choiceClass } from "@/components/ui/ChoiceCard";
import { POS_PRESETS, PRESET_INFO, type PosPreset } from "@/lib/pos/layout";
import { cn } from "@/lib/utils/cn";
import { PresetThumb } from "./PresetThumb";

// Barra superior del POS: estado de la caja, pantalla del cliente y el
// selector rápido de diseño (override del usuario; el del negocio se define
// en Configuración, Diseño del POS).

export function PosTopBar({
  hasShift,
  registerName,
  onOpenShift,
  onCloseShift,
  onCustomerDisplay,
  preset,
  usingOwn,
  diningEnabled,
  onPickPreset,
  onResetPreset,
}: {
  hasShift: boolean;
  registerName: string | null;
  onOpenShift: () => void;
  onCloseShift: () => void;
  onCustomerDisplay: () => void;
  preset: PosPreset;
  usingOwn: boolean;
  diningEnabled: boolean;
  onPickPreset: (p: PosPreset) => void;
  onResetPreset: () => void;
}) {
  return (
    // En el celular no hay título: la caja va a la izquierda y la fila arranca
    // pegada al header de la app (sin franja vacía arriba).
    <header className="flex shrink-0 items-center gap-2 px-3 pb-2 pt-2 sm:pt-3 md:px-4">
      <h1 className="hidden items-center gap-2 font-display text-lg font-black tracking-tight sm:flex">
        Punto de venta
        <InfoHint section="pos" />
      </h1>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 sm:ml-auto sm:flex-none">
        <button
          type="button"
          onClick={hasShift ? onCloseShift : onOpenShift}
          className={cn(
            "mr-auto flex h-10 min-w-0 items-center gap-2 rounded-full px-3.5 text-[13px] font-bold transition sm:mr-0",
            hasShift ? "bg-success/15 text-success hover:bg-success/20" : "bg-muted text-muted-foreground hover:text-foreground",
          )}
          title={hasShift ? "Cerrar caja (arqueo)" : "Abrir caja"}
        >
          <span className={cn("h-2 w-2 shrink-0 rounded-full", hasShift ? "bg-emerald-400" : "bg-muted-foreground opacity-60")} />
          <span className="truncate">
            {hasShift ? (registerName ? `${registerName} abierta` : "Caja abierta") : "Caja cerrada"}
          </span>
          <span className="hidden shrink-0 text-[11px] font-semibold opacity-70 sm:inline">
            {hasShift ? "Cerrar" : "Abrir"}
          </span>
        </button>
        <button
          type="button"
          onClick={onCustomerDisplay}
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground transition hover:text-foreground"
          aria-label="Abrir la pantalla del cliente"
          title="Pantalla del cliente (arrastrala al segundo monitor)"
        >
          <MonitorSmartphone size={17} />
        </button>
        <Popover.Root>
          <Popover.Trigger asChild>
            <button
              type="button"
              className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground transition hover:text-foreground data-[state=open]:bg-foreground data-[state=open]:text-background"
              aria-label="Cambiar el diseño del POS"
              title="Diseño del POS"
            >
              <LayoutTemplate size={17} />
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              align="end"
              sideOffset={8}
              className="z-50 w-[min(92vw,360px)] rounded-3xl bg-popover p-3 text-popover-foreground shadow-2xl ring-1 ring-border animate-fade-in"
            >
              <p className="px-1 text-sm font-black">Diseño de esta pantalla</p>
              <p className="px-1 pb-2.5 text-xs text-muted-foreground">
                {usingOwn ? "Usás un diseño propio en tu usuario." : "Usás el diseño del negocio."}
              </p>
              <div className="grid grid-cols-2 gap-2">
                {POS_PRESETS.map((p) => {
                  const info = PRESET_INFO[p];
                  const blocked = info.requiresDining && !diningEnabled;
                  const on = preset === p;
                  return (
                    <Popover.Close asChild key={p}>
                      <button
                        type="button"
                        disabled={blocked}
                        onClick={() => onPickPreset(p)}
                        aria-pressed={on}
                        className={choiceClass(on, "rounded-lg p-1.5")}
                      >
                        <PresetThumb preset={p} className={cn("h-[68px] w-full", blocked && "opacity-50")} />
                        <span className="flex items-center gap-1 px-1 pt-1.5 text-xs font-semibold">
                          {blocked && <Lock size={11} aria-hidden />}
                          {info.name}
                        </span>
                        {blocked && (
                          <span className="block px-1 text-[10px] text-muted-foreground">Necesita el modo gastronómico</span>
                        )}
                      </button>
                    </Popover.Close>
                  );
                })}
              </div>
              <div className="mt-2.5 flex items-center justify-between gap-2 px-1">
                {usingOwn ? (
                  <Popover.Close asChild>
                    <button type="button" onClick={onResetPreset} className="flex items-center gap-1 text-xs font-bold text-muted-foreground hover:text-foreground">
                      <X size={13} /> Volver al del negocio
                    </button>
                  </Popover.Close>
                ) : (
                  <span />
                )}
                <Link
                  href="/configuracion?seccion=diseno-pos"
                  className="flex items-center gap-1 text-xs font-bold text-muted-foreground hover:text-foreground"
                >
                  <Settings2 size={13} /> Personalizar
                </Link>
              </div>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      </div>
    </header>
  );
}
