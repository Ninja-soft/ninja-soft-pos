"use client";

// Barra de acciones en lote (fija abajo mientras hay algo seleccionado) y el
// diálogo de confirmación con totales y avance.

import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";

export interface BulkAction {
  key: string;
  label: string;
  onClick: () => void;
  variant?: "primary" | "secondary" | "ghost";
  disabled?: boolean;
  icon?: React.ReactNode;
}

export function BulkBar({
  count,
  amount,
  noun = { one: "seleccionado", many: "seleccionados" },
  actions,
  onClear,
  className,
}: {
  count: number;
  amount: number;
  noun?: { one: string; many: string };
  actions: BulkAction[];
  onClear: () => void;
  className?: string;
}) {
  // Esc limpia la selección (atajo de teclado).
  useEffect(() => {
    if (count === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("[role=dialog]")) return;
      onClear();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [count, onClear]);

  if (count === 0) return null;
  return (
    <div
      role="region"
      aria-label="Acciones con lo seleccionado"
      className={cn(
        "sticky bottom-[calc(env(safe-area-inset-bottom)+0.75rem)] z-30 mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-popover px-3 py-2.5 text-sm sm:gap-3 sm:px-4",
        className,
      )}
    >
      <button
        type="button"
        onClick={onClear}
        aria-label="Limpiar selección (Esc)"
        title="Limpiar selección (Esc)"
        className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <X size={16} />
      </button>
      <div className="min-w-0 flex-1">
        <p className="font-semibold tabular-nums">
          {count} {count === 1 ? noun.one : noun.many}
        </p>
        <p className="text-xs tabular-nums text-muted-foreground">{formatCurrency(amount)}</p>
      </div>
      <div className="flex w-full flex-wrap gap-2 sm:w-auto">
        {actions.map((a) => (
          <Button
            key={a.key}
            size="sm"
            variant={a.variant ?? "secondary"}
            onClick={a.onClick}
            disabled={a.disabled}
            className="flex-1 sm:flex-none"
          >
            {a.icon}
            {a.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

export interface BulkConfirmState {
  title: string;
  /** Líneas del resumen (concepto, valor). */
  rows: [string, string][];
  note?: string;
  confirmLabel: string;
  run: (onProgress: (done: number, total: number) => void) => Promise<void>;
}

export function BulkConfirm({
  state,
  progress,
  running,
  onOpenChange,
  onConfirm,
}: {
  state: BulkConfirmState | null;
  progress: { done: number; total: number } | null;
  running: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  return (
    <Modal
      open={state !== null}
      onOpenChange={(o) => {
        if (!running) onOpenChange(o);
      }}
      title={state?.title ?? ""}
      className="max-w-md"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={running}>
            Cancelar
          </Button>
          <Button onClick={onConfirm} loading={running}>
            {state?.confirmLabel}
          </Button>
        </>
      }
    >
      {state && (
        <div className="space-y-4">
          <dl className="divide-y divide-border rounded-lg border border-border">
            {state.rows.map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between gap-3 px-3 py-2 text-sm">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="font-semibold tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>
          {state.note && <p className="text-sm text-muted-foreground">{state.note}</p>}
          {running && progress && (
            <div className="space-y-1.5" aria-live="polite">
              <div className="h-1.5 w-full overflow-hidden rounded-sm bg-muted">
                <div className="h-full bg-foreground transition-[width]" style={{ width: `${pct}%` }} />
              </div>
              <p className="text-xs tabular-nums text-muted-foreground">
                {progress.done} de {progress.total}
              </p>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

/** Estado del diálogo de confirmación y del avance de una acción en lote. */
export function useBulkRunner() {
  const [state, setState] = useState<BulkConfirmState | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [running, setRunning] = useState(false);

  const confirm = useCallback(async () => {
    if (!state) return;
    setRunning(true);
    setProgress({ done: 0, total: 0 });
    try {
      await state.run((done, total) => setProgress({ done, total }));
    } finally {
      setRunning(false);
      setProgress(null);
      setState(null);
    }
  }, [state]);

  const dialog = (
    <BulkConfirm
      state={state}
      progress={progress}
      running={running}
      onOpenChange={(o) => {
        if (!o) setState(null);
      }}
      onConfirm={() => void confirm()}
    />
  );
  return { ask: setState, running, dialog };
}
