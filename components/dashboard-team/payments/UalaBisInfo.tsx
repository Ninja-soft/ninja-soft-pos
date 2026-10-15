"use client";

// Ualá Bis (ADR-143). Dos caminos que conviven:
//  - API conectada (Cobros online v2): el POS arma un link de pago de Ualá
//    (también como QR) y la venta se cierra sola al acreditarse.
//  - Registro manual, siempre disponible: el QR de Ualá, el POS Mini / POS Pro
//    y Tap en tu celu no tienen API pública. El cajero cobra en la app de Ualá
//    y en el POS carga el número de operación (payments.method = 'ualabis').
import { ExternalLink, Plug } from "lucide-react";

const PORTAL_URL = "https://web.ualabis.com.ar/";
const DEVELOPERS_URL = "https://developers.ualabis.com.ar/v2/ambientes";

const API_STEPS = [
  "En el POS elegís Ualá Bis, Link o QR.",
  "El cliente escanea el QR con la cámara del celular (no con una billetera virtual: no es un QR interoperable) o abre el link, y paga con tarjeta de crédito, débito o prepaga en el checkout de Ualá Bis.",
  "Ualá nos avisa, verificamos la orden y la venta se cierra sola.",
];

const MANUAL_STEPS = [
  "En el POS elegís Ualá Bis, QR, POS o Tap.",
  "Cobrás el total con tu QR de Ualá, el POS Mini o Pro o Tap en tu celu.",
  "Cargás el número de operación que te muestra la app y confirmás la venta.",
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

export function UalaBisInfo({ connected = false, onConnect }: { connected?: boolean; onConnect?: () => void }) {
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">
        {connected
          ? "La API de Ualá Bis está conectada: el link de pago y el QR se integran solos al POS. Tu QR, POS o Tap se siguen registrando con el número de operación."
          : "Sin la API conectada, cobrás con tu QR, POS o Tap de Ualá Bis y el POS lo registra con el número de operación."}
      </p>
      {connected && <Steps title="Link de pago y QR" steps={API_STEPS} />}
      <Steps title="QR, POS o Tap" steps={MANUAL_STEPS} />
      {!connected && (
        <p className="text-xs text-muted-foreground">
          Si tenés las credenciales de Cobros online, conectalas para cobrar con link de pago sin cargar nada a mano.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {!connected && onConnect && (
          <button type="button" onClick={onConnect} className={linkBtn}>
            <Plug size={12} /> Conectar API
          </button>
        )}
        <a href={PORTAL_URL} target="_blank" rel="noopener noreferrer" className={linkBtn}>
          Portal de Ualá Bis <ExternalLink size={12} />
        </a>
        {!connected && (
          <a href={DEVELOPERS_URL} target="_blank" rel="noopener noreferrer" className={linkBtn}>
            Credenciales de la API <ExternalLink size={12} />
          </a>
        )}
      </div>
    </div>
  );
}
UalaBisInfo.displayName = "UalaBisInfo";
