"use client";

import { useState } from "react";
import { Cake, Mail, Phone } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { useBirthdays } from "@/modules/customers/hooks";

const MONTHS = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

// Cumpleaños del mes (H40 base): lista de clientes que cumplen, para campañas
// de retención. Solo lectura.
export function BirthdaysModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [month, setMonth] = useState(() => new Date().getMonth());
  const { data, isLoading } = useBirthdays(month, open);

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Cumpleaños"
      className="max-w-lg"
    >
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Cake size={16} className="text-ninja-flameSoft" />
          <select
            value={month}
            onChange={(e) => setMonth(Number(e.target.value))}
            className="h-10 rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
          >
            {MONTHS.map((m, i) => (
              <option key={m} value={i}>
                {m}
              </option>
            ))}
          </select>
          <span className="text-sm text-muted-foreground">
            {data ? `${data.length} cliente(s)` : ""}
          </span>
        </div>

        <div className="max-h-80 space-y-1 overflow-y-auto">
          {isLoading && (
            <p className="py-6 text-center text-sm text-muted-foreground">Cargando…</p>
          )}
          {!isLoading && data && data.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Nadie cumple en {MONTHS[month]}.
            </p>
          )}
          {data?.map((c) => (
            <div
              key={c.id}
              className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-sm"
            >
              <span className="flex items-center gap-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ninja-flame/15 text-xs font-bold text-ninja-flameSoft">
                  {c.day}
                </span>
                <span className="font-medium">{c.name}</span>
              </span>
              <span className="flex items-center gap-3 text-xs text-muted-foreground">
                {c.phone && (
                  <a href={`tel:${c.phone}`} className="flex items-center gap-1 hover:text-foreground">
                    <Phone size={13} /> {c.phone}
                  </a>
                )}
                {c.email && (
                  <a href={`mailto:${c.email}`} className="flex items-center gap-1 hover:text-foreground">
                    <Mail size={13} /> Email
                  </a>
                )}
              </span>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
