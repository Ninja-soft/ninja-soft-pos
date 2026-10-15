"use client";

// Movimientos de stock de la sucursal (ADR-137): cada entrada y salida con el
// producto, el motivo, la diferencia, quién y cuándo (hora de Argentina).

import { useEffect, useState } from "react";
import { History } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { ProductThumb } from "@/components/products/ProductThumb";
import { MOVEMENT_REASON_LABEL } from "@/lib/stock/adjustments";
import { fmtDateTimeAR } from "@/lib/stock/inventorySheet";
import { inventoryApi, useInventoryMovements, type MovementRow } from "@/modules/stock/adjustments";
import { DeltaText } from "./shared";

const LOSS_LABEL: Record<string, string> = {
  roto: "rotura",
  vencido: "vencimiento",
  preparacion_fallida: "preparación fallida",
  devolucion: "devolución",
  otro: "otro",
};

export function MovementsTab({ storeId }: { storeId: string | null }) {
  const { data, isLoading } = useInventoryMovements(storeId);
  const first = data ?? [];
  const [older, setOlder] = useState<MovementRow[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    setOlder([]);
    setDone(false);
  }, [storeId, data]);

  const rows = [...first, ...older];

  async function more() {
    const last = rows[rows.length - 1];
    if (!storeId || !last) return;
    setLoadingMore(true);
    try {
      const next = await inventoryApi.movements(storeId, last.created_at);
      setOlder((o) => [...o, ...next]);
      if (next.length === 0) setDone(true);
    } finally {
      setLoadingMore(false);
    }
  }

  if (isLoading) return <SpinnerBlock label="Cargando movimientos" />;
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={History}
        title="Acá vas a ver cada movimiento de stock"
        description="Ventas, compras, ajustes, conteos y traslados de esta sucursal, con quién los hizo y cuándo."
      />
    );
  }

  return (
    <div className="space-y-3">
      <ul className="divide-y divide-border overflow-hidden rounded-lg bg-card ring-1 ring-border">
        {rows.map((r) => (
          <li key={r.id} className="flex items-start gap-3 p-3">
            <ProductThumb src={r.image_url} size={40} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">
                {r.product_name}
                {r.variant_label ? <span className="text-muted-foreground"> · {r.variant_label}</span> : null}
              </p>
              <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <Badge tone="neutral">{MOVEMENT_REASON_LABEL[r.reason] ?? r.reason}</Badge>
                {r.loss_reason ? `por ${LOSS_LABEL[r.loss_reason] ?? r.loss_reason} · ` : ""}
                {fmtDateTimeAR(r.created_at)}
                {r.actor_name ? ` · ${r.actor_name}` : ""}
              </p>
              {r.notes && <p className="mt-0.5 truncate text-xs text-muted-foreground">{r.notes}</p>}
            </div>
            <DeltaText value={r.delta} unit={r.unit} className="shrink-0" />
          </li>
        ))}
      </ul>
      {!done && rows.length >= 60 && (
        <div className="flex justify-center">
          <Button variant="secondary" size="sm" onClick={more} loading={loadingMore}>
            Ver anteriores
          </Button>
        </div>
      )}
    </div>
  );
}
