"use client";

import { Package } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { formatCurrency } from "@/lib/utils/format";
import { useServicePacks } from "@/modules/packs/hooks";

// Vender un pack desde el POS (H41): lista los packs activos del tenant; al
// elegir uno se agrega como ítem de venta por su precio (onPick). El cliente es
// obligatorio (lo valida la página antes de abrir): al cobrar se le acreditan
// las sesiones. Mismo lugar/patrón que "Canjear vale".
export function SellPackModal({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onPick: (p: { packId: string; name: string; price: number }) => void;
}) {
  const { data: packs, isLoading } = useServicePacks(true);

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Vender paquete"
      description="Elegí un pack: se cobra ahora y se le acreditan las sesiones al cliente."
      className="max-w-sm"
    >
      <div className="space-y-2">
        {isLoading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Cargando…</p>
        ) : (packs ?? []).length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
            No hay paquetes activos. Creálos en Configuración → Paquetes.
          </p>
        ) : (
          packs!.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                onPick({ packId: p.id, name: p.name, price: Number(p.price) });
                onOpenChange(false);
              }}
              className="flex w-full items-center justify-between gap-2 rounded-lg border border-border px-3 py-2.5 text-left transition hover:border-ninja-flameSoft/40 hover:bg-muted"
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <Package size={16} className="shrink-0 text-ninja-flameSoft" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-foreground">
                    {p.name}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {p.sessions} {p.sessions === 1 ? "sesión" : "sesiones"}
                    {p.validity_days != null ? ` · ${p.validity_days} días` : " · sin vto"}
                  </span>
                </span>
              </span>
              <span className="shrink-0 font-price text-sm font-bold tabular-nums">
                {formatCurrency(Number(p.price))}
              </span>
            </button>
          ))
        )}
      </div>
    </Modal>
  );
}
