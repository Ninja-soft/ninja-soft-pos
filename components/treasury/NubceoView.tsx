"use client";

// NubCeo dentro de Tesorería (F23 · H155, ADR-158): lo que le mandás a NubCeo
// y lo que te devuelve. La configuración sigue en Configuración > NubCeo.
// Sin NubCeo configurado, la promo de siempre.

import { useState } from "react";
import Link from "next/link";
import { Activity, BookOpenCheck, Lock, RefreshCcw, SlidersHorizontal } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Segmented } from "@/components/ui/Segmented";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { NubceoPromo } from "@/components/integrations/NubceoPromo";
import { NubceoMonitor } from "@/components/integrations/nubceo/NubceoMonitor";
import { NubceoLedger } from "@/components/integrations/nubceo/NubceoLedger";
import { useNubceoAccess, useNubceoConfig } from "@/modules/integrations/nubceo/hooks";
import { nubceoErrorMessage } from "@/modules/integrations/nubceo/api";

type Tab = "envios" | "asientos";

export function NubceoView() {
  const access = useNubceoAccess();
  const cfg = useNubceoConfig();
  const [tab, setTab] = useState<Tab>("envios");
  const config = cfg.data;
  const configured = Boolean(config?.settings);

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Tesorería"
        title="NubCeo"
        icon={RefreshCcw}
        description="Lo que le mandás a NubCeo y lo que te devuelve conciliado. Cada venta viaja con sus cobros; NubCeo la cruza con lo que liquidan las tarjetas y billeteras."
        actions={
          <Link href={"/configuracion?seccion=nubceo" as never}>
            <Button variant="secondary">
              <SlidersHorizontal size={16} /> Configurar
            </Button>
          </Link>
        }
      />
      <div className="mt-4 space-y-4">
        {cfg.isLoading ? (
          <SpinnerBlock className="py-16" />
        ) : cfg.error || !config ? (
          <Callout tone="warning" icon={Lock} title="No disponible">
            {nubceoErrorMessage(cfg.error)}
          </Callout>
        ) : !configured ? (
          <NubceoPromo />
        ) : (
          <>
            <Callout tone="neutral" title="Cómo se usa con la contabilidad">
              Hoy NinjaPOS arma los asientos de cada liquidación con su propia conciliación. Los asientos que devuelve
              NubCeo se ven acá como control: no entran al Diario, así nada se cuenta dos veces.
            </Callout>
            <Segmented
              value={tab}
              onChange={setTab}
              aria-label="Sección"
              options={[
                { value: "envios", label: "Envíos", icon: <Activity size={15} /> },
                { value: "asientos", label: "Asientos que devolvió", icon: <BookOpenCheck size={15} /> },
              ]}
            />
            {tab === "envios" && <NubceoMonitor config={config} canWrite={config.feature && access.enabled !== false} />}
            {tab === "asientos" && <NubceoLedger config={config} canWrite={config.feature && access.enabled !== false} />}
          </>
        )}
      </div>
    </PageContainer>
  );
}
