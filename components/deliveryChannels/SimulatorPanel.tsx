"use client";

import { useState } from "react";
import { Bike, CircleOff, CloudOff, Send, Truck } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { formatCurrency } from "@/lib/utils/format";
import {
  CHANNEL_LABELS,
  EXTERNAL_STATUS_LABELS,
  channelErrorMessage,
  type ChannelConnection,
  type ChannelProvider,
} from "@/modules/deliveryChannels/api";
import { useChannelMutations, useChannelOrders, useCredentialKeys } from "@/modules/deliveryChannels/hooks";

const BRANDS: ChannelProvider[] = ["pedidosya", "rappi", "ubereats"];

// Simulador (ADR-102): hace de PedidosYa, Rappi o Uber Eats para probar de
// punta a punta en cualquier negocio. Cada pedido viaja como un webhook real
// firmado; los botones de abajo hacen lo que haría la app (cancelar, mover al
// repartidor, marcar retirado o entregado). Sólo dueño o encargado.
export function SimulatorPanel({ conn }: { conn: ChannelConnection }) {
  const { toast } = useToast();
  const { simulate, setCredentials } = useChannelMutations();
  const orders = useChannelOrders();
  const keys = useCredentialKeys(conn.id);
  const [unmapped, setUnmapped] = useState(false);
  const [ownLogistics, setOwnLogistics] = useState(false);
  const [takeaway, setTakeaway] = useState(false);
  const [courierStep, setCourierStep] = useState<Record<string, number>>({});
  const failing = (keys.data?.keys ?? []).includes("fail_actions");

  const run = (body: Record<string, unknown>, ok: string) =>
    simulate.mutate(
      { connectionId: conn.id, body },
      {
        onSuccess: (r) => {
          if (r.ok || r.webhook === null) toast({ title: ok, variant: "success" });
          else toast({ title: "La app simulada no pudo entregar el aviso", description: JSON.stringify(r.webhook?.body ?? ""), variant: "warning" });
        },
        onError: (e) => toast({ title: "No se pudo simular", description: channelErrorMessage(e), variant: "error" }),
      },
    );

  const mine = (orders.data ?? []).filter((o) => o.connection_id === conn.id).slice(0, 12);

  return (
    <div className="space-y-5">
      {conn.status !== "activa" && (
        <Callout tone="warning" title="Conexión pausada">
          Activala en Configuración para simular pedidos.
        </Callout>
      )}
      <div className="space-y-3 rounded-lg border border-border p-4">
        <p className="text-sm font-semibold text-foreground">Simular un pedido nuevo</p>
        <div className="flex flex-wrap gap-2">
          {BRANDS.map((b) => (
            <Button
              key={b}
              size="sm"
              loading={simulate.isPending}
              disabled={conn.status !== "activa"}
              onClick={() =>
                run(
                  {
                    scenario: "order",
                    brand: b,
                    unmapped_item: unmapped,
                    logistics: ownLogistics ? "propia" : "plataforma",
                    order_type: takeaway ? "takeaway" : "delivery",
                  },
                  `Pedido de ${CHANNEL_LABELS[b]} enviado`,
                )
              }
            >
              <Send size={14} /> {CHANNEL_LABELS[b]}
            </Button>
          ))}
          <Button
            variant="secondary"
            size="sm"
            disabled={conn.status !== "activa" || simulate.isPending}
            onClick={() =>
              run(
                { scenario: "order_lost", brand: "rappi" },
                "Pedido creado en la app sin webhook: lo recupera la reconciliación en 1 o 2 minutos",
              )
            }
          >
            <CloudOff size={14} /> Pedido con webhook perdido
          </Button>
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          <Toggle label="Con un ítem sin mapear" checked={unmapped} onChange={setUnmapped} />
          <Toggle label="Reparto propio (con envío)" checked={ownLogistics} onChange={setOwnLogistics} />
          <Toggle label="Retira el cliente" checked={takeaway} onChange={setTakeaway} />
        </div>
        <Toggle
          label="La app no responde (para probar los reintentos)"
          checked={failing}
          onChange={(v) =>
            setCredentials.mutate(
              { id: conn.id, credentials: { fail_actions: v ? ["accept", "reject", "mark_ready", "mark_picked_up"] : null } },
              {
                onSuccess: () => void keys.refetch(),
                onError: (e) => toast({ title: "No se pudo cambiar", description: channelErrorMessage(e), variant: "error" }),
              },
            )
          }
        />
      </div>

      <div className="space-y-2">
        <p className="text-sm font-semibold text-foreground">Lo que haría la app con los últimos pedidos</p>
        {mine.length === 0 && <p className="text-xs text-muted-foreground">Todavía no hay pedidos simulados.</p>}
        <ul className="divide-y divide-border rounded-lg border border-border">
          {mine.map((o) => {
            const step = courierStep[o.id] ?? 0;
            const open = !["cancelado", "rechazado"].includes(o.external_status);
            return (
              <li key={o.id} className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 text-sm">
                  <span className="font-medium">
                    {CHANNEL_LABELS[o.brand]} #{o.external_display_code ?? o.external_order_id}
                  </span>{" "}
                  <span className="text-muted-foreground">{formatCurrency(Number(o.total))}</span>{" "}
                  <Badge tone={open ? "info" : "neutral"}>{EXTERNAL_STATUS_LABELS[o.external_status]}</Badge>
                </div>
                {open && (
                  <div className="flex flex-wrap gap-1.5">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={simulate.isPending}
                      onClick={() => {
                        setCourierStep((s) => ({ ...s, [o.id]: Math.min(step + 1, 4) }));
                        run({ scenario: "courier", external_order_id: o.external_order_id, step }, "Repartidor actualizado");
                      }}
                    >
                      <Bike size={14} /> Repartidor
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={simulate.isPending}
                      onClick={() =>
                        run({ scenario: "status", external_order_id: o.external_order_id, status: "retirado" }, "La app marcó retirado")
                      }
                    >
                      <Truck size={14} /> Retiró
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={simulate.isPending}
                      onClick={() =>
                        run({ scenario: "status", external_order_id: o.external_order_id, status: "entregado" }, "La app marcó entregado")
                      }
                    >
                      Entregó
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={simulate.isPending}
                      onClick={() =>
                        run({ scenario: "cancel", external_order_id: o.external_order_id }, "La app canceló el pedido")
                      }
                    >
                      <CircleOff size={14} /> Cancelar en la app
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-sm text-foreground">
      <span>{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} label={label} />
    </label>
  );
}
