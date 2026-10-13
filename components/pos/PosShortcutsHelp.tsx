"use client";

import { Modal } from "@/components/ui/Modal";
import { POS_PASSIVE_SHORTCUTS, POS_SHORTCUTS } from "@/lib/pos/shortcuts";

// Ayuda de atajos del POS (TX-3). Se abre con "?" (fuera de un campo de
// texto) o con el botón de teclado de la barra superior. El catálogo sale de
// lib/pos/shortcuts.ts: lo que se ve acá es exactamente lo que el POS atiende.

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="flex shrink-0 flex-wrap items-center justify-end gap-1">
      {keys.map((k, i) => (
        <span key={k} className="flex items-center gap-1">
          {i > 0 && <span className="text-xs text-muted-foreground">o</span>}
          <kbd className="min-w-8 rounded-md border border-border bg-muted px-1.5 py-0.5 text-center font-mono text-xs text-foreground">
            {k}
          </kbd>
        </span>
      ))}
    </span>
  );
}

export function PosShortcutsHelp({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Atajos de teclado"
      description="Funcionan con el foco en cualquier parte del POS, también en la búsqueda. Ninguno usa Ctrl ni Alt, para no chocar con el navegador."
    >
      <dl className="divide-y divide-border">
        {POS_SHORTCUTS.map((s) => (
          <div
            key={s.action}
            className="flex items-start justify-between gap-4 py-2.5"
          >
            <dt className="min-w-0">
              <span className="block text-sm font-medium">{s.label}</span>
              {s.hint && (
                <span className="block text-xs text-muted-foreground">
                  {s.hint}
                </span>
              )}
            </dt>
            <dd>
              <Keys keys={s.keys} />
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-5 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
        En diálogos y listas
      </p>
      <dl className="mt-1 divide-y divide-border">
        {POS_PASSIVE_SHORTCUTS.map((s) => (
          <div
            key={s.label}
            className="flex items-start justify-between gap-4 py-2.5"
          >
            <dt className="text-sm">{s.label}</dt>
            <dd>
              <Keys keys={s.keys} />
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-4 text-xs text-muted-foreground">
        El lector de códigos sigue funcionando igual: escaneá sin hacer clic en
        ningún campo.
      </p>
    </Modal>
  );
}
