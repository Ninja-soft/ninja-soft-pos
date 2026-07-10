"use client";

import { useState } from "react";
import { Package, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { formatCurrency } from "@/lib/utils/format";
import { useProducts } from "@/modules/products/hooks";
import {
  useServicePacks,
  useServicePackMutations,
} from "@/modules/packs/hooks";
import type { ServicePack } from "@/modules/packs/api";

function PackModal({
  open,
  onOpenChange,
  pack,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  pack: ServicePack | null;
}) {
  const { toast } = useToast();
  const { create, update } = useServicePackMutations();
  // Productos del tenant para elegir el servicio que el pack cubre (opcional).
  const { data: products } = useProducts("");
  const [name, setName] = useState("");
  const [productId, setProductId] = useState<string>("");
  const [sessions, setSessions] = useState("");
  const [price, setPrice] = useState("");
  const [validityDays, setValidityDays] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [notes, setNotes] = useState("");

  function sync() {
    setName(pack?.name ?? "");
    setProductId(pack?.product_id ?? "");
    setSessions(pack?.sessions != null ? String(pack.sessions) : "");
    setPrice(pack?.price != null ? String(pack.price) : "");
    setValidityDays(pack?.validity_days != null ? String(pack.validity_days) : "");
    setIsActive(pack?.is_active ?? true);
    setNotes(pack?.notes ?? "");
  }

  async function save() {
    if (!name.trim()) {
      toast({ title: "Poné un nombre", variant: "error" });
      return;
    }
    const n = Number(sessions);
    if (!Number.isInteger(n) || n <= 0) {
      toast({ title: "Las sesiones deben ser un entero mayor a 0", variant: "error" });
      return;
    }
    const p = Number(price);
    if (!Number.isFinite(p) || p < 0) {
      toast({ title: "Precio inválido", variant: "error" });
      return;
    }
    const v = validityDays.trim() === "" ? null : Number(validityDays);
    if (v != null && (!Number.isInteger(v) || v <= 0)) {
      toast({ title: "La validez debe ser un entero de días mayor a 0 (o vacío)", variant: "error" });
      return;
    }
    const payload = {
      name: name.trim(),
      product_id: productId || null,
      sessions: n,
      price: p,
      validity_days: v,
      is_active: isActive,
      notes: notes.trim() || null,
    };
    try {
      if (pack) {
        await update.mutateAsync({ id: pack.id, patch: payload });
        toast({ title: "Paquete actualizado", variant: "success" });
      } else {
        await create.mutateAsync(payload);
        toast({ title: "Paquete creado", variant: "success" });
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
      title={pack ? "Editar paquete" : "Nuevo paquete"}
      description="Un pack acredita sesiones al cliente al comprarlo; cada visita consume una."
    >
      <div className="space-y-4">
        <Input
          label="Nombre"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          placeholder="Ej. 4 cortes, 10 sesiones de estética"
        />
        <div>
          <label className="mb-2 block text-sm font-medium text-muted-foreground">
            Servicio que cubre (opcional)
          </label>
          <select
            value={productId}
            onChange={(e) => setProductId(e.target.value)}
            className="h-11 w-full rounded-lg border border-input bg-background px-4 text-sm text-foreground outline-none focus:border-ninja-flameSoft focus:ring-4 focus:ring-ninja-flameSoft/15"
          >
            <option value="">Genérico (cualquier servicio)</option>
            {(products ?? []).map((p) => (
              <option key={p.id} value={p.id} className="bg-popover text-popover-foreground">
                {p.name}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-muted-foreground">
            Si elegís un servicio, el POS ofrece usar una sesión sólo cuando se
            cobra ese servicio. Genérico = sirve para cualquier línea.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Sesiones"
            type="number"
            step="1"
            min="1"
            value={sessions}
            onChange={(e) => setSessions(e.target.value)}
            placeholder="Ej. 4"
          />
          <Input
            label="Precio del pack"
            type="number"
            step="0.01"
            min="0"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="Ej. 16000"
          />
        </div>
        <Input
          label="Validez en días (opcional)"
          type="number"
          step="1"
          min="1"
          value={validityDays}
          onChange={(e) => setValidityDays(e.target.value)}
          placeholder="Vacío = sin vencimiento"
        />
        <Input
          label="Notas (opcional)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Condiciones, observaciones…"
        />
        <label className="flex items-center justify-between gap-2 text-sm">
          <span>Activo (disponible para vender)</span>
          <Switch checked={isActive} onCheckedChange={setIsActive} label="Activo" />
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={save} loading={create.isPending || update.isPending}>
            {pack ? "Guardar" : "Crear"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// Gestión de paquetes (packs de sesiones): alta/edición/baja. El saldo por
// cliente se acredita al vender el pack en el POS y se consume al cobrar el
// servicio cubierto. Sólo escritura RLS-permitida (la policy de service_packs
// acota por tenant; la UI no es la única barrera).
export function ServicePacksManager() {
  const { toast } = useToast();
  const { data: packs, isLoading } = useServicePacks();
  const { remove } = useServicePackMutations();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<ServicePack | null>(null);

  function openNew() {
    setEditing(null);
    setModalOpen(true);
  }
  function openEdit(p: ServicePack) {
    setEditing(p);
    setModalOpen(true);
  }

  async function del(p: ServicePack) {
    try {
      await remove.mutateAsync(p.id);
      toast({ title: "Paquete eliminado", variant: "success" });
    } catch {
      toast({ title: "No se pudo eliminar", variant: "error" });
    }
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-semibold">
          <Package size={16} className="text-ninja-flameSoft" /> Paquetes de sesiones
        </span>
        <Button size="sm" variant="secondary" onClick={openNew}>
          <Plus size={15} /> Nuevo paquete
        </Button>
      </div>

      {isLoading ? (
        <p className="py-4 text-sm text-muted-foreground">Cargando…</p>
      ) : (packs ?? []).length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
          Sin paquetes. Creá bonos de sesiones (ej. &quot;4 cortes&quot;, &quot;10
          sesiones de estética&quot;) para venderlos y que el cliente los use en
          sus próximas visitas.
        </p>
      ) : (
        <div className="space-y-2">
          {packs!.map((p) => (
            <div
              key={p.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-foreground">
                  {p.name}
                  {!p.is_active && (
                    <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground">
                      inactivo
                    </span>
                  )}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {p.sessions} {p.sessions === 1 ? "sesión" : "sesiones"} ·{" "}
                  {formatCurrency(p.price)}
                  {p.validity_days != null
                    ? ` · vence a los ${p.validity_days} días`
                    : " · sin vencimiento"}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => openEdit(p)}
                  className="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                  aria-label="Editar"
                >
                  <Pencil size={15} />
                </button>
                <button
                  type="button"
                  onClick={() => del(p)}
                  className="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-danger"
                  aria-label="Eliminar"
                >
                  <Trash2 size={15} />
                </button>
              </span>
            </div>
          ))}
        </div>
      )}

      <PackModal open={modalOpen} onOpenChange={setModalOpen} pack={editing} />
    </div>
  );
}
