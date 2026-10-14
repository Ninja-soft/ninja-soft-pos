"use client";

import { Card, CardContent } from "@/components/ui/Card";
import { SkeletonLines } from "@/components/ui/Skeleton";
import { getProfile } from "@/lib/profiles/businessProfiles";
import { formatRelative } from "@/lib/utils/format";
import { useTenantProfile } from "@/modules/profiles/hooks";

// Panel interno: perfil por rubro aplicado al negocio (F5 · ADR-075). Sólo
// lectura: el perfil lo elige el dueño desde su Configuración. La lectura pasa
// por RLS con internal_scope() (ADR-052).
export function TenantProfileCard({ tenantId }: { tenantId: string }) {
  const { data, isLoading, isError } = useTenantProfile(tenantId);
  const profile = getProfile(data?.profile_key);
  const previous = getProfile(data?.previous_key);

  return (
    <Card>
      <CardContent className="p-5">
        <p className="mb-2 text-sm font-medium text-muted-foreground">Perfil por rubro</p>
        {isLoading ? (
          <SkeletonLines lines={2} />
        ) : isError ? (
          <p className="text-sm text-muted-foreground">No se pudo leer el perfil.</p>
        ) : !data ? (
          <p className="text-sm text-muted-foreground">Sin perfil aplicado.</p>
        ) : (
          <>
            <p className="text-base font-semibold text-foreground">{profile?.label ?? data.profile_key}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Versión {data.profile_version} · aplicado {formatRelative(data.applied_at)}
              {data.previous_key ? ` · antes: ${previous?.label ?? data.previous_key}` : ""}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
