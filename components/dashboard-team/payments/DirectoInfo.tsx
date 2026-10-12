"use client";

// Directo (Crédito Directo S.A.). Dos caminos (ADR-041):
//  - API conectada: el POS crea la orden en Directo y muestra su QR + link;
//    la venta se cierra sola cuando Directo avisa que el crédito se aprobó.
//  - Sin conectar (respaldo, ADR-034): el cajero cobra en el portal de
//    comercios de Directo y en el POS registra el número de operación
//    (payments.method = 'directo', reference = Nº de operación).
import { ExternalLink, Plug } from "lucide-react";

const PORTAL_URL = "https://minegocio.directo.com.ar/login";
const ALTA_URL = "https://sumatucomercio.directo.com.ar/flow";

const API_STEPS = [
  "En el POS elegís Directo QR o Link al cobrar.",
  "El cliente escanea el QR o abre el link y arma su crédito en Directo.",
  "Directo nos avisa, verificamos la orden y la venta se cierra sola.",
];

const MANUAL_STEPS = [
  "En el POS elegís Directo (crédito) al cobrar.",
  "Generás el cobro por el total en el portal de comercios de Directo (QR o link).",
  "Cuando Directo lo aprueba, cargás el número de operación y confirmás la venta.",
];

const linkBtn =
  "inline-flex h-8 items-center gap-1.5 rounded-lg bg-muted px-2.5 text-xs font-semibold text-foreground transition hover:bg-[color-mix(in_srgb,var(--foreground)_10%,transparent)]";

export function DirectoInfo({
  connected = false,
  onConnect,
}: {
  connected?: boolean;
  onConnect?: () => void;
}) {
  const steps = connected ? API_STEPS : MANUAL_STEPS;
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">
        {connected
          ? "Tu cliente compra en cuotas fijas sin tarjeta. La API de Directo está conectada: el cobro se integra solo al POS."
          : "Tu cliente compra en cuotas fijas sin tarjeta. Sin la API conectada, el cobro se hace en el portal de Directo y el POS lo registra."}
      </p>
      <ol className="space-y-1.5">
        {steps.map((step, i) => (
          <li key={i} className="flex gap-2.5 text-muted-foreground">
            <span className="mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--foreground)_10%,transparent)] text-[10px] font-bold text-foreground">
              {i + 1}
            </span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
      <p className="text-xs text-muted-foreground">
        {connected
          ? "Mientras la API esté conectada, el registro manual con número de operación no se ofrece en el POS."
          : "Si Directo te dio credenciales de integración por API, conectalas para cobrar con QR y link sin cargar nada a mano."}
      </p>
      <div className="flex flex-wrap gap-2">
        {!connected && onConnect && (
          <button type="button" onClick={onConnect} className={linkBtn}>
            <Plug size={12} /> Conectar API
          </button>
        )}
        <a href={PORTAL_URL} target="_blank" rel="noopener noreferrer" className={linkBtn}>
          Portal de comercios <ExternalLink size={12} />
        </a>
        {!connected && (
          <a href={ALTA_URL} target="_blank" rel="noopener noreferrer" className={linkBtn}>
            Sumar mi comercio <ExternalLink size={12} />
          </a>
        )}
      </div>
    </div>
  );
}
DirectoInfo.displayName = "DirectoInfo";
