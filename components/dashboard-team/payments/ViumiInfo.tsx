"use client";

// Viumi (ADR-173): link de pago y QR por la Checkout API v2 de Viumi (Banco
// Macro). Sin registro manual: sólo funciona con la API conectada. Las
// devoluciones no tienen API: se hacen desde la app o el panel de Viumi.
import { ExternalLink, Mail, Plug } from "lucide-react";

const PORTAL_URL = "https://www.viumi.com.ar";
const DEVELOPERS_URL = "https://developers.viumi.com.ar";
const CREDENTIALS_EMAIL = "consultas@viumi.com.ar";

const API_STEPS = [
  "En el POS elegís Viumi, Link o QR.",
  "El cliente abre el link o escanea el QR con la cámara del celular y paga con tarjeta en el checkout de Viumi.",
  "Viumi nos avisa, verificamos la orden y la venta se cierra sola.",
];

const CONNECT_STEPS = [
  `Pedile a Viumi las credenciales de la API: escribiles a ${CREDENTIALS_EMAIL}.`,
  "Te mandan un Client ID y un Client Secret (de prueba o de producción).",
  "Conectalos acá: los probamos antes de guardarlos.",
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

export function ViumiInfo({ connected = false, onConnect }: { connected?: boolean; onConnect?: () => void }) {
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">
        {connected
          ? "La API de Viumi está conectada: el link de pago y el QR se integran solos al POS."
          : "Para cobrar con Viumi desde el POS necesitás conectar la API con tus credenciales."}
      </p>
      {connected ? <Steps title="Link de pago y QR" steps={API_STEPS} /> : <Steps title="Cómo conectarla" steps={CONNECT_STEPS} />}
      <p className="text-xs text-muted-foreground">
        Las devoluciones no tienen API: las hacés desde la app o el panel de Viumi.
      </p>
      <div className="flex flex-wrap gap-2">
        {!connected && onConnect && (
          <button type="button" onClick={onConnect} className={linkBtn}>
            <Plug size={12} /> Conectar API
          </button>
        )}
        <a href={PORTAL_URL} target="_blank" rel="noopener noreferrer" className={linkBtn}>
          Portal de Viumi <ExternalLink size={12} />
        </a>
        {!connected && (
          <>
            <a href={`mailto:${CREDENTIALS_EMAIL}`} className={linkBtn}>
              <Mail size={12} /> Pedir credenciales
            </a>
            <a href={DEVELOPERS_URL} target="_blank" rel="noopener noreferrer" className={linkBtn}>
              Documentación de la API <ExternalLink size={12} />
            </a>
          </>
        )}
      </div>
    </div>
  );
}
ViumiInfo.displayName = "ViumiInfo";
