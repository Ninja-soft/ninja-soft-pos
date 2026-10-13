"use client";

// Onboarding guiado desde internal (F15 · H70, H71, H74 · ADR-089): cuentas
// trabadas con correctivos, recorridos guiados y sugerencias por evento, sin
// deploy. Soporte ve todo y dispara correctivos; editar y publicar es de
// admin y super admin (el servidor lo exige, esto sólo oculta los botones).
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Compass } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { PageHeader } from "@/components/ui/PageHeader";
import { Segmented } from "@/components/ui/Segmented";
import { ActivationPanel } from "@/components/internal/onboarding/ActivationPanel";
import { ToursPanel } from "@/components/internal/onboarding/ToursPanel";
import { NudgesPanel } from "@/components/internal/onboarding/NudgesPanel";

type Tab = "activacion" | "recorridos" | "sugerencias";

export default function InternalOnboardingPage() {
  const [tab, setTab] = useState<Tab>("activacion");
  const { data: level } = useQuery({
    queryKey: ["my-internal-level"],
    queryFn: async () => {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      return ((user?.app_metadata as { internal_level?: string } | null)?.internal_level ?? null) as string | null;
    },
    staleTime: 5 * 60 * 1000,
  });
  const canEdit = level !== "support" && level !== undefined;

  return (
    <>
      <PageHeader
        eyebrow="Panel interno"
        title="Onboarding"
        icon={Compass}
        description="Activación por negocio, recorridos guiados y sugerencias por evento. Lo publicado llega sin deploy."
      />
      <div className="mt-6 space-y-5">
        <Segmented<Tab>
          value={tab}
          onChange={setTab}
          aria-label="Sección"
          options={[
            { value: "activacion", label: "Activación" },
            { value: "recorridos", label: "Recorridos" },
            { value: "sugerencias", label: "Sugerencias" },
          ]}
        />
        {tab === "activacion" && <ActivationPanel />}
        {tab === "recorridos" && <ToursPanel canEdit={canEdit} />}
        {tab === "sugerencias" && <NudgesPanel canEdit={canEdit} />}
      </div>
    </>
  );
}
