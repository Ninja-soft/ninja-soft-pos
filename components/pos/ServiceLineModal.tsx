"use client";

// Aclaraciones de un renglón de servicio en el POS (ADR-116): descripción
// ampliada (viene del servicio, se puede cambiar para esta venta),
// aclaraciones predefinidas y una aclaración libre (lote, dirección del
// relevamiento, N° de muestra, normativa). Todo viaja a la factura debajo del
// nombre del servicio.

import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import type { CartLine } from "@/modules/pos/store";
import type { ServiceClarification, ServiceProductInfo } from "@/modules/services/api";

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  line: CartLine | null;
  info: ServiceProductInfo | null;
  clarifications: ServiceClarification[];
  onSave: (v: { lineDetail: string | null; clarificationIds: string[]; lineNote: string | null }) => void;
}

const areaCls =
  "w-full resize-y rounded-xl border-0 bg-muted px-3.5 py-3 text-sm leading-relaxed text-foreground outline-none transition placeholder:text-muted-foreground focus:bg-secondary focus:shadow-[inset_0_0_0_1px_var(--border)]";

export function ServiceLineModal({ open, onOpenChange, line, info, clarifications, onSave }: Props) {
  const [detail, setDetail] = useState("");
  const [ids, setIds] = useState<string[]>([]);
  const [note, setNote] = useState("");

  useEffect(() => {
    if (!open || !line) return;
    setDetail(line.lineDetail !== undefined ? (line.lineDetail ?? "") : (info?.invoice_detail ?? ""));
    setIds(line.clarificationIds ?? info?.service_clarification_ids ?? []);
    setNote(line.lineNote ?? "");
  }, [open, line, info]);

  const active = clarifications.filter((c) => c.is_active || ids.includes(c.id));

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={line ? `Aclaraciones: ${line.name}` : "Aclaraciones"}
      description="Sale en la factura debajo del servicio, sólo en esta venta."
      className="sm:max-w-lg"
      footer={
        <>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            type="button"
            onClick={() => {
              onSave({
                lineDetail: detail.trim() ? detail.trim() : null,
                clarificationIds: ids,
                lineNote: note.trim() ? note.trim() : null,
              });
              onOpenChange(false);
            }}
          >
            Guardar
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Aclaración de este renglón</span>
          <textarea
            className={`${areaCls} min-h-[96px]`}
            placeholder={"Lote 2381, muestra N° 45\nRelevamiento en Av. Pellegrini 1200, Rosario"}
            maxLength={1000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            autoFocus
          />
          <span className="mt-1 block text-xs text-muted-foreground">
            Lote, dirección del relevamiento, N° de muestra o normativa aplicada.
          </span>
        </label>

        {active.length > 0 && (
          <section>
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Aclaraciones predefinidas
            </h3>
            <div className="divide-y divide-border rounded-lg bg-muted">
              {active.map((c) => {
                const on = ids.includes(c.id);
                return (
                  <div key={c.id} className="flex items-center justify-between gap-4 px-3.5 py-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground">{c.title}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{c.body}</p>
                    </div>
                    <Switch
                      checked={on}
                      onCheckedChange={(v) => setIds((prev) => (v ? [...prev.filter((x) => x !== c.id), c.id] : prev.filter((x) => x !== c.id)))}
                      label={`Sumar ${c.title}`}
                    />
                  </div>
                );
              })}
            </div>
          </section>
        )}

        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Descripción en la factura</span>
          <textarea
            className={`${areaCls} min-h-[84px]`}
            placeholder="Qué incluye el trabajo. Empezá una línea con un guion para hacer una lista."
            maxLength={2000}
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
          />
        </label>
      </div>
    </Modal>
  );
}
