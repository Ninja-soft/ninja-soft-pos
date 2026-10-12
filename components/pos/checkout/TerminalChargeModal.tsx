"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, CreditCard, PlugZap, RotateCcw, XCircle } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Modal } from "@/components/ui/Modal";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import type { PaymentTerminal } from "@/lib/payments/terminals";
import { INITIAL_CHARGE, chargeReducer, isBusy, phaseLabel, runSale } from "@/lib/payments/terminal/charge";
import { normalizeCardBrand, normalizeResult, toCardVoucher } from "@/lib/payments/terminal/normalize";
import { adapterFor, terminalConfig } from "@/lib/payments/terminal/session";
import { isTerminalError, type TerminalAdapter, type TerminalResult } from "@/lib/payments/terminal/types";
import { configApi } from "@/modules/config/api";
import { money } from "../ui/posStyles";
import type { TerminalChargeRequest } from "./types";

// Cobro con la terminal integrada de la caja (ADR-053): manda el monto,
// espera (cancelar / timeout / reintentar), y al aprobarse registra la
// operación en la bitácora (terminal_tx_record) y devuelve el cupón para el
// pago. Rechazo: muestra el motivo. Siempre se puede pasar a la carga manual.

function txStatus(phase: string): "approved" | "declined" | "timeout" | "cancelled" | "error" | null {
  if (phase === "approved" || phase === "declined" || phase === "timeout" || phase === "cancelled" || phase === "error") {
    return phase;
  }
  return null;
}

