"use client";

import { useState } from "react";
import { Activity, BookOpenCheck, Lock, SlidersHorizontal } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { Segmented } from "@/components/ui/Segmented";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { useNubceoAccess, useNubceoConfig } from "@/modules/integrations/nubceo/hooks";
import { nubceoErrorMessage } from "@/modules/integrations/nubceo/api";
import { ENV_LABEL, NubceoLogo } from "./shared";
import { NubceoSetup } from "./NubceoSetup";
import { NubceoMonitor } from "./NubceoMonitor";
import { NubceoLedger } from "./NubceoLedger";

type Tab = "config" | "envios" | "asientos";

// Configuración > Integraciones > NubCeo (ADR-062): conexión, envío y mapeo,
// monitor de lo enviado y asientos contables. Dueño o encargado; escribir
// pide la feature `integracion_nubceo` (el servidor lo exige igual).
export function NubceoSettings() {
  const access = useNubceoAccess();
  const cfg = useNubceoConfig();
  const [tab, setTab] = useState<Tab>("config");

  if (cfg.isLoading) return <SpinnerBlock className="py-16" />;
  if (cfg.error || !cfg.data) {
    return (
      <Callout tone="warning" icon={Lock} title="No disponible">
        {nubceoErrorMessage(cfg.error)}
      </Callout>
    );
  }
  const config = cfg.data;
  const canWrite = config.feature && access.enabled !== false;
  const s = config.settings;

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-4">
          <NubceoLogo height={26} />
          <div className="hidden h-8 w-px bg-border sm:block" aria-hidden />
          <p className="min-w-0 text-sm text-muted-foreground">
            Cada venta viaja a NubCeo con sus cobros para conciliarlos contra lo que liquidan las tarjetas y billeteras.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {!s?.enabled ? (
            <Badge tone="neutral">Apagada</Badge>
          ) : s.simulate ? (
            <Badge tone="info">Solo simular</Badge>
          ) : (
            <Badge tone="success">Enviando</Badge>
          )}
          {s?.enabled && <Badge tone="neutral">{ENV_LABEL[s.environment]}</Badge>}
        </div>
      </div>

      {!config.feature && (
        <Callout tone="warning" icon={Lock} title="Tu plan no incluye la integración con NubCeo">
          Está en los planes Business y Enterprise (o como add-on). Podés ver lo que ya se mandó, pero no cambiar la configuración.
        </Callout>
      )}

      <Segmented
        value={tab}
        onChange={setTab}
        aria-label="Sección"
        options={[
          { value: "config", label: "Configuración", icon: <SlidersHorizontal size={15} /> },
          { value: "envios", label: "Envíos", icon: <Activity size={15} /> },
          { value: "asientos", label: "Asientos contables", icon: <BookOpenCheck size={15} /> },
        ]}
      />

      {tab === "config" && <NubceoSetup config={config} canWrite={canWrite} />}
      {tab === "envios" && <NubceoMonitor config={config} canWrite={canWrite} />}
      {tab === "asientos" && <NubceoLedger config={config} canWrite={canWrite} />}
    </div>
  );
}
NubceoSettings.displayName = "NubceoSettings";
