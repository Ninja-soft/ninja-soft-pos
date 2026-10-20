"use client";

// Talo (ADR-175): datos de la transferencia en el cobro del POS. El CVU y el
// alias son únicos de esta venta: se muestran grandes y copiables para que el
// cliente los dicte o los copie, junto al total exacto. Si llegó menos plata
// (UNDERPAID) avisa cuánto falta; la venta no se cierra hasta completar.
import { useState } from "react";
import { AlertTriangle, Check, Copy } from "lucide-react";
import { Callout } from "@/components/ui/Callout";
import { useToast } from "@/components/ui/Toast";
import { formatCurrency } from "@/lib/utils/format";
import { formatCvu, taloWaitingNote } from "@/lib/payments/talo";
import type { TaloStatus } from "@/modules/pos/api";

function CopyRow({ label, value, display }: { label: string; value: string; display: string }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
      toast({ title: `${label} copiado`, variant: "success" });
    } catch {
      toast({ title: `No se pudo copiar el ${label}`, variant: "error" });
    }
  }
  return (
    <button
      type="button"
      onClick={() => void copy()}
      className="group flex w-full items-center justify-between gap-3 rounded-lg bg-fg-4 px-3 py-2.5 text-left transition hover:bg-fg-6"
      aria-label={`Copiar ${label}`}
    >
      <span className="min-w-0">
        <span className="block text-xs text-muted-foreground">{label}</span>
        <span className="block break-all font-mono text-lg font-bold tabular-nums leading-snug md:text-xl">{display}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1 text-xs font-semibold text-muted-foreground group-hover:text-foreground">
        {copied ? <Check size={14} aria-hidden className="text-success" /> : <Copy size={14} aria-hidden />}
        {copied ? "Copiado" : "Copiar"}
      </span>
    </button>
  );
}

export function TaloTransferPanel({
  cvu,
  alias,
  amount,
  status,
}: {
  cvu: string | null;
  alias: string | null;
  amount: number;
  status: TaloStatus | null | undefined;
}) {
  const note = taloWaitingNote(status);
  return (
    <div className="space-y-2.5">
      <p className="text-sm text-muted-foreground">
        El cliente transfiere exactamente {formatCurrency(amount)} desde su banco o billetera a estos datos, que son
        sólo de esta venta. La pantalla se actualiza sola cuando llega la plata.
      </p>
      {alias && <CopyRow label="Alias" value={alias} display={alias} />}
      {cvu && <CopyRow label="CVU" value={cvu} display={formatCvu(cvu)} />}
      {!cvu && !alias && (
        <p className="text-sm text-muted-foreground">El cliente ve el CVU y el alias al abrir el link o escanear el QR.</p>
      )}
      {note && (
        <Callout tone={note.tone} icon={AlertTriangle} title={note.title}>
          {note.text}
        </Callout>
      )}
    </div>
  );
}
TaloTransferPanel.displayName = "TaloTransferPanel";
