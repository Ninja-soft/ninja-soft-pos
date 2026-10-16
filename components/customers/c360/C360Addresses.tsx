"use client";

import { useState } from "react";
import { MapPin, Plus, Star, Trash2 } from "lucide-react";
import { AddressAutocomplete } from "@/components/geo/AddressAutocomplete";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { addressProblem, addressServerError, formatShipTo, GEO_QUALITY_LABEL, type CustomerAddress, type GeoAddress } from "@/lib/geo/address";
import { useCustomerAddresses, useCustomerAddressMutations } from "@/modules/geo/api";
import { useFeature } from "@/modules/saas/gating";

// Direcciones de entrega del cliente (ADR-157): varias, una predeterminada,
// con autocompletar y mapa. Son las que ofrece la pestaña Envío del cobro.
export function C360Addresses({ customerId }: { customerId: string }) {
  const { toast } = useToast();
  const feature = useFeature("direcciones_geo");
  const { data, isLoading } = useCustomerAddresses(customerId, feature !== false);
  const m = useCustomerAddressMutations(customerId);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<GeoAddress | null>(null);
  const [label, setLabel] = useState("");
  const [deleting, setDeleting] = useState<CustomerAddress | null>(null);

  if (feature === false) return null;
  const list = data ?? [];
  const fail = (e: unknown) =>
    toast({
      title: "No se pudo guardar",
      description: addressServerError(e instanceof Error ? e.message : String(e)) ?? undefined,
      variant: "error",
    });

  async function save() {
    const problem = addressProblem(draft);
    if (problem || !draft) {
      toast({ title: problem ?? "Cargá la dirección", variant: "error" });
      return;
    }
    try {
      await m.save.mutateAsync({ id: null, data: { ...draft, label: label.trim() || null } });
      toast({ title: "Dirección guardada", variant: "success" });
      setAdding(false);
    } catch (e) {
      fail(e);
    }
  }

  return (
    <section className="rounded-xl border border-border bg-card p-4" aria-labelledby="c360-addresses">
      <div className="flex items-center justify-between gap-2">
        <h2 id="c360-addresses" className="flex items-center gap-2 text-sm font-semibold">
          <MapPin size={15} className="text-muted-foreground" aria-hidden /> Direcciones de entrega
        </h2>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            setDraft(null);
            setLabel("");
            setAdding(true);
          }}
        >
          <Plus size={15} aria-hidden /> Agregar
        </Button>
      </div>
      {isLoading ? (
        <p className="mt-3 text-xs text-muted-foreground">Cargando…</p>
      ) : list.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Sin direcciones de entrega. Se guardan solas al cobrar un envío o las podés agregar acá.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {list.map((a) => (
            <li key={a.id} className="flex items-start justify-between gap-3 rounded-lg bg-muted/40 px-3 py-2.5">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">
                  {a.label ? `${a.label} · ` : ""}
                  {formatShipTo(a)}
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  {a.is_default && <Badge tone="brand">Predeterminada</Badge>}
                  <Badge tone={a.geo_quality === "exacta" ? "success" : a.geo_quality === "calle" ? "info" : "warning"}>
                    {GEO_QUALITY_LABEL[a.geo_quality]}
                  </Badge>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                {!a.is_default && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 px-2"
                    aria-label="Hacer predeterminada"
                    title="Hacer predeterminada"
                    loading={m.save.isPending && m.save.variables?.id === a.id}
                    onClick={() => m.save.mutateAsync({ id: a.id, data: { ...a, is_default: true } }).catch(fail)}
                  >
                    <Star size={15} aria-hidden />
                  </Button>
                )}
                <Button size="sm" variant="ghost" className="h-8 px-2" aria-label="Borrar dirección" onClick={() => setDeleting(a)}>
                  <Trash2 size={15} aria-hidden />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Modal open={adding} onOpenChange={setAdding} title="Nueva dirección de entrega">
        <div className="space-y-3">
          <AddressAutocomplete value={draft} onChange={setDraft} autoFocus />
          <Input label="Nombre (opcional)" placeholder="Casa, Depósito, Obra Pilar" value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} />
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={() => setAdding(false)}>
              Cancelar
            </Button>
            <Button onClick={save} loading={m.save.isPending} disabled={!draft}>
              Guardar
            </Button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="¿Borrar la dirección?"
        description={deleting ? formatShipTo(deleting) : undefined}
        confirmLabel="Borrar"
        danger
        loading={m.remove.isPending}
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await m.remove.mutateAsync(deleting.id);
            setDeleting(null);
          } catch (e) {
            fail(e);
          }
        }}
      />
    </section>
  );
}
C360Addresses.displayName = "C360Addresses";
