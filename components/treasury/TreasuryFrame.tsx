"use client";

// Marco común de las pantallas de Tesorería (F23 · H155, ADR-158): encabezado
// con una línea que dice qué es la pantalla, candado si el plan no la trae y el
// contenido sólo con la feature activa (la barrera real es el servidor).

import { useState } from "react";
import { Lock, type LucideIcon } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { UpgradeModal } from "@/components/saas/UpgradeModal";
import { useTreasuryAccess } from "@/modules/treasury/hooks";

export function TreasuryFrame({
  title,
  icon,
  description,
  actions,
  children,
}: {
  title: string;
  icon: LucideIcon;
  description: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const access = useTreasuryAccess();
  const [upgrade, setUpgrade] = useState(false);
  const header = (
    <PageHeader
      eyebrow="Tesorería"
      title={title}
      icon={icon}
      description={description}
      actions={access.enabled ? actions : undefined}
    />
  );

  if (access.locked) {
    return (
      <PageContainer>
        {header}
        <div className="mt-8 rounded-md bg-muted/40 p-8 text-center">
          <Lock className="mx-auto text-ninja-flameSoft" size={28} />
          <p className="mt-3 font-semibold">Tesorería no está incluida en tu plan</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Mirá toda tu plata en un lugar: cajas, bancos, billeteras y lo que te tienen que acreditar. Conciliá contra
            el extracto, controlá los cheques y proyectá el flujo de fondos.
          </p>
          <Button className="mt-4" onClick={() => setUpgrade(true)}>
            Ver planes
          </Button>
          <UpgradeModal open={upgrade} onOpenChange={setUpgrade} featureKey="tesoreria" featureLabel="Tesorería" />
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      {header}
      {access.enabled ? (
        children
      ) : (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      )}
    </PageContainer>
  );
}

/** Tarjeta de número grande (saldo, totales). */
export function TreasuryStat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "danger" | "success";
}) {
  return (
    <div className="rounded-md border border-border bg-card p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={
          "mt-1 font-price text-xl font-black tabular-nums" +
          (tone === "danger" ? " text-danger" : tone === "success" ? " text-success" : "")
        }
      >
        {value}
      </div>
      {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}
