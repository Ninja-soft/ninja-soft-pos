"use client";

import { useEffect, useMemo, useReducer, useState } from "react";
import { CheckCircle2, Plug, Usb, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import type { PaymentTerminal } from "@/lib/payments/terminals";
import {
  ADAPTER_LABEL,
  BRIDGE_DEFAULT_URL,
  TRANSPORT_LABEL,
  bridgeUrlOk,
  integrationProblem,
  loadPairing,
  savePairing,
  type DevicePairing,
} from "@/lib/payments/terminal/config";
import { INITIAL_CHARGE, chargeReducer, isBusy, phaseLabel, runSale } from "@/lib/payments/terminal/charge";
import { normalizeResult } from "@/lib/payments/terminal/normalize";
import { adapterFor, dropAdapter, terminalConfig } from "@/lib/payments/terminal/session";
import { pairSerialPort, pairUsbDevice, transportSupport } from "@/lib/payments/terminal/transports";
import type { TerminalStatus } from "@/lib/payments/terminal/types";
import { configApi } from "@/modules/config/api";
import { formatCurrency } from "@/lib/utils/format";

// "Conectar y probar" una terminal integrada (ADR-053): emparejar el
// dispositivo en ESTA PC (Web Serial / WebUSB / puente local), ver el estado
// de la conexión y hacer una venta de prueba con el simulador.

export function TerminalDeviceModal({ terminal, onClose }: { terminal: PaymentTerminal; onClose: () => void }) {
  const { toast } = useToast();
  const cfg = useMemo(() => terminalConfig(terminal), [terminal]);
  const support = useMemo(() => transportSupport(), []);
  const [pairing, setPairing] = useState<DevicePairing | null>(null);
  const [bridgeUrl, setBridgeUrl] = useState(BRIDGE_DEFAULT_URL);
  const [bridgeToken, setBridgeToken] = useState("");
  const [status, setStatus] = useState<TerminalStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [amount, setAmount] = useState("100");
  const [charge, dispatch] = useReducer(chargeReducer, INITIAL_CHARGE);
  const simulated = cfg.adapter === "simulator";

  useEffect(() => {
    const p = loadPairing(terminal.id);
    setPairing(p);
    if (p?.bridge) {
      setBridgeUrl(p.bridge.url);
      setBridgeToken(p.bridge.token);
    }
  }, [terminal.id]);

  const problem = integrationProblem(cfg, pairing);

  const store = async (p: DevicePairing | null) => {
    savePairing(terminal.id, p);
    setPairing(p);
    setStatus(null);
    await dropAdapter(terminal.id);
  };

  const pair = async () => {
    try {
      const device = cfg.transport === "webusb" ? await pairUsbDevice() : await pairSerialPort();
      await store({ ...pairing, device });
      toast({ title: `Dispositivo emparejado: ${device.name}`, variant: "success" });
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : "No se pudo emparejar", variant: "error" });
    }
  };

  const saveBridge = async () => {
    if (!bridgeUrlOk(bridgeUrl)) {
      return toast({ title: "La dirección del puente tiene que ser de esta PC (ws://127.0.0.1:puerto)", variant: "error" });
    }
    if (bridgeToken.trim().length < 16) return toast({ title: "Pegá el token que muestra el puente", variant: "error" });
    await store({ ...pairing, bridge: { url: bridgeUrl.trim(), token: bridgeToken.trim() } });
    toast({ title: "Puente guardado en esta PC", variant: "success" });
  };

  const check = async () => {
    setChecking(true);
    try {
      const a = adapterFor(terminal);
      await a.connect();
      setStatus(await a.status());
    } catch (e) {
      setStatus({ connected: false, ready: false, message: e instanceof Error ? e.message : "Sin conexión" });
    } finally {
      setChecking(false);
    }
  };

  const testSale = async () => {
    const n = Number(amount.replace(",", "."));
    if (!(n > 0)) return toast({ title: "Monto inválido", variant: "error" });
    dispatch({ type: "reset" });
    dispatch({ type: "start" });
    let res = null;
    try {
      res = await runSale(adapterFor(terminal), { amount: n, installments: 1, reference: `test-${Date.now()}` }, { dispatch, timeoutMs: 20_000 });
    } catch {
      /* el estado ya quedó despachado */
    }
    const r = res ? normalizeResult(res) : null;
    void configApi
      .recordTerminalTx({
        terminalId: terminal.id,
        op: "test",
        status: r ? (r.approved ? "approved" : "declined") : "error",
        amount: n,
        installments: 1,
        result: r ? { lote: r.lote, cupon: r.cupon, authCode: r.authCode, last4: r.last4, cardBrand: r.cardBrand } : {},
        raw: r?.raw ?? null,
        clientRef: null,
      })
      .catch(() => undefined);
  };

  const r = charge.result;
  return (
    <Modal open onOpenChange={(o) => !o && !isBusy(charge.phase) && onClose()} title={`Conectar ${terminal.label}`} className="max-w-lg">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge tone="info">{ADAPTER_LABEL[cfg.adapter]}</Badge>
          {!simulated && <Badge tone="neutral">{TRANSPORT_LABEL[cfg.transport]}</Badge>}
        </div>

        {!simulated && !support.secure && (
          <Callout tone="warning" className="p-3 text-xs">
            La conexión con dispositivos sólo funciona en https o en localhost.
          </Callout>
        )}
        {!simulated && cfg.transport === "webserial" && !support.webserial && (
          <Callout tone="warning" className="p-3 text-xs">
            Este navegador no soporta Web Serial. Usá Chrome o Edge de escritorio, o el puente local NinjaPOS.
          </Callout>
        )}
        {!simulated && cfg.transport === "webusb" && !support.webusb && (
          <Callout tone="warning" className="p-3 text-xs">
            Este navegador no soporta WebUSB. Usá Chrome o Edge de escritorio, o el puente local NinjaPOS.
          </Callout>
        )}

        {!simulated && (cfg.transport === "webserial" || cfg.transport === "webusb") && (
          <div className="flex flex-col gap-2 rounded-lg bg-muted/40 p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm">
              <p className="font-medium">Dispositivo en esta PC</p>
              <p className="text-xs text-muted-foreground">
                {pairing?.device ? pairing.device.name : "Sin emparejar. Conectá el cable y elegilo en la lista del navegador."}
              </p>
            </div>
            <span className="flex gap-1">
              <Button size="sm" variant="secondary" onClick={pair}>
                <Usb size={14} /> {pairing?.device ? "Cambiar" : "Emparejar"}
              </Button>
              {pairing?.device && (
                <Button size="sm" variant="ghost" onClick={() => void store({ ...pairing, device: null })}>
                  Olvidar
                </Button>
              )}
            </span>
          </div>
        )}

        {!simulated && cfg.transport === "bridge" && (
          <div className="space-y-2 rounded-lg bg-muted/40 p-3">
            <p className="text-sm font-medium">Puente local NinjaPOS en esta PC</p>
            <p className="text-xs text-muted-foreground">
              Abrí el puente en la PC de la caja (ver tools/bridge) y pegá el token que muestra al arrancar.
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              <Input label="Dirección" value={bridgeUrl} onChange={(e) => setBridgeUrl(e.target.value)} />
              <Input label="Token" value={bridgeToken} onChange={(e) => setBridgeToken(e.target.value)} autoComplete="off" />
            </div>
            <Button size="sm" variant="secondary" onClick={saveBridge}>
              <Plug size={14} /> Guardar en esta PC
            </Button>
          </div>
        )}

        {problem && <p className="text-xs text-muted-foreground">{problem}</p>}

        <div className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2 text-sm" role="status">
            {status ? (
              status.ready ? (
                <CheckCircle2 size={16} className="text-success" aria-hidden />
              ) : (
                <XCircle size={16} className={status.connected ? "text-warning" : "text-danger"} aria-hidden />
              )
            ) : null}
            <span>
              {status
                ? status.ready
                  ? "Conectada y lista"
                  : status.connected
                    ? (status.message ?? "Conectada, no lista")
                    : (status.message ?? "Sin conexión")
                : "Estado sin probar"}
            </span>
          </div>
          <Button size="sm" variant="secondary" onClick={check} disabled={checking || Boolean(problem)}>
            {checking ? "Probando" : "Probar conexión"}
          </Button>
        </div>

        {simulated && (
          <div className="space-y-3 rounded-lg border border-border p-3">
            <p className="text-sm font-medium">Venta de prueba</p>
            <div className="flex items-end gap-2">
              <Input label="Monto" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
              <Button onClick={testSale} disabled={isBusy(charge.phase)}>
                {isBusy(charge.phase) ? "Esperando" : "Cobrar de prueba"}
              </Button>
            </div>
            {charge.phase !== "idle" && (
              <div className="text-sm" role="status" aria-live="polite">
                <p className="font-medium">{phaseLabel(charge)}</p>
                {r?.approved && (
                  <p className="text-xs text-muted-foreground">
                    {r.cardBrand ?? "Tarjeta"} **** {r.last4 ?? "????"} · Lote {r.lote} · Cupón {r.cupon} · Autorización{" "}
                    {r.authCode}
                    {r.amount != null ? ` · ${formatCurrency(r.amount)}` : ""}
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        <div className="flex justify-end">
          <Button variant="secondary" onClick={onClose} disabled={isBusy(charge.phase)}>
            Listo
          </Button>
        </div>
      </div>
    </Modal>
  );
}