export function TerminalChargeModal({ terminal, req }: { terminal: PaymentTerminal; req: TerminalChargeRequest }) {
  const { toast } = useToast();
  const [state, dispatch] = useReducer(chargeReducer, INITIAL_CHARGE);
  const ctrlRef = useRef<AbortController | null>(null);
  const adapterRef = useRef<TerminalAdapter | null>(null);
  const recorded = useRef<number>(0);
  const finished = useRef(false);
  const [lastTx, setLastTx] = useState<TerminalResult | null>(null);
  const [checking, setChecking] = useState(false);
  const cfg = useMemo(() => terminalConfig(terminal), [terminal]);
  const simulated = cfg.adapter === "simulator";
  // Referencia del POS para la terminal (factura / ticket): única por cobro.
  const reference = useMemo(
    () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Date.now())),
    [],
  );

  const start = useCallback(
    async (retry: boolean) => {
      dispatch(retry ? { type: "retry" } : { type: "start" });
      setLastTx(null);
      let adapter: TerminalAdapter;
      try {
        adapter = adapterFor(terminal);
      } catch (e) {
        dispatch({
          type: "error",
          code: isTerminalError(e) ? e.code : "unknown",
          message: e instanceof Error ? e.message : "No se pudo preparar la terminal",
        });
        return;
      }
      adapterRef.current = adapter;
      const ctrl = new AbortController();
      ctrlRef.current = ctrl;
      await runSale(
        adapter,
        {
          amount: req.amount,
          installments: req.installments,
          reference,
          cardType: req.cardKind,
          cardBrand: req.cardBrand,
        },
        { timeoutMs: cfg.timeoutSec * 1000, signal: ctrl.signal, dispatch },
      );
    },
    [terminal, req.amount, req.installments, req.cardKind, req.cardBrand, reference, cfg.timeoutSec],
  );

  // Arranca solo al abrir.
  useEffect(() => {
    void start(false);
    return () => ctrlRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Bitácora de cada intento terminado; en la aprobación, además, el pago.
  useEffect(() => {
    const status = txStatus(state.phase);
    if (!status || recorded.current === state.attempt) return;
    recorded.current = state.attempt;
    const r = state.result;
    const record = configApi.recordTerminalTx({
      terminalId: terminal.id,
      op: "sale",
      status,
      amount: req.amount,
      installments: r?.installments ?? req.installments,
      result: r
        ? {
            approved: r.approved,
            authCode: r.authCode,
            lote: r.lote,
            cupon: r.cupon,
            cardBrand: r.cardBrand,
            cardType: r.cardType,
            last4: r.last4,
            installments: r.installments,
            merchantNumber: r.merchantNumber,
            terminalNumber: r.terminalNumber,
            responseCode: r.responseCode,
            message: r.message,
          }
        : { errorCode: state.errorCode, message: state.message },
      raw: r?.raw ?? null,
      clientRef: reference,
    });
    if (status !== "approved" || !r || finished.current) {
      void record.catch(() => undefined);
      return;
    }
    finished.current = true;
    const method = r.cardType ?? req.cardKind;
    const brandKey = normalizeCardBrand(r.cardBrand);
    void record
      .then((txId) =>
        req.onApproved({
          method,
          brandKey,
          card_voucher: toCardVoucher(r, {
            terminalTxId: txId,
            fallbackMerchant: terminal.merchant_number,
            acquirer: terminal.provider_key,
          }),
        }),
      )
      .catch(() => {
        // Sin bitácora (red o base sin migrar): la plata ya se cobró, el pago
        // se registra igual con el cupón como carga manual.
        const { origen: _o, terminal_tx: _t, ...manual } = toCardVoucher(r, {
          fallbackMerchant: terminal.merchant_number,
          acquirer: terminal.provider_key,
        });
        toast({
          title: "Cobro aprobado",
          description: "No se pudo guardar la bitácora de la terminal: el cupón se registra como carga manual.",
          variant: "info",
        });
        req.onApproved({ method, brandKey, card_voucher: manual });
      });
  }, [state.phase, state.attempt, state.result, state.errorCode, state.message, terminal, req, reference, toast]);

  const cancel = () => ctrlRef.current?.abort();

  const checkLast = async () => {
    const a = adapterRef.current;
    if (!a?.lastTransaction) return;
    setChecking(true);
    try {
      await a.connect();
      setLastTx(await a.lastTransaction());
    } catch (e) {
      toast({ title: "No se pudo consultar la terminal", description: e instanceof Error ? e.message : undefined, variant: "error" });
    } finally {
      setChecking(false);
    }
  };

  const busy = isBusy(state.phase);
  const canLast = Boolean(adapterRef.current?.capabilities.lastTransaction);
  const last = lastTx ? normalizeResult(lastTx) : null;

  return (
    <Modal
      open
      onOpenChange={(o) => {
        if (!o && !busy && state.phase !== "approved") req.onClose();
      }}
      title={`Cobro con ${terminal.label}`}
      className="max-w-md"
    >
      <div className="space-y-4">
        <div className="flex items-baseline justify-between rounded-lg bg-muted px-4 py-3">
          <span className="text-sm text-muted-foreground">
            {req.installments && req.installments > 1 ? `${req.installments} cuotas` : req.cardKind === "debit" ? "Débito" : "Crédito"}
          </span>
          <span className="font-price text-2xl font-bold tabular-nums">{money(req.amount)}</span>
        </div>

        <div className="flex items-center gap-3" role="status" aria-live="polite">
          {busy ? (
            <Spinner />
          ) : state.phase === "approved" ? (
            <CheckCircle2 className="text-success" size={22} aria-hidden />
          ) : state.phase === "timeout" ? (
            <AlertTriangle className="text-warning" size={22} aria-hidden />
          ) : state.phase === "idle" ? (
            <PlugZap className="text-muted-foreground" size={22} aria-hidden />
          ) : (
            <XCircle className="text-danger" size={22} aria-hidden />
          )}
          <div className="min-w-0">
            <p className="text-sm font-semibold">{phaseLabel(state)}</p>
            {busy && (
              <p className="text-xs text-muted-foreground">
                {simulated
                  ? "Simulador: termina en ,51 rechaza; ,91 no responde; ,96 corta la comunicación."
                  : "Seguí las indicaciones en la terminal."}
              </p>
            )}
            {state.phase === "approved" && <p className="text-xs text-muted-foreground">Registrando el cobro</p>}
            {state.attempt > 1 && busy && <p className="text-xs text-muted-foreground">Intento {state.attempt}</p>}
          </div>
        </div>

        {state.phase === "timeout" && (
          <Callout tone="warning" className="p-3 text-xs">
            La terminal pudo haber cobrado. Mirá la pantalla o el cupón impreso antes de reintentar, para no cobrar dos
            veces.
          </Callout>
        )}
        {state.phase === "cancelled" && !adapterRef.current?.capabilities.cancelInFlight && !simulated && (
          <p className="text-xs text-muted-foreground">
            Si la terminal sigue esperando la tarjeta, cancelá también en la terminal.
          </p>
        )}

        {last && (
          <div className="rounded-lg border border-border p-3 text-sm">
            <p className="mb-1 flex items-center gap-1.5 font-medium">
              <CreditCard size={14} aria-hidden /> Última operación de la terminal
            </p>
            <p className="text-xs text-muted-foreground">
              {last.approved ? "Aprobada" : "No aprobada"}
              {last.amount != null ? ` · ${money(last.amount)}` : ""}
              {last.cupon ? ` · Cupón ${last.cupon}` : ""}
              {last.lote ? ` · Lote ${last.lote}` : ""}
              {last.last4 ? ` · **** ${last.last4}` : ""}
            </p>
            {last.approved && last.op === "sale" && (last.amount == null || Math.abs(last.amount - req.amount) < 0.005) && (
              <Button
                size="sm"
                className="mt-2"
                onClick={() => dispatch({ type: "result", result: { ...last, amount: req.amount } })}
              >
                Es este cobro: registrarlo
              </Button>
            )}
          </div>
        )}

        <div className="flex flex-wrap justify-end gap-2 pt-1">
          {busy && (
            <Button variant="secondary" onClick={cancel}>
              Cancelar
            </Button>
          )}
          {!busy && state.phase !== "approved" && (
            <>
              <Button variant="ghost" onClick={req.onManual}>
                Cargar el cupón a mano
              </Button>
              {state.phase === "timeout" && canLast && (
                <Button variant="secondary" onClick={checkLast} disabled={checking}>
                  {checking ? "Consultando" : "Consultar la terminal"}
                </Button>
              )}
              <Button variant="secondary" onClick={req.onClose}>
                Cerrar
              </Button>
              <Button onClick={() => void start(true)}>
                <RotateCcw size={14} /> Reintentar
              </Button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
