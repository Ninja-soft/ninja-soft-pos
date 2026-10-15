"use client";

// Barra de entregas del carrito (ADR-136) y aviso de las entregas abiertas
// después de cobrar (con el código de retiro, que se ve una sola vez).

import { PackageCheck, Truck } from "lucide-react";
import Link from "next/link";
import type { Route } from "next";
import { Modal } from "@/components/ui/Modal";
import { Button, buttonVariants } from "@/components/ui/Button";
import type { CreateSaleResult } from "@/modules/pos/api";

export function DeliveryBar({ summary, onOpen }: { summary: string | null; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex min-h-11 w-full items-center gap-2.5 rounded-lg bg-fg-4 px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-fg-6"
    >
      <Truck size={16} className="shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{summary ? "Entregas repartidas" : "Entrega: todo se lleva ahora"}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {summary ?? "Vendé de otra sucursal o partí la entrega"}
        </span>
      </span>
      <span className="shrink-0 text-xs font-medium text-muted-foreground">{summary ? "Cambiar" : "Repartir"}</span>
    </button>
  );
}

export function DeliveriesDoneModal({
  done,
  storeName,
  onClose,
}: {
  done: { saleNumber: number; list: NonNullable<CreateSaleResult["deliveries"]> } | null;
  storeName: (id: string) => string;
  onClose: () => void;
}) {
  if (!done) return null;
  const pending = done.list.filter((d) => d.mode !== "ahora");
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Venta #${done.saleNumber}: ${done.list.length === 1 ? "1 entrega" : `${done.list.length} entregas`}`}
      description="Pasale al cliente el código de cada retiro: se ve una sola vez."
      className="sm:max-w-md"
      footer={
        <>
          <Link href={"/expedicion" as Route} className={buttonVariants({ variant: "secondary" })} onClick={onClose}>
            Ver en Expedición
          </Link>
          <Button onClick={onClose}>Listo</Button>
        </>
      }
    >
      <ul className="space-y-2">
        {done.list.map((d) => (
          <li key={d.id} className="flex items-center gap-3 rounded-lg bg-muted/40 p-3 text-sm">
            {d.mode === "envio" ? <Truck size={16} aria-hidden /> : <PackageCheck size={16} aria-hidden />}
            <span className="min-w-0 flex-1">
              <span className="block font-medium">
                Entrega N° {d.number}
                {d.mode === "ahora"
                  ? ": se la llevó"
                  : d.mode === "envio"
                    ? `: envío desde ${storeName(d.origin_store_id)}`
                    : `: retira en ${storeName(d.fulfillment_store_id)}`}
              </span>
              {d.mode !== "ahora" && d.origin_store_id !== d.fulfillment_store_id && (
                <span className="block text-xs text-muted-foreground">Sale de {storeName(d.origin_store_id)}</span>
              )}
            </span>
            {d.pickup_code && (
              <span className="font-mono text-xl font-bold tracking-[0.2em] tabular-nums">{d.pickup_code}</span>
            )}
          </li>
        ))}
      </ul>
      {pending.length > 0 && (
        <p className="mt-3 text-xs text-muted-foreground">Las entregas pendientes ya están en la cola de Expedición de cada sucursal.</p>
      )}
    </Modal>
  );
}
