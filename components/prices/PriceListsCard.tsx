"use client";

import { useState } from "react";
import { BadgeDollarSign, Pencil, Plus, Trash2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { Heading } from "@/components/ui/Typography";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useMyTenant } from "@/modules/tenants/hooks";
import {
  usePriceLists,
  usePriceListMutations,
} from "@/modules/prices/hooks";
import {
  PRICE_CHANNELS,
  type PriceChannel,
  type PriceList,
} from "@/modules/prices/api";
import { PriceListEditorModal } from "@/components/prices/PriceListEditorModal";
import { FeatureGate } from "@/components/saas/FeatureGate";

const CHANNEL_LABELS: Record<string, string> = Object.fromEntries(
  PRICE_CHANNELS.map((c) => [c.value, c.label]),
);

export function PriceListsCard() {
  const { toast } = useToast();
  const { data: myTenant } = useMyTenant();
  const tenantId = myTenant?.tenantId;
  const { data: lists } = usePriceLists();
  const { create, update, remove } = usePriceListMutations(tenantId);

  const [name, setName] = useState("");
  const [channel, setChannel] = useState<PriceChannel>("mostrador");
  const [adjustment, setAdjustment] = useState("");

  const [editing, setEditing] = useState<PriceList | null>(null);
  const [toDelete, setToDelete] = useState<PriceList | null>(null);

  const inputCls =
    "h-10 rounded-lg border border-input bg-background px-2 text-sm outline-none focus:border-ninja-flameSoft";

  // Canales no-custom ya ocupados (una lista activa por canal): se deshabilitan.
  const takenChannels = new Set(
    (lists ?? []).filter((l) => l.channel !== "custom").map((l) => l.channel),
  );

  function add() {
    if (!tenantId) return;
    if (name.trim().length < 1) {
      toast({ title: "Poné un nombre", variant: "error" });
      return;
    }
    const pct = adjustment.trim() === "" ? null : Number(adjustment);
    if (pct != null && !Number.isFinite(pct)) {
      toast({ title: "Ajuste % inválido", variant: "error" });
      return;
    }
    create.mutate(
      { name: name.trim(), channel, adjustment_pct: pct },
      {
        onSuccess: () => {
          setName("");
          setAdjustment("");
          toast({ title: "Lista creada", variant: "success" });
        },
        onError: () =>
          toast({
            title: "No se pudo crear",
            description: "¿Ya existe una lista activa para ese canal?",
            variant: "error",
          }),
      },
    );
  }

  function confirmDelete() {
    if (!toDelete) return;
    remove.mutate(toDelete.id, {
      onSuccess: () => {
        toast({ title: "Lista eliminada", variant: "success" });
        setToDelete(null);
      },
      onError: () => toast({ title: "No se pudo eliminar", variant: "error" }),
    });
  }

  return (
    <Card>
      <CardContent className="space-y-5 p-6">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-lg bg-ninja-flame/12 text-ninja-flameSoft">
            <BadgeDollarSign size={18} />
          </span>
          <div>
            <Heading as="h3" className="text-base">
              Listas de precios
            </Heading>
            <p className="text-sm text-muted-foreground">
              Precios por canal (mostrador, catálogo, mayorista). Ajuste % global
              o precio puntual por producto/variante.
            </p>
          </div>
        </div>

        {/* Nueva lista */}
        <div className="rounded-lg border border-border p-3">
          <div className="grid gap-2 sm:grid-cols-3">
            <label className="text-xs text-muted-foreground">
              Nombre
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Precios mayorista"
                className={`${inputCls} mt-1 w-full`}
              />
            </label>
            <label className="text-xs text-muted-foreground">
              Canal
              <select
                value={channel}
                onChange={(e) => setChannel(e.target.value as PriceChannel)}
                className={`${inputCls} mt-1 w-full`}
              >
                {PRICE_CHANNELS.map((c) => {
                  const disabled = c.value !== "custom" && takenChannels.has(c.value);
                  return (
                    <option key={c.value} value={c.value} disabled={disabled}>
                      {c.label}
                      {disabled ? " (ya existe)" : ""}
                    </option>
                  );
                })}
              </select>
            </label>
            <label className="text-xs text-muted-foreground">
              Ajuste % (opcional)
              <input
                value={adjustment}
                onChange={(e) => setAdjustment(e.target.value)}
                type="number"
                step="0.01"
                placeholder="Ej. -10 ó 25"
                className={`${inputCls} mt-1 w-full`}
              />
            </label>
          </div>
          <div className="mt-2 flex justify-end">
            <FeatureGate feature="listas_precios" featureLabel="Listas de precios">
              <Button onClick={add} loading={create.isPending} disabled={!tenantId}>
                <Plus size={15} /> Nueva lista
              </Button>
            </FeatureGate>
          </div>
        </div>

        {/* Tabla de listas */}
        <div className="space-y-1.5">
          {(lists ?? []).length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Sin listas de precios. Creá la primera.
            </p>
          )}
          {(lists ?? []).map((l) => (
            <div
              key={l.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5 text-sm"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate font-medium">{l.name}</span>
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                  {CHANNEL_LABELS[l.channel] ?? l.channel}
                </span>
                {l.adjustment_pct != null && (
                  <span className="rounded-full bg-ninja-flame/12 px-2 py-0.5 text-xs font-medium text-ninja-flameSoft">
                    {Number(l.adjustment_pct) > 0 ? "+" : ""}
                    {l.adjustment_pct}%
                  </span>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <Switch
                  checked={l.is_active}
                  onCheckedChange={(v) =>
                    update.mutate({ id: l.id, patch: { is_active: v } })
                  }
                  label="Activa"
                />
                <button
                  type="button"
                  title="Editar precios"
                  aria-label="Editar precios"
                  onClick={() => setEditing(l)}
                  className="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                >
                  <Pencil size={15} />
                </button>
                <button
                  type="button"
                  title="Eliminar"
                  aria-label="Eliminar"
                  onClick={() => setToDelete(l)}
                  className="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-destructive"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </CardContent>

      <PriceListEditorModal
        list={editing}
        tenantId={tenantId}
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
      />

      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(o) => !o && setToDelete(null)}
        title="Eliminar lista de precios"
        description={
          toDelete
            ? `¿Eliminar la lista "${toDelete.name}"? Es una baja lógica.`
            : undefined
        }
        confirmLabel="Eliminar"
        danger
        loading={remove.isPending}
        onConfirm={confirmDelete}
      />
    </Card>
  );
}
