"use client";

// "Ver asiento" (F23 · H155, ADR-158): botón chico que busca el asiento de un
// documento (acc_entry_lookup) y lo abre en el detalle de siempre. Si hay más
// de uno (por ejemplo la venta y su anulación), muestra la lista primero.
// Sólo con la feature contabilidad y para dueño o encargado.

import { useState } from "react";
import { BookOpenCheck } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Spinner } from "@/components/ui/Spinner";
import { formatCurrency } from "@/lib/utils/format";
import { EVENT_LABEL } from "@/lib/accounting/sources";
import { useAccountingAccess, useEntriesForSource } from "@/modules/accounting/hooks";
import type { AccEntry } from "@/modules/accounting/api";
import { EntryDetailModal } from "./EntryModals";
import { fmtDate } from "./shared";

export function ViewEntryButton({
  sourceType,
  sourceId,
  label = "Ver asiento",
  className,
}: {
  sourceType: string;
  sourceId: string;
  label?: string;
  className?: string;
}) {
  const access = useAccountingAccess();
  const [open, setOpen] = useState(false);
  if (!access.enabled) return null;
  return (
    <>
      <Button size="sm" variant="ghost" className={className} onClick={() => setOpen(true)}>
        <BookOpenCheck size={14} /> {label}
      </Button>
      {open && <EntryLookup sourceType={sourceType} sourceId={sourceId} onClose={() => setOpen(false)} />}
    </>
  );
}

function EntryLookup({ sourceType, sourceId, onClose }: { sourceType: string; sourceId: string; onClose: () => void }) {
  const { data = [], isLoading, isError } = useEntriesForSource(sourceType, sourceId);
  const [picked, setPicked] = useState<AccEntry | null>(null);
  const only = !isLoading && data.length === 1 ? data[0]! : null;
  const entry = picked ?? only;

  if (entry) {
    return (
      <EntryDetailModal
        entry={entry}
        onOpenChange={(o) => {
          if (o) return;
          if (picked && data.length > 1) setPicked(null);
          else onClose();
        }}
      />
    );
  }

  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Asiento contable" className="sm:max-w-md">
      {isLoading ? (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      ) : isError ? (
        <p className="text-sm text-danger">No se pudo buscar el asiento. Probá de nuevo.</p>
      ) : data.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Todavía no hay asiento para esto. Se arma solo cuando la contabilidad está activada y el documento es de
          la fecha de inicio en adelante. Si falta una cuenta, queda en Contabilidad, Resumen, para mapearla.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {data.map((e) => (
            <li key={e.id}>
              <button
                type="button"
                onClick={() => setPicked(e)}
                className="flex w-full items-center justify-between gap-3 py-3 text-left text-sm hover:text-ninja-flameSoft"
              >
                <span className="min-w-0">
                  <span className="block font-medium">
                    N° {e.official_number ?? e.number} · {EVENT_LABEL[e.source_event ?? ""] ?? "Asiento"}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {fmtDate(e.entry_date)} · {e.description}
                  </span>
                </span>
                <span className="shrink-0 tabular-nums">{formatCurrency(e.total)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
