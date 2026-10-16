"use client";

import { useState } from "react";
import Link from "next/link";
import { Bot, Gift, Mail, Puzzle, Settings2, Sparkles, Store, TriangleAlert } from "lucide-react";
import { AiConfigCard } from "@/components/internal/AiConfigCard";
import { EmailAddonConfigCard } from "@/components/internal/EmailAddonConfigCard";
import { EMAIL_ADDON_KEY } from "@/lib/billing/emailAddon";
import { CatalogCard, CatalogCardSkeleton, CatalogStat } from "@/components/internal/CatalogCard";
import { ArcaCertificateServiceCard } from "@/components/internal/arca/ArcaCertificateServiceCard";
import { ArcaCertificateSettings } from "@/components/internal/arca/ArcaCertificateSettings";
import { PageHeader, SectionHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { EmptyState } from "@/components/ui/EmptyState";
import { Modal } from "@/components/ui/Modal";
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
  // ADR-156: emails de los negocios desde el dominio de NinjaSoft, con
  // escalones de emails por mes que se suman a la suscripción.
  [EMAIL_ADDON_KEY]: {
    title: "Email con dominio NinjaSoft",
    description:
      "API key de Resend de la plataforma, dominio remitente verificado, escalones de emails por mes y qué pasa al pasar el cupo.",
  },
};

function addonIcon(key: string) {
  if (key === AI_ASSISTANT_ADDON_KEY) return Bot;
  if (key === EMAIL_ADDON_KEY) return Mail;
  return Puzzle;
}

function AddonCard({ addon, onConfigure }: { addon: AddonCatalogItem; onConfigure?: () => void }) {
  const paid = addon.activeTenants - addon.grantedTenants;
  return (
    <CatalogCard
      icon={addonIcon(addon.key)}
      title={addon.label}
      badge={addon.isActive ? <Badge tone="success">Disponible</Badge> : <Badge>No disponible</Badge>}
      subtitle={addon.key}
      description={addon.description?.trim() || "Sin descripción cargada."}
      stats={
        <>
          <CatalogStat
            label="Precio por mes"
            value={
              addon.key === EMAIL_ADDON_KEY
                ? "Por escalón"
                : addon.monthlyPrice > 0
                  ? formatCurrency(addon.monthlyPrice)
                  : "Sin cargo"
            }
          />
          <CatalogStat
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
        </>
      }
      actions={
        onConfigure ? (
          <Button size="sm" onClick={onConfigure} className="w-full sm:w-auto">
            <Settings2 size={15} /> Configurar
          </Button>
        ) : (
          <p className="text-xs text-muted-foreground">Sin configuración global. Se activa desde la ficha de cada negocio.</p>
        )
      }
    />
  );
}

export default function InternalAddonsPage() {
  const [arcaOpen, setArcaOpen] = useState(false);
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
                <CatalogCardSkeleton />
                <CatalogCardSkeleton />
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

      {/* Servicios que NinjaSoft brinda a todos los negocios con su propia
          configuración (no se contratan): hoy, el certificado de ARCA para el
          padrón de CUITs (ADR-133), con la misma tarjeta que el catálogo y el
          mismo panel que Plataforma › ARCA. */}
      <section className="mt-10">
        <SectionHeader
          title="Servicios de la plataforma"
          icon={Settings2}
          description="Los usan todos los negocios sin contratarlos. Se configuran una sola vez desde acá."
        />
        <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <ArcaCertificateServiceCard onConfigure={() => setArcaOpen(true)} />
        </div>
      </section>

      <Modal
        open={arcaOpen}
        onOpenChange={setArcaOpen}
        title="Certificado de ARCA"
        description="Producción. Con este certificado todos los negocios consultan CUITs en el padrón de ARCA."
        className="sm:max-w-3xl"
      >
        <ArcaCertificateSettings />
      </Modal>

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
        {configKey === EMAIL_ADDON_KEY && <EmailAddonConfigCard />}
      </Modal>
    </>
  );
}
