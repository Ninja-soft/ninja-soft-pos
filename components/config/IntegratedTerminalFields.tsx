"use client";

import { Input } from "@/components/ui/Input";
import { Callout } from "@/components/ui/Callout";
import { Select } from "@/components/ui/Select";
import {
  ADAPTER_LABEL,
  TRANSPORT_LABEL,
  adapterForProvider,
  type IntegrationConfig,
} from "@/lib/payments/terminal/config";
import { CARD_BRANDS } from "@/lib/pos/cardBrands";
import type { AdapterKey, TransportKind } from "@/lib/payments/terminal/types";

// Campos de una terminal integrada (ADR-053) en el alta / edición de
// Configuración, Terminales: protocolo, conexión física, puerto y datos que
// el protocolo manda en cada venta. Lo que es de cada PC (qué dispositivo
// quedó emparejado, token del puente) se hace aparte, en "Conectar".

const BAUDS = [9600, 19200, 38400, 57600, 115200];

export function IntegratedTerminalFields({
  provider,
  value,
  onChange,
}: {
  provider: string;
  value: IntegrationConfig;
  onChange: (v: IntegrationConfig) => void;
}) {
  const brandAdapter = adapterForProvider(provider);
  const adapters: AdapterKey[] = ["simulator", brandAdapter];
  const set = (patch: Partial<IntegrationConfig>) => onChange({ ...value, ...patch });
  const real = value.adapter !== "simulator";
  const target = value.bridgeTarget;

  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Select
          label="Protocolo"
          value={value.adapter}
          options={adapters.map((a) => ({ value: a, label: ADAPTER_LABEL[a] }))}
          onChange={(adapter) =>
            set({ adapter, transport: adapter === "simulator" ? "none" : value.transport === "none" ? "webserial" : value.transport })
          }
        />
        {real && (
          <Select<TransportKind>
            label="Conexión"
            value={value.transport}
            options={(["webserial", "webusb", "bridge"] as const).map((t) => ({ value: t, label: TRANSPORT_LABEL[t] }))}
            onChange={(transport) => set({ transport })}
          />
        )}
      </div>

      {value.adapter === "simulator" && (
        <p className="text-xs text-muted-foreground">
          El simulador no cobra: sirve para probar el circuito completo en la caja. Montos terminados en ,51 se
          rechazan, en ,91 la terminal no responde y en ,96 se corta la comunicación.
        </p>
      )}
      {value.adapter === "payway_lapos" && (
        <Callout tone="warning" className="p-3 text-xs">
          Payway no publica el protocolo: está implementado según fuentes públicas no oficiales y falta validarlo con el
          kit de integradores. Probalo primero con una venta chica y anulala.
        </Callout>
      )}
      {(value.adapter === "fiserv_posnet" || value.adapter === "getnet") && (
        <Callout tone="info" className="p-3 text-xs">
          La conexión física ya funciona, pero cobrar requiere la especificación del adquirente (en trámite). Mientras
          tanto el POS ofrece la carga manual del cupón.
        </Callout>
      )}

      {real && (value.transport === "webserial" || (value.transport === "bridge" && target?.kind !== "tcp")) && (
        <Select
          label="Velocidad del puerto"
          value={String(value.serial.baudRate)}
          options={BAUDS.map((b) => ({ value: String(b), label: `${b} bps` }))}
          onChange={(b) => set({ serial: { ...value.serial, baudRate: Number(b) } })}
        />
      )}

      {real && value.transport === "bridge" && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Select
            label="Destino"
            value={target?.kind ?? "serial"}
            options={[
              { value: "serial", label: "Puerto de la PC" },
              { value: "tcp", label: "Red (LAN)" },
            ]}
            onChange={(k) =>
              set({ bridgeTarget: k === "tcp" ? { kind: "tcp", host: "", port: 0 } : { kind: "serial", path: "" } })
            }
          />
          {target?.kind === "tcp" ? (
            <>
              <Input
                label="IP de la terminal"
                value={target.host}
                onChange={(e) => set({ bridgeTarget: { ...target, host: e.target.value.trim() } })}
                placeholder="192.168.0.50"
              />
              <Input
                label="Puerto TCP"
                inputMode="numeric"
                value={target.port ? String(target.port) : ""}
                onChange={(e) => set({ bridgeTarget: { ...target, port: Number(e.target.value.replace(/\D/g, "")) || 0 } })}
              />
            </>
          ) : (
            <Input
              label="Puerto"
              value={target?.kind === "serial" ? target.path : ""}
              onChange={(e) => set({ bridgeTarget: { kind: "serial", path: e.target.value.trim() } })}
              placeholder="COM3"
            />
          )}
        </div>
      )}

      {real && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Input
            label="Espera máxima (s)"
            inputMode="numeric"
            value={String(value.timeoutSec)}
            onChange={(e) => set({ timeoutSec: Number(e.target.value.replace(/\D/g, "")) || 0 })}
            hint="Entre 20 y 300."
          />
          <Input
            label="Razón social"
            value={value.merchantName}
            onChange={(e) => set({ merchantName: e.target.value })}
          />
          <Input label="CUIT" inputMode="numeric" value={value.cuit} onChange={(e) => set({ cuit: e.target.value })} />
        </div>
      )}

      {value.adapter === "payway_lapos" && (
        <div>
          <p className="mb-1 text-sm font-medium">Códigos de tarjeta de la terminal</p>
          <p className="mb-2 text-xs text-muted-foreground">
            Payway los informa con la terminal (no se pueden leer de la terminal). Hasta 3 letras o números.
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {CARD_BRANDS.map((b) => (
              <Input
                key={b.key}
                label={b.short ?? b.label}
                value={value.cardCodes[b.key] ?? ""}
                maxLength={3}
                onChange={(e) => {
                  const v = e.target.value.replace(/[^0-9a-z]/gi, "").toUpperCase().slice(0, 3);
                  const next = { ...value.cardCodes };
                  if (v) next[b.key] = v;
                  else delete next[b.key];
                  set({ cardCodes: next });
                }}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
