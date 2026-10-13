"use client";

import { useState } from "react";
import { Inbox, Lock } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import type { RegisterHardware } from "@/lib/hardware/config";
import { drawerDeniedMessage, type DrawerAction, type DrawerDenyReason } from "@/lib/hardware/drawer";
import { hardwareErrorMessage } from "@/modules/hardware/api";
import type { DrawerOutcome } from "@/modules/hardware/hooks";

// "Abrir cajón" sin venta en el POS (F17, ADR-063). Pide motivo; con la
// política "Con PIN" el servidor pide el PIN de supervisor (withSupervisor);
// "Prohibido" no se ofrece. Cada pedido queda registrado.

const REASONS = ["Dar cambio", "Corregir un vuelto", "Guardar un comprobante"];

const iconBtn =
  "grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-fg-4 text-muted-foreground transition-colors hover:bg-fg-6 hover:text-foreground disabled:opacity-50";

export function PosDrawerButton({
  hw,
  decision,
  open,
}: {
  hw: RegisterHardware | null;
  decision: { action: DrawerAction; reason?: DrawerDenyReason };
  open: (hw: RegisterHardware, kind: "no_sale", opts: { reason: string }) => Promise<DrawerOutcome>;
}) {
  const { toast } = useToast();
  const [dialog, setDialog] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  if (!hw || decision.reason === "no_drawer") return null;
  const blocked = decision.action === "deny";
  const title = blocked ? drawerDeniedMessage(decision.reason) : decision.action === "ask_pin" ? "Abrir cajón (pide PIN de supervisor)" : "Abrir cajón";

  async function confirm() {
    if (!hw) return;
    const r = reason.trim();
    if (r.length < 3) {
      toast({ title: "Escribí el motivo", variant: "error" });
      return;
    }
    setBusy(true);
    try {
      const out = await open(hw, "no_sale", { reason: r });
      if (out.status === "opened") {
        setDialog(false);
        setReason("");
        toast(
          out.pulse === "sent"
            ? { title: "Cajón abierto", variant: "success" }
            : { title: "Autorizado, pero el cajón no respondió: abrilo con la llave", description: out.error, variant: "error" },
        );
      } else if (out.status === "denied") {
        toast({ title: drawerDeniedMessage(out.result.denied_reason), variant: "error" });
      } else if (out.status === "error") {
        toast({ title: hardwareErrorMessage(out.error), variant: "error" });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => !blocked && setDialog(true)}
        aria-disabled={blocked || undefined}
        className={cn(iconBtn, blocked && "cursor-not-allowed opacity-50")}
        aria-label={title}
        title={title}
      >
        <span className="relative">
          <Inbox size={18} aria-hidden />
          {decision.action === "ask_pin" && (
            <Lock size={10} className="absolute -bottom-1 -right-1.5" aria-hidden />
          )}
        </span>
      </button>
      <Modal
        open={dialog}
        onOpenChange={(o) => !busy && setDialog(o)}
        title="Abrir el cajón sin venta"
        description={
          decision.action === "ask_pin"
            ? "Queda registrado con tu usuario y el motivo. Un supervisor tiene que autorizar con su PIN."
            : "Queda registrado con tu usuario, la caja, el turno y el motivo."
        }
      >
        <div className="space-y-4">
          <div className="flex flex-wrap gap-1.5">
            {REASONS.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setReason(r)}
                className={cn(
                  "h-9 rounded-md px-3 text-[13px] font-medium transition-colors",
                  reason === r ? "bg-[var(--pos-solid)] text-white" : "bg-fg-6 hover:bg-fg-10",
                )}
              >
                {r}
              </button>
            ))}
          </div>
          <Input
            label="Motivo"
            value={reason}
            maxLength={200}
            autoFocus
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void confirm()}
            placeholder="Por qué se abre"
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDialog(false)} disabled={busy}>
              Cancelar
            </Button>
            <Button onClick={confirm} loading={busy}>
              Abrir cajón
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
