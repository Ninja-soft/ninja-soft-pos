"use client";

import { useState } from "react";
import { Wand2 } from "lucide-react";
import { Button, type ButtonProps } from "@/components/ui/Button";
import { IndustryPresetWizard } from "./IndustryPresetWizard";

// Botón "Configuración rápida por rubro" + el wizard que lanza. Autocontenible:
// se puede soltar en Configuración (RubroCard), el Dashboard o el onboarding sin
// cablear estado externo. F12 · H35.
export function IndustryPresetButton({
  label = "Configuración rápida por rubro",
  variant = "secondary",
  className,
  size,
}: {
  label?: string;
  variant?: ButtonProps["variant"];
  className?: string;
  size?: ButtonProps["size"];
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant={variant}
        size={size}
        className={className}
        onClick={() => setOpen(true)}
      >
        <Wand2 size={16} /> {label}
      </Button>
      <IndustryPresetWizard open={open} onOpenChange={setOpen} />
    </>
  );
}
