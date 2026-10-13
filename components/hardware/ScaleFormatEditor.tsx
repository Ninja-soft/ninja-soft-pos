"use client";

import { useMemo } from "react";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import { cn } from "@/lib/utils/cn";
import {
  ALL_SCALE_PREFIXES,
  buildScaleLabel,
  decodeScaleLabel,
  scaleFormatProblem,
  valueDigits,
  type ScaleLabelFormat,
} from "@/lib/barcode/scaleLabel";

// Editor del formato de la etiqueta de balanza (ADR-063) con una etiqueta de
// ejemplo armada y desarmada en vivo, para que el dueño compare con la que
// imprime su balanza.

export function ScaleFormatEditor({
  value,
  onChange,
  disabled,
}: {
  value: ScaleLabelFormat;
  onChange: (f: ScaleLabelFormat) => void;
  disabled?: boolean;
}) {
  const problem = scaleFormatProblem(value);
  const set = (patch: Partial<ScaleLabelFormat>) => onChange({ ...value, ...patch });
  const len = valueDigits(value);

  const sample = useMemo(() => {
    if (problem) return null;
    const exampleValue = value.embed === "weight" ? 0.75 : Math.min(15000, 10 ** (len - value.decimals) - 1);
    try {
      const code = buildScaleLabel(value, value.prefixes[0] ?? "20", "1234", exampleValue);
      const d = decodeScaleLabel(code, value);
      return { code, d };
    } catch {
      return null;
    }
  }, [value, problem, len]);

  const parts = sample
    ? [
        { t: sample.code.slice(0, 2), l: "Prefijo" },
        { t: sample.code.slice(2, 2 + value.codeDigits), l: "Código" },
        ...(value.valueCheckDigit ? [{ t: sample.code.slice(2 + value.codeDigits, 3 + value.codeDigits), l: "DV valor" }] : []),
        { t: sample.code.slice(12 - len, 12), l: value.embed === "weight" ? "Peso" : "Precio" },
        { t: sample.code.slice(12), l: "DV" },
      ]
    : [];

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-medium">Prefijos de balanza</p>
        <p className="text-xs text-muted-foreground">Los códigos que empiezan así se leen como etiqueta de balanza.</p>
        <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Prefijos de balanza">
          {ALL_SCALE_PREFIXES.map((p) => {
            const on = value.prefixes.includes(p);
            return (
              <button
                key={p}
                type="button"
                aria-pressed={on}
                disabled={disabled}
                onClick={() =>
                  set({ prefixes: on ? value.prefixes.filter((x) => x !== p) : [...value.prefixes, p].sort() })
                }
                className={cn(
                  "h-9 w-11 rounded-md text-sm font-semibold tabular-nums transition-colors disabled:opacity-60",
                  on ? "bg-[var(--pos-solid)] text-white" : "bg-muted text-muted-foreground hover:bg-secondary",
                )}
              >
                {p}
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <p className="mb-1.5 text-sm font-medium">Qué trae la etiqueta</p>
          <Segmented
            aria-label="Qué trae la etiqueta"
            value={value.embed}
            onChange={(v) => set({ embed: v, decimals: v === "weight" ? 3 : 0 })}
            options={[
              { value: "price", label: "Precio" },
              { value: "weight", label: "Peso" },
            ]}
          />
        </div>
        <div>
          <p className="mb-1.5 text-sm font-medium">Dígitos del código del producto</p>
          <Segmented
            aria-label="Dígitos del código del producto"
            value={String(value.codeDigits) as "4" | "5" | "6"}
            onChange={(v) => set({ codeDigits: Number(v) })}
            options={[
              { value: "4", label: "4" },
              { value: "5", label: "5" },
              { value: "6", label: "6" },
            ]}
          />
        </div>
        <div>
          <p className="mb-1.5 text-sm font-medium">Decimales del {value.embed === "weight" ? "peso" : "precio"}</p>
          <Segmented
            aria-label="Decimales"
            value={String(value.decimals) as "0" | "1" | "2" | "3"}
            onChange={(v) => set({ decimals: Number(v) })}
            options={[
              { value: "0", label: "0" },
              { value: "1", label: "1" },
              { value: "2", label: "2" },
              { value: "3", label: value.embed === "weight" ? "3 (gramos)" : "3" },
            ]}
          />
        </div>
        <div className="space-y-2.5">
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>Validar el dígito verificador</span>
            <Switch
              checked={value.verifyCheckDigit}
              onCheckedChange={(c) => set({ verifyCheckDigit: c })}
              disabled={disabled}
              label="Validar el dígito verificador"
            />
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>La balanza agrega un dígito verificador del valor</span>
            <Switch
              checked={value.valueCheckDigit}
              onCheckedChange={(c) => set({ valueCheckDigit: c })}
              disabled={disabled}
              label="Dígito verificador del valor"
            />
          </label>
        </div>
      </div>

      {problem ? (
        <p className="rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning">{problem}</p>
      ) : (
        sample && (
          <div className="rounded-lg bg-muted/60 p-3">
            <p className="text-xs text-muted-foreground">Ejemplo de etiqueta con este formato</p>
            <div className="mt-2 flex flex-wrap gap-1.5 font-mono text-sm">
              {parts.map((p, i) => (
                <span key={i} className="flex flex-col items-center rounded-md bg-card px-2 py-1">
                  <span className="tabular-nums">{p.t}</span>
                  <span className="font-sans text-[10px] text-muted-foreground">{p.l}</span>
                </span>
              ))}
            </div>
            {sample.d?.ok && (
              <p className="mt-2 text-xs text-muted-foreground">
                Producto con código {sample.d.itemCode}:{" "}
                {value.embed === "weight"
                  ? `${sample.d.value.toLocaleString("es-AR", { minimumFractionDigits: 3 })} kg`
                  : `$ ${sample.d.value.toLocaleString("es-AR")}`}
                . El código se busca en el PLU, el SKU o el código de barras del producto.
              </p>
            )}
          </div>
        )
      )}
    </div>
  );
}
