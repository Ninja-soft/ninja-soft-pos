"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Banknote } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Callout } from "@/components/ui/Callout";
import { useShiftMovements } from "@/modules/cash/hooks";
import { summarize } from "@/modules/cash/api";
import { MIN_REASON, validReason, zeroCloseNeedsConfirm } from "@/lib/cash/closeControls";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { formatCurrency } from "@/lib/utils/format";
import { Switch } from "@/components/ui/Switch";
import {
  DENOMINATIONS,
  billsTotal,
  buildCount,
  countHasData,
  countableMethods,
  openingNeedsConfirm,
  toAmount,
  toQty,
  type CloseCount,
} from "@/lib/cash/arqueo";

// Apertura y cierre de caja del POS. El cobro vive en la hoja única
// (components/pos/checkout/CheckoutSheet.tsx), que reemplazó a PaymentModal.

export function OpenShiftModal({
  open,
  onOpenChange,
  onConfirm,
  loading,
  locationLabel,
  suggested,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onConfirm: (opening: number) => void;
  loading: boolean;
  // "Centro · Caja 1": dónde se abre el turno (F17 · H90).
  locationLabel?: string;
  // H159: lo que quedó contado en el último cierre de esta caja.
  suggested?: number | null;
}) {
  const [amount, setAmount] = useState("0");
  const [confirmZero, setConfirmZero] = useState(false);
  useEffect(() => {
    if (open) {
      setAmount(suggested && suggested > 0 ? String(suggested) : "0");
      setConfirmZero(false);
    }
  }, [open, suggested]);
  const value = Number(amount) || 0;
  const askZero = openingNeedsConfirm(value, suggested);
  const differs = suggested != null && suggested > 0 && Math.abs(value - suggested) > 0.009;
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Abrir caja" description={locationLabel || undefined}>
      <div className="space-y-4">
        <Input
          label="Monto inicial"
          type="number"
          step="0.01"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            setConfirmZero(false);
          }}
        />
        {suggested != null && suggested > 0 && (
          <p className="-mt-2 text-xs text-muted-foreground">
            En el último cierre de esta caja quedaron {formatCurrency(suggested)}.
            {differs && " Si abrís con otro monto, la diferencia queda registrada."}
          </p>
        )}
        {askZero && confirmZero && (
          <Callout tone="warning" icon={AlertTriangle} title={`¿Abrís con $0?`}>
            <p>
              El último cierre dejó {formatCurrency(suggested ?? 0)} en el cajón. Si se retiró, abrí igual; si no, cargá el
              monto.
            </p>
          </Callout>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            loading={loading}
            onClick={() => {
              if (askZero && !confirmZero) {
                setConfirmZero(true);
                return;
              }
              onConfirm(value);
            }}
            data-tour="caja-abrir-confirmar"
          >
            {askZero && confirmZero ? "Abrir con $0" : "Abrir"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export interface ClosePendingSummary {
  waiting: number;
  paid: number;
  amount: number;
}

export function CloseShiftModal({
  open,
  onOpenChange,
  onConfirm,
  loading,
  locationLabel,
  pending,
  shiftId,
  opening,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onConfirm: (
    closing: number,
    notes: string,
    pendingAction: "cancel" | "carry" | null,
    zeroCloseReason?: string | null,
    count?: CloseCount | null,
  ) => void;
  loading: boolean;
  locationLabel?: string;
  // Cobros en espera abiertos en este turno (ADR-048): obligan a decidir.
  pending?: ClosePendingSummary | null;
  // H156 (ADR-158): turno y apertura para calcular el efectivo esperado.
  shiftId?: string | null;
  opening?: number;
}) {
  const [amount, setAmount] = useState("0");
  const [notes, setNotes] = useState("");
  const [pendingAction, setPendingAction] = useState<"cancel" | "carry" | null>(null);
  const [zeroReason, setZeroReason] = useState("");
  const needsDecision = Boolean(pending && pending.waiting + pending.paid > 0);
  // El esperado sale de los movimientos del turno (se piden sólo con el modal abierto).
  const { data: movements } = useShiftMovements(open && shiftId ? shiftId : null);
  const summary = movements ? summarize(opening ?? 0, movements) : null;
  const expected = summary ? summary.cashExpected : null;
  // H159: arqueo por billete y por medio.
  const [byBills, setByBills] = useState(false);
  const [bills, setBills] = useState<Record<string, string>>({});
  const [coins, setCoins] = useState("");
  const [methodCounts, setMethodCounts] = useState<Record<string, string>>({});
  const billQty = useMemo(() => {
    const q: Record<string, number> = {};
    for (const d of DENOMINATIONS) q[String(d)] = toQty(bills[String(d)] ?? "");
    return q;
  }, [bills]);
  const coinsAmount = toAmount(coins) ?? 0;
  const billSum = billsTotal(billQty, coinsAmount);
  const methods = useMemo(() => (summary ? countableMethods(summary.byMethod) : []), [summary]);
  const counted = byBills ? billSum : Number(amount) || 0;
  const needsZeroConfirm = zeroCloseNeedsConfirm(counted, expected);
  const zeroOk = !needsZeroConfirm || validReason(zeroReason);
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Cerrar caja (arqueo)"
      description={locationLabel || undefined}
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-2 text-sm font-medium">
            <Banknote size={16} aria-hidden /> Contar por billete
          </span>
          <Switch checked={byBills} onCheckedChange={setByBills} label="Contar por billete" />
        </div>
        {byBills ? (
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {DENOMINATIONS.filter((d) => d >= 10).map((d) => (
                <label key={d} className="flex items-center gap-2 rounded-lg bg-fg-4 px-2.5 py-1.5 text-sm">
                  <span className="w-16 shrink-0 font-semibold tabular-nums">{formatCurrency(d)}</span>
                  <span aria-hidden className="text-muted-foreground">×</span>
                  <input
                    inputMode="numeric"
                    aria-label={`Billetes de ${d}`}
                    className="h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 text-right tabular-nums"
                    value={bills[String(d)] ?? ""}
                    placeholder="0"
                    onChange={(e) => setBills((b) => ({ ...b, [String(d)]: e.target.value.replace(/\D/g, "").slice(0, 7) }))}
                  />
                </label>
              ))}
            </div>
            <Input label="Monedas (total)" inputMode="decimal" value={coins} placeholder="0" onChange={(e) => setCoins(e.target.value)} />
            <p className="text-sm">
              Efectivo contado: <span className="font-semibold tabular-nums">{formatCurrency(billSum)}</span>
            </p>
          </div>
        ) : (
          <Input
            label="Efectivo contado"
            type="number"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        )}
        {expected !== null && (
          <p className="-mt-2 text-xs text-muted-foreground">
            El sistema espera {formatCurrency(expected)} en efectivo
            {counted !== expected ? ` (diferencia ${formatCurrency(counted - expected)})` : ""}.
          </p>
        )}
        {methods.length > 0 && (
          <fieldset className="space-y-2 rounded-xl bg-fg-4 p-3">
            <legend className="sr-only">Otros medios</legend>
            <p className="text-sm font-semibold">Otros medios (opcional)</p>
            <p className="text-xs text-muted-foreground">
              Contá los cupones, transferencias y QR del turno. Lo que cargues queda en el Z con su diferencia.
            </p>
            {methods.map((m) => {
              const c = toAmount(methodCounts[m.method] ?? "");
              return (
                <div key={m.method} className="grid grid-cols-[1fr_8rem] items-center gap-2 text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{m.label}</p>
                    <p className="text-xs text-muted-foreground">
                      Esperado {formatCurrency(m.expected)}
                      {c !== null && Math.abs(c - m.expected) > 0.004 ? ` · diferencia ${formatCurrency(c - m.expected)}` : ""}
                    </p>
                  </div>
                  <input
                    inputMode="decimal"
                    aria-label={`Contado de ${m.label}`}
                    className="h-9 w-full rounded-md border border-input bg-background px-2 text-right tabular-nums"
                    placeholder="Contado"
                    value={methodCounts[m.method] ?? ""}
                    onChange={(e) => setMethodCounts((x) => ({ ...x, [m.method]: e.target.value }))}
                  />
                </div>
              );
            })}
          </fieldset>
        )}
        {needsZeroConfirm && expected !== null && (
          <Callout tone="warning" icon={AlertTriangle} title="Vas a cerrar con $0 contados">
            <p>
              El sistema espera {formatCurrency(expected)}. Si es así, contá de nuevo o escribí por qué. La diferencia
              queda como faltante de caja.
            </p>
            <div className="mt-2">
              <Input
                label="¿Por qué cerrás con $0?"
                value={zeroReason}
                maxLength={300}
                placeholder={`Mínimo ${MIN_REASON} letras`}
                onChange={(e) => setZeroReason(e.target.value)}
              />
            </div>
          </Callout>
        )}
        <Input
          label="Notas (opcional)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
        {needsDecision && pending && (
          <fieldset className="space-y-2 rounded-xl bg-fg-4 p-3">
            <legend className="sr-only">Cobros en espera</legend>
            <p className="text-sm font-semibold">
              Tenés {pending.waiting + pending.paid} cobro{pending.waiting + pending.paid === 1 ? "" : "s"} en espera
              {" "}por {formatCurrency(pending.amount)}
            </p>
            <p className="text-xs text-muted-foreground">
              No entran en este arqueo (todavía no se cobraron). Elegí qué hacer con ellos.
            </p>
            <label className="flex cursor-pointer items-start gap-2 rounded-lg p-2 hover:bg-fg-6">
              <input
                type="radio"
                name="pending-action"
                className="mt-1"
                checked={pendingAction === "carry"}
                onChange={() => setPendingAction("carry")}
              />
              <span className="text-sm">
                <span className="font-medium">Pasarlos a la próxima apertura</span>
                <span className="block text-xs text-muted-foreground">
                  Siguen esperando el pago. Si el cliente paga, la venta entra en la caja abierta en ese momento (o en la próxima que se abra).
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2 rounded-lg p-2 hover:bg-fg-6">
              <input
                type="radio"
                name="pending-action"
                className="mt-1"
                checked={pendingAction === "cancel"}
                onChange={() => setPendingAction("cancel")}
              />
              <span className="text-sm">
                <span className="font-medium">Cancelar todos los cobros en espera</span>
                <span className="block text-xs text-muted-foreground">
                  Los links dejan de servir.
                  {pending.paid > 0
                    ? ` Los ${pending.paid} que ya se pagaron no se cancelan: pasan a la próxima apertura.`
                    : ""}
                </span>
              </span>
            </label>
          </fieldset>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            loading={loading}
            disabled={(needsDecision && pendingAction === null) || !zeroOk}
            onClick={() => {
              const count = buildCount(
                byBills ? billQty : {},
                byBills ? coinsAmount : 0,
                Object.fromEntries(methods.map((m) => [m.method, toAmount(methodCounts[m.method] ?? "")])),
              );
              onConfirm(
                counted,
                notes,
                needsDecision ? pendingAction : null,
                needsZeroConfirm ? zeroReason.trim() : null,
                countHasData(count) ? count : null,
              );
            }}
          >
            Cerrar caja
          </Button>
        </div>
      </div>
    </Modal>
  );
}
