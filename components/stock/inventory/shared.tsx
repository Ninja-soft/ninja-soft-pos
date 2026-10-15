"use client";

// Piezas compartidas de Inventario (ADR-137): diferencia con signo, foto de
// respaldo y selector de sucursal.

import { useState } from "react";
import { Camera } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Spinner } from "@/components/ui/Spinner";
import { Select } from "@/components/ui/Select";
import { cn } from "@/lib/utils/cn";
import { formatQty } from "@/lib/utils/format";
import { useAdjustmentPhotoUrl } from "@/modules/stock/adjustments";

/** Diferencia con signo y texto (no sólo color): "+5" / "−3". */
export function DeltaText({ value, unit, className }: { value: number; unit?: string; className?: string }) {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return (
    <span
      className={cn(
        "font-semibold tabular-nums",
        value > 0 ? "text-success" : value < 0 ? "text-danger" : "text-muted-foreground",
        className,
      )}
    >
      {sign}
      {formatQty(Math.abs(value))}
      {unit && unit !== "un" ? ` ${unit}` : ""}
    </span>
  );
}

/** Botón que abre la foto de respaldo de un ajuste (URL firmada, 10 min). */
export function AdjustmentPhotoButton({ path }: { path: string }) {
  const [open, setOpen] = useState(false);
  const { data: url, isLoading } = useAdjustmentPhotoUrl(open ? path : null);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex min-h-[32px] items-center gap-1 rounded-md px-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <Camera size={13} aria-hidden /> Ver foto
      </button>
      <Modal open={open} onOpenChange={setOpen} title="Foto de respaldo">
        <div className="grid min-h-[200px] place-items-center">
          {isLoading ? (
            <Spinner size={22} label="Cargando foto" />
          ) : url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={url} alt="Foto de respaldo del ajuste" className="max-h-[70dvh] w-auto rounded-lg object-contain" />
          ) : (
            <p className="text-sm text-muted-foreground">No pudimos abrir la foto.</p>
          )}
        </div>
      </Modal>
    </>
  );
}

export function StorePicker({
  stores,
  value,
  onChange,
  allLabel,
  className,
}: {
  stores: { id: string; name: string }[];
  value: string | null;
  onChange: (id: string | null) => void;
  /** Con texto, suma la opción "todas" (valor null). */
  allLabel?: string;
  className?: string;
}) {
  const ALL = "__all__";
  const options = [
    ...(allLabel ? [{ value: ALL, label: allLabel }] : []),
    ...stores.map((s) => ({ value: s.id, label: s.name })),
  ];
  return (
    <Select
      aria-label="Sucursal"
      className={className}
      value={value ?? (allLabel ? ALL : null)}
      options={options}
      onChange={(v) => onChange(v === ALL ? null : v)}
    />
  );
}
