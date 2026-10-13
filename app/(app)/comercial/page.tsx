"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Lock, ShieldCheck } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Segmented";
import { UpgradeModal } from "@/components/saas/UpgradeModal";
import { ApprovalsPanel } from "@/components/commercial/ApprovalsPanel";
import { MarginAlertsPanel } from "@/components/commercial/MarginAlertsPanel";
import { getCurrentUser } from "@/lib/supabase/currentUser";
import { useFeature } from "@/modules/saas/gating";
import { useMyTenant } from "@/modules/tenants/hooks";

type Tab = "aprobaciones" | "margenes";

// Control comercial (F14 · H63, H67, ADR-092): aprobación de cambios de los
// encargados y alertas de margen. Dueño y encargado.
export default function ComercialPage() {
  const approvals = useFeature("aprobaciones_comerciales");
  const margins = useFeature("alertas_margen");
  const { data: me } = useMyTenant();
  const { data: userId = null } = useQuery({
    queryKey: ["current-user-id"],
    queryFn: async () => (await getCurrentUser())?.id ?? null,
  });
  const [tab, setTab] = useState<Tab>("aprobaciones");
  const [upgradeOpen, setUpgradeOpen] = useState(false);

  // ?tab=margenes (la notificación de margen bajo llega acá).
  useEffect(() => {
    if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("tab") === "margenes") {
      setTab("margenes");
    }
  }, []);

  const header = (
    <PageHeader
      eyebrow="Gestión"
      title="Control comercial"
      icon={ShieldCheck}
      description="Aprobá los cambios de tus encargados en promociones y recargos, y revisá los productos con margen bajo."
    />
  );

  if (me && !me.canManage) {
    return (
      <PageContainer>
        {header}
        <p className="mt-6 text-sm text-muted-foreground">Esta sección es del dueño y los encargados.</p>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      {header}
      <div className="mt-6">
        <Segmented<Tab>
          aria-label="Sección"
          size="sm"
          value={tab}
          onChange={setTab}
          options={[
            { value: "aprobaciones", label: "Aprobaciones" },
            { value: "margenes", label: "Márgenes" },
          ]}
        />
      </div>

      <div className="mt-6">
        {tab === "aprobaciones" &&
          (approvals === false ? (
            <div className="rounded-lg bg-muted/40 p-8 text-center">
              <Lock className="mx-auto text-ninja-flameSoft" size={28} />
              <p className="mt-3 font-semibold">La aprobación de cambios comerciales no está incluida en tu plan</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                Que los cambios de tus encargados en promociones de alto impacto y recargos esperen tu visto bueno.
              </p>
              <Button className="mt-4" onClick={() => setUpgradeOpen(true)}>
                Ver planes
              </Button>
              <UpgradeModal
                open={upgradeOpen}
                onOpenChange={setUpgradeOpen}
                featureKey="aprobaciones_comerciales"
                featureLabel="Aprobación de cambios comerciales"
              />
            </div>
          ) : approvals ? (
            <ApprovalsPanel role={me?.role ?? null} userId={userId} />
          ) : null)}

        {tab === "margenes" &&
          (margins === false ? (
            <p className="text-sm text-muted-foreground">Tu plan no incluye las alertas de margen.</p>
          ) : margins ? (
            <MarginAlertsPanel />
          ) : null)}
      </div>
    </PageContainer>
  );
}
