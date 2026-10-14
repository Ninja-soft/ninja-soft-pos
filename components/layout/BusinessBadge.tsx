"use client";

import { useMyTenant } from "@/modules/tenants/hooks";
import { useTenantTicketBranding } from "@/modules/tickets/hooks";
import { useBranchContext } from "@/modules/branches/hooks";
import { cn } from "@/lib/utils/cn";

// Negocio activo en la barra lateral y el encabezado mobile (ADR-124): logo de
// la marca (o la inicial) y el nombre para mostrar (fantasía, si no el de la
// cuenta). Sin negocio cargado todavía, no ocupa lugar.
export function BusinessBadge({ compact = false }: { compact?: boolean }) {
  const { data: tenant } = useMyTenant();
  const { data: brand } = useTenantTicketBranding(Boolean(tenant));
  const branches = useBranchContext();
  const name = tenant?.name ?? null;
  if (!name) return null;
  // En el encabezado mobile, con varias sucursales manda el chip de sucursal
  // (el negocio sigue a la vista en el menú lateral).
  if (compact && branches.isMulti) return null;
  return <BusinessBadgeView name={name} logo={brand?.logo_url ?? null} compact={compact} />;
}

export function BusinessBadgeView({ name, logo, compact = false }: { name: string; logo: string | null; compact?: boolean }) {
  return (
    <div
      className={cn("flex min-w-0 items-center gap-2", compact ? "flex-1" : "w-full px-2")}
      title={name}
      data-testid="business-badge"
    >
      <span
        className={cn(
          "grid shrink-0 place-items-center overflow-hidden rounded-md border border-border bg-muted text-xs font-bold text-muted-foreground",
          compact ? "h-6 w-6" : "h-7 w-7",
        )}
        aria-hidden
      >
        {logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logo} alt="" className="h-full w-full object-contain" />
        ) : (
          name.charAt(0).toUpperCase()
        )}
      </span>
      <span className="min-w-0 flex-1 leading-tight">
        {!compact && <span className="block text-[11px] text-muted-foreground">Negocio</span>}
        <span className="block truncate text-sm font-semibold text-foreground">{name}</span>
      </span>
    </div>
  );
}
