"use client";

import { Modal } from "@/components/ui/Modal";
import { useStockMovements } from "@/modules/products/hooks";
import type { Product } from "@/modules/products/api";
import { formatQty } from "@/lib/utils/format";

const REASON_LABELS: Record<string, string> = {
  purchase: "Compra",
  sale: "Venta",
  sale_void: "Anulación",
  adjustment: "Ajuste",
  transfer: "Transferencia",
  loss: "Merma",
  return: "Devolución",
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: Product | null;
}

export function StockHistoryModal({ open, onOpenChange, product }: Props) {
  const { data, isLoading } = useStockMovements(product?.id ?? null, open);

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Historial de stock"
      description={product?.name}
    >
      <div className="max-h-96 overflow-y-auto">
        {isLoading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Cargando…
          </p>
        ) : !data || data.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Sin movimientos registrados.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {data.map((m) => {
              const positive = m.delta > 0;
              return (
                <li
                  key={m.id}
                  className="flex items-center justify-between py-3 text-sm"
                >
                  <div>
                    <span className="font-medium text-foreground">
                      {REASON_LABELS[m.reason] ?? m.reason}
                    </span>
                    {m.notes && (
                      <span className="ml-2 text-muted-foreground">
                        {m.notes}
                      </span>
                    )}
                    <div className="text-xs text-muted-foreground">
                      {new Date(m.created_at).toLocaleString("es-AR")}
                    </div>
                  </div>
                  <span
                    className={
                      positive
                        ? "font-mono font-semibold text-emerald-300"
                        : "font-mono font-semibold text-red-300"
                    }
                  >
                    {positive ? "+" : ""}
                    {formatQty(m.delta)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Modal>
  );
}
