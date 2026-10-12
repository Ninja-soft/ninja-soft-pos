"use client";

// Directo (Crédito Directo S.A., ADR-034): no tiene API pública, así que no
// hay credenciales que conectar. Este bloque explica el circuito manual: el
// cajero cobra en el portal de comercios de Directo y en el POS registra el
// número de operación (payments.method = 'directo', reference = Nº de operación).
import { ExternalLink } from "lucide-react";

const PORTAL_URL = "https://minegocio.directo.com.ar/login";
const ALTA_URL = "https://sumatucomercio.directo.com.ar/flow";

export function DirectoInfo() {
  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/images/payments/directo.webp" alt="Directo" className="h-6 w-auto" />
      </div>
      <p className="text-muted-foreground">
        Con Directo tu cliente compra en cuotas fijas sin tarjeta de crédito. Directo no ofrece
        integración automática, así que el cobro se hace en su portal y el POS lo registra.
      </p>
      <ol className="list-decimal space-y-1 rounded-md bg-muted/40 py-3 pl-8 pr-3 text-muted-foreground">
        <li>En el POS elegí el medio Directo (crédito) al cobrar.</li>
        <li>Generá el cobro por el total en el portal de comercios de Directo (QR o link).</li>
        <li>Cuando Directo lo aprueba, cargá el número de operación y confirmá la venta.</li>
      </ol>
      <p className="text-xs text-muted-foreground">
        Requiere tener cuenta de comercio en Directo. El número de operación queda guardado en
        el pago para conciliar con las liquidaciones de Directo.
      </p>
      <div className="flex flex-wrap gap-3">
        <a
          href={PORTAL_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-ninja-flameSoft hover:underline"
        >
          Portal de comercios <ExternalLink size={12} />
        </a>
        <a
          href={ALTA_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-ninja-flameSoft hover:underline"
        >
          Sumar mi comercio <ExternalLink size={12} />
        </a>
      </div>
    </div>
  );
}
DirectoInfo.displayName = "DirectoInfo";
