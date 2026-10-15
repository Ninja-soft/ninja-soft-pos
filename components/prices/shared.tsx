"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";
import type { RoundingRule } from "@/lib/prices/rounding";

// Piezas chicas compartidas por la sección de precios (ADR-058). Sin
// degradados ni sombras, redondeo mínimo, selección neutra.

export const fieldCls =
  "h-10 w-full rounded-md border border-input bg-background px-2.5 text-sm outline-none transition focus:border-foreground/40";

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("block text-xs font-medium text-muted-foreground", className)}>
      {label}
      <div className="mt-1">{children}</div>
      {hint && <span className="mt-1 block text-[11px] font-normal leading-snug text-muted-foreground">{hint}</span>}
    </label>
  );
}

export function numOrNull(v: string): number | null {
  if (v.trim() === "") return null;
  const n = Number(v.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

const ROUNDING_PRESETS: { key: string; label: string; rule: RoundingRule | null }[] = [
  { key: "none", label: "Sin redondeo", rule: null },
  { key: "m10", label: "A $10", rule: { mode: "multiple", step: 10, direction: "nearest" } },
  { key: "m50", label: "A $50", rule: { mode: "multiple", step: 50, direction: "nearest" } },
  { key: "m100", label: "A $100", rule: { mode: "multiple", step: 100, direction: "nearest" } },
  { key: "e9", label: "Terminado en 9", rule: { mode: "ending", ending: 9, direction: "nearest" } },
  { key: "e99c", label: "Terminado en ,99", rule: { mode: "ending", ending: 0.99, direction: "nearest" } },
  { key: "e90", label: "Terminado en 90", rule: { mode: "ending", ending: 90, direction: "nearest" } },
  { key: "e99", label: "Terminado en 99", rule: { mode: "ending", ending: 99, direction: "nearest" } },
];

function presetKey(r: RoundingRule | null | undefined): string {
  if (!r || r.mode === "none") return "none";
  const hit = ROUNDING_PRESETS.find(
    (p) =>
      p.rule &&
      p.rule.mode === r.mode &&
      Number(p.rule.step ?? 0) === Number(r.step ?? 0) &&
      Number(p.rule.ending ?? -1) === Number(r.ending ?? -1),
  );
  return hit?.key ?? "none";
}

/** Redondeo: múltiplo o terminación + dirección. */
export function RoundingPicker({
  value,
  onChange,
}: {
  value: RoundingRule | null | undefined;
  onChange: (r: RoundingRule | null) => void;
}) {
  const key = presetKey(value);
  return (
    <div className="grid grid-cols-2 gap-2">
      <select
        className={fieldCls}
        value={key}
        onChange={(e) => {
          const p = ROUNDING_PRESETS.find((x) => x.key === e.target.value);
          onChange(p?.rule ? { ...p.rule, direction: value?.direction ?? "nearest" } : null);
        }}
        aria-label="Redondeo"
      >
        {ROUNDING_PRESETS.map((p) => (
          <option key={p.key} value={p.key}>
            {p.label}
          </option>
        ))}
      </select>
      <select
        className={fieldCls}
        value={value?.direction ?? "nearest"}
        disabled={key === "none"}
        onChange={(e) => value && onChange({ ...value, direction: e.target.value as RoundingRule["direction"] })}
        aria-label="Dirección del redondeo"
      >
        <option value="nearest">Al más cercano</option>
        <option value="up">Hacia arriba</option>
        <option value="down">Hacia abajo</option>
      </select>
    </div>
  );
}

/** "2026-11-10T15:00" (datetime-local) ↔ ISO. */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function fromLocalInput(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" });
}

export function friendlyPriceError(e: unknown): string {
  const m = String((e as { message?: string })?.message ?? e ?? "");
  if (m.includes("listas_precios_pro")) return "Necesitás Listas de precios PRO (plan Business).";
  if (m.includes("precios_usd")) return "Tu plan no incluye Costos en dólares (desde el plan Pro).";
  if (m.includes("costo_final")) return "Tu plan no incluye Costo final y utilidad.";
  if (m.includes("fx_rate_missing")) return "No hay cotización del dólar para esa fuente. Cargala o usá una manual.";
  if (m.includes("fx_cannot_schedule")) return "La actualización por dólar se aplica en el momento, no se programa.";
  if (m.includes("invalid_fx_rate")) return "La cotización no es válida.";
  if (m.includes("no_targets")) return "Elegí al menos un precio para actualizar.";
  if (m.includes("invalid_cost_extras")) return "Revisá los componentes del costo.";
  if (m.includes("invalid_floor_margin")) return "El margen mínimo tiene que ser entre 0 y 99,9 %.";
  if (m.includes("invalid_threshold")) return "La variación tiene que ser mayor a 0 y hasta 100 %.";
  if (m.includes("feature_not_in_plan: listas_precios")) return "Tu plan no incluye listas de precios.";
  if (m.includes("multi_sucursal")) return "Asignar listas por sucursal requiere Multi-sucursal.";
  if (m.includes("price_list_cycle")) return "Esa lista ya deriva de esta: armaría un círculo.";
  if (m.includes("bulk_empty")) return "No hay precios que cambien con ese criterio.";
  if (m.includes("index_value_missing")) return "Faltan valores del índice o la cotización para esas fechas.";
  if (m.includes("effective_at_past")) return "La fecha tiene que ser futura.";
  if (m.includes("cannot_approve_own")) return "Quien carga el cambio no lo puede aprobar.";
  if (m.includes("forbidden")) return "No tenés permiso para esta acción.";
  if (m.includes("uq_price_lists_channel") || m.includes("duplicate")) return "Ya existe una lista para ese canal.";
  if (m.includes("invalid_rounding")) return "El redondeo no es válido.";
  return "No se pudo guardar. Revisá los datos.";
}
