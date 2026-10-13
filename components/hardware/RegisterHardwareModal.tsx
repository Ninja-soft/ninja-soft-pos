"use client";

import { useEffect, useState } from "react";
import { Link2, Scale, Inbox } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { Select } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import {
  DRAWER_TRANSPORT_LABEL,
  SCALE_TRANSPORT_LABEL,
  loadBridgeAuth,
  loadHardwarePairing,
  saveBridgeAuth,
  saveHardwarePairing,
  serializeDrawerDevice,
  serializeScaleDevice,
  type BridgeTarget,
  type DrawerDevice,
  type DrawerTransport,
  type HardwareDevice,
  type RegisterHardware,
  type ScaleDevice,
  type ScaleTransport,
} from "@/lib/hardware/config";
import { SCALE_PROTOCOLS, protocolDefaults, regexProblem, type ScaleProtocol } from "@/lib/hardware/scale/protocols";
import { BRIDGE_DEFAULT_URL, pairSerialPort, pairUsbDevice, transportSupport } from "@/lib/payments/terminal/transports";
import { bridgeUrlOk } from "@/lib/payments/terminal/config";
import { usePrinters } from "@/modules/config/hooks";
import { hardwareErrorMessage } from "@/modules/hardware/api";
import { useRegisterHardwareMutation } from "@/modules/hardware/hooks";
import { RegisterHardwareTests } from "./RegisterHardwareTests";

// Equipos de UNA caja (ADR-063): la balanza y el cajón que están enchufados
// ahí, más el emparejamiento de esta PC y las pruebas. Las reglas (pesables,
// formato de etiqueta, cuándo se abre el cajón) NO van acá: son de la
// sucursal.

const BAUDS = ["1200", "2400", "4800", "9600", "19200", "38400", "57600", "115200"] as const;
type Baud = (typeof BAUDS)[number];

function BridgeTargetFields({
  value,
  onChange,
  allowTcp,
}: {
  value: BridgeTarget | null;
  onChange: (b: BridgeTarget | null) => void;
  allowTcp: boolean;
}) {
  const kind = value?.kind ?? "serial";
  return (
    <div className="space-y-2">
      {allowTcp && (
        <Segmented
          aria-label="Cómo llega el puente a la impresora"
          size="sm"
          value={kind}
          onChange={(k) => onChange(k === "serial" ? { kind: "serial", path: "" } : { kind: "tcp", host: "", port: 9100 })}
          options={[
            { value: "serial", label: "Puerto de la PC" },
            { value: "tcp", label: "Por red (IP)" },
          ]}
        />
      )}
      {kind === "serial" ? (
        <Input
          label="Puerto en la PC"
          placeholder="COM3 o /dev/ttyUSB0"
          value={value?.kind === "serial" ? value.path : ""}
          onChange={(e) => onChange({ kind: "serial", path: e.target.value.trim() })}
        />
      ) : (
        <div className="grid grid-cols-[1fr_7rem] gap-2">
          <Input
            label="IP de la impresora"
            placeholder="192.168.0.50"
            value={value?.kind === "tcp" ? value.host : ""}
            onChange={(e) =>
              onChange({ kind: "tcp", host: e.target.value.trim(), port: value?.kind === "tcp" ? value.port : 9100 })
            }
          />
          <Input
            label="Puerto"
            inputMode="numeric"
            value={value?.kind === "tcp" ? String(value.port) : "9100"}
            onChange={(e) =>
              onChange({
                kind: "tcp",
                host: value?.kind === "tcp" ? value.host : "",
                port: Number(e.target.value.replace(/\D/g, "")) || 9100,
              })
            }
          />
        </div>
      )}
    </div>
  );
}

function cleanBridge(b: BridgeTarget | null): BridgeTarget | null {
  if (!b) return null;
  if (b.kind === "serial") return b.path ? b : null;
  return b.host ? b : null;
}

