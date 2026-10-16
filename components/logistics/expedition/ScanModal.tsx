"use client";

// Ventana de control por escaneo (ADR-165): de una entrega (al armar o al
// entregar en el mostrador) o de una hoja de ruta entera (al cargar el
// camión). Lee los controles guardados y los refresca después de cada
// lectura.

import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { ScanPanel, type ScanPanelItem } from "@/components/logistics/expedition/ScanPanel";
import { SCAN_STAGE_LABEL, checkProgress, stageMode, type CheckState, type ScanStage } from "@/lib/logistics/expedition";
import { useDispatchChecks, useExpeditionSettings, useRouteItems } from "@/modules/logistics/expedition";
import { DISPATCHES_KEY } from "@/modules/orders/hooks";
import type { Dispatch } from "@/modules/orders/api";

export function DispatchScanModal({
  dispatch,
  stage,
  onClose,
}: {
  dispatch: Dispatch | null;
  stage: "armado" | "entrega";
  onClose: () => void;
}) {
  const { data: settings } = useExpeditionSettings(Boolean(dispatch));
  const ids = useMemo(() => (dispatch ? [dispatch.id] : []), [dispatch]);
  const checks = useDispatchChecks(ids, stage, Boolean(dispatch));
  const qc = useQueryClient();
  const refetch = checks.refetch;
  const onChanged = useCallback(() => {
    void refetch();
    void qc.invalidateQueries({ queryKey: DISPATCHES_KEY });
  }, [refetch, qc]);
  if (!dispatch) return null;
  const items: ScanPanelItem[] = (dispatch.items ?? [])
    .filter((i) => i.id && i.qty > 0)
    .map((i) => ({
      id: i.id!,
      name: i.variant_label ? `${i.product_name} (${i.variant_label})` : i.product_name,
      qty: i.qty,
      unit: i.unit,
      // Sin SKU puede tener código de barras: el servidor decide al confirmar a mano.
      hasCode: Boolean(i.sku),
    }));
  const map = (checks.data ?? {}) as Record<string, CheckState>;
  const done = checkProgress(items, map).complete;
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`${SCAN_STAGE_LABEL[stage]}: entrega N° ${dispatch.number}`}
      description={
        stage === "armado"
          ? "Escaneá cada producto que ponés en el paquete. Si algo no es de esta entrega, suena y queda registrado."
          : "Escaneá cada producto que se lleva el cliente."
      }
      footer={<Button onClick={onClose}>{done ? "Listo" : "Cerrar"}</Button>}
    >
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Esta entrega no tiene renglones por producto para escanear.</p>
      ) : checks.isLoading ? (
        <Skeleton className="h-40 rounded-lg" />
      ) : (
        <ScanPanel
          stage={stage}
          scope={{ dispatchId: dispatch.id }}
          mode={settings ? stageMode(settings, stage) : "opcional"}
          items={items}
          checks={map}
          onChanged={onChanged}
        />
      )}
    </Modal>
  );
}
DispatchScanModal.displayName = "DispatchScanModal";

/** Control de carga de una hoja de ruta (panel o app del repartidor). */
export function RouteLoadScanModal({
  routeId,
  title,
  onClose,
}: {
  routeId: string | null;
  title: string;
  onClose: () => void;
}) {
  const q = useRouteItems(routeId);
  const refetch = q.refetch;
  const qc = useQueryClient();
  const onChanged = useCallback(() => {
    void refetch();
    void qc.invalidateQueries({ queryKey: ["logistics"] });
  }, [refetch, qc]);
  if (!routeId) return null;
  const stage: ScanStage = "carga";
  const data = q.data;
  const items: ScanPanelItem[] = [];
  const map: Record<string, CheckState> = {};
  for (const d of (data?.dispatches ?? []).filter((x) => x.outcome === "pendiente")) {
    for (const i of d.items) {
      items.push({ id: i.id, name: i.name, qty: i.qty, unit: i.unit, hasCode: i.codes.length > 0, group: `Entrega N° ${d.number}` });
      if (i.load) map[i.id] = { scanned: i.load.scanned, reason: i.load.reason };
    }
  }
  const done = checkProgress(items, map).complete;
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={title}
      description="Escaneá cada producto al subirlo al camión. Lo que es de otra entrega o de otra hoja suena y queda registrado."
      footer={<Button onClick={onClose}>{done ? "Carga completa" : "Cerrar"}</Button>}
    >
      {q.isLoading || !data ? (
        <Skeleton className="h-40 rounded-lg" />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">La hoja no tiene entregas para cargar.</p>
      ) : (
        <ScanPanel stage={stage} scope={{ routeId }} mode={data.settings.scan_on_load} items={items} checks={map} onChanged={onChanged} />
      )}
    </Modal>
  );
}
RouteLoadScanModal.displayName = "RouteLoadScanModal";
