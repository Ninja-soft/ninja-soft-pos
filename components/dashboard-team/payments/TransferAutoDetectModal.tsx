"use client";

// Detección automática de transferencias (ADR-061): por cuenta de Mercado
// Pago (CVU). Mientras la hoja de cobro espera, el servidor consulta Mercado
// Pago y empareja la transferencia por monto (± tolerancia) y ventana de
// tiempo. Modo: avisar al cajero o cerrar la venta sola. "Probar detección"
// verifica que la API de Mercado Pago informe las transferencias de la cuenta.

import { useEffect, useState } from "react";
import { Lock, Search } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { Segmented } from "@/components/ui/Segmented";
import { Callout } from "@/components/ui/Callout";
import { useToast } from "@/components/ui/Toast";
import { UpgradeModal } from "@/components/saas/UpgradeModal";
import { formatCurrency } from "@/lib/utils/format";
import {
  autoSettingsOf,
  isMpCvuAccount,
  transferErrorMessage,
  type TransferAccount,
  type TransferAutoMode,
  type TransferAutoSettings,
} from "@/lib/payments/transfer";
import {
  transferWatchApi,
  transferWatchErrorMessage,
  useTransferAutoFeature,
  useTransferMutations,
  type TransferProbe,
} from "@/modules/payments/transfer";

