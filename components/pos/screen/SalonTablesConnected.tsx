"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useToast } from "@/components/ui/Toast";
import {
  useDiningAreas,
  useDiningTables,
  useOpenTableTotals,
  useTableMutations,
  useTableOrderMutations,
} from "@/modules/dining/hooks";
import type { DiningTable, TableStatus } from "@/modules/dining/api";
import { SalonTablesPanel } from "./SalonTablesPanel";

const TableAccountModal = dynamic(
  () => import("@/components/dining/TableAccountModal").then((m) => m.TableAccountModal),
  { ssr: false },
);

// Mesas del preset Salón con sus datos y la cuenta de la mesa (misma lógica
// que la vista de Salón: abrir mesa libre, ver/editar cuenta, cobrar en el POS).
export function SalonTablesConnected({ activeOrderId }: { activeOrderId: string | null }) {
  const { toast } = useToast();
  const { data: areas } = useDiningAreas();
  const { data: tables, isLoading } = useDiningTables();
  const { data: totals } = useOpenTableTotals();
  const { setStatus } = useTableMutations();
  const { open: openTable } = useTableOrderMutations();
  const [activeTable, setActiveTable] = useState<DiningTable | null>(null);

  // Igual que Salón (BUG 13): si otro mozo liberó la mesa, se cierra la cuenta.
  const activeLive = useMemo(() => {
    if (!activeTable) return null;
    const live = (tables ?? []).find((t) => t.id === activeTable.id);
    if (!live) return activeTable;
    if (live.status === "libre") return null;
    const orderId = live.current_order_id ?? activeTable.current_order_id;
    if (!orderId) return null;
    return { ...live, current_order_id: orderId };
  }, [activeTable, tables]);
  useEffect(() => {
    if (activeTable && activeLive === null) setActiveTable(null);
  }, [activeTable, activeLive]);

  async function onTap(t: DiningTable) {
    if (t.status === "bloqueada") {
      toast({ title: `Mesa ${t.label} bloqueada`, variant: "info" });
      return;
    }
    if (t.status === "reservada") {
      toast({
        title: `Mesa ${t.label} reservada`,
        description: "Sentá la reserva desde la sección Reservas.",
        variant: "info",
      });
      return;
    }
    if (t.status === "libre") {
      try {
        const orderId = await openTable.mutateAsync({ tableId: t.id });
        setActiveTable({ ...t, status: "ocupada", current_order_id: orderId });
      } catch (e) {
        toast({
          title: "No se pudo abrir la mesa",
          description: e instanceof Error ? e.message : undefined,
          variant: "error",
        });
      }
      return;
    }
    setActiveTable(t);
  }

  function onSetStatus(tableId: string, status: TableStatus) {
    setStatus.mutate(
      { id: tableId, status },
      {
        onError: (e) =>
          toast({
            title: "No se pudo cambiar el estado",
            description: e instanceof Error ? e.message : undefined,
            variant: "error",
          }),
      },
    );
  }

  return (
    <>
      <SalonTablesPanel
        areas={areas ?? []}
        tables={tables ?? []}
        totals={totals}
        activeOrderId={activeOrderId}
        onTap={onTap}
        loading={isLoading}
      />
      {activeLive && (
        <TableAccountModal table={activeLive} onClose={() => setActiveTable(null)} onSetStatus={onSetStatus} />
      )}
    </>
  );
}
