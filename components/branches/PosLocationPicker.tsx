"use client";

import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown, Lock, MapPin } from "lucide-react";
import { BranchDot } from "@/components/branches/BranchSwitcher";
import {
  useBranchContext,
  useBranchScope,
  useCurrentRegister,
  useStoreOpenShifts,
} from "@/modules/branches/hooks";
import { liveRegisters, locationLabel, REGISTER_KIND_LABEL } from "@/modules/branches/logic";
import { cn } from "@/lib/utils/cn";

// "Centro · Caja 1" en la cabecera del POS (F17 · H90) con el selector "¿Dónde
// vendés hoy?": sucursales permitidas y sus cajas (libre, abierta, abierta por
// vos). No se cambia con el carrito cargado ni con un turno propio abierto.
export function PosLocationPicker({
  lockedReason,
  placeholder,
}: {
  // Motivo por el que no se puede cambiar ahora (null = se puede).
  lockedReason: string | null;
  // Último rótulo conocido en este dispositivo: se muestra mientras carga el
  // contexto de sucursales para que la barra no salte (null = no hay chip).
  placeholder?: { full: string; short: string; color: string | null; pickable: boolean } | null;
}) {
  const ctx = useBranchContext();
  const current = useCurrentRegister();
  const scope = useBranchScope();
  const [open, setOpen] = useState(false);
  const [storeId, setStoreId] = useState<string | null>(null);
  const viewStoreId = storeId ?? ctx.posStoreId;
  const viewStore = ctx.allowed.find((b) => b.id === viewStoreId) ?? null;
  const shifts = useStoreOpenShifts(open ? viewStoreId : null);

  if (!ctx.ready) {
    if (!placeholder) return null;
    return (
      <span
        aria-busy="true"
        className="flex h-11 min-w-0 shrink items-center gap-2 rounded-lg bg-fg-4 px-3 text-[13px]"
        title={`Estás vendiendo en ${placeholder.full}`}
      >
        <BranchDot branch={{ color: placeholder.color }} />
        <span className="truncate font-medium text-foreground">
          <span className="sm:hidden">{placeholder.short}</span>
          <span className="hidden sm:inline">{placeholder.full}</span>
        </span>
        {placeholder.pickable && <ChevronDown size={14} className="shrink-0 text-muted-foreground" aria-hidden />}
      </span>
    );
  }
  if (!current.store) return null;

  const registers = viewStore ? liveRegisters(viewStore.registers) : [];
  const choices = ctx.allowed.filter((b) => b.is_active);
  const canPick = choices.length > 1 || liveRegisters(current.store.registers).length > 1;
  const full = locationLabel(current.store, current.data);
  const short = locationLabel(current.store, current.data, true);

  const label = (
    <>
      <BranchDot branch={current.store} />
      <span className="truncate font-medium text-foreground">
        <span className="sm:hidden">{short}</span>
        <span className="hidden sm:inline">{full}</span>
      </span>
    </>
  );

  if (!canPick) {
    return (
      <span
        className="flex h-11 min-w-0 shrink items-center gap-2 rounded-lg bg-fg-4 px-3 text-[13px]"
        title={`Estás vendiendo en ${full}`}
      >
        {label}
      </span>
    );
  }

  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setStoreId(null);
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          className="flex h-11 min-w-0 shrink items-center gap-2 rounded-lg bg-fg-4 px-3 text-[13px] transition-colors hover:bg-fg-6 data-[state=open]:bg-fg-10"
          aria-label={`Estás vendiendo en ${full}. Cambiar sucursal o caja`}
          title="Sucursal y caja de este dispositivo"
        >
          {label}
          <ChevronDown size={14} className="shrink-0 text-muted-foreground" aria-hidden />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={8}
          className="z-50 w-[min(92vw,340px)] rounded-xl border border-border bg-popover p-3 text-popover-foreground animate-fade-in"
        >
          <p className="flex items-center gap-1.5 px-1 text-sm font-semibold">
            <MapPin size={15} aria-hidden /> ¿Dónde vendés hoy?
          </p>
          <p className="px-1 pb-2.5 text-xs text-muted-foreground">
            Este dispositivo recuerda la sucursal y la caja.
          </p>

          {lockedReason ? (
            <p className="flex items-start gap-2 rounded-lg bg-fg-4 px-3 py-2.5 text-xs text-muted-foreground">
              <Lock size={13} className="mt-0.5 shrink-0" aria-hidden /> {lockedReason}
            </p>
          ) : (
            <>
              {choices.length > 1 && (
                <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Sucursal">
                  {choices.map((b) => (
                    <button
                      key={b.id}
                      type="button"
                      aria-pressed={b.id === viewStoreId}
                      onClick={() => setStoreId(b.id)}
                      className={cn(
                        "flex h-9 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition",
                        b.id === viewStoreId
                          ? "border-ninja-flame/50 bg-ninja-flame/10 text-foreground"
                          : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                    >
                      <BranchDot branch={b} className="h-2 w-2" />
                      {b.short_name || b.name}
                    </button>
                  ))}
                </div>
              )}
              <div className="space-y-1" role="group" aria-label="Caja">
                {registers.length === 0 && (
                  <p className="px-1 py-2 text-xs text-muted-foreground">Esta sucursal no tiene cajas activas.</p>
                )}
                {registers.map((r) => {
                  const shift = (shifts.data ?? []).find((s) => s.cash_register_id === r.id);
                  const mine = shift && shift.opened_by === scope.data?.userId;
                  const selected = viewStoreId === ctx.posStoreId && current.data?.id === r.id;
                  return (
                    <Popover.Close asChild key={r.id}>
                      <button
                        type="button"
                        onClick={() => ctx.setPosLocation(r.store_id, r.id)}
                        className={cn(
                          "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition hover:bg-muted",
                          selected && "bg-muted",
                        )}
                      >
                        <span
                          aria-hidden
                          className={cn(
                            "h-2 w-2 shrink-0 rounded-full",
                            shift ? "bg-success" : "bg-muted-foreground/50",
                          )}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{r.name}</span>
                          <span className="block text-[11px] text-muted-foreground">
                            {shift ? (mine ? "Abierta por vos" : "Abierta") : "Libre"}
                            {r.kind !== "fixed" ? ` · ${REGISTER_KIND_LABEL[r.kind]}` : ""}
                          </span>
                        </span>
                        {selected && <Check size={15} className="text-ninja-flameSoft" aria-hidden />}
                      </button>
                    </Popover.Close>
                  );
                })}
              </div>
            </>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
