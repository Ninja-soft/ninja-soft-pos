"use client";

// Sumar entregas a una hoja (ADR-161): las entregas por envío propio de la
// sucursal que todavía no viajan, con su dirección, si tiene ubicación en el
// mapa y los intentos anteriores. Las de un mismo cliente y dirección van a
// la misma parada (lo resuelve route_add_dispatches).

import { useEffect, useMemo, useState } from "react";
import { MapPinOff, PackageCheck } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Input } from "@/components/ui/Input";
import { EmptyState } from "@/components/ui/EmptyState";
import { useToast } from "@/components/ui/Toast";
import { logisticsErrorMessage } from "@/lib/logistics/logic";
import { useLogisticsMutations, useLogisticsSettings, useRouteCandidates } from "@/modules/logistics/api";

const STATUS_LABEL: Record<string, string> = { pendiente: "Para armar", armando: "Armando", listo: "Listo" };

export function AddDispatchesModal({
  open,
  routeId,
  storeId,
  onClose,
}: {
  open: boolean;
  routeId: string;
  storeId: string;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const m = useLogisticsMutations();
  const { data: list = [], isLoading } = useRouteCandidates(storeId, open);
  const { data: cfg } = useLogisticsSettings(open);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  useEffect(() => {
    if (open) {
      setPicked(new Set());
      setQ("");
    }
  }, [open]);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return list;
    return list.filter((d) =>
      `${d.number} ${d.sale?.number ?? ""} ${d.customer_name ?? ""} ${d.ship_address ?? ""} ${d.ship_to?.locality ?? ""}`.toLowerCase().includes(t),
    );
  }, [list, q]);

  function toggle(id: string) {
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  async function add() {
    try {
      const r = await m.addDispatches.mutateAsync({ routeId, ids: [...picked] });
      toast({ title: r.added === 1 ? "1 entrega sumada" : `${r.added} entregas sumadas`, description: `La hoja tiene ${r.stops} paradas.`, variant: "success" });
      onClose();
    } catch (e) {
      toast({ title: "No se pudieron sumar", description: logisticsErrorMessage(e), variant: "error" });
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Sumar entregas"
      description="Envíos propios de esta sucursal que todavía no están en una hoja."
      className="sm:max-w-2xl"
      footer={
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm text-muted-foreground">{picked.size ? `${picked.size} elegidas` : "Elegí las entregas"}</span>
          <div className="flex gap-2">
            {shown.length > 0 && (
              <Button variant="ghost" onClick={() => setPicked(new Set(shown.map((d) => d.id)))}>
                Todas
              </Button>
            )}
            <Button onClick={add} disabled={picked.size === 0} loading={m.addDispatches.isPending}>
              Sumar a la hoja
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        <Input placeholder="Buscar por cliente, dirección, localidad o número" value={q} onChange={(e) => setQ(e.target.value)} />
        {isLoading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Cargando entregas…</p>
        ) : shown.length === 0 ? (
          <EmptyState compact icon={PackageCheck} title="No hay envíos para repartir" description="Las ventas con envío a domicilio aparecen acá hasta que salen en una hoja." />
        ) : (
          <ul className="divide-y divide-border rounded-lg ring-1 ring-border">
            {shown.map((d) => {
              const noGeo = d.ship_to?.lat == null;
              return (
                <li key={d.id}>
                  <label className="flex cursor-pointer items-start gap-3 p-3 hover:bg-muted/40">
                    <input type="checkbox" className="mt-1 h-5 w-5 shrink-0" checked={picked.has(d.id)} onChange={() => toggle(d.id)} />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="font-semibold">{d.customer_name ?? "Sin nombre"}</span>
                        <span className="text-xs text-muted-foreground">
                          Entrega {d.number}
                          {d.sale ? ` · venta ${d.sale.number}` : ""}
                        </span>
                      </span>
                      <span className="block truncate text-sm text-muted-foreground">{d.ship_address ?? "Sin dirección"}</span>
                      <span className="mt-1 flex flex-wrap gap-1.5">
                        <Badge tone={d.status === "listo" ? "success" : "neutral"}>{STATUS_LABEL[d.status] ?? d.status}</Badge>
                        {noGeo && (
                          <Badge tone="warning">
                            <MapPinOff size={12} aria-hidden /> Sin ubicación en el mapa
                          </Badge>
                        )}
                        {cfg && d.delivery_attempts >= cfg.max_attempts && <Badge tone="warning">Revisar con el cliente antes de salir</Badge>}
                        {d.delivery_attempts > 0 && (
                          <Badge tone="danger">
                            {d.delivery_attempts === 1 ? "1 intento" : `${d.delivery_attempts} intentos`}
                            {d.last_failure_reason ? `: ${d.last_failure_reason}` : ""}
                          </Badge>
                        )}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Modal>
  );
}
AddDispatchesModal.displayName = "AddDispatchesModal";
