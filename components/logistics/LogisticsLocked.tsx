"use client";

// Plan sin reparto propio (ADR-161): qué hace y cómo sumarlo.
import { useState } from "react";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { UpgradeModal } from "@/components/saas/UpgradeModal";

export function LogisticsLocked({ title, description }: { title: string; description: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-8 rounded-lg bg-muted/40 p-8 text-center">
      <Lock className="mx-auto text-ninja-flameSoft" size={28} aria-hidden />
      <p className="mt-3 font-semibold">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{description}</p>
      <Button className="mt-4" onClick={() => setOpen(true)}>
        Ver planes
      </Button>
      <UpgradeModal open={open} onOpenChange={setOpen} featureKey="reparto_propio" featureLabel="Reparto propio" />
    </div>
  );
}
LogisticsLocked.displayName = "LogisticsLocked";
