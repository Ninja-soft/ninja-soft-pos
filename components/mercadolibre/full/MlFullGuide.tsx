"use client";

import { BookOpen, CheckCircle2, ListChecks, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { FULL_CHECKLIST, FULL_GLOSSARY, FULL_NA_REASONS, type FullNaReason } from "@/lib/mercadolibre/full";

const WHERE_LABEL = { ml: "En Mercado Libre", pos: "En NinjaSoft", both: "En los dos" } as const;
const WHERE_TONE = { ml: "gold", pos: "brand", both: "info" } as const;

// Cómo funciona Full y qué hace cada paso (ADR-142). Sólo texto: lo que se
// explica acá es lo que hacen las RPC ml_full_* y la Edge ml_full.
export function MlFullGuide({ done }: { done?: Partial<Record<string, boolean>> }) {
  return (
    <div className="space-y-5">
      <Callout tone="info" icon={BookOpen} title="Qué es Full y cómo lo lleva el sistema">
        Con Full, Mercado Libre guarda tu mercadería en sus centros y despacha cada venta. En NinjaSoft cada cuenta
        tiene un depósito virtual <strong>Mercado Libre Full</strong> con el stock real que informa Mercado Libre. Ese
        stock <strong>no se vende en el mostrador</strong> y no se mezcla con tu stock propio: cuando ML vende por Full,
        descuenta de Full, no de tus sucursales.
      </Callout>

      <section aria-labelledby="full-steps" className="space-y-3">
        <h3 id="full-steps" className="flex items-center gap-2 text-sm font-semibold">
          <ListChecks size={16} aria-hidden /> Paso a paso de un envío a Full
        </h3>
        <ol className="space-y-2">
          {FULL_CHECKLIST.map((s, i) => (
            <li key={s.key} className="flex gap-3 rounded-xl bg-card p-3.5">
              <span
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-bold"
                aria-hidden
              >
                {done?.[s.key] ? <CheckCircle2 size={16} className="text-success" /> : i + 1}
              </span>
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <p className="text-sm font-semibold">{s.title}</p>
                  <Badge tone={WHERE_TONE[s.where]}>{WHERE_LABEL[s.where]}</Badge>
                  {done?.[s.key] && <Badge tone="success">Hecho</Badge>}
                </div>
                <p className="text-sm text-muted-foreground">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="full-na" className="space-y-2">
        <h3 id="full-na" className="text-sm font-semibold">Por qué una unidad en Full puede no estar disponible</h3>
        <div className="grid gap-2 sm:grid-cols-2">
          {(Object.keys(FULL_NA_REASONS) as FullNaReason[]).map((k) => (
            <div key={k} className="rounded-xl bg-card p-3">
              <p className="text-sm font-medium">{FULL_NA_REASONS[k].label}</p>
              <p className="text-xs text-muted-foreground">{FULL_NA_REASONS[k].help}</p>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="full-words" className="space-y-2">
        <h3 id="full-words" className="text-sm font-semibold">Palabras que vas a ver</h3>
        <dl className="grid gap-2 sm:grid-cols-2">
          {FULL_GLOSSARY.map((g) => (
            <div key={g.term} className="rounded-xl bg-card p-3">
              <dt className="text-sm font-medium">{g.term}</dt>
              <dd className="text-xs text-muted-foreground">{g.meaning}</dd>
            </div>
          ))}
        </dl>
      </section>

      <Callout tone="neutral" icon={ShieldCheck} title="Cómo comprobarlo vos">
        <ul className="list-disc space-y-1 pl-4">
          <li>El disponible de cada producto en Stock en Full es el mismo que muestra Mercado Libre en Ventas › Full › Stock.</li>
          <li>Al despachar un envío, el historial de stock del producto muestra un &quot;Traslado enviado&quot; con el número del envío.</li>
          <li>Una venta por Full aparece en Ventas, pero el stock de tu sucursal no cambia.</li>
          <li>Cada envío, despacho, conciliación y cancelación queda en la auditoría con quién y cuándo.</li>
        </ul>
      </Callout>
    </div>
  );
}
