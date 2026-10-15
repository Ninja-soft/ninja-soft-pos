"use client";

import { useEffect, useMemo, useState } from "react";
import { RefreshCw, Wand2 } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { selectCls } from "@/components/stock/transfers/shared";
import { formatInt } from "@/lib/utils/format";
import { fullErrorMessage, reconcileReception, receptionFromMl, type ReceptionLine } from "@/lib/mercadolibre/full";
import { useMlFullMutations, type MlFullInbound } from "@/modules/mercadolibre/fullHooks";

const numCls = "h-10 w-20 rounded-lg border border-input bg-background px-2 text-right text-sm tabular-nums";

/**
 * Recepción y conciliación de un envío a Full (ADR-142): enviado, recibido,
 * dañado y faltante por producto, con la sugerencia leída de Mercado Libre.
 */
export function MlFullReceiveModal({
  open,
  onOpenChange,
  inbound,
  canClose,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  inbound: MlFullInbound;
  /** Dueño o encargado: cerrar con diferencias. */
  canClose: boolean;
}) {
  const { toast } = useToast();
  const { receive, checkReception } = useMlFullMutations();
  const [lines, setLines] = useState<ReceptionLine[]>([]);

  useEffect(() => {
    if (!open) return;
    setLines(
      inbound.items.map((i) => ({
        id: i.id,
        title: i.title,
        sent: i.qty_sent,
        received: i.qty_received,
        damaged: i.qty_damaged,
        missingAction: null,
        missingReason: "",
      })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, inbound.id]);

  const result = useMemo(() => reconcileReception(lines), [lines]);
  const hasMl = inbound.items.some((i) => i.ml_received !== null || i.ml_damaged !== null);
  const set = (id: string, patch: Partial<ReceptionLine>) => setLines((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)));

  const useMl = () => {
    const sug = receptionFromMl(inbound.items.map((i) => ({ id: i.id, sent: i.qty_sent, ml_received: i.ml_received, ml_damaged: i.ml_damaged })));
    setLines((ls) => ls.map((l) => ({ ...l, ...(sug.find((s) => s.id === l.id) ?? {}) })));
  };

  const submit = (close: boolean) => {
    receive.mutate(
      {
        id: inbound.id,
        close,
        lines: lines.map((l) => ({
          item_id: l.id,
          received: l.received,
          damaged: l.damaged,
          missing_action: l.missingAction ?? null,
          missing_reason: l.missingReason?.trim() || null,
        })),
      },
      {
        onSuccess: (r) => {
          toast({
            title: close ? (r.status === "received" ? "Envío recibido sin diferencias" : "Envío cerrado con diferencias") : "Recepción guardada",
            variant: "success",
          });
          if (close) onOpenChange(false);
        },
        onError: (e) => toast({ title: "No se pudo guardar la recepción", description: fullErrorMessage(e), variant: "error" }),
      },
    );
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`Recepción del envío N° ${inbound.number}`}
      description="Cargá lo que recibió Full. Lo dañado queda en Full como no disponible; lo que faltó lo marcás como perdido o como que vuelve a tu depósito."
      footer={
        <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={() => submit(false)} disabled={!result.canSave} loading={receive.isPending && !receive.variables?.close}>
            Guardar lo contado
          </Button>
          {canClose && (
            <Button onClick={() => submit(true)} disabled={!result.canClose} loading={receive.isPending && receive.variables?.close}>
              {result.closeStatus === "received" ? "Cerrar: recibido completo" : "Cerrar con diferencias"}
            </Button>
          )}
        </div>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            loading={checkReception.isPending}
            onClick={() =>
              checkReception.mutate(
                { accountId: inbound.account_id, inboundId: inbound.id },
                {
                  onSuccess: (r) =>
                    toast({
                      title: r.lines.length ? "Recepción leída de Mercado Libre" : "Mercado Libre todavía no informa recepción",
                      description: r.lines.length ? "Revisá la sugerencia y aplicala." : "Probá de nuevo cuando ML procese el envío.",
                      variant: r.lines.length ? "success" : "info",
                    }),
                  onError: (e) => toast({ title: "No se pudo leer Mercado Libre", description: fullErrorMessage(e), variant: "error" }),
                },
              )
            }
          >
            <RefreshCw size={15} /> Leer de Mercado Libre
          </Button>
          {hasMl && (
            <Button variant="ghost" size="sm" onClick={useMl}>
              <Wand2 size={15} /> Usar lo que informó ML
            </Button>
          )}
        </div>

        <ul className="space-y-2">
          {lines.map((l, idx) => {
            const r = result.lines[idx]!;
            const item = inbound.items.find((i) => i.id === l.id);
            return (
              <li key={l.id} className="space-y-2 rounded-xl bg-card p-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  <p className="text-sm font-medium">{l.title}</p>
                  <span className="font-mono text-xs text-muted-foreground">{item?.inventory_id}</span>
                  {item?.ml_received !== null && item?.ml_received !== undefined && (
                    <Badge tone="info">
                      ML: {formatInt(item.ml_received)} recibidas{item.ml_damaged ? `, ${formatInt(item.ml_damaged)} dañadas` : ""}
                    </Badge>
                  )}
                </div>
                <div className="flex flex-wrap items-end gap-3 text-sm">
                  <div>
                    <p className="text-[11px] text-muted-foreground">Enviadas</p>
                    <p className="h-10 py-2 font-semibold tabular-nums">{formatInt(l.sent)}</p>
                  </div>
                  <label>
                    <span className="block text-[11px] text-muted-foreground">Recibidas</span>
                    <input type="number" min={0} inputMode="numeric" className={numCls} value={l.received}
                      onChange={(e) => set(l.id, { received: Math.floor(Number(e.target.value) || 0) })} />
                  </label>
                  <label>
                    <span className="block text-[11px] text-muted-foreground">Dañadas</span>
                    <input type="number" min={0} inputMode="numeric" className={numCls} value={l.damaged}
                      onChange={(e) => set(l.id, { damaged: Math.floor(Number(e.target.value) || 0) })} />
                  </label>
                  <div>
                    <p className="text-[11px] text-muted-foreground">Faltan</p>
                    <p className={`h-10 py-2 font-semibold tabular-nums ${r.missing > 0 ? "text-warning" : ""}`}>{formatInt(r.missing)}</p>
                  </div>
                </div>
                {r.issues.includes("over_sent") && <p className="text-xs text-danger">Lo recibido más lo dañado supera lo enviado.</p>}
                {r.missing > 0 && (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <select
                      className={selectCls}
                      value={l.missingAction ?? ""}
                      onChange={(e) => set(l.id, { missingAction: (e.target.value || null) as ReceptionLine["missingAction"] })}
                      aria-label={`Qué pasó con lo que faltó de ${l.title}`}
                    >
                      <option value="">¿Qué pasó con lo que faltó?</option>
                      <option value="returned">Vuelve a mi depósito (no salió o volvió)</option>
                      <option value="lost">Se perdió en el camino</option>
                    </select>
                    <input
                      className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm"
                      placeholder="Motivo (obligatorio)"
                      maxLength={300}
                      value={l.missingReason ?? ""}
                      aria-label={`Motivo del faltante de ${l.title}`}
                      onChange={(e) => set(l.id, { missingReason: e.target.value })}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        <Callout tone={result.closeStatus === "received" ? "success" : "warning"} title="Resumen">
          Enviadas {formatInt(result.totals.sent)} · recibidas {formatInt(result.totals.received)} · dañadas{" "}
          {formatInt(result.totals.damaged)} · faltan {formatInt(result.totals.missing)}
          {result.totals.returned > 0 ? ` (${formatInt(result.totals.returned)} vuelven a tu stock)` : ""}
          {result.totals.lost > 0 ? ` (${formatInt(result.totals.lost)} perdidas)` : ""}.
          {!canClose && " Cerrar con diferencias lo hace el dueño o un encargado."}
        </Callout>
      </div>
    </Modal>
  );
}
