"use client";

import { useState } from "react";
import { Inbox, Scale } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import {
  drawerDeviceProblem,
  loadBridgeAuth,
  loadHardwarePairing,
  pairingProblem,
  scaleDeviceProblem,
  type RegisterHardware,
} from "@/lib/hardware/config";
import { drawerDeniedMessage } from "@/lib/hardware/drawer";
import { visibleFrame } from "@/lib/hardware/scale/protocols";
import { formatKg } from "@/lib/hardware/scale/stable";
import { useDiagnosticsLog } from "@/lib/hardware/diagnosticsLog";
import { useDrawerOpener, useScaleReader } from "@/modules/hardware/hooks";
import { hardwareErrorMessage } from "@/modules/hardware/api";

// Pruebas de hardware de UNA caja con su configuración efectiva (ADR-063):
// "Probar balanza" (peso en vivo, estable, tara y trama cruda) y "Abrir cajón
// de prueba" (pasa por el servidor, que lo registra, y manda el pulso).

export function RegisterHardwareTests({ hw, label }: { hw: RegisterHardware; label: string }) {
  const { toast } = useToast();
  const { log } = useDiagnosticsLog();
  const [scaleOn, setScaleOn] = useState(false);
  const scale = useScaleReader(hw.scale, hw.registerId, scaleOn);
  const openDrawer = useDrawerOpener();
  const [drawerBusy, setDrawerBusy] = useState(false);

  const scaleCfgProblem = scaleDeviceProblem(hw.scale);
  const scaleLocal =
    typeof window === "undefined"
      ? null
      : pairingProblem(hw.scale.transport, loadHardwarePairing(hw.registerId, "scale"), loadBridgeAuth());
  const drawerCfgProblem = drawerDeviceProblem(hw.drawer);
  const drawerLocal =
    typeof window === "undefined"
      ? null
      : pairingProblem(hw.drawer.transport, loadHardwarePairing(hw.registerId, "drawer"), loadBridgeAuth());

  async function testDrawer() {
    setDrawerBusy(true);
    try {
      const out = await openDrawer(hw, "test", { reason: "Prueba de hardware" });
      if (out.status === "opened") {
        if (out.pulse === "sent") {
          log("cash_drawer", `Abrir cajón de prueba (${label})`, "ok", "El servidor lo autorizó y registró; se mandó el pulso ESC/POS. Confirmá que el cajón se abrió.");
          toast({ title: hw.drawer.transport === "simulator" ? "Pulso enviado al simulador" : "Pulso enviado", variant: "success" });
        } else {
          log("cash_drawer", `Abrir cajón de prueba (${label})`, "error", `Autorizado y registrado, pero la impresora no respondió: ${out.error ?? ""}`);
          toast({ title: "La impresora no respondió", description: out.error, variant: "error" });
        }
      } else if (out.status === "denied") {
        const msg = drawerDeniedMessage(out.result.denied_reason);
        log("cash_drawer", `Abrir cajón de prueba (${label})`, "warn", msg);
        toast({ title: msg, variant: "error" });
      } else if (out.status === "error") {
        const msg = hardwareErrorMessage(out.error);
        log("cash_drawer", `Abrir cajón de prueba (${label})`, "error", msg);
        toast({ title: msg, variant: "error" });
      }
    } finally {
      setDrawerBusy(false);
    }
  }

  function toggleScale() {
    const next = !scaleOn;
    setScaleOn(next);
    if (!next && scale.reading) {
      log(
        "scale",
        `Probar balanza (${label})`,
        scale.reading.stable ? "ok" : "warn",
        `Última lectura ${formatKg(scale.reading.netKg)} ${scale.reading.stable ? "estable" : "en movimiento"} (trama ${visibleFrame(scale.reading.raw)}).`,
      );
    }
    if (!next && !scale.reading) {
      log("scale", `Probar balanza (${label})`, "error", scale.error ?? "No llegó ninguna lectura de la balanza.");
    }
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-2 rounded-lg bg-muted/50 p-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Scale size={15} aria-hidden /> Balanza
        </div>
        {!hw.scale.enabled ? (
          <p className="text-xs text-muted-foreground">Esta caja no tiene balanza conectada.</p>
        ) : (
          <>
            {(scaleCfgProblem || scaleLocal) && (
              <p className="text-xs text-warning">{scaleCfgProblem ?? scaleLocal}</p>
            )}
            <Button size="sm" variant={scaleOn ? "secondary" : "primary"} onClick={toggleScale}>
              <Scale size={14} /> {scaleOn ? "Terminar prueba" : "Probar balanza"}
            </Button>
            {scaleOn && (
              <div className="space-y-2">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-mono text-2xl font-semibold tabular-nums">
                    {scale.reading ? formatKg(scale.reading.netKg) : "-"}
                  </span>
                  <span
                    className={cn(
                      "rounded-md px-2 py-0.5 text-xs font-medium",
                      scale.reading?.stable ? "bg-success/15 text-success" : "bg-warning/15 text-warning",
                    )}
                  >
                    {scale.status === "connecting"
                      ? "Conectando"
                      : scale.reading
                        ? scale.reading.stable
                          ? "Estable"
                          : "En movimiento"
                        : "Esperando"}
                  </span>
                </div>
                {scale.reading && scale.reading.tareKg > 0 && (
                  <p className="text-xs text-muted-foreground">Tara {formatKg(scale.reading.tareKg)}</p>
                )}
                {(scale.error || scale.silent) && (
                  <p className="text-xs text-danger">{scale.error ?? "La balanza no manda datos."}</p>
                )}
                <div className="flex flex-wrap gap-1.5">
                  <Button size="sm" variant="secondary" onClick={scale.tareNow} disabled={!scale.reading}>
                    Tara
                  </Button>
                  <Button size="sm" variant="ghost" onClick={scale.clearTare}>
                    Sin tara
                  </Button>
                  {scale.simulate &&
                    [0.25, 0.75, 1.2].map((kg) => (
                      <Button key={kg} size="sm" variant="ghost" onClick={() => scale.simulate?.(kg)}>
                        Apoyar {kg} kg
                      </Button>
                    ))}
                </div>
                {scale.reading && (
                  <p className="break-all font-mono text-[11px] text-muted-foreground">
                    Trama: {visibleFrame(scale.reading.raw)}
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <div className="space-y-2 rounded-lg bg-muted/50 p-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Inbox size={15} aria-hidden /> Cajón
        </div>
        {!hw.drawer.hasDrawer ? (
          <p className="text-xs text-muted-foreground">Esta caja está marcada sin cajón.</p>
        ) : (
          <>
            {(drawerCfgProblem || drawerLocal) && (
              <p className="text-xs text-warning">{drawerCfgProblem ?? drawerLocal}</p>
            )}
            <Button size="sm" onClick={testDrawer} disabled={drawerBusy || Boolean(drawerCfgProblem)}>
              <Inbox size={14} /> {drawerBusy ? "Abriendo..." : "Abrir cajón de prueba"}
            </Button>
            <p className="text-xs text-muted-foreground">
              Queda registrado como prueba. Sólo el dueño o un encargado.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
