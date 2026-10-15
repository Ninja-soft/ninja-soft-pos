"use client";

import { useState } from "react";
import { ClipboardCheck, Hash, Pencil, Plus, Printer, Truck, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { useToast } from "@/components/ui/Toast";
import { formatInt } from "@/lib/utils/format";
import { INBOUND_STATUS, OPEN_INBOUND, fullErrorMessage, isValidMlInboundId } from "@/lib/mercadolibre/full";
import { useMlFullMutations, type MlFullInbound, type MlFullRow } from "@/modules/mercadolibre/fullHooks";
import { MlFullInboundEditor } from "./MlFullInboundEditor";
import { MlFullLabelsModal } from "./MlFullLabelsModal";
import { MlFullReceiveModal } from "./MlFullReceiveModal";

type Filter = "open" | "draft" | "closed" | "all";

const fmtDate = (v: string | null) =>
  v ? new Date(v).toLocaleDateString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", year: "numeric" }) : "";

/** Próximo paso de un envío, en palabras. */
export function nextStep(ib: Pick<MlFullInbound, "status" | "ml_inbound_id" | "label_units_printed">): string {
  switch (ib.status) {
    case "draft":
      if (!ib.ml_inbound_id) return "Creá el envío en Mercado Libre y cargá su número.";
      if (ib.label_units_printed === 0) return "Imprimí las etiquetas y despachá.";
      return "Despachá cuando sale la mercadería.";
    case "in_transit":
      return "Cuando Full lo reciba, leé la recepción de Mercado Libre y conciliá.";
    case "partially_received":
      return "Terminá la conciliación y cerrá el envío.";
    case "received":
      return "Listo: todo recibido.";
    case "closed_with_diff":
      return "Cerrado con diferencias registradas.";
    default:
      return "Cancelado.";
  }
}

// Envíos a Full (ADR-142): historial, estados y acciones de cada paso.
export function MlFullInbounds({
  accountId,
  accountName,
  inbounds,
  rows,
  defaultStoreId,
  labelFormat,
  canManage,
  onNew,
}: {
  accountId: string;
  accountName: string;
  inbounds: MlFullInbound[];
  rows: MlFullRow[];
  defaultStoreId: string | null;
  labelFormat: string;
  canManage: boolean;
  onNew: () => void;
}) {
  const { toast } = useToast();
  const { dispatch, cancel, setMl } = useMlFullMutations();
  const [filter, setFilter] = useState<Filter>("open");
  const [edit, setEdit] = useState<MlFullInbound | null>(null);
  const [labels, setLabels] = useState<MlFullInbound | null>(null);
  const [receive, setReceive] = useState<MlFullInbound | null>(null);
  const [toDispatch, setToDispatch] = useState<MlFullInbound | null>(null);
  const [toCancel, setToCancel] = useState<MlFullInbound | null>(null);
  const [mlFor, setMlFor] = useState<MlFullInbound | null>(null);
  const [mlValue, setMlValue] = useState("");

  const list = inbounds.filter((i) =>
    filter === "all"
      ? true
      : filter === "open"
        ? OPEN_INBOUND.includes(i.status)
        : filter === "draft"
          ? i.status === "draft"
          : ["received", "closed_with_diff", "cancelled"].includes(i.status),
  );
  const live = (id: string | undefined) => inbounds.find((i) => i.id === id) ?? null;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Segmented
          value={filter}
          onChange={setFilter}
          aria-label="Filtrar envíos"
          scrollOnMobile
          options={[
            { value: "open", label: "En camino" },
            { value: "draft", label: "Borradores" },
            { value: "closed", label: "Cerrados" },
            { value: "all", label: "Todos" },
          ]}
        />
        {canManage && (
          <Button onClick={onNew}>
            <Plus size={15} /> Nuevo envío a Full
          </Button>
        )}
      </div>

      {list.length === 0 ? (
        <EmptyState icon={Truck} title="No hay envíos para mostrar" description="Armá un envío a Full con los productos y cantidades que vas a mandar." />
      ) : (
        <ul className="space-y-2" aria-label="Envíos a Full">
          {list.map((ib) => {
            const st = INBOUND_STATUS[ib.status];
            const units = ib.items.reduce((a, i) => a + i.qty_sent, 0);
            const rec = ib.items.reduce((a, i) => a + i.qty_received, 0);
            const dmg = ib.items.reduce((a, i) => a + i.qty_damaged, 0);
            const miss = ib.items.reduce((a, i) => a + i.qty_missing, 0);
            return (
              <li key={ib.id} className="space-y-2 rounded-xl bg-card p-3.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <p className="text-sm font-semibold">Envío N° {ib.number}</p>
                  <Badge tone={st.tone}>{st.label}</Badge>
                  {ib.ml_inbound_id ? <Badge tone="neutral">ML {ib.ml_inbound_id}</Badge> : <Badge tone="warning">Sin número de ML</Badge>}
                </div>
                <p className="text-xs text-muted-foreground">
                  {ib.stores?.name ?? "Sucursal"} · {formatInt(ib.items.length)} productos · {formatInt(units)} unidades · {formatInt(ib.boxes)}{" "}
                  {ib.boxes === 1 ? "bulto" : "bultos"}
                  {ib.scheduled_for ? ` · entrega ${fmtDate(ib.scheduled_for)}` : ""}
                  {ib.dispatched_at ? ` · despachado ${fmtDate(ib.dispatched_at)}` : ` · creado ${fmtDate(ib.created_at)}`}
                </p>
                {(rec > 0 || dmg > 0 || miss > 0) && (
                  <p className="text-xs">
                    Recibidas {formatInt(rec)} · dañadas {formatInt(dmg)}
                    {miss > 0 ? ` · faltaron ${formatInt(miss)}` : ""}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">Próximo paso: {nextStep(ib)}</p>
                {ib.cancel_reason && <p className="text-xs text-muted-foreground">Motivo: {ib.cancel_reason}</p>}
                <div className="flex flex-wrap gap-2">
                  {ib.status === "draft" && canManage && (
                    <Button size="sm" variant="secondary" onClick={() => setEdit(ib)}>
                      <Pencil size={15} /> Editar
                    </Button>
                  )}
                  {(ib.status === "draft" || OPEN_INBOUND.includes(ib.status)) && canManage && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setMlFor(ib);
                        setMlValue(ib.ml_inbound_id ?? "");
                      }}
                    >
                      <Hash size={15} /> {ib.ml_inbound_id ? "Cambiar número de ML" : "Cargar número de ML"}
                    </Button>
                  )}
                  {ib.status !== "cancelled" && (
                    <Button size="sm" variant="secondary" onClick={() => setLabels(ib)}>
                      <Printer size={15} /> Etiquetas
                    </Button>
                  )}
                  {ib.status === "draft" && canManage && (
                    <Button size="sm" onClick={() => setToDispatch(ib)} disabled={!ib.ml_inbound_id}>
                      <Truck size={15} /> Despachar
                    </Button>
                  )}
                  {OPEN_INBOUND.includes(ib.status) && (
                    <Button size="sm" onClick={() => setReceive(ib)}>
                      <ClipboardCheck size={15} /> Recepción
                    </Button>
                  )}
                  {(ib.status === "draft" || (ib.status === "in_transit" && rec + dmg === 0)) && canManage && (
                    <Button size="sm" variant="ghost" onClick={() => setToCancel(ib)}>
                      <XCircle size={15} /> Cancelar
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <MlFullInboundEditor
        open={Boolean(edit)}
        onOpenChange={(o) => !o && setEdit(null)}
        accountId={accountId}
        rows={rows}
        defaultStoreId={defaultStoreId}
        inbound={edit}
      />
      {labels && (
        <MlFullLabelsModal
          open
          onOpenChange={(o) => !o && setLabels(null)}
          inbound={live(labels.id) ?? labels}
          rows={rows}
          accountName={accountName}
          defaultFormat={labelFormat}
        />
      )}
      {receive && (
        <MlFullReceiveModal open onOpenChange={(o) => !o && setReceive(null)} inbound={live(receive.id) ?? receive} canClose={canManage} />
      )}

      <ConfirmDialog
        open={Boolean(toDispatch)}
        onOpenChange={(o) => !o && setToDispatch(null)}
        title={`Despachar el envío N° ${toDispatch?.number ?? ""}`}
        description="Se descuentan las unidades de tu stock y quedan En camino a Full. Ya no se venden en el mostrador. Si no alcanza el stock, el sistema te avisa y no despacha nada."
        confirmLabel="Despachar"
        loading={dispatch.isPending}
        onConfirm={() =>
          toDispatch &&
          dispatch.mutate(toDispatch.id, {
            onSuccess: (r) => {
              toast({ title: "Envío despachado", description: `${formatInt(r.units)} unidades en camino a Full.`, variant: "success" });
              setToDispatch(null);
            },
            onError: (e) => toast({ title: "No se pudo despachar", description: fullErrorMessage(e), variant: "error" }),
          })
        }
      />
      <ConfirmDialog
        open={Boolean(toCancel)}
        onOpenChange={(o) => !o && setToCancel(null)}
        title={`Cancelar el envío N° ${toCancel?.number ?? ""}`}
        description={
          toCancel?.status === "in_transit"
            ? "Todo vuelve al depósito de origen. Cancelalo también en Mercado Libre."
            : "El borrador se cancela; no toca el stock."
        }
        confirmLabel="Cancelar envío"
        cancelLabel="Volver"
        danger
        withReason={toCancel?.status === "in_transit"}
        reasonLabel="Motivo"
        loading={cancel.isPending}
        onConfirm={(reason?: string) =>
          toCancel &&
          cancel.mutate(
            { id: toCancel.id, reason: reason ?? "" },
            {
              onSuccess: () => {
                toast({ title: "Envío cancelado", variant: "success" });
                setToCancel(null);
              },
              onError: (e) => toast({ title: "No se pudo cancelar", description: fullErrorMessage(e), variant: "error" }),
            },
          )
        }
      />
      <Modal
        open={Boolean(mlFor)}
        onOpenChange={(o) => !o && setMlFor(null)}
        title="Número del envío en Mercado Libre"
        description="Lo ves en Mercado Libre, en Ventas › Full › Envíos, al crear el envío."
        footer={
          <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="secondary" onClick={() => setMlFor(null)}>
              Volver
            </Button>
            <Button
              disabled={!isValidMlInboundId(mlValue)}
              loading={setMl.isPending}
              onClick={() =>
                mlFor &&
                setMl.mutate(
                  { id: mlFor.id, mlInboundId: mlValue.trim(), boxes: null },
                  {
                    onSuccess: () => {
                      toast({ title: "Número guardado", variant: "success" });
                      setMlFor(null);
                    },
                    onError: (e) => toast({ title: "No se pudo guardar", description: fullErrorMessage(e), variant: "error" }),
                  },
                )
              }
            >
              Guardar
            </Button>
          </div>
        }
      >
        <Input label="Número de envío" value={mlValue} onChange={(e) => setMlValue(e.target.value)} autoFocus />
        <Callout tone="info" className="mt-3">
          La API de Mercado Libre no permite crear el envío desde otro sistema: se arma en Mercado Libre y acá se registra para
          seguirlo y conciliar lo recibido.
        </Callout>
      </Modal>
    </div>
  );
}
