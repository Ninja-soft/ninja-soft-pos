"use client";

import { useState } from "react";
import { ScanLine } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { useDecidePlu } from "@/modules/products/hooks";

type PluMode = "random" | "incremental";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Se llama cuando el dueño resolvió el prompt (aceptó u omitió). El productos
  // page lo usa para abrir el formulario de alta a continuación.
  onResolved: () => void;
}

const MODES: { value: PluMode; label: string; hint: string }[] = [
  {
    value: "random",
    label: "Aleatorio",
    hint: "Asigna un número de 6 dígitos al azar (no consecutivo).",
  },
  {
    value: "incremental",
    label: "Incremental",
    hint: "Asigna el siguiente número disponible, de forma correlativa.",
  },
];

// Prompt del primer producto: ofrece activar el PLU (código corto de 6 dígitos
// para tipear rápido en el POS) y elegir el modo de generación. Se muestra una
// sola vez (al cargar el primer producto del tenant). Cambiarlo luego se hace
// desde Configuración del POS. NO es window.confirm: es un modal Tailwind.
export function FirstProductPluPrompt({ open, onOpenChange, onResolved }: Props) {
  const { toast } = useToast();
  const decide = useDecidePlu();
  const [mode, setMode] = useState<PluMode>("random");

  async function resolve(accept: boolean) {
    try {
      await decide.mutateAsync({ accept, mode });
      if (accept) {
        toast({
          title: "PLU activado",
          description:
            "Tus productos llevarán un código corto de 6 dígitos. Lo cambiás en Configuración del POS.",
          variant: "success",
        });
      }
    } catch {
      // No bloquea el alta: si falla guardar la preferencia, seguimos igual.
      toast({ title: "No se pudo guardar la preferencia de PLU", variant: "error" });
    } finally {
      onOpenChange(false);
      onResolved();
    }
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="¿Usar PLU en tus productos?">
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-lg border border-ninja-flame/30 bg-ninja-flame/[0.06] p-3">
          <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-ninja-flame/15 text-ninja-flameSoft">
            <ScanLine size={18} />
          </span>
          <p className="text-sm text-muted-foreground">
            El <strong className="text-foreground">PLU</strong> es un código corto
            de <strong className="text-foreground">6 dígitos</strong>, fácil de
            recordar, para tipear un producto en el POS sin escanear ni buscar por
            nombre. Se asigna solo a cada producto. Podés activarlo o cambiarlo
            después en <strong className="text-foreground">Configuración del POS</strong>.
          </p>
        </div>

        <div>
          <div className="mb-1.5 text-sm font-medium text-foreground">
            Modo de generación
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {MODES.map((m) => {
              const active = mode === m.value;
              return (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => setMode(m.value)}
                  className={
                    active
                      ? "flex items-start gap-2.5 rounded-lg border border-ninja-flame bg-ninja-flame/[0.06] px-3 py-2.5 text-left"
                      : "flex items-start gap-2.5 rounded-lg border border-border px-3 py-2.5 text-left transition hover:border-ninja-flameSoft/40"
                  }
                >
                  <span
                    className={
                      "mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border " +
                      (active ? "border-ninja-flame" : "border-muted-foreground/40")
                    }
                  >
                    {active && <span className="h-2 w-2 rounded-full bg-ninja-flame" />}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{m.label}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {m.hint}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="secondary"
            disabled={decide.isPending}
            onClick={() => resolve(false)}
          >
            Ahora no
          </Button>
          <Button type="button" loading={decide.isPending} onClick={() => resolve(true)}>
            Activar PLU
          </Button>
        </div>
      </div>
    </Modal>
  );
}
