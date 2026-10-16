"use client";

// Resultado por producto (ADR-165, R16): cuánto se entregó, cuánto llegó
// roto y cuánto rechazó el cliente; lo que no suma queda "sin entregar". Lo
// usan la entrega parcial de Expedición y la app del repartidor. Botones
// grandes de menos y más para usar con el pulgar.

import { Minus, Plus } from "lucide-react";
import { PhotoInput, type PhotoValue } from "@/components/logistics/PhotoInput";
import { cn } from "@/lib/utils/cn";
import { selectCls } from "@/components/stock/transfers/shared";
import {
  DAMAGE_REASON_LABEL,
  lineMissing,
  setLine,
  type DamageReason,
  type OutcomeLine,
} from "@/lib/logistics/expedition";

const fmt = (n: number) => n.toLocaleString("es-AR", { maximumFractionDigits: 3 });

function Stepper({
  label,
  value,
  max,
  onChange,
  tone,
}: {
  label: string;
  value: number;
  max: number;
  onChange: (v: number) => void;
  tone: "success" | "danger" | "warning";
}) {
  return (
    <div className="flex flex-col items-center gap-1">
      <span className={cn("text-xs font-medium", tone === "success" ? "text-success" : tone === "danger" ? "text-danger" : "text-warning")}>{label}</span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label={`${label}: uno menos`}
          onClick={() => onChange(value - 1)}
          disabled={value <= 0}
          className="grid h-10 w-10 place-items-center rounded-lg bg-muted/60 disabled:opacity-40"
        >
          <Minus size={16} aria-hidden />
        </button>
        <input
          aria-label={label}
          inputMode="decimal"
          value={fmt(value)}
          onChange={(e) => onChange(Number(e.target.value.replace(",", ".")) || 0)}
          className="h-10 w-14 rounded-lg border border-input bg-background text-center text-base font-semibold tabular-nums"
        />
        <button
          type="button"
          aria-label={`${label}: uno más`}
          onClick={() => onChange(value + 1)}
          disabled={value >= max}
          className="grid h-10 w-10 place-items-center rounded-lg bg-muted/60 disabled:opacity-40"
        >
          <Plus size={16} aria-hidden />
        </button>
      </div>
    </div>
  );
}

export function OutcomeForm({ lines, onChange }: { lines: OutcomeLine[]; onChange: (v: OutcomeLine[]) => void }) {
  const set = (i: number, field: "delivered" | "damaged" | "rejected", v: number) =>
    onChange(lines.map((l, k) => (k === i ? setLine(l, field, v) : l)));
  return (
    <ul className="space-y-3">
      {lines.map((l, i) => {
        const missing = lineMissing(l);
        return (
          <li key={l.itemId} className="rounded-lg bg-muted/30 p-3">
            <div className="flex items-baseline justify-between gap-2">
              <p className="min-w-0 text-sm font-semibold">{l.name}</p>
              <p className="shrink-0 text-xs text-muted-foreground">Lleva {fmt(l.qty)}</p>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-1">
              <Stepper label="Entregado" tone="success" value={l.delivered} max={l.qty - l.damaged - l.rejected} onChange={(v) => set(i, "delivered", v)} />
              <Stepper label="Roto" tone="danger" value={l.damaged} max={l.qty - l.delivered - l.rejected} onChange={(v) => set(i, "damaged", v)} />
              <Stepper label="Rechazado" tone="warning" value={l.rejected} max={l.qty - l.delivered - l.damaged} onChange={(v) => set(i, "rejected", v)} />
            </div>
            {missing > 0 && <p className="mt-2 text-xs text-muted-foreground">Sin entregar: {fmt(missing)}</p>}
          </li>
        );
      })}
    </ul>
  );
}
OutcomeForm.displayName = "OutcomeForm";

/** Qué le pasó a lo roto, nota y foto (la foto puede ser obligatoria). */
export function DamageFields({
  reason,
  onReason,
  note,
  onNote,
  photos,
  onPhotos,
  photoRequired,
}: {
  reason: DamageReason | null;
  onReason: (r: DamageReason) => void;
  note: string;
  onNote: (v: string) => void;
  photos: PhotoValue[];
  onPhotos: (v: PhotoValue[]) => void;
  photoRequired: boolean;
}) {
  return (
    <div className="space-y-3 rounded-lg bg-danger/5 p-3">
      <p className="text-sm font-semibold">Lo roto</p>
      <select
        aria-label="Qué le pasó"
        className={cn(selectCls, "h-11 w-full")}
        value={reason ?? ""}
        onChange={(e) => onReason(e.target.value as DamageReason)}
      >
        <option value="" disabled className="bg-popover text-popover-foreground">
          Elegí qué le pasó
        </option>
        {(Object.keys(DAMAGE_REASON_LABEL) as DamageReason[]).map((k) => (
          <option key={k} value={k} className="bg-popover text-popover-foreground">
            {DAMAGE_REASON_LABEL[k]}
          </option>
        ))}
      </select>
      <input
        aria-label="Nota de la rotura"
        value={note}
        maxLength={300}
        onChange={(e) => onNote(e.target.value)}
        placeholder={reason === "otro" ? "Contá qué pasó" : "Nota (opcional)"}
        className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm"
      />
      <PhotoInput
        label="Foto de lo roto"
        value={photos}
        onChange={onPhotos}
        max={3}
        required={photoRequired}
        hint={photoRequired ? "Obligatoria: queda con la merma." : "Queda con la merma."}
      />
    </div>
  );
}
DamageFields.displayName = "DamageFields";
