"use client";

import { useRef, useState } from "react";
import { ImagePlus, Layers, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { SettingsCard } from "@/components/settings/Settings";
import { BranchDot } from "@/components/branches/BranchSwitcher";
import { useBranchContext, useBranchScope } from "@/modules/branches/hooks";
import {
  useInheritanceFlags,
  useStoreGroupMap,
  useStoreGroupMutations,
  useStoreGroups,
  useStoreLogo,
  useStoreLogoMutations,
} from "@/modules/config/hooks";
import { useTenantTicketBranding } from "@/modules/tickets/hooks";

// Logo propio de una sucursal (F17 · ADR-049). Opcional: sin logo, la
// sucursal usa el del negocio en tickets, remitos y pantalla del cliente.
export function BranchLogoField({ storeId }: { storeId: string }) {
  const logo = useStoreLogo(storeId);
  const { data: tenantBrand } = useTenantTicketBranding();
  const mut = useStoreLogoMutations();
  const { toast } = useToast();
  const input = useRef<HTMLInputElement>(null);
  const shown = logo ?? tenantBrand?.logo_url ?? null;

  const onFile = (file: File | undefined) => {
    if (!file) return;
    if (!/^image\/(png|jpe?g|webp|svg\+xml)$/.test(file.type)) {
      return toast({ title: "Usá una imagen PNG, JPG, WEBP o SVG", variant: "error" });
    }
    if (file.size > 1_000_000) return toast({ title: "La imagen pesa más de 1 MB", variant: "error" });
    mut.upload.mutate(
      { storeId, file },
      {
        onSuccess: () => toast({ title: "Logo de la sucursal actualizado", variant: "success" }),
        onError: () => toast({ title: "No se pudo subir el logo", variant: "error" }),
      },
    );
  };

  return (
    <SettingsCard title="Logo de la sucursal" description="Sale en el ticket, el remito y la pantalla del cliente de esta sucursal.">
      <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
        <div className="flex h-16 w-32 items-center justify-center rounded-lg bg-muted">
          {shown ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={shown} alt="Logo" className="max-h-14 max-w-28 object-contain" />
          ) : (
            <span className="text-xs text-muted-foreground">Sin logo</span>
          )}
        </div>
        <div className="flex flex-1 flex-col gap-2">
          {logo ? <Badge tone="brand">Personalizado</Badge> : <Badge tone="neutral">Heredado del negocio</Badge>}
          <div className="flex flex-wrap gap-2">
            <input
              ref={input}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              className="hidden"
              onChange={(e) => onFile(e.target.files?.[0])}
            />
            <Button size="sm" variant="secondary" disabled={mut.upload.isPending} onClick={() => input.current?.click()}>
              <ImagePlus size={14} /> {logo ? "Cambiar" : "Subir logo propio"}
            </Button>
            {logo && (
              <Button size="sm" variant="ghost" disabled={mut.clear.isPending} onClick={() => mut.clear.mutate(storeId)}>
                <Trash2 size={14} /> Volver al del negocio
              </Button>
            )}
          </div>
        </div>
      </div>
    </SettingsCard>
  );
}

// Grupos de sucursales (zona o región): un nivel de herencia entre el negocio
// y la sucursal ("todas las del interior con recargo 0").
export function StoreGroupsCard() {
  const ctx = useBranchContext();
  const scope = useBranchScope();
  const flags = useInheritanceFlags();
  const { data: groups } = useStoreGroups();
  const { data: groupMap } = useStoreGroupMap();
  const mut = useStoreGroupMutations();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const canManage = scope.data?.role === "owner" || scope.data?.role === "manager";
  if (!ctx.isMulti || !canManage || !flags.multiStore) return null;
  const live = (groups ?? []).filter((g) => !g.deleted_at);

  return (
    <SettingsCard
      icon={Layers}
      title="Grupos de sucursales"
      description="Zonas o regiones que comparten configuración. La sucursal hereda del grupo y el grupo del negocio."
    >
      <div className="flex flex-col gap-2 px-5 py-3 sm:flex-row">
        <Input placeholder="Ej. Interior, Shoppings" value={name} onChange={(e) => setName(e.target.value)} />
        <Button
          variant="secondary"
          disabled={!name.trim() || mut.create.isPending}
          onClick={() =>
            mut.create.mutate(
              { name: name.trim(), color: null },
              {
                onSuccess: () => setName(""),
                onError: () => toast({ title: "No se pudo crear el grupo (¿nombre repetido?)", variant: "error" }),
              },
            )
          }
        >
          <Plus size={14} /> Crear grupo
        </Button>
      </div>
      {live.map((g) => (
        <div key={g.id} className="flex flex-col gap-2 px-5 py-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">{g.name}</p>
            <Button size="sm" variant="ghost" onClick={() => mut.archive.mutate(g.id)} aria-label={`Archivar ${g.name}`}>
              <Trash2 size={13} />
            </Button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {ctx.allowed.map((b) => {
              const inGroup = groupMap?.[b.id] === g.id;
              return (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => mut.assign.mutate({ storeId: b.id, groupId: inGroup ? null : g.id })}
                  className={
                    inGroup
                      ? "flex items-center gap-1.5 rounded-md bg-ninja-flame/15 px-3 py-1 text-xs font-medium"
                      : "flex items-center gap-1.5 rounded-md bg-muted px-3 py-1 text-xs text-muted-foreground hover:text-foreground"
                  }
                >
                  <BranchDot branch={b} /> {b.name}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </SettingsCard>
  );
}
