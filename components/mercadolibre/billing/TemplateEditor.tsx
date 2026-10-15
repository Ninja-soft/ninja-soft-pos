"use client";

import { useRef } from "react";
import { RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { selectCls } from "@/components/stock/transfers/shared";
import { cn } from "@/lib/utils/cn";
import {
  DEFAULT_TEMPLATES,
  TEMPLATE_LIMITS,
  TEMPLATE_VARS,
  exampleVars,
  renderTemplate,
  unknownVars,
  type TemplateKind,
} from "@/supabase/functions/_shared/mercadolibre/billingConfig";

// Editor de una plantilla de la facturación de Mercado Libre (ADR-145): texto
// precargado con el ejemplo, variables que se insertan con un toque, vista
// previa con la venta de ejemplo, contador contra el tope de Mercado Libre y
// "Restaurar ejemplo". Opcionalmente, un interruptor para activarla.
export function TemplateEditor({
  kind,
  label,
  description,
  value,
  onChange,
  enabled,
  onEnabledChange,
  disabled,
  previewVars,
}: {
  kind: TemplateKind;
  label: string;
  description?: string;
  /** Texto actual (nunca vacío: si no hay nada guardado, el ejemplo). */
  value: string;
  onChange: (v: string) => void;
  enabled?: boolean;
  onEnabledChange?: (v: boolean) => void;
  disabled?: boolean;
  /** Valores de la venta de ejemplo (por defecto, los del catálogo de variables). */
  previewVars?: Record<string, string>;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const vars = TEMPLATE_VARS[kind];
  const limit = TEMPLATE_LIMITS[kind];
  const preview = renderTemplate(value, { ...exampleVars(kind), ...previewVars });
  const unknown = unknownVars(kind, value);
  const isDefault = value.trim() === DEFAULT_TEMPLATES[kind].trim();
  const off = enabled === false;
  const missingLink = kind === "perception" && !/\{link\}/.test(value);
  const over = preview.length > limit.max;
  const id = `tpl-${kind}`;

  const insert = (key: string) => {
    const el = ref.current;
    const token = `{${key}}`;
    if (!el) return onChange(`${value}${token}`);
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const next = `${value.slice(0, start)}${token}${value.slice(end)}`;
    onChange(next.slice(0, limit.stored));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };

  return (
    <div className="space-y-3" role="group" aria-label={`Plantilla: ${label}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <label htmlFor={id} className="text-sm font-medium">
            {label}
          </label>
          {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
        </div>
        {onEnabledChange && (
          <Switch checked={!off} disabled={disabled} label={`Activar: ${label}`} onCheckedChange={onEnabledChange} />
        )}
      </div>
      <div className={cn("space-y-3", off && "opacity-60")}>
        <textarea
          id={id}
          ref={ref}
          className={`${selectCls} min-h-[96px] w-full py-2 text-sm leading-relaxed`}
          maxLength={limit.stored}
          value={value}
          disabled={disabled || off}
          onChange={(e) => onChange(e.target.value)}
        />
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Variables:</span>
          {vars.map((v) => (
            <button
              key={v.key}
              type="button"
              title={v.label}
              disabled={disabled || off}
              onClick={() => insert(v.key)}
              className="rounded-md bg-muted px-2 py-0.5 font-mono text-xs text-foreground transition hover:bg-secondary disabled:opacity-50"
            >
              {`{${v.key}}`}
            </button>
          ))}
        </div>
        <div className="rounded-lg bg-muted/50 p-3">
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-medium text-muted-foreground">Así lo ve el comprador</span>
            <Badge tone={over ? "warning" : "neutral"}>
              {preview.length} / {limit.max}
            </Badge>
          </div>
          <p className="whitespace-pre-wrap break-words text-sm" data-testid={`preview-${kind}`}>
            {preview}
          </p>
        </div>
        {(unknown.length > 0 || missingLink || over) && (
          <ul className="space-y-1 text-xs text-warning">
            {unknown.length > 0 && <li>No existe {unknown.map((u) => `{${u}}`).join(", ")}: se va a ver tal cual.</li>}
            {missingLink && <li>Falta {"{link}"}: sin el link el comprador no puede pagar la percepción.</li>}
            {over && (
              <li>
                {kind === "invoice_notes"
                  ? `La leyenda se corta en ${limit.max} caracteres.`
                  : `Pasa los ${limit.max} caracteres de la guía de mensajes: se acorta el texto sin cortar el link.`}
              </li>
            )}
          </ul>
        )}
        <div className="flex justify-end">
          <Button size="sm" variant="ghost" disabled={disabled || off || isDefault} onClick={() => onChange(DEFAULT_TEMPLATES[kind])}>
            <RotateCcw size={14} /> Restaurar ejemplo
          </Button>
        </div>
      </div>
    </div>
  );
}
