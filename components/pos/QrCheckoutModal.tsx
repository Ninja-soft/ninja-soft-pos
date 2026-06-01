"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { posApi } from "@/modules/pos/api";
import { useProviderPlans } from "@/modules/pos/hooks";
import { BASE_LABEL } from "@/modules/pos/planConstants";
import { formatCurrency } from "@/lib/utils/format";

type Phase = "select" | "creating" | "waiting" | "approved" | "rejected" | "error";

const round2 = (n: number) => Math.round(n * 100) / 100;

// Cobro por QR de Mercado Pago: el cajero elige el plan (marca/cuotas) que
// aplica su recargo, se genera el QR por el total con recargo y se espera la
// aprobación (webhook → estado en vivo por polling).
export function QrCheckoutModal({
  open,
  onOpenChange,
  base,
  onApproved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  base: number;
  onApproved: (reference: string, amount: number, extras: { name: string; amount: number }[]) => void;
}) {
  const { toast } = useToast();
  const [phase, setPhase] = useState<Phase>("select");
  const [planId, setPlanId] = useState("");
  const [intentId, setIntentId] = useState<string | null>(null);
  const [initPoint, setInitPoint] = useState("");
  const firedRef = useRef(false);

  const { data: plans = [] } = useProviderPlans(open ? "mercadopago" : null);
  const activePlans = useMemo(() => plans.filter((p) => p.is_active), [plans]);
  const plan = activePlans.find((p) => p.id === planId) ?? null;
  const surcharge = plan ? round2((base * (Number(plan.surcharge_pct) || 0)) / 100) : 0;
  const amount = round2(base + surcharge);

  useEffect(() => {
    if (open) {
      setPhase("select");
      setPlanId("");
      setIntentId(null);
      setInitPoint("");
      firedRef.current = false;
    }
  }, [open]);

  function startQr() {
    setPhase("creating");
    posApi
      .createMpQr(amount, "Venta NinjaPos")
      .then((r) => {
        setIntentId(r.intent_id);
        setInitPoint(r.init_point);
        setPhase("waiting");
      })
      .catch((e) => {
        setPhase("error");
        toast({
          title:
            e instanceof Error && e.message === "not_connected"
              ? "Conectá Mercado Pago en Configuración"
              : "No se pudo generar el QR",
          variant: "error",
        });
      });
  }

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
      const extras = surcharge > 0 && plan ? [{ name: `Recargo ${plan.label}`, amount: surcharge }] : [];
      onApproved(status.mp_payment_id ?? intentId ?? "", amount, extras);
    } else if (status.status === "rejected" || status.status === "cancelled") {
      setPhase("rejected");
    }
  }, [status, onApproved, intentId, amount, surcharge, plan]);

  const qrSrc = initPoint
    ? `https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${encodeURIComponent(initPoint)}`
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

        {/* Selección de plan + recargo */}
        {phase === "select" && (
          <div className="space-y-3 text-left">
            <label className="block text-sm">
              <span className="mb-1 block text-muted-foreground">Plan de pago</span>
              <select
                value={planId}
                onChange={(e) => setPlanId(e.target.value)}
                className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
              >
                <option value="">Sin recargo (1 pago)</option>
                {activePlans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {BASE_LABEL[p.base ?? "otro"] ?? p.base} {p.label}
                    {Number(p.surcharge_pct) ? ` · +${p.surcharge_pct}%` : ""}
                  </option>
                ))}
              </select>
            </label>
            <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">
              <div className="flex justify-between text-muted-foreground">
                <span>Subtotal</span>
                <span className="tabular-nums">{formatCurrency(base)}</span>
              </div>
              {surcharge > 0 && (
                <div className="flex justify-between text-ninja-flameSoft">
                  <span>Recargo {plan?.label}</span>
                  <span className="tabular-nums">+{formatCurrency(surcharge)}</span>
                </div>
              )}
              <div className="mt-1 flex justify-between border-t border-border pt-1 font-semibold">
                <span>Total a cobrar</span>
                <span className="price-hl font-price tabular-nums">{formatCurrency(amount)}</span>
              </div>
            </div>
            <Button className="w-full" onClick={startQr}>
              Generar QR
            </Button>
          </div>
        )}

        {phase !== "select" && (
          <div className="text-sm text-muted-foreground">
            Total a cobrar
            <div className="price-hl font-price text-3xl font-black tabular-nums text-foreground">
              {formatCurrency(amount)}
            </div>
          </div>
        )}

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
