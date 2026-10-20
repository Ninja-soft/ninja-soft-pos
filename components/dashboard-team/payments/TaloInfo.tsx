"use client";

// Talo (ADR-175): cobro por transferencia con CVU y alias únicos por venta.
// Sólo por API (Payments API de Talo): sin conectar, la transferencia común
// sigue siendo el medio Transferencia (con comprobante a mano).
import { ExternalLink, Plug } from "lucide-react";

const DASHBOARD_URL = "https://app.talo.com.ar";
const DOCS_URL = "https://docs.talo.com.ar/ecommerce/API/API_Reference/authentication";

const STEPS = [
  "En el POS elegís Transferencia, Talo.",
  "Aparecen un CVU y un alias que son sólo de esa venta, más un QR y un link de Talo con los mismos datos.",
  "El cliente transfiere el total desde cualquier banco o billetera. Talo nos avisa, verificamos el pago y la venta se cierra sola.",
  "Si transfiere de menos, el POS muestra cuánto falta. Si transfiere de más, la venta se cierra y la diferencia se devuelve desde Ventas, Cobros QR.",
];

const linkBtn =
  "inline-flex h-8 items-center gap-1.5 rounded-lg bg-muted px-2.5 text-xs font-semibold text-foreground transition hover:bg-[color-mix(in_srgb,var(--foreground)_10%,transparent)]";

export function TaloInfo({ connected = false, onConnect }: { connected?: boolean; onConnect?: () => void }) {
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">
        {connected
          ? "Talo está conectado: cada cobro por transferencia tiene su propio CVU y se confirma solo."
          : "Conectá tu cuenta de Talo para cobrar transferencias que se confirman solas, sin pedir comprobante."}
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
      <div className="flex flex-wrap gap-2">
        {!connected && onConnect && (
          <button type="button" onClick={onConnect} className={linkBtn}>
            <Plug size={12} /> Conectar Talo
          </button>
        )}
        <a href={DASHBOARD_URL} target="_blank" rel="noopener noreferrer" className={linkBtn}>
          Dashboard de Talo <ExternalLink size={12} />
        </a>
        {!connected && (
          <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className={linkBtn}>
            Cómo generar las credenciales <ExternalLink size={12} />
          </a>
        )}
      </div>
    </div>
  );
}
TaloInfo.displayName = "TaloInfo";
