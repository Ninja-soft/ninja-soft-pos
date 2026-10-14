"use client";

import { useState } from "react";
import Link from "next/link";
import { Bot, Gift, Puzzle, Settings2, Sparkles, Store, TriangleAlert } from "lucide-react";
import { AiConfigCard } from "@/components/internal/AiConfigCard";
import { PageHeader, SectionHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { EmptyState } from "@/components/ui/EmptyState";
import { Modal } from "@/components/ui/Modal";
import { Skeleton } from "@/components/ui/Skeleton";
import { AI_ASSISTANT_ADDON_KEY, useAddonCatalog } from "@/modules/internal/hooks";
import type { AddonCatalogItem } from "@/modules/internal/api";
import { formatCurrency, formatInt } from "@/lib/utils/format";

// Addons con pantalla de configuración propia (se abre en el modal).
const CONFIGURABLE: Record<string, { title: string; description: string }> = {
  [AI_ASSISTANT_ADDON_KEY]: {
    title: "Asistente IA",
    description:
      "Un proveedor a la vez (Gemini o Claude), cada uno con su API key. La key se guarda cifrada y nunca se vuelve a mostrar.",
  },
};

function addonIcon(key: string) {
  return key === AI_ASSISTANT_ADDON_KEY ? Bot : Puzzle;
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-base font-semibold tabular-nums text-foreground">{value}</dd>
      {sub && <dd className="text-xs text-muted-foreground">{sub}</dd>}
    </div>
  );
}

function AddonCard({ addon, onConfigure }: { addon: AddonCatalogItem; onConfigure?: () => void }) {
  const Icon = addonIcon(addon.key);
  const paid = addon.activeTenants - addon.grantedTenants;
  return (
    <Card className="flex min-w-0 flex-col p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-ninja-flame/10 text-ninja-flameSoft"
        >
          <Icon size={20} strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="min-w-0 truncate text-base font-bold tracking-tight text-foreground">{addon.label}</h3>
            {addon.isActive ? <Badge tone="success">Disponible</Badge> : <Badge>No disponible</Badge>}
          </div>
          <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{addon.key}</p>
        </div>
      </div>

      <p className="mt-3 line-clamp-3 text-sm text-muted-foreground">
        {addon.description?.trim() || "Sin descripción cargada."}
      </p>

      <dl className="mt-4 grid grid-cols-2 gap-3 rounded-lg bg-muted/50 p-3">
        <Stat
          label="Precio por mes"
          value={addon.monthlyPrice > 0 ? formatCurrency(addon.monthlyPrice) : "Sin cargo"}
        />
        <Stat
          label="Negocios"
          value={formatInt(addon.activeTenants)}
          sub={
            [
              paid > 0 ? `${formatInt(paid)} pagos` : null,
              addon.grantedTenants > 0 ? `${formatInt(addon.grantedTenants)} bonificados` : null,
            ]
              .filter(Boolean)
              .join(" · ") || undefined
          }
        />
      </dl>

      <div className="mt-4 flex flex-1 flex-wrap items-end gap-2">
        {onConfigure ? (
          <Button size="sm" onClick={onConfigure} className="w-full sm:w-auto">
            <Settings2 size={15} /> Configurar
          </Button>
        ) : (
          <p className="text-xs text-muted-foreground">Sin configuración global. Se activa desde la ficha de cada negocio.</p>
        )}
      </div>
    </Card>
  );
}

function AddonCardSkeleton() {
  return (
    <Card className="p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <Skeleton className="h-10 w-10 rounded-lg" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      </div>
      <Skeleton className="mt-4 h-10 w-full" />
      <Skeleton className="mt-4 h-16 w-full rounded-lg" />
      <Skeleton className="mt-4 h-9 w-28" />
    </Card>
  );
}

export default function InternalAddonsPage() {
  const { data: addons = [], isLoading, isError, refetch } = useAddonCatalog();
  const [configKey, setConfigKey] = useState<string | null>(null);
  const config = configKey ? CONFIGURABLE[configKey] : null;

  const totalTenants = addons.reduce((acc, a) => acc + a.activeTenants, 0);
  const totalGranted = addons.reduce((acc, a) => acc + a.grantedTenants, 0);

  return (
    <>
      <PageHeader
        eyebrow="Plataforma"
        title="Complementos"
        icon={Sparkles}
        description={
          <>
            Lo que los negocios contratan aparte de su plan: precio, disponibilidad y
            cuántos negocios lo tienen. Desde acá configurás cada complemento.
          </>
        }
      />

      <section className="mt-8">
        <SectionHeader
          title="Catálogo"
          icon={Puzzle}
          description={
            isLoading || isError
              ? "Complementos que se pueden sumar a cualquier plan."
              : `${formatInt(addons.length)} complementos · ${formatInt(totalTenants)} activaciones (${formatInt(totalGranted)} bonificadas).`
          }
        />

        {isError ? (
          <Callout tone="danger" icon={TriangleAlert} className="mt-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span>No se pudo cargar el catálogo de complementos.</span>
              <Button size="sm" variant="secondary" onClick={() => refetch()}>
                Reintentar
              </Button>
            </div>
          </Callout>
        ) : (
          <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {isLoading ? (
              <>
                <AddonCardSkeleton />
                <AddonCardSkeleton />
              </>
            ) : addons.length === 0 ? (
              <Card className="md:col-span-2 xl:col-span-3">
                <EmptyState
                  icon={Puzzle}
                  title="Todavía no hay complementos"
                  description="Cuando se cargue uno en el catálogo va a aparecer acá con su precio y los negocios que lo tienen."
                />
              </Card>
            ) : (
              addons.map((a) => (
                <AddonCard
                  key={a.id}
                  addon={a}
                  onConfigure={CONFIGURABLE[a.key] ? () => setConfigKey(a.key) : undefined}
                />
              ))
            )}
          </div>
        )}

        <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <Gift size={14} aria-hidden /> Para bonificar un complemento entrá a la ficha del negocio.
          </span>
          <Link href="/internal/tenants" className="inline-flex items-center gap-1.5 text-ninja-flameSoft hover:underline">
            <Store size={14} aria-hidden /> Ir a Negocios
          </Link>
        </div>
      </section>

      <Modal
        open={config !== null}
        onOpenChange={(o) => {
          if (!o) setConfigKey(null);
        }}
        title={config?.title}
        description={config?.description}
        className="sm:max-w-2xl"
      >
        {configKey === AI_ASSISTANT_ADDON_KEY && <AiConfigCard bare />}
      </Modal>
    </>
  );
}
