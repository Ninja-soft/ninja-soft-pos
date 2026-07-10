"use client";

import { useMemo, useState } from "react";
import { LayoutGrid, MapPin, Pencil, Plus, Trash2, Utensils } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import {
  useDiningAreas,
  useDiningTables,
  useAreaMutations,
  useTableMutations,
} from "@/modules/dining/hooks";
import type { DiningArea, DiningTable } from "@/modules/dining/api";

// ── Modal de salón (alta/edición) ──────────────────────────────────────────────
function AreaModal({
  open,
  onOpenChange,
  area,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  area: DiningArea | null;
}) {
  const { toast } = useToast();
  const { create, update } = useAreaMutations();
  const [name, setName] = useState("");

  function sync() {
    setName(area?.name ?? "");
  }

  async function save() {
    if (!name.trim()) {
      toast({ title: "Poné un nombre al salón", variant: "error" });
      return;
    }
    try {
      if (area) {
        await update.mutateAsync({ id: area.id, patch: { name: name.trim() } });
        toast({ title: "Salón actualizado", variant: "success" });
      } else {
        await create.mutateAsync({ name: name.trim() });
        toast({ title: "Salón agregado", variant: "success" });
      }
      onOpenChange(false);
    } catch (e) {
      toast({
        title: "No se pudo guardar",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (o) sync();
        onOpenChange(o);
      }}
      title={area ? "Editar salón" : "Nuevo salón"}
    >
      <div className="space-y-4">
        <Input
          label="Nombre del salón"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          placeholder="Ej. Salón principal, Terraza, Barra"
        />
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={save} loading={create.isPending || update.isPending}>
            {area ? "Guardar" : "Agregar"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ── Modal de mesa (alta/edición) ───────────────────────────────────────────────
function TableModal({
  open,
  onOpenChange,
  table,
  areas,
  defaultAreaId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  table: DiningTable | null;
  areas: DiningArea[];
  defaultAreaId: string | null;
}) {
  const { toast } = useToast();
  const { create, update } = useTableMutations();
  const [label, setLabel] = useState("");
  const [capacity, setCapacity] = useState("2");
  const [areaId, setAreaId] = useState<string>("");

  function sync() {
    setLabel(table?.label ?? "");
    setCapacity(table ? String(table.capacity) : "2");
    setAreaId(table?.area_id ?? defaultAreaId ?? "");
  }

  async function save() {
    if (!label.trim()) {
      toast({ title: "Poné un número o nombre de mesa", variant: "error" });
      return;
    }
    const cap = Number(capacity);
    const payload = {
      area_id: areaId || null,
      label: label.trim(),
      capacity: Number.isFinite(cap) && cap >= 0 ? Math.round(cap) : 2,
    };
    try {
      if (table) {
        await update.mutateAsync({ id: table.id, patch: payload });
        toast({ title: "Mesa actualizada", variant: "success" });
      } else {
        await create.mutateAsync(payload);
        toast({ title: "Mesa agregada", variant: "success" });
      }
      onOpenChange(false);
    } catch (e) {
      toast({
        title: "No se pudo guardar",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  const selectClass =
    "h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none transition focus:border-ninja-flameSoft focus:ring-4 focus:ring-ninja-flameSoft/15";

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (o) sync();
        onOpenChange(o);
      }}
      title={table ? "Editar mesa" : "Nueva mesa"}
    >
      <div className="space-y-4">
        <Input
          label="Número o nombre"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          autoFocus
          placeholder="Ej. 12, Barra 1, VIP"
        />
        <Input
          label="Capacidad (personas)"
          type="number"
          min="0"
          step="1"
          value={capacity}
          onChange={(e) => setCapacity(e.target.value)}
          placeholder="2"
        />
        <div>
          <label className="mb-1.5 block text-sm font-medium text-muted-foreground">
            Salón
          </label>
          <select
            value={areaId}
            onChange={(e) => setAreaId(e.target.value)}
            className={selectClass}
          >
            <option value="">Sin salón</option>
            {areas.map((a) => (
              <option key={a.id} value={a.id} className="bg-popover text-popover-foreground">
                {a.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={save} loading={create.isPending || update.isPending}>
            {table ? "Guardar" : "Agregar"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// Gestión de salones y mesas (F13 · H44). Alta/edición/baja de salones y mesas.
// Escritura RLS por tenant. Usado en Configuración → Salones y mesas.
export function SalonesManager() {
  const { toast } = useToast();
  const { data: areas, isLoading: areasLoading } = useDiningAreas();
  const { data: tables, isLoading: tablesLoading } = useDiningTables();
  const { remove: removeArea } = useAreaMutations();
  const { remove: removeTable } = useTableMutations();

  const [areaModal, setAreaModal] = useState(false);
  const [editingArea, setEditingArea] = useState<DiningArea | null>(null);
  const [tableModal, setTableModal] = useState(false);
  const [editingTable, setEditingTable] = useState<DiningTable | null>(null);
  const [newTableArea, setNewTableArea] = useState<string | null>(null);

  // Mesas agrupadas por salón (incl. "sin salón").
  const tablesByArea = useMemo(() => {
    const m = new Map<string | null, DiningTable[]>();
    for (const t of tables ?? []) {
      const k = t.area_id ?? null;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(t);
    }
    return m;
  }, [tables]);

  function openNewArea() {
    setEditingArea(null);
    setAreaModal(true);
  }
  function openNewTable(areaId: string | null) {
    setEditingTable(null);
    setNewTableArea(areaId);
    setTableModal(true);
  }

  async function delArea(a: DiningArea) {
    try {
      await removeArea.mutateAsync(a.id);
      toast({ title: "Salón eliminado", variant: "success" });
    } catch {
      toast({ title: "No se pudo eliminar el salón", variant: "error" });
    }
  }
  async function delTable(t: DiningTable) {
    try {
      await removeTable.mutateAsync(t.id);
      toast({ title: "Mesa eliminada", variant: "success" });
    } catch {
      toast({ title: "No se pudo eliminar la mesa", variant: "error" });
    }
  }

  const loading = areasLoading || tablesLoading;
  const areaList = areas ?? [];
  // Orden de bloques: cada salón + el bloque "sin salón" si tiene mesas.
  const blocks: { id: string | null; name: string }[] = [
    ...areaList.map((a) => ({ id: a.id as string | null, name: a.name })),
    ...(tablesByArea.has(null) ? [{ id: null, name: "Sin salón" }] : []),
  ];

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-semibold">
          <MapPin size={16} className="text-ninja-flameSoft" /> Salones
        </span>
        <Button size="sm" variant="secondary" onClick={openNewArea}>
          <Plus size={15} /> Nuevo salón
        </Button>
      </div>

      {loading ? (
        <p className="py-4 text-sm text-muted-foreground">Cargando…</p>
      ) : blocks.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-5 text-center">
          <Utensils size={26} className="mx-auto mb-2 text-ninja-flameSoft" />
          <p className="text-sm text-muted-foreground">
            Creá tu primer salón (ej. Salón principal, Terraza) y después cargá sus
            mesas.
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          {blocks.map((block) => {
            const area = areaList.find((a) => a.id === block.id) ?? null;
            const blockTables = tablesByArea.get(block.id) ?? [];
            return (
              <div
                key={block.id ?? "none"}
                className="rounded-xl border border-border bg-card p-4"
              >
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-2 font-semibold text-foreground">
                    <LayoutGrid size={15} className="text-ninja-flameSoft" />
                    {block.name}
                    <span className="text-xs font-normal text-muted-foreground">
                      ({blockTables.length} {blockTables.length === 1 ? "mesa" : "mesas"})
                    </span>
                  </span>
                  <div className="flex items-center gap-1">
                    <Button size="sm" variant="ghost" onClick={() => openNewTable(block.id)}>
                      <Plus size={14} /> Mesa
                    </Button>
                    {area && (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingArea(area);
                            setAreaModal(true);
                          }}
                          className="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                          aria-label="Editar salón"
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          type="button"
                          onClick={() => delArea(area)}
                          className="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-danger"
                          aria-label="Eliminar salón"
                        >
                          <Trash2 size={14} />
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {blockTables.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-border p-3 text-center text-xs text-muted-foreground">
                    Sin mesas en este salón.
                  </p>
                ) : (
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {blockTables.map((t) => (
                      <div
                        key={t.id}
                        className="flex items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 py-2"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-foreground">
                            {t.label}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {t.capacity} pers.
                          </span>
                        </span>
                        <span className="flex shrink-0 items-center gap-0.5">
                          <button
                            type="button"
                            onClick={() => {
                              setEditingTable(t);
                              setTableModal(true);
                            }}
                            className="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                            aria-label="Editar mesa"
                          >
                            <Pencil size={14} />
                          </button>
                          <button
                            type="button"
                            onClick={() => delTable(t)}
                            className="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-danger"
                            aria-label="Eliminar mesa"
                          >
                            <Trash2 size={14} />
                          </button>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <AreaModal open={areaModal} onOpenChange={setAreaModal} area={editingArea} />
      <TableModal
        open={tableModal}
        onOpenChange={setTableModal}
        table={editingTable}
        areas={areaList}
        defaultAreaId={newTableArea}
      />
    </div>
  );
}
