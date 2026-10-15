"use client";

// Acceso rápido a "Mis PINes" desde el pie del menú (POS e internal): un ícono
// que abre un modal con el panel completo (código rotativo, PIN de un solo uso,
// historial). Sólo aparece si el usuario puede tener PIN; el panel se carga
// recién al abrir.
import { useState } from "react";
import dynamic from "next/dynamic";
import { KeyRound } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { usePinStatus } from "@/modules/security/hooks";

const MyPinsPanel = dynamic(() => import("@/components/security/MyPins").then((m) => m.MyPinsPanel), {
  ssr: false,
  loading: () => <SpinnerBlock />,
});

export function PinQuickAccess() {
  const { data } = usePinStatus();
  const [open, setOpen] = useState(false);
  if (!data?.can_have_pin) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Mis PINes"
        aria-label="Abrir Mis PINes"
        className="grid h-10 w-9 shrink-0 place-items-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <KeyRound size={17} aria-hidden />
      </button>
      <Modal
        open={open}
        onOpenChange={setOpen}
        title="Mis PINes"
        description="Generá tu código rotativo o un PIN de un solo uso para autorizar en el POS."
        className="sm:max-w-2xl"
      >
        {open && <MyPinsPanel />}
      </Modal>
    </>
  );
}
