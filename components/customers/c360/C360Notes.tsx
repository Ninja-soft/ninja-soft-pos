"use client";

import { useState } from "react";
import { Pin, StickyNote, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { useCustomerNotes } from "@/modules/customers/c360";
import type { C360Summary } from "@/lib/customers/c360";

const when = (iso: string) =>
  new Date(iso).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });

// Notas internas del cliente (no las ve el cliente). Las fijadas quedan arriba;
// todas aparecen en la línea de tiempo.
export function C360Notes({ customerId, pinned }: { customerId: string; pinned: C360Summary["pinned_notes"] }) {
  const { toast } = useToast();
  const { add, remove } = useCustomerNotes(customerId);
  const [body, setBody] = useState("");
  const [pin, setPin] = useState(false);

  const save = () =>
    add.mutate(
      { body: body.trim(), pinned: pin },
      {
        onSuccess: () => {
          setBody("");
          setPin(false);
          toast({ title: "Nota guardada", variant: "success" });
        },
        onError: () => toast({ title: "No se pudo guardar la nota", variant: "error" }),
      },
    );

  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <StickyNote size={15} className="text-muted-foreground" /> Notas internas
      </h2>
      {pinned.length > 0 && (
        <ul className="mt-3 space-y-2">
          {pinned.map((n) => (
            <li key={n.id} className="rounded-lg bg-ninja-gold/10 px-3 py-2 text-sm">
              <div className="flex items-start justify-between gap-2">
                <p className="min-w-0 whitespace-pre-wrap break-words">
                  <Pin size={13} className="mr-1.5 inline align-[-2px] text-warning" />
                  {n.body}
                </p>
                <button
                  type="button"
                  title="Borrar nota"
                  onClick={() =>
                    remove.mutate(n.id, {
                      onError: () => toast({ title: "Sólo quien la escribió o un encargado la puede borrar", variant: "error" }),
                    })
                  }
                  className="shrink-0 rounded-md p-1 text-muted-foreground transition hover:bg-muted hover:text-danger"
                >
                  <Trash2 size={14} />
                </button>
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {n.author ?? "Alguien del equipo"} · {when(n.created_at)}
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 space-y-2">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={2000}
          rows={3}
          placeholder="Ej.: prefiere que le avisen por WhatsApp, compra para su local, pidió factura A."
          className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-ninja-flameSoft focus:ring-2 focus:ring-ninja-flameSoft/20"
        />
        <div className="flex items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Switch checked={pin} onCheckedChange={setPin} label="Fijar arriba" />
            Fijar arriba
          </label>
          <Button className="h-9 px-3" disabled={!body.trim()} loading={add.isPending} onClick={save}>
            Guardar nota
          </Button>
        </div>
      </div>
    </section>
  );
}