export function TransferAutoDetectModal({
  account,
  onOpenChange,
}: {
  account: TransferAccount | null;
  onOpenChange: (o: boolean) => void;
}) {
  const { toast } = useToast();
  const allowed = useTransferAutoFeature();
  const mut = useTransferMutations();
  const [s, setS] = useState<TransferAutoSettings>({ auto_detect: false, auto_tolerance: 0, auto_mode: "notify", auto_window_min: 30 });
  const [tolStr, setTolStr] = useState("0");
  const [winStr, setWinStr] = useState("30");
  const [probe, setProbe] = useState<TransferProbe | null>(null);
  const [probeErr, setProbeErr] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const [upgrade, setUpgrade] = useState(false);

  useEffect(() => {
    if (!account) return;
    const v = autoSettingsOf(account);
    setS(v);
    setTolStr(String(v.auto_tolerance).replace(".", ","));
    setWinStr(String(v.auto_window_min));
    setProbe(null);
    setProbeErr(null);
  }, [account]);

  if (!account) return null;
  const mp = isMpCvuAccount(account);

  async function runProbe() {
    if (!account) return;
    setProbing(true);
    setProbeErr(null);
    try {
      setProbe(await transferWatchApi.probe(account.id));
    } catch (e) {
      setProbeErr(transferWatchErrorMessage(e));
    } finally {
      setProbing(false);
    }
  }

  function save() {
    if (!account) return;
    const tol = Number(tolStr.replace(/\./g, "").replace(",", "."));
    const win = Number(winStr);
    const settings: TransferAutoSettings = {
      ...s,
      auto_tolerance: Number.isFinite(tol) && tol >= 0 ? tol : 0,
      auto_window_min: Number.isFinite(win) ? win : 30,
    };
    mut.auto.mutate(
      { id: account.id, settings },
      {
        onSuccess: () => {
          toast({ title: "Detección automática guardada", variant: "success" });
          onOpenChange(false);
        },
        onError: (e) => {
          const m = e instanceof Error ? e.message : "";
          toast({
            title: m.includes("feature_not_in_plan") || m.includes("auto_detect") ? transferWatchErrorMessage(e) : transferErrorMessage(e),
            variant: "error",
          });
        },
      },
    );
  }

  return (
    <Modal
      open
      onOpenChange={onOpenChange}
      title="Detectar transferencias automáticamente"
      description={`${account.bank_name} · ${account.holder_name}`}
      className="sm:max-w-lg"
      footer={
        mp && allowed ? (
          <div className="flex w-full justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button onClick={save} disabled={mut.auto.isPending}>
              Guardar
            </Button>
          </div>
        ) : undefined
      }
    >
      {!mp ? (
        <Callout tone="neutral">
          Sólo para cuentas de Mercado Pago (CVU). Para otros bancos y billeteras el cajero confirma la transferencia a
          mano con el n° de operación.
        </Callout>
      ) : !allowed ? (
        <div className="text-center">
          <Lock className="mx-auto text-ninja-flameSoft" size={24} />
          <p className="mt-2 text-sm font-semibold">La detección automática no está incluida en tu plan</p>
          <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
            Con la cuenta de Mercado Pago conectada, el POS se entera solo cuando entra la transferencia y la venta se
            cierra sola o te avisa.
          </p>
          <Button className="mt-3" size="sm" onClick={() => setUpgrade(true)}>
            Ver planes
          </Button>
          {upgrade && (
            <UpgradeModal
              open
              onOpenChange={(o) => !o && setUpgrade(false)}
              featureKey="transferencia_auto_mp"
              featureLabel="Transferencias automáticas (Mercado Pago)"
            />
          )}
        </div>
      ) : (
        <div className="space-y-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">Detectar transferencias automáticamente</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Mientras la hoja de cobro espera, consultamos Mercado Pago y buscamos una transferencia recibida por el
                monto de la venta. Si hay dudas (dos transferencias iguales o dos cajas esperando el mismo monto), le
                preguntamos al cajero.
              </p>
            </div>
            <Switch
              checked={s.auto_detect}
              onCheckedChange={(c) => setS((v) => ({ ...v, auto_detect: c }))}
              label="Detectar transferencias automáticamente"
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs text-muted-foreground">Tolerancia (± pesos)</span>
              <Input
                inputMode="decimal"
                value={tolStr}
                onChange={(e) => setTolStr(e.target.value)}
                disabled={!s.auto_detect}
                aria-describedby="tol-help"
              />
              <span id="tol-help" className="mt-1 block text-xs text-muted-foreground">
                Acepta transferencias hasta {formatCurrency(Number(tolStr.replace(",", ".")) || 0)} por arriba o por debajo.
              </span>
            </label>
            <label className="block">
              <span className="text-xs text-muted-foreground">Esperar hasta (minutos)</span>
              <Input
                inputMode="numeric"
                value={winStr}
                onChange={(e) => setWinStr(e.target.value.replace(/\D/g, ""))}
                disabled={!s.auto_detect}
              />
              <span className="mt-1 block text-xs text-muted-foreground">Entre 5 y 240 minutos.</span>
            </label>
          </div>

          <div>
            <span className="text-xs text-muted-foreground">Cuando llega la transferencia</span>
            <Segmented<TransferAutoMode>
              aria-label="Qué hacer cuando llega la transferencia"
              className="mt-1"
              fill
              value={s.auto_mode}
              onChange={(m) => s.auto_detect && setS((v) => ({ ...v, auto_mode: m }))}
              options={[
                { value: "notify", label: "Avisar y que el cajero cierre" },
                { value: "auto_close", label: "Cerrar la venta sola" },
              ]}
            />
          </div>

          <div className="rounded-lg border border-border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-medium">Probar detección</p>
                <p className="text-xs text-muted-foreground">Buscamos las transferencias recibidas en los últimos 7 días.</p>
              </div>
              <Button size="sm" variant="secondary" onClick={runProbe} disabled={probing}>
                <Search size={14} /> {probing ? "Buscando..." : "Probar"}
              </Button>
            </div>
            {probeErr && <p className="mt-2 text-xs text-danger">{probeErr}</p>}
            {probe &&
              (probe.incoming === 0 ? (
                <p className="mt-2 text-xs text-warning">
                  No encontramos transferencias recibidas por API en los últimos 7 días. Si recibiste alguna, Mercado
                  Pago no las informa para tu cuenta: seguí confirmando a mano.
                </p>
              ) : (
                <div className="mt-2 text-xs">
                  <p className="text-success">
                    Encontramos {probe.incoming} {probe.incoming === 1 ? "transferencia recibida" : "transferencias recibidas"}.
                    La detección automática va a funcionar.
                  </p>
                  <ul className="mt-1 space-y-0.5 text-muted-foreground">
                    {probe.sample.map((t, i) => (
                      <li key={i} className="flex justify-between gap-2">
                        <span className="truncate">
                          {new Date(t.at).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" })}
                          {t.payer_name ? ` · ${t.payer_name}` : ""}
                        </span>
                        <span className="tabular-nums">{formatCurrency(t.amount)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
          </div>
        </div>
      )}
    </Modal>
  );
}
