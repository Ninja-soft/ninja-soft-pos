"use client";

// Directo (Crédito Directo S.A., ADR-034): no tiene API pública, así que no
// hay credenciales que conectar. Este bloque explica el circuito manual: el
// cajero cobra en el portal de comercios de Directo y en el POS registra el
// número de operación (payments.method = 'directo', reference = Nº de operación).
import { ExternalLink } from "lucide-react";

const PORTAL_URL = "https://minegocio.directo.com.ar/login";
const ALTA_URL = "https://sumatucomercio.directo.com.ar/flow";

const STEPS = [
  "En el POS elegís Directo (crédito) al cobrar.",
  "Generás el cobro por el total en el portal de comercios de Directo (QR o link).",
  "Cuando Directo lo aprueba, cargás el número de operación y confirmás la venta.",
];

export function DirectoInfo() {
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">
        Tu cliente compra en cuotas fijas sin tarjeta de crédito. Directo no ofrece integración
        automática: el cobro se hace en su portal y el POS lo registra.
      </p>
      <ol className="space-y-1.5">
        {STEPS.map((step, i) => (
          <li key={i} className="flex gap-2.5 text-muted-foreground">
            <span className="mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--foreground)_10%,transparent)] text-[10px] font-bold text-foreground">
              {i + 1}
            </span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
      <p className="text-xs text-muted-foreground">
        Requiere cuenta de comercio en Directo. El número de operación queda guardado en el pago
        para conciliar con sus liquidaciones.
      </p>
      <div className="flex flex-wrap gap-2">
        <a
          href={PORTAL_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-muted px-2.5 text-xs font-semibold text-foreground transition hover:bg-[color-mix(in_srgb,var(--foreground)_10%,transparent)]"
        >
          Portal de comercios <ExternalLink size={12} />
        </a>
        <a
          href={ALTA_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-muted px-2.5 text-xs font-semibold text-foreground transition hover:bg-[color-mix(in_srgb,var(--foreground)_10%,transparent)]"
        >
          Sumar mi comercio <ExternalLink size={12} />
        </a>
      </div>
    </div>
  );
}
DirectoInfo.displayName = "DirectoInfo";
