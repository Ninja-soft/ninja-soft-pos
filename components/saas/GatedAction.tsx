"use client";

import { useState, type ComponentProps, type ReactNode } from "react";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils/cn";
import { useFeature } from "@/modules/saas/gating";
import { UpgradeModal } from "@/components/saas/UpgradeModal";

// =============================================================================
// Helpers de gating UNIVERSAL para el POS del cliente. Capa de UX sobre el
// enforcement real (trigger + tenant_has_feature en backend): toda función que
// el plan no incluye se ve DESHABILITADA (no escondida) y, al clickearla, abre
// el UpgradeModal con el plan mínimo, su costo y el botón de pago.
//
// Optimista mientras carga el gating (useFeature === undefined → permitido) para
// no parpadear el bloqueo. El backend igual rechaza si no corresponde.
// =============================================================================

// ── Botón de acción gateado ──────────────────────────────────────────────────
// Igual a <Button> pero: si el tenant NO tiene `feature`, se muestra atenuado
// con un candado y, al clickear, abre el UpgradeModal en vez de ejecutar onClick.
export function GatedButton({
  feature,
  featureLabel,
  children,
  onClick,
  className,
  disabled,
  ...rest
}: ComponentProps<typeof Button> & {
  feature: string;
  featureLabel: string;
}) {
  const allowed = useFeature(feature);
  const [open, setOpen] = useState(false);
  const locked = allowed === false;

  if (!locked) {
    return (
      <Button onClick={onClick} className={className} disabled={disabled} {...rest}>
        {children}
      </Button>
    );
  }

  return (
    <>
      <Button
        {...rest}
        className={cn("opacity-60", className)}
        onClick={(e) => {
          e.preventDefault();
          setOpen(true);
        }}
        // No se pasa disabled: queremos que sea clickeable para abrir el modal,
        // pero visualmente atenuado (locked). aria refleja el bloqueo.
        aria-disabled
        title={`${featureLabel}: función no incluida en tu plan`}
      >
        <Lock size={14} className="opacity-80" />
        {children}
      </Button>
      <UpgradeModal
        open={open}
        onOpenChange={setOpen}
        featureKey={feature}
        featureLabel={featureLabel}
      />
    </>
  );
}

// ── Wrapper genérico clickeable ──────────────────────────────────────────────
// Para elementos que no son <Button> (filas, ítems de menú, iconos de acción).
// Si está bloqueado, atenúa el contenido, agrega un candado e intercepta el
// click para abrir el UpgradeModal. Si no, renderiza children tal cual.
export function GatedClick({
  feature,
  featureLabel,
  children,
  className,
  as = "div",
  showLock = true,
}: {
  feature: string;
  featureLabel: string;
  children: ReactNode;
  className?: string;
  as?: "div" | "span" | "li";
  showLock?: boolean;
}) {
  const allowed = useFeature(feature);
  const [open, setOpen] = useState(false);
  const locked = allowed === false;
  const Tag = as;

  if (!locked) return <>{children}</>;

  return (
    <>
      <Tag className={cn("relative inline-flex", className)}>
        <span
          aria-hidden
          className="pointer-events-none select-none opacity-50 grayscale"
        >
          {children}
        </span>
        {showLock && (
          <span className="pointer-events-none absolute right-1 top-1 z-10 grid h-4 w-4 place-items-center rounded-full bg-ninja-flame/90 text-white shadow">
            <Lock size={10} />
          </span>
        )}
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={`${featureLabel}: función no incluida en tu plan`}
          className="absolute inset-0 z-20 cursor-pointer rounded-[inherit]"
        />
      </Tag>
      <UpgradeModal
        open={open}
        onOpenChange={setOpen}
        featureKey={feature}
        featureLabel={featureLabel}
      />
    </>
  );
}

// ── Hook para gatear acciones imperativas ────────────────────────────────────
// Útil cuando el botón ya existe y solo querés interceptar su handler:
//   const gate = useFeatureGate("garantias", "Garantías");
//   <Button onClick={() => gate.run(() => abrirGarantias())} /> …
//   {gate.modal}
export function useFeatureGate(feature: string, featureLabel: string) {
  const allowed = useFeature(feature);
  const [open, setOpen] = useState(false);
  const locked = allowed === false;

  return {
    locked,
    // Ejecuta `fn` si la feature está disponible; si no, abre el UpgradeModal.
    run(fn: () => void) {
      if (locked) setOpen(true);
      else fn();
    },
    // Render del modal — colocalo una vez en el árbol del componente.
    modal: (
      <UpgradeModal
        open={open}
        onOpenChange={setOpen}
        featureKey={feature}
        featureLabel={featureLabel}
      />
    ),
  };
}
