"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { posApi } from "@/modules/pos/api";
import { formatCurrency } from "@/lib/utils/format";

type Phase = "creating" | "waiting" | "approved" | "rejected" | "error";

// Cobro por QR de Mercado Pago: genera la preferencia, muestra el QR del
// init_point y espera la aprobación (webhook → estado en vivo por polling).
export function QrCheckoutModal({
  open,
  onOpenChange,
  amount,
  onApproved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  amount: number;
  onApproved: (reference: string) => void;
}) {
  const { toast } = useToast();
  const [phase, setPhase] = useState<Phase>("creating");
  const [intentId, setIntentId] = useState<string | null>(null);
  const [initPoint, setInitPoint] = useState("");
  const firedRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPhase("creating");
    setIntentId(null);
    setInitPoint("");
    firedRef.current = false;
    posApi
      .createMpQr(amount, "Venta NinjaPos")
      .then((r) => {
        if (cancelled) return;
        setIntentId(r.intent_id);
        setInitPoint(r.init_point);
        setPhase("waiting");
      })
      .catch((e) => {
        if (cancelled) return;
        setPhase("error");
        toast({
          title:
            e instanceof Error && e.message === "not_connected"
              ? "Conectá Mercado Pago en Configuración"
              : "No se pudo generar el QR",
          variant: "error",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [open, amount, toast]);

  const { data: status } = useQuery({
    queryKey: ["mp-intent", intentId],
    queryFn: () => posApi.mpIntentStatus(intentId!),
    enabled: open && phase === "waiting" && Boolean(intentId),
    refetchInterval: 3000,
  });

  useEffect(() => {
    if (!status || firedRef.current) return;
    if (status.status === "approved") {
      firedRef.current = true;
      setPhase("approved");
      onApproved(status.mp_payment_id ?? intentId ?? "");
    } else if (status.status === "rejected" || status.status === "cancelled") {
      setPhase("rejected");
    }
  }, [status, onApproved, intentId]);

  const qrSrc = initPoint
    ? `https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${encodeURIComponent(
        initPoint,
      )}`
    : "";

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Cobrar con QR · Mercado Pago">
      <div className="space-y-4 text-center">
        <div className="flex items-center justify-center py-1">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/img/medios_de_pago/mercado_pago_cube.webp"
            alt="Mercado Pago"
            className="h-12 w-auto object-contain"
          />
        </div>
        <div className="text-sm text-muted-foreground">
          Total a cobrar
          <div className="price-hl font-price text-3xl font-black tabular-nums text-foreground">
            {formatCurrency(amount)}
          </div>
        </div>

        {phase === "creating" && (
          <div className="flex flex-col items-center gap-2 py-8">
            <Spinner size={28} />
            <span className="text-sm text-muted-foreground">Generando QR…</span>
          </div>
        )}

        {phase === "waiting" && (
          <>
            <div className="flex justify-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={qrSrc}
                alt="QR de pago Mercado Pago"
                className="rounded-lg border border-border bg-white p-2"
                width={260}
                height={260}
              />
            </div>
            <p className="text-sm text-muted-foreground">
              El cliente escanea con la app de Mercado Pago. La pantalla se actualiza
              sola al acreditarse.
            </p>
            <a
              href={initPoint}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block text-xs text-ninja-flameSoft hover:underline"
            >
              Abrir link de pago
            </a>
            <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
              <Spinner size={14} /> Esperando pago…
            </div>
          </>
        )}

        {phase === "approved" && (
          <div className="py-8 text-emerald-400">
            <div className="text-lg font-bold">¡Pago aprobado!</div>
            <div className="text-sm text-muted-foreground">Registrando la venta…</div>
          </div>
        )}

        {phase === "rejected" && (
          <div className="space-y-3 py-6">
            <div className="text-lg font-bold text-red-300">Pago rechazado o cancelado</div>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cerrar
            </Button>
          </div>
        )}

        {phase === "error" && (
          <div className="space-y-3 py-6">
            <div className="text-sm text-muted-foreground">
              No se pudo generar el QR. Revisá que Mercado Pago esté conectado en
              Configuración → Medios de pago.
            </div>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cerrar
            </Button>
          </div>
        )}

        {(phase === "creating" || phase === "waiting") && (
          <Button variant="ghost" className="w-full" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
        )}
      </div>
    </Modal>
  );
}
