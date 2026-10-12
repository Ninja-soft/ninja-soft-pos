"use client";

// Detección automática de la transferencia (ADR-061) en la hoja de cobro: con
// una cuenta de Mercado Pago con la detección prendida, el POS abre una
// espera en el servidor (Edge transfer_watch) y la consulta cada 4 segundos.
//   Esperando → Recibiste $X de <nombre / CUIT> (Cerrar ticket o No es esta)
//   Varias que coinciden → el cajero elige.  Vencida → Seguir esperando.
// En modo "Cerrar la venta sola" la línea se confirma sola al detectarla. La
// confirmación manual ("Ya transfirió") sigue disponible siempre.

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Clock, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import {
  transferWatchApi,
  transferWatchErrorMessage,
  type TransferWatchView,
} from "@/modules/payments/transfer";

const POLL_MS = 4000;

export function TransferAutoDetect({
  accountId,
  amount,
  storeId,
  registerId,
  onUse,
}: {
  accountId: string;
  amount: number;
  storeId: string | null;
  registerId: string | null;
  /** Confirma la línea con el id del movimiento de Mercado Pago como n° de operación. */
  onUse: (mpPaymentId: string) => void;
}) {
  const [watch, setWatch] = useState<TransferWatchView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const watchRef = useRef<TransferWatchView | null>(null);
  const usedRef = useRef(false);
  const autoDoneRef = useRef<string | null>(null);
  const [round, setRound] = useState(0);

  const set = (w: TransferWatchView) => {
    watchRef.current = w;
    setWatch(w);
  };

  // Abre la espera (una por cuenta, monto y vuelta) y la cancela al salir si
  // no se usó la transferencia detectada.
  useEffect(() => {
    let alive = true;
    usedRef.current = false;
    setError(null);
    setWatch(null);
    watchRef.current = null;
    transferWatchApi
      .start({ accountId, amount, storeId, registerId })
      .then((w) => {
        if (alive) set(w);
        else void transferWatchApi.cancel(w.id).catch(() => null);
      })
      .catch((e) => alive && setError(transferWatchErrorMessage(e)));
    return () => {
      alive = false;
      const w = watchRef.current;
      if (w && !usedRef.current && w.status !== "cancelled" && w.status !== "closed") {
        void transferWatchApi.cancel(w.id).catch(() => null);
      }
    };
  }, [accountId, amount, storeId, registerId, round]);

  // Sondeo mientras espera.
  useEffect(() => {
    if (!watch || (watch.status !== "waiting" && watch.status !== "ambiguous")) return;
    const t = setInterval(() => {
      const w = watchRef.current;
      if (!w) return;
      transferWatchApi
        .poll(w.id)
        .then((n) => {
          set(n);
          setError(n.error ? transferWatchErrorMessage(new Error(n.error)) : null);
        })
        .catch((e) => setError(transferWatchErrorMessage(e)));
    }, POLL_MS);
    return () => clearInterval(t);
  }, [watch?.id, watch?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const use = useCallback(
    (id: string) => {
      usedRef.current = true;
      onUse(id);
    },
    [onUse],
  );

  // Modo "Cerrar la venta sola".
  useEffect(() => {
    if (watch?.status === "matched" && watch.mode === "auto_close" && watch.match && autoDoneRef.current !== watch.match.id) {
      autoDoneRef.current = watch.match.id;
      use(watch.match.id);
    }
  }, [watch, use]);

  async function act(fn: () => Promise<TransferWatchView>) {
    setBusy(true);
    try {
      set(await fn());
      setError(null);
    } catch (e) {
      setError(transferWatchErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const box = "rounded-lg border px-3 py-3 text-sm";

  if (error && !watch) {
    return <div className={cn(box, "border-border text-xs text-muted-foreground")}>{error}</div>;
  }
  if (!watch) {
    return (
      <div className={cn(box, "flex items-center gap-2 border-border text-muted-foreground")}>
        <Spinner size={14} /> Preparando la detección de la transferencia...
      </div>
    );
  }

  if (watch.status === "matched" && watch.match) {
    const who = [watch.match.payer_name, watch.match.payer_doc].filter(Boolean).join(" · ");
    return (
      <div className={cn(box, "border-success/40 bg-success/10")} role="status" aria-live="polite">
        <p className="flex items-center gap-2 font-semibold text-foreground">
          <CheckCircle2 size={16} className="text-success" aria-hidden />
          Recibiste {formatCurrency(watch.match.amount)}
          {who ? ` de ${who}` : ""}
        </p>
        {Math.abs(watch.match.amount - watch.amount) > 0.005 && (
          <p className="mt-1 text-xs text-warning">
            La venta es de {formatCurrency(watch.amount)}: diferencia de {formatCurrency(watch.match.amount - watch.amount)}.
          </p>
        )}
        <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">Operación {watch.match.id}</p>
        {watch.mode === "auto_close" ? (
          <p className="mt-2 text-xs text-muted-foreground">Cerrando la venta...</p>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" onClick={() => use(watch.match!.id)} disabled={busy}>
              Cerrar ticket
            </Button>
            <Button size="sm" variant="ghost" onClick={() => act(() => transferWatchApi.reject(watch.id))} disabled={busy}>
              No es esta
            </Button>
          </div>
        )}
      </div>
    );
  }

  if (watch.status === "ambiguous") {
    return (
      <div className={cn(box, "border-warning/40 bg-warning/10")} role="status" aria-live="polite">
        <p className="font-semibold text-foreground">Hay más de una transferencia que coincide</p>
        <p className="mt-0.5 text-xs text-muted-foreground">Elegí la de este cliente o seguí esperando.</p>
        <ul className="mt-2 space-y-1.5">
          {watch.candidates.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                disabled={busy}
                onClick={() => act(() => transferWatchApi.pick(watch.id, c.id))}
                className="flex w-full items-center justify-between gap-2 rounded-md border border-border bg-background px-3 py-2 text-left text-xs transition hover:bg-muted"
              >
                <span className="min-w-0 truncate">
                  {new Date(c.at).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}
                  {c.payer_name ? ` · ${c.payer_name}` : ""}
                  {c.payer_doc ? ` · ${c.payer_doc}` : ""}
                </span>
                <span className="shrink-0 font-semibold tabular-nums">{formatCurrency(c.amount)}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (watch.status === "expired" || watch.status === "cancelled") {
    return (
      <div className={cn(box, "border-border")}>
        <p className="flex items-center gap-2 text-foreground">
          <Clock size={15} aria-hidden /> No llegó la transferencia en el tiempo de espera.
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">Podés seguir esperando o confirmarla a mano con el n° de operación.</p>
        <Button size="sm" variant="secondary" className="mt-2" onClick={() => setRound((r) => r + 1)}>
          <RefreshCw size={14} /> Seguir esperando
        </Button>
      </div>
    );
  }

  return (
    <div className={cn(box, "flex items-start gap-2 border-border")} role="status" aria-live="polite">
      <Spinner size={14} />
      <div className="min-w-0">
        <p className="font-medium text-foreground">Esperando transferencia de {formatCurrency(watch.amount)}...</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {watch.tolerance > 0 ? `Acepta ± ${formatCurrency(watch.tolerance)}. ` : ""}
          Hasta las {new Date(watch.expires_at).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}.
          {watch.mode === "auto_close" ? " La venta se cierra sola al llegar." : ""}
        </p>
        {error && <p className="mt-1 text-xs text-warning">{error}</p>}
      </div>
    </div>
  );
}
