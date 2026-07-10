"use client";

import { useEffect, useState } from "react";
import { Check, Pencil, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { useReturnReasons, useReturnReasonMutations } from "@/modules/sales/hooks";
import {
  STOCK_DESTINATIONS,
  type ReturnReason,
  type ReturnReasonInput,
  type StockDestination,
} from "@/modules/sales/api";

const inputCls =
  "h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm outline-none focus:border-ninja-flameSoft";

const emptyDraft: ReturnReasonInput = {
  label: "",
  code: null,
  stock_destination: "resale",
  sort: 0,
  is_active: true,
};

// Catálogo PRO de motivos de devolución. Tabla con Etiqueta / Código / Destino de
// stock / Orden / Estado. El destino define si el producto reingresa a la venta,
// va a depósito o se descarta (merma) al registrar la devolución.
export function ReturnReasonsModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { toast } = useToast();
  const { data: reasons } = useReturnReasons(false);
  const { create, update, setActive, remove } = useReturnReasonMutations();

  const [draft, setDraft] = useState<ReturnReasonInput>(emptyDraft);
  const [editId, setEditId] = useState<string | null>(null);
  const [edit, setEdit] = useState<ReturnReasonInput>(emptyDraft);

  useEffect(() => {
    if (!open) {
      setDraft(emptyDraft);
      setEditId(null);
    }
  }, [open]);

  function add() {
    if (draft.label.trim().length < 1) {
      toast({ title: "Poné una etiqueta para el motivo", variant: "error" });
      return;
    }
    create.mutate(
      { ...draft, sort: nextSort(reasons) },
      {
        onSuccess: () => setDraft(emptyDraft),
        onError: (e) => toast({ title: codeError(e), variant: "error" }),
      },
    );
  }

  function startEdit(r: ReturnReason) {
    setEditId(r.id);
    setEdit({
      label: r.label,
      code: r.code,
      stock_destination: r.stock_destination,
      sort: r.sort,
      is_active: r.is_active,
    });
  }

  function saveEdit() {
    if (!editId) return;
    if (edit.label.trim().length < 1) {
      toast({ title: "La etiqueta no puede quedar vacía", variant: "error" });
      return;
    }
    update.mutate(
      { id: editId, input: edit },
      {
        onSuccess: () => setEditId(null),
        onError: (e) => toast({ title: codeError(e), variant: "error" }),
      },
    );
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Motivos de devolución"
      description="El destino de stock de cada motivo define qué pasa con el producto al devolverlo."
      className="max-w-2xl"
    >
      <div className="space-y-4">
        {/* Tabla de motivos */}
        <div className="overflow-hidden rounded-lg border border-border">
          <div className="hidden grid-cols-[1fr_120px_150px_64px_92px] gap-2 border-b border-border bg-muted/40 px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground sm:grid">
            <span>Etiqueta</span>
            <span>Código</span>
            <span>Destino de stock</span>
            <span className="text-center">Orden</span>
            <span className="text-right">Estado</span>
          </div>

          <div className="max-h-[44vh] divide-y divide-border overflow-y-auto">
            {(reasons ?? []).length === 0 && (
              <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                Sin motivos. Agregá el primero abajo.
              </p>
            )}
            {(reasons ?? []).map((r) =>
              editId === r.id ? (
                <div
                  key={r.id}
                  className="grid grid-cols-2 gap-2 bg-ninja-flame/[0.04] px-3 py-2.5 sm:grid-cols-[1fr_120px_150px_64px_92px] sm:items-center"
                >
                  <input
                    className={inputCls}
                    value={edit.label}
                    onChange={(e) => setEdit((p) => ({ ...p, label: e.target.value }))}
                    placeholder="Etiqueta"
                  />
                  <input
                    className={inputCls}
                    value={edit.code ?? ""}
                    onChange={(e) => setEdit((p) => ({ ...p, code: e.target.value }))}
                    placeholder="código"
                  />
                  <select
                    className={inputCls}
                    value={edit.stock_destination}
                    onChange={(e) =>
                      setEdit((p) => ({ ...p, stock_destination: e.target.value as StockDestination }))
                    }
                  >
                    {STOCK_DESTINATIONS.map((d) => (
                      <option key={d.value} value={d.value}>
                        {d.label}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    className={`${inputCls} text-center tabular-nums`}
                    value={edit.sort}
                    onChange={(e) => setEdit((p) => ({ ...p, sort: Number(e.target.value) || 0 }))}
                  />
                  <div className="flex items-center justify-end gap-1">
                    <Switch
                      checked={edit.is_active}
                      onCheckedChange={(v) => setEdit((p) => ({ ...p, is_active: v }))}
                      label="Activo"
                    />
                  </div>
                  <div className="col-span-2 flex justify-end gap-1.5 sm:col-span-5">
                    <Button variant="ghost" className="h-8 px-2" onClick={() => setEditId(null)}>
                      <X size={15} /> Cancelar
                    </Button>
                    <Button className="h-8 px-2" loading={update.isPending} onClick={saveEdit}>
                      <Check size={15} /> Guardar
                    </Button>
                  </div>
                </div>
              ) : (
                <div
                  key={r.id}
                  className="grid grid-cols-2 items-center gap-2 px-3 py-2.5 text-sm sm:grid-cols-[1fr_120px_150px_64px_92px]"
                >
                  <span
                    className={
                      r.is_active
                        ? "min-w-0 truncate font-medium"
                        : "min-w-0 truncate text-muted-foreground line-through"
                    }
                  >
                    {r.label}
                  </span>
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {r.code ?? "—"}
                  </span>
                  <span className="truncate">
                    <DestinationBadge destination={r.stock_destination} />
                  </span>
                  <span className="text-center tabular-nums text-muted-foreground">{r.sort}</span>
                  <div className="flex items-center justify-end gap-1.5">
                    <Switch
                      checked={r.is_active}
                      onCheckedChange={(v) => setActive.mutate({ id: r.id, is_active: v })}
                      label="Activo"
                    />
                    <button
                      onClick={() => startEdit(r)}
                      title="Editar"
                      className="text-muted-foreground transition hover:text-foreground"
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      onClick={() => remove.mutate(r.id)}
                      title="Eliminar"
                      className="text-muted-foreground transition hover:text-destructive"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              ),
            )}
          </div>

          {/* Fila de alta */}
          <div className="grid grid-cols-2 gap-2 border-t border-border bg-muted/30 px-3 py-2.5 sm:grid-cols-[1fr_120px_150px_64px_92px] sm:items-center">
            <input
              className={inputCls}
              value={draft.label}
              onChange={(e) => setDraft((p) => ({ ...p, label: e.target.value }))}
              placeholder="Nuevo motivo"
              onKeyDown={(e) => {
                if (e.key === "Enter") add();
              }}
            />
            <input
              className={inputCls}
              value={draft.code ?? ""}
              onChange={(e) => setDraft((p) => ({ ...p, code: e.target.value }))}
              placeholder="código (opc.)"
            />
            <select
              className={inputCls}
              value={draft.stock_destination}
              onChange={(e) =>
                setDraft((p) => ({ ...p, stock_destination: e.target.value as StockDestination }))
              }
            >
              {STOCK_DESTINATIONS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
            <span className="hidden text-center text-xs text-muted-foreground sm:block">auto</span>
            <div className="flex justify-end">
              <Button className="h-9 w-full px-2 sm:w-auto" loading={create.isPending} onClick={add}>
                <Plus size={15} /> Agregar
              </Button>
            </div>
          </div>
        </div>

        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <RotateCcw size={13} className="mt-0.5 shrink-0" />
          <span>
            <strong>Vuelve a la venta</strong> reingresa el producto a stock vendible.{" "}
            <strong>A depósito</strong> lo saca del stock vendible. <strong>Pérdida/merma</strong> y{" "}
            <strong>a revisión</strong> no reingresan. Cada devolución queda auditada con su destino.
          </span>
        </p>
      </div>
    </Modal>
  );
}

function DestinationBadge({ destination }: { destination: StockDestination }) {
  const meta = STOCK_DESTINATIONS.find((d) => d.value === destination);
  const tone =
    destination === "resale"
      ? "bg-emerald-400/15 text-success"
      : destination === "warehouse"
        ? "bg-sky-400/15 text-info"
        : "bg-amber-400/15 text-warning";
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>
      {meta?.label ?? destination}
    </span>
  );
}

function nextSort(reasons: ReturnReason[] | undefined): number {
  const max = (reasons ?? []).reduce((m, r) => Math.max(m, r.sort), 0);
  return max + 10;
}

// La DB rechaza códigos duplicados por (tenant, code) con un error de unicidad.
function codeError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/duplicate|unique|uq_return_reasons/i.test(msg)) {
    return "Ya existe un motivo con ese código";
  }
  return "No se pudo guardar el motivo";
}
