"use client";

import { useState } from "react";
import { Shuffle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { getProfile, profileForVertical } from "@/lib/profiles/businessProfiles";
import { formatRelative } from "@/lib/utils/format";
import { useProfileContext } from "@/modules/profiles/hooks";
import { BusinessProfileModal } from "./BusinessProfileModal";

// Configuración → Rubro: perfil por rubro aplicado y "Cambiar rubro" (F5 ·
// ADR-075). Lo ve el dueño o encargado; sólo el dueño aplica (lo valida la RPC).
export function BusinessProfileCard() {
  const { tenant, applied, isOwner } = useProfileContext();
  const [open, setOpen] = useState(false);

  if (!tenant || !tenant.canManage) return null;
  const profile = getProfile(applied?.profile_key);

  return (
    <Card className="border-t-2 border-t-[var(--pos-solid)]">
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
              Perfil por rubro
            </p>
            {profile ? (
              <>
                <h3 className="mt-1 text-lg font-semibold text-foreground">{profile.label}</h3>
                <p className="text-sm text-muted-foreground">{profile.tagline}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Aplicado {formatRelative(applied?.applied_at)} · versión {applied?.profile_version}
                </p>
              </>
            ) : (
              <>
                <h3 className="mt-1 text-lg font-semibold text-foreground">Todavía no elegiste un perfil</h3>
                <p className="text-sm text-muted-foreground">
                  Un perfil prende las funciones que usa tu rubro (mesas, balanza, PLU, venta libre), sugiere
                  categorías y ajusta la pantalla de venta. No borra nada.
                </p>
              </>
            )}
          </div>
          {isOwner ? (
            <Button variant={profile ? "secondary" : "primary"} className="shrink-0" onClick={() => setOpen(true)}>
              <Shuffle size={16} /> {profile ? "Cambiar rubro" : "Elegir perfil"}
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground sm:max-w-[14rem]">
              Sólo el dueño del negocio puede cambiar el perfil.
            </p>
          )}
        </div>

        {profile && profile.tips.length > 0 && (
          <ul className="list-disc space-y-1 border-t border-border pl-5 pt-3 text-sm text-muted-foreground">
            {[...profile.tips, ...profile.shortcuts].map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        )}
      </CardContent>

      <BusinessProfileModal
        open={open}
        onOpenChange={setOpen}
        initialKey={profile?.key ?? profileForVertical(tenant.industry)}
      />
    </Card>
  );
}
