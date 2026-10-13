"use client";

import { useState } from "react";
import Link from "next/link";
import { ExternalLink, Upload } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { formatCurrency } from "@/lib/utils/format";
import { itemStatusLabel, itemStatusTone } from "@/lib/mercadolibre/labels";
import { useMlAccounts, useMlChannelPreview } from "@/modules/mercadolibre/hooks";
import { MlPublishModal } from "./MlPublishModal";

// Ficha del producto > Más > Mercado Libre (ADR-104): publicaciones vinculadas
// a este producto en la primera cuenta activa, precio del canal y stock
// publicable, y el acceso a publicarlo.
export function MlProductPanel({ productId, canManage }: { productId: string; canManage: boolean }) {
  const { data: accounts = [], isLoading } = useMlAccounts(canManage);
  const active = accounts.filter((a) => a.status === "active");
  const first = active[0] ?? null;
  const { data: pv } = useMlChannelPreview(first?.id ?? null, productId);
  const [open, setOpen] = useState(false);

  if (!canManage) {
    return <p className="text-xs text-muted-foreground">Publicar en Mercado Libre lo hace el dueño o un encargado.</p>;
  }
  if (isLoading) return <SpinnerBlock className="py-6" />;
  if (active.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Conectá una cuenta en{" "}
        <Link href="/configuracion?seccion=mercadolibre" className="underline">
          Configuración &gt; Integraciones &gt; Mercado Libre
        </Link>{" "}
        para publicar este producto.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {pv && (
        <p className="text-xs text-muted-foreground">
          Precio del canal {pv.price != null ? formatCurrency(pv.price) : "sin precio"}
          {pv.qty != null ? ` · ${pv.qty} publicables` : ""} · cuenta {first?.nickname}
        </p>
      )}
      {(pv?.links ?? []).length > 0 ? (
        <div className="space-y-1">
          {pv!.links.map((l) => (
            <div key={l.link_id} className="flex items-center justify-between gap-2 rounded-lg bg-muted px-3 py-2 text-sm">
              <span className="min-w-0 truncate">
                {l.ml_item_id} · {l.title}
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <Badge tone={itemStatusTone(l.status)}>{itemStatusLabel(l.status)}</Badge>
                {l.permalink && (
                  <a href={l.permalink} target="_blank" rel="noreferrer" aria-label="Ver en Mercado Libre">
                    <ExternalLink size={14} />
                  </a>
                )}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Este producto todavía no tiene publicación vinculada.</p>
      )}
      <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <Upload size={15} /> Publicar en Mercado Libre
      </Button>
      {open && <MlPublishModal open={open} onOpenChange={setOpen} productId={productId} accounts={accounts} />}
    </div>
  );
}
