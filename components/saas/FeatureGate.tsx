"use client";

import { useState, type ReactNode } from "react";
import { useFeature } from "@/modules/saas/gating";
import { UpgradeModal } from "@/components/saas/UpgradeModal";

interface FeatureGateProps {
  // key de la feature en el catálogo (features.key / plans.limits.modules).
  feature: string;
  // etiqueta humana para el modal de upgrade.
  featureLabel: string;
  children: ReactNode;
  className?: string;
}

// Envuelve UI gateada. Si el tenant tiene la feature → renderiza children tal
// cual. Si no → children atenuados (no interactivos) + un overlay que captura
// el click y abre el UpgradeModal. Cortesía client-side: el enforcement real es
// server-side (RPC/RLS). Mientras carga el gating se asume permitido (optimista,
// sin parpadeo).
export function FeatureGate({
  feature,
  featureLabel,
  children,
  className,
}: FeatureGateProps) {
  const allowed = useFeature(feature);
  const [open, setOpen] = useState(false);

  // undefined (cargando) o true → sin bloqueo.
  if (allowed !== false) {
    return <>{children}</>;
  }

  return (
    <>
      <div className={`relative ${className ?? ""}`}>
        <div
          aria-hidden
          className="pointer-events-none select-none opacity-50 grayscale"
        >
          {children}
        </div>
        {/* Capa que intercepta el click y abre el modal de upgrade. */}
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={`${featureLabel}: función no incluida en tu plan`}
          className="absolute inset-0 z-10 cursor-pointer rounded-[inherit]"
        />
      </div>
      <UpgradeModal
        open={open}
        onOpenChange={setOpen}
        featureKey={feature}
        featureLabel={featureLabel}
      />
    </>
  );
}
