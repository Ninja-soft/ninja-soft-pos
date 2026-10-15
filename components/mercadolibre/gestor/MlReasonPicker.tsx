"use client";

import { useMemo, useState } from "react";
import { Check, Plus, X } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { SearchField } from "@/components/ui/SearchField";
import { cn } from "@/lib/utils/cn";
import {
  groupByFamily,
  indexReasons,
  REASON_CODE_RE,
  reasonTitleOf,
  searchReasons,
  type ClaimReason,
  type ReasonIndex,
} from "@/lib/mercadolibre/claimReasons";

// Selector de motivos de reclamo con el maestro de Mercado Libre (ADR-145).
// Guarda lo mismo que antes: una lista de códigos (exclusion_reasons).

const MAX_RESULTS = 60;

export type MlReasonPickerProps = {
  value: string[];
  onChange: (next: string[]) => void;
  reasons: ClaimReason[];
  /** Códigos que se están buscando en Mercado Libre. */
  loadingIds?: string[];
  disabled?: boolean;
  max?: number;
};

export function MlReasonPicker({ value, onChange, reasons, loadingIds = [], disabled, max = 50 }: MlReasonPickerProps) {
  const [query, setQuery] = useState("");
  const [onlyExcludable, setOnlyExcludable] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const index = useMemo(() => indexReasons(reasons), [reasons]);
  const selected = new Set(value);
  const full = value.length >= max;

  const code = query.trim().toUpperCase();
  const manual = REASON_CODE_RE.test(code) && !index.has(code) && !selected.has(code) ? code : null;
  const searching = query.trim().length > 0;
  const results = useMemo(
    () => (searching || onlyExcludable ? searchReasons(reasons, query, { onlyExcludable, limit: MAX_RESULTS }) : reasons.filter((r) => r.recommended)),
    [reasons, query, onlyExcludable, searching],
  );
  const groups = searching || onlyExcludable ? groupByFamily(results) : [{ family: "REC", label: "Recomendados", items: results }];

  const toggle = (id: string) => {
    if (disabled) return;
    if (selected.has(id)) onChange(value.filter((x) => x !== id));
    else if (!full) onChange([...value, id]);
  };
  const open = openId && selected.has(openId) ? openId : null;
  const openReason = open ? index.get(open) : undefined;

  return (
    <div className="w-full space-y-3">
      <div>
        <p className="mb-1.5 text-xs font-medium text-muted-foreground">
          Elegidos ({value.length}
          {full ? `, máximo ${max}` : ""})
        </p>
        {value.length === 0 ? (
          <p className="text-sm text-muted-foreground">Ninguno: ningún caso se marca para pedir la exclusión.</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5" aria-label="Motivos elegidos">
            {value.map((id) => {
              const r = index.get(id);
              const title = r?.title ?? (loadingIds.includes(id) ? "Buscando descripción" : "Sin descripción");
              return (
                <li key={id} className={cn("flex max-w-full items-center rounded-md bg-muted text-xs", open === id && "bg-secondary")}>
                  <button
                    type="button"
                    className="flex min-w-0 items-center gap-1.5 rounded-md py-1 pl-2 pr-1 text-left"
                    title={r?.description ?? title}
                    aria-expanded={open === id}
                    onClick={() => setOpenId(open === id ? null : id)}
                  >
                    <span className="font-mono font-semibold">{id}</span>
                    <span className={cn("truncate sm:max-w-[16rem]", !r && "italic text-muted-foreground")}>{title}</span>
                  </button>
                  {!disabled && (
                    <button
                      type="button"
                      className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:text-foreground"
                      aria-label={`Quitar ${id}`}
                      onClick={() => toggle(id)}
                    >
                      <X size={13} />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {open && (
          <div className="mt-2 rounded-lg bg-muted/60 px-3 py-2 text-sm" role="region" aria-label={`Detalle de ${open}`}>
            <p className="font-medium">
              <span className="font-mono">{open}</span> · {openReason?.title ?? "Sin descripción"}
            </p>
            {openReason ? (
              <>
                {openReason.description && <p className="text-xs text-muted-foreground">{openReason.description}</p>}
                <ReasonBadges r={openReason} />
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                No está en el maestro. {loadingIds.includes(open) ? "La estamos buscando en Mercado Libre." : "Si Mercado Libre la conoce, aparece la próxima vez que abras esta pantalla."}
              </p>
            )}
          </div>
        )}
      </div>

      {!disabled && (
        <div className="space-y-2">
          <SearchField
            value={query}
            onValueChange={setQuery}
            placeholder="Buscá por código o palabra: arrepentí, error, no llegó"
            aria-label="Buscar motivo"
          />
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Checkbox checked={onlyExcludable} onCheckedChange={setOnlyExcludable} aria-label="Sólo los que suelen poder excluirse" />
            Sólo los que suelen poder excluirse
          </label>

          {manual && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/60 px-3 py-2 text-sm">
              <span className="min-w-0">
                <span className="font-mono font-semibold">{manual}</span> no está en el maestro. Se agrega sin descripción y la buscamos en Mercado Libre.
              </span>
              <Button
                size="sm"
                variant="secondary"
                disabled={full}
                onClick={() => {
                  toggle(manual);
                  setQuery("");
                }}
              >
                <Plus size={14} /> Agregar a mano
              </Button>
            </div>
          )}

          <div className="max-h-80 space-y-3 overflow-y-auto overscroll-contain">
            {reasons.length === 0 ? (
              <p className="py-3 text-sm text-muted-foreground">Todavía no está el maestro de motivos. Podés agregar códigos a mano.</p>
            ) : results.length === 0 ? (
              <p className="py-3 text-sm text-muted-foreground">No encontramos motivos con esa búsqueda.</p>
            ) : (
              groups.map((g) => (
                <section key={g.family} aria-label={g.label}>
                  <h4 className="sticky top-0 bg-card py-1 text-xs font-semibold text-muted-foreground">
                    {g.label} <span className="font-normal">({g.items.length})</span>
                  </h4>
                  <ul className="divide-y divide-border">
                    {g.items.map((r) => {
                      const on = selected.has(r.id);
                      return (
                        <li key={r.id}>
                          <button
                            type="button"
                            aria-pressed={on}
                            disabled={!on && full}
                            onClick={() => toggle(r.id)}
                            className="flex w-full items-start gap-2 py-2 text-left disabled:opacity-50"
                          >
                            <span
                              className={cn(
                                "mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-[5px] border",
                                on ? "border-foreground bg-foreground text-background" : "border-input",
                              )}
                              aria-hidden
                            >
                              {on && <Check size={11} strokeWidth={3} />}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block text-sm">
                                <span className="font-mono text-xs font-semibold">{r.id}</span> {r.title}
                              </span>
                              {r.description && <span className="block text-xs text-muted-foreground">{r.description}</span>}
                              <ReasonBadges r={r} />
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))
            )}
            {!searching && !onlyExcludable && reasons.length > 0 && (
              <p className="text-xs text-muted-foreground">Escribí para buscar entre los {reasons.length} motivos de Mercado Libre, agrupados por tipo.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Título del motivo con su código, para listas y detalles de casos. */
export function MlReasonLabel({ id, index }: { id: string | null | undefined; index: ReasonIndex | undefined }) {
  const r = id ? index?.get(id.toUpperCase()) : undefined;
  return (
    <span title={r?.description ?? undefined}>
      {reasonTitleOf(index, id)}
      {id ? <span className="font-mono text-xs font-normal text-muted-foreground"> ({id})</span> : null}
    </span>
  );
}

function ReasonBadges({ r }: { r: ClaimReason }) {
  if (!r.excludable && r.active && !r.alias_of && !r.recommended) return null;
  return (
    <span className="mt-1 flex flex-wrap gap-1">
      {r.recommended && <Badge tone="brand">Recomendado</Badge>}
      {r.excludable && <Badge tone="success">Suele poder excluirse</Badge>}
      {r.alias_of && <Badge tone="neutral">Equivale a {r.alias_of}</Badge>}
      {!r.active && <Badge tone="neutral">Ya no se usa</Badge>}
    </span>
  );
}
