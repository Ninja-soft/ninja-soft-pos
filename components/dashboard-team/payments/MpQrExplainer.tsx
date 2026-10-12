"use client";

import { BadgePercent, Lightbulb, Link2, ScanLine } from "lucide-react";
import { Disclosure } from "@/components/ui/Disclosure";

// "¿Qué cambia si lo activo?": diferencia entre el QR del link de pago (hoy) y
// el QR de cobro presencial de Mercado Pago ("QR en el mostrador").
const ROWS: { label: string; today: string; active: string }[] = [
  {
    label: "Pasos del cliente",
    today: "Escanea, se abre la web, inicia sesión y paga",
    active: "Escanea y confirma",
  },
  { label: "Ideal para", today: "Pagos a distancia", active: "Pagos en el local" },
  { label: "Nombre de tu local en la app", today: "No siempre", active: "Sí" },
  { label: "Enviar link por WhatsApp", today: "Sí", active: "Sí, sigue disponible" },
];

export function MpQrExplainer({ defaultOpen }: { defaultOpen: boolean }) {
  return (
    <Disclosure variant="help" title="¿Qué cambia si lo activo?" defaultOpen={defaultOpen}>
      <div className="space-y-3 text-foreground">
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="rounded-lg bg-muted p-3">
            <p className="flex items-center gap-2 font-semibold">
              <Link2 size={16} className="shrink-0 text-muted-foreground" aria-hidden />
              Sin activar (hoy)
            </p>
            <p className="mt-1 text-muted-foreground">
              El POS muestra un QR con un link de pago adentro. El cliente lo escanea, se abre
              una página de Mercado Pago, muchas veces inicia sesión, elige el medio y paga.
              Sirve, pero tiene más pasos y está pensado para pagos a distancia.
            </p>
          </div>
          <div className="rounded-lg bg-success/10 p-3">
            <p className="flex items-center gap-2 font-semibold">
              <ScanLine size={16} className="shrink-0 text-success" aria-hidden />
              Con QR en el mostrador
            </p>
            <p className="mt-1 text-muted-foreground">
              El POS muestra el QR de cobro presencial. El cliente lo escanea con la app de
              Mercado Pago y ya ve el monto y el nombre de tu negocio: confirma con un toque, sin
              páginas web. La venta se cierra sola apenas paga.
            </p>
          </div>
        </div>

        <div className="overflow-hidden rounded-lg bg-muted/60">
          <div className="grid grid-cols-2 gap-2 px-3 pt-2.5 text-xs font-semibold text-muted-foreground">
            <span>Sin activar</span>
            <span>Activado</span>
          </div>
          <ul className="divide-y divide-border/60">
            {ROWS.map((r) => (
              <li key={r.label} className="px-3 py-2.5">
                <p className="text-xs font-medium text-muted-foreground">{r.label}</p>
                <div className="mt-0.5 grid grid-cols-2 gap-2">
                  <span>{r.today}</span>
                  <span className="font-semibold">{r.active}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <p className="flex items-start gap-2 text-muted-foreground">
          <BadgePercent size={16} className="mt-0.5 shrink-0" aria-hidden />
          <span>
            Las comisiones de Mercado Pago pueden ser distintas para el cobro presencial y para
            el link de pago. Revisalas en tu cuenta, en Tu negocio → Costos.
          </span>
        </p>
        <p className="flex items-start gap-2 rounded-lg bg-ninja-flame/[0.08] p-3">
          <Lightbulb size={16} className="mt-0.5 shrink-0 text-ninja-flameSoft" aria-hidden />
          <span>
            Si tus clientes pagan seguido con la app de Mercado Pago en el mostrador, activalo: es
            un paso de una sola vez. Si no, todo sigue funcionando como hoy.
          </span>
        </p>
      </div>
    </Disclosure>
  );
}
