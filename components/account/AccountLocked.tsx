"use client";

import { useState } from "react";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { UpgradeModal } from "@/components/saas/UpgradeModal";

// Estado vacío cuando el plan no incluye la cuenta corriente.
export function AccountLocked() {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-8 rounded-xl bg-muted/40 p-8 text-center">
      <Lock className="mx-auto text-ninja-flameSoft" size={28} />
      <p className="mt-3 font-semibold">La cuenta corriente no está incluida en tu plan</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
        Vendé a cuenta con plazos y cuotas, cobrá con recibo, seguí la mora por vencimiento y mandá recordatorios.
      </p>
      <Button className="mt-4" onClick={() => setOpen(true)}>
        Ver planes
      </Button>
      <UpgradeModal open={open} onOpenChange={setOpen} featureKey="cuenta_corriente" featureLabel="Cuenta corriente" />
    </div>
  );
}
