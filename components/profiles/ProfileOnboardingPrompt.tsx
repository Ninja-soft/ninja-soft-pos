"use client";

import { useState } from "react";
import { Shuffle } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { getProfile, profileForVertical } from "@/lib/profiles/businessProfiles";
import { useProfileContext } from "@/modules/profiles/hooks";
import { BusinessProfileModal } from "./BusinessProfileModal";

// Onboarding (F5 · ADR-075): al crear el negocio, el dueño elige el perfil de su
// rubro (preseleccionado con el rubro que eligió en el registro) y ve qué
// cambia antes de aplicarlo. Desaparece cuando ya hay un perfil aplicado.
export function ProfileOnboardingPrompt() {
  const { tenant, applied, isOwner, isLoading } = useProfileContext();
  const [open, setOpen] = useState(false);

  if (!tenant || !isOwner || isLoading || applied) return null;
  const suggested = profileForVertical(tenant.industry);
  const label = getProfile(suggested)?.label ?? "tu rubro";

  return (
    <div className="mt-4 flex flex-col gap-3 rounded-md border border-border border-t-2 border-t-[var(--pos-solid)] bg-muted/40 p-3.5 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-xs text-muted-foreground">
        <span className="font-semibold text-foreground">Adaptá el POS a tu rubro.</span> Sugerimos el perfil{" "}
        <span className="font-medium text-foreground">{label}</span>: prende las funciones que usás y sugiere
        categorías. Te mostramos qué cambia antes de aplicarlo.
      </p>
      <Button size="sm" className="shrink-0" onClick={() => setOpen(true)}>
        <Shuffle size={14} /> Elegir perfil
      </Button>
      <BusinessProfileModal open={open} onOpenChange={setOpen} initialKey={suggested} />
    </div>
  );
}
