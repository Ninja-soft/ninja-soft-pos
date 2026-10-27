"use client";

// dLocal Go (ADR-180): link de pago y QR con el checkout de la Payments API de
// dLocal Go. Sin registro manual: sólo funciona con la API conectada. Las
// devoluciones totales se piden desde la conciliación de cobros QR.
import { ExternalLink, Plug } from "lucide-react";

const DASHBOARD_URL = "https://dashboard.dlocalgo.com";
const DOCS_URL = "https://docs.dlocalgo.com/integration-api/welcome-to-dlocal-go-api";

const API_STEPS = [
  "En el POS elegís dLocal Go, Link o QR.",
  "El cliente abre el link o escanea el QR con la cámara del celular y paga con tarjeta en el checkout de dLocal Go.",
  "dLocal Go nos avisa, verificamos el pago y la venta se cierra sola.",
];

const CONNECT_STEPS = [
  "Entrá al dashboard de dLocal Go con tu cuenta.",
  "Abrí Integraciones › API Integration y copiá la API Key y la Secret Key.",
  "Conectalas acá: las probamos antes de guardarlas.",
];

const linkBtn =
  "inline-flex h-8 items-center gap-1.5 rounded-lg bg-muted px-2.5 text-xs font-semibold text-foreground transition hover:bg-[color-mix(in_srgb,var(--foreground)_10%,transparent)]";

function Steps({ title, steps }: { title: string; steps: string[] }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">{title}</p>
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
    </div>
  );
}

export function DlocalGoInfo({ connected = false, onConnect }: { connected?: boolean; onConnect?: () => void }) {
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">
        {connected
          ? "La API de dLocal Go está conectada: el link de pago y el QR se integran solos al POS."
          : "Para cobrar con dLocal Go desde el POS necesitás conectar la API con tus credenciales."}
      </p>
      {connected ? <Steps title="Link de pago y QR" steps={API_STEPS} /> : <Steps title="Cómo conectarla" steps={CONNECT_STEPS} />}
      <p className="text-xs text-muted-foreground">
        Las devoluciones totales se piden desde Ventas, Cobros QR, en el cobro aprobado sin venta vigente.
      </p>
      <div className="flex flex-wrap gap-2">
        {!connected && onConnect && (
          <button type="button" onClick={onConnect} className={linkBtn}>
            <Plug size={12} /> Conectar API
          </button>
        )}
        <a href={DASHBOARD_URL} target="_blank" rel="noopener noreferrer" className={linkBtn}>
          Dashboard de dLocal Go <ExternalLink size={12} />
        </a>
        {!connected && (
          <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className={linkBtn}>
            Documentación de la API <ExternalLink size={12} />
          </a>
        )}
      </div>
    </div>
  );
}
DlocalGoInfo.displayName = "DlocalGoInfo";