export function RegisterHardwareModal({
  open,
  onOpenChange,
  hw,
  label,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  hw: RegisterHardware;
  label: string;
}) {
  const { toast } = useToast();
  const mut = useRegisterHardwareMutation();
  const { data: printers } = usePrinters();
  const [scale, setScale] = useState<ScaleDevice>(hw.scale);
  const [drawer, setDrawer] = useState<DrawerDevice>(hw.drawer);
  const [bridgeUrl, setBridgeUrl] = useState(BRIDGE_DEFAULT_URL);
  const [bridgeToken, setBridgeToken] = useState("");
  const [pairs, setPairs] = useState<Record<HardwareDevice, string | null>>({ scale: null, drawer: null });
  const support = typeof window === "undefined" ? { webserial: false, webusb: false, secure: false } : transportSupport();

  useEffect(() => {
    if (!open) return;
    setScale(hw.scale);
    setDrawer(hw.drawer);
    const b = loadBridgeAuth();
    setBridgeUrl(b?.url ?? BRIDGE_DEFAULT_URL);
    setBridgeToken(b?.token ?? "");
    setPairs({
      scale: loadHardwarePairing(hw.registerId, "scale")?.device?.name ?? null,
      drawer: loadHardwarePairing(hw.registerId, "drawer")?.device?.name ?? null,
    });
  }, [open, hw]);

  const storePrinters = (printers ?? []).filter(
    (p) => p.store_id === hw.storeId && p.active && (!p.cash_register_id || p.cash_register_id === hw.registerId),
  );
  const regexErr = regexProblem(scale.protocol.regex);

  async function pair(device: HardwareDevice, how: "serial" | "usb") {
    try {
      const m = how === "usb" ? await pairUsbDevice() : await pairSerialPort();
      saveHardwarePairing(hw.registerId, device, { device: m });
      setPairs((p) => ({ ...p, [device]: m.name }));
      toast({ title: `Emparejado en esta PC: ${m.name}`, variant: "success" });
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : "No se pudo emparejar", variant: "error" });
    }
  }

  function saveBridge() {
    if (!bridgeUrlOk(bridgeUrl)) {
      toast({ title: "El puente tiene que estar en esta PC (ws://127.0.0.1:puerto)", variant: "error" });
      return;
    }
    if (bridgeToken.trim().length < 8) {
      toast({ title: "Pegá el token que muestra el puente al iniciar", variant: "error" });
      return;
    }
    saveBridgeAuth({ url: bridgeUrl.trim(), token: bridgeToken.trim() });
    toast({ title: "Puente guardado en esta PC", variant: "success" });
  }

  async function save() {
    if (regexErr) {
      toast({ title: regexErr, variant: "error" });
      return;
    }
    try {
      await mut.mutateAsync({
        registerId: hw.registerId,
        scale: serializeScaleDevice({ ...scale, bridge: cleanBridge(scale.bridge) }),
        drawer: serializeDrawerDevice({ ...drawer, bridge: cleanBridge(drawer.bridge) }),
      });
      toast({ title: "Equipos de la caja guardados", variant: "success" });
      onOpenChange(false);
    } catch (e) {
      toast({ title: hardwareErrorMessage(e), variant: "error" });
    }
  }

  const setProto = (patch: Partial<ScaleDevice["protocol"]>) =>
    setScale((s) => ({ ...s, protocol: { ...s.protocol, ...patch } }));
  const preset = SCALE_PROTOCOLS[scale.protocol.protocol];

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`Equipos de ${label}`}
      description="Lo que está enchufado en esta caja. Las reglas (pesables, etiquetas, cuándo se abre el cajón) son de la sucursal."
      className="sm:max-w-2xl"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={save} loading={mut.isPending}>
            Guardar
          </Button>
        </div>
      }
    >
      <div className="space-y-6">
        {/* ── Balanza ───────────────────────────────────────────────────── */}
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h3 className="flex items-center gap-2 font-semibold">
              <Scale size={16} aria-hidden /> Balanza conectada
            </h3>
            <Switch
              checked={scale.enabled}
              onCheckedChange={(c) => setScale((s) => ({ ...s, enabled: c }))}
              label="Esta caja tiene balanza"
            />
          </div>
          {!scale.enabled ? (
            <p className="text-sm text-muted-foreground">
              Sin balanza: los productos por kilo se pesan tipeando los gramos o con la etiqueta de la balanza
              etiquetadora.
            </p>
          ) : (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Input
                  label="Modelo (para reconocerla)"
                  placeholder="Systel Cuora Max"
                  value={scale.model}
                  onChange={(e) => setScale((s) => ({ ...s, model: e.target.value }))}
                />
                <Select<ScaleProtocol>
                  label="Protocolo"
                  value={scale.protocol.protocol}
                  onChange={(p) =>
                    setScale((s) => ({
                      ...s,
                      protocol: protocolDefaults(p),
                      serial: { ...s.serial, baudRate: SCALE_PROTOCOLS[p].baud },
                    }))
                  }
                  options={(Object.keys(SCALE_PROTOCOLS) as ScaleProtocol[]).map((p) => ({
                    value: p,
                    label: SCALE_PROTOCOLS[p].label,
                    description: SCALE_PROTOCOLS[p].verified ? undefined : "A validar con tu equipo",
                  }))}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {preset.hint}{" "}
                {!preset.verified && (
                  <Badge tone="warning" className="ml-1">
                    Sin validar con el equipo
                  </Badge>
                )}
              </p>
              <div>
                <p className="mb-1.5 text-sm font-medium">Conexión</p>
                <Segmented<ScaleTransport>
                  aria-label="Conexión de la balanza"
                  value={scale.transport}
                  onChange={(t) => setScale((s) => ({ ...s, transport: t }))}
                  options={(Object.keys(SCALE_TRANSPORT_LABEL) as ScaleTransport[]).map((t) => ({
                    value: t,
                    label: t === "webserial" ? "USB / serie" : t === "bridge" ? "Puente local" : "Simulador",
                  }))}
                />
                <p className="mt-1 text-xs text-muted-foreground">{SCALE_TRANSPORT_LABEL[scale.transport]}</p>
              </div>
              {scale.transport === "bridge" && (
                <BridgeTargetFields
                  value={scale.bridge}
                  onChange={(b) => setScale((s) => ({ ...s, bridge: b }))}
                  allowTcp={false}
                />
              )}
              {scale.transport !== "simulator" && (
                <div className="grid gap-3 sm:grid-cols-3">
                  <Select<Baud>
                    label="Velocidad (baudios)"
                    value={String(scale.serial.baudRate) as Baud}
                    onChange={(b) => setScale((s) => ({ ...s, serial: { ...s.serial, baudRate: Number(b) } }))}
                    options={BAUDS.map((b) => ({ value: b, label: b }))}
                  />
                  <Select<"8N1" | "7E1" | "7O1">
                    label="Formato"
                    value={
                      scale.serial.dataBits === 7 ? (scale.serial.parity === "odd" ? "7O1" : "7E1") : "8N1"
                    }
                    onChange={(f) =>
                      setScale((s) => ({
                        ...s,
                        serial: {
                          ...s.serial,
                          dataBits: f === "8N1" ? 8 : 7,
                          parity: f === "8N1" ? "none" : f === "7O1" ? "odd" : "even",
                          stopBits: 1,
                        },
                      }))
                    }
                    options={[
                      { value: "8N1", label: "8N1" },
                      { value: "7E1", label: "7E1" },
                      { value: "7O1", label: "7O1" },
                    ]}
                  />
                  <Select<"kg" | "g">
                    label="La balanza informa en"
                    value={scale.protocol.unit}
                    onChange={(u) => setProto({ unit: u })}
                    options={[
                      { value: "kg", label: "Kilos" },
                      { value: "g", label: "Gramos" },
                    ]}
                  />
                </div>
              )}
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="sm:col-span-1">
                  <p className="mb-1.5 text-sm font-medium">Lectura</p>
                  <Segmented<"continuous" | "poll">
                    aria-label="Modo de lectura"
                    size="sm"
                    value={scale.protocol.mode}
                    onChange={(m) => setProto({ mode: m })}
                    options={[
                      { value: "continuous", label: "Continua" },
                      { value: "poll", label: "A pedido" },
                    ]}
                  />
                </div>
                {scale.protocol.mode === "poll" && (
                  <>
                    <Input
                      label="Comando para pedir el peso"
                      hint="Con escapes: \x05 es ENQ"
                      value={scale.protocol.pollCommand}
                      onChange={(e) => setProto({ pollCommand: e.target.value })}
                    />
                    <Input
                      label="Cada (ms)"
                      inputMode="numeric"
                      value={String(scale.protocol.pollMs)}
                      onChange={(e) =>
                        setProto({ pollMs: Math.min(5000, Math.max(100, Number(e.target.value.replace(/\D/g, "")) || 300)) })
                      }
                    />
                  </>
                )}
              </div>
              <Input
                label="Expresión del peso (avanzado)"
                placeholder={preset.regex}
                hint="Vacía usa la del protocolo. El primer grupo entre paréntesis es el número."
                error={regexErr ?? undefined}
                value={scale.protocol.regex}
                onChange={(e) => setProto({ regex: e.target.value })}
              />
            </div>
          )}
        </section>

        {/* ── Cajón ─────────────────────────────────────────────────────── */}
        <section className="space-y-3 border-t border-border pt-5">
          <div className="flex items-center justify-between gap-3">
            <h3 className="flex items-center gap-2 font-semibold">
              <Inbox size={16} aria-hidden /> Cajón de dinero
            </h3>
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Esta caja no tiene cajón</span>
              <Switch
                checked={!drawer.hasDrawer}
                onCheckedChange={(c) => setDrawer((d) => ({ ...d, hasDrawer: !c }))}
                label="Esta caja no tiene cajón"
              />
            </label>
          </div>
          {!drawer.hasDrawer ? (
            <p className="text-sm text-muted-foreground">
              El POS no ofrece Abrir cajón en esta caja y no intenta abrirlo al cobrar.
            </p>
          ) : (
            <div className="space-y-3">
              <Select<string>
                label="Impresora que abre el cajón"
                placeholder={storePrinters.length ? "Elegí la impresora" : "No hay impresoras cargadas en la sucursal"}
                value={drawer.printerId}
                onChange={(id) => setDrawer((d) => ({ ...d, printerId: id }))}
                options={storePrinters.map((p) => ({
                  value: p.id,
                  label: p.name,
                  description: p.cash_register_id ? "De esta caja" : "De la sucursal",
                }))}
                hint="El cajón va enchufado a la impresora térmica (ficha DK). Las impresoras se cargan en Impresión."
              />
              <div>
                <p className="mb-1.5 text-sm font-medium">Cómo se le manda el pulso</p>
                <Segmented<DrawerTransport>
                  aria-label="Conexión con la impresora del cajón"
                  value={drawer.transport}
                  onChange={(t) => setDrawer((d) => ({ ...d, transport: t }))}
                  options={(["webserial", "webusb", "bridge", "simulator", "none"] as DrawerTransport[]).map((t) => ({
                    value: t,
                    label:
                      t === "webserial"
                        ? "USB / serie"
                        : t === "webusb"
                          ? "USB directo"
                          : t === "bridge"
                            ? "Puente"
                            : t === "simulator"
                              ? "Simulador"
                              : "Ninguno",
                  }))}
                />
                <p className="mt-1 text-xs text-muted-foreground">{DRAWER_TRANSPORT_LABEL[drawer.transport]}</p>
              </div>
              {drawer.transport === "bridge" && (
                <BridgeTargetFields value={drawer.bridge} onChange={(b) => setDrawer((d) => ({ ...d, bridge: b }))} allowTcp />
              )}
              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <p className="mb-1.5 text-sm font-medium">Pin del cajón</p>
                  <Segmented<"2" | "5">
                    aria-label="Pin del cajón"
                    size="sm"
                    value={String(drawer.pin) as "2" | "5"}
                    onChange={(p) => setDrawer((d) => ({ ...d, pin: p === "5" ? 5 : 2 }))}
                    options={[
                      { value: "2", label: "Pin 2" },
                      { value: "5", label: "Pin 5" },
                    ]}
                  />
                </div>
                <Input
                  label="Pulso encendido (ms)"
                  inputMode="numeric"
                  value={String(drawer.onMs)}
                  onChange={(e) =>
                    setDrawer((d) => ({ ...d, onMs: Math.min(510, Math.max(2, Number(e.target.value.replace(/\D/g, "")) || 2)) }))
                  }
                />
                <Input
                  label="Pausa (ms)"
                  inputMode="numeric"
                  value={String(drawer.offMs)}
                  onChange={(e) =>
                    setDrawer((d) => ({ ...d, offMs: Math.min(510, Math.max(2, Number(e.target.value.replace(/\D/g, "")) || 2)) }))
                  }
                />
              </div>
              <p className="text-xs text-muted-foreground">
                La mayoría de los cajones abre con pin 2 y 100 a 200 ms. Si no abre, probá pin 5.
              </p>
            </div>
          )}
        </section>

        {/* ── Esta PC ───────────────────────────────────────────────────── */}
        {(scale.enabled || drawer.hasDrawer) && (
          <section className="space-y-3 border-t border-border pt-5">
            <h3 className="flex items-center gap-2 font-semibold">
              <Link2 size={16} aria-hidden /> En esta PC
            </h3>
            <p className="text-sm text-muted-foreground">
              El permiso al puerto USB es del navegador de cada PC: se empareja una vez en la PC de esta caja. Se
              guarda en el equipo, no en el sistema.
            </p>
            {!support.secure && (
              <p className="text-sm text-warning">Esta página no está en https: el navegador no deja usar USB.</p>
            )}
            <div className="grid gap-2 sm:grid-cols-2">
              {scale.enabled && scale.transport === "webserial" && (
                <PairRow
                  label="Balanza"
                  paired={pairs.scale}
                  disabled={!support.webserial}
                  onPair={() => pair("scale", "serial")}
                  onForget={() => {
                    saveHardwarePairing(hw.registerId, "scale", null);
                    setPairs((p) => ({ ...p, scale: null }));
                  }}
                />
              )}
              {drawer.hasDrawer && (drawer.transport === "webserial" || drawer.transport === "webusb") && (
                <PairRow
                  label="Impresora del cajón"
                  paired={pairs.drawer}
                  disabled={drawer.transport === "webusb" ? !support.webusb : !support.webserial}
                  onPair={() => pair("drawer", drawer.transport === "webusb" ? "usb" : "serial")}
                  onForget={() => {
                    saveHardwarePairing(hw.registerId, "drawer", null);
                    setPairs((p) => ({ ...p, drawer: null }));
                  }}
                />
              )}
            </div>
            {(scale.transport === "bridge" || drawer.transport === "bridge") && (
              <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                <Input label="Puente local" value={bridgeUrl} onChange={(e) => setBridgeUrl(e.target.value)} />
                <Input
                  label="Token del puente"
                  type="password"
                  value={bridgeToken}
                  onChange={(e) => setBridgeToken(e.target.value)}
                />
                <Button variant="secondary" onClick={saveBridge}>
                  Guardar en esta PC
                </Button>
              </div>
            )}
          </section>
        )}

        {/* ── Pruebas ───────────────────────────────────────────────────── */}
        <section className="space-y-2 border-t border-border pt-5">
          <h3 className="font-semibold">Pruebas</h3>
          <p className="text-sm text-muted-foreground">Prueban lo guardado. Guardá antes si cambiaste algo.</p>
          <RegisterHardwareTests hw={hw} label={label} />
        </section>
      </div>
    </Modal>
  );
}

function PairRow({
  label,
  paired,
  disabled,
  onPair,
  onForget,
}: {
  label: string;
  paired: string | null;
  disabled: boolean;
  onPair: () => void;
  onForget: () => void;
}) {
  return (
    <div className={cn("flex items-center justify-between gap-2 rounded-lg bg-muted/50 px-3 py-2")}>
      <div className="min-w-0 text-sm">
        <p className="font-medium">{label}</p>
        <p className="truncate text-xs text-muted-foreground">{paired ?? "Sin emparejar en esta PC"}</p>
      </div>
      <div className="flex shrink-0 gap-1">
        {paired && (
          <Button size="sm" variant="ghost" onClick={onForget}>
            Olvidar
          </Button>
        )}
        <Button size="sm" variant="secondary" onClick={onPair} disabled={disabled}>
          {paired ? "Cambiar" : "Emparejar"}
        </Button>
      </div>
    </div>
  );
}
