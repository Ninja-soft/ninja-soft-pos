"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CreditCard, RefreshCw, XCircle } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import { posApi } from "@/modules/pos/api";

// F8 · H15 (resto) — Cobro presencial con lectores Mercado Point.
// Flujo: elegir lector → la Edge mp_point empuja el cobro AL dispositivo →
// el cliente pasa/apoya la tarjeta en el Point → el POS sondea el estado y,
// con "approved" (verificado contra /v1/payments), registra la venta como
// débito/crédito según la tarjeta usada. Las cuotas las elige el cliente en
// el lector (como MODO: el POS no muestra selección de planes).
//
// El último lector usado se recuerda por caja (localStorage) para que el cobro
// habitual sea de un toque.

const DEVICE_LS_KEY = "ninja-point-device";

type Phase = "device" | "creating" | "on_terminal" | "error";

export function PointCheckoutModal({
  open,
  onOpenChange,
  base,
  onApproved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  base: number;
  onApproved: (
    reference: string,
    amount: number,
    cardType: "debit" | "credit",
  ) => void;
}) {
  const { toast } = useToast();
  const [phase, setPhase] = useState<Phase>("device");
  const [device, setDevice] = useState<string | null>(null);
  const [intentId, setIntentId] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string>("");
  const firedRef = useRef(false);

  // Lectores Point de la cuenta MP conectada (solo con el modal abierto).
  const {
    data: devices,
    isLoading: devicesLoading,
    isError: devicesError,
    refetch: refetchDevices,
  } = useQuery({
    queryKey: ["point-devices"],
    enabled: open,
    staleTime: 60_000,
    retry: 1,
    queryFn: () => posApi.pointDevices(),
  });

  // Al abrir: reset + preseleccionar el último lector usado.
  useEffect(() => {
    if (!open) return;
    setPhase("device");
    setIntentId(null);
    setErrorDetail("");
    firedRef.current = false;
    try {
      setDevice(window.localStorage.getItem(DEVICE_LS_KEY));
    } catch {
      setDevice(null);
    }
  }, [open]);

  // Un solo lector → seleccionarlo directo.
  useEffect(() => {
    if (!open || !devices) return;
    if (!device && devices.length === 1 && devices[0]) setDevice(devices[0].id);
    // Si el recordado ya no existe en la cuenta, lo limpiamos.
    if (device && devices.length > 0 && !devices.some((d) => d.id === device)) {
      setDevice(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, devices]);

  // Sondeo del estado mientras el cobro está en el lector.
  useEffect(() => {
    if (!open || phase !== "on_terminal" || !intentId) return;
    let alive = true;
    const tick = async () => {
      try {
        const r = await posApi.pointIntentStatus(intentId);
        if (!alive) return;
        if (r.status === "approved" && !firedRef.current) {
          firedRef.current = true;
          onApproved(intentId, base, r.card_type ?? "credit");
          return;
        }
        if (r.status === "rejected") {
          setErrorDetail("El pago fue rechazado en el lector.");
          setPhase("error");
          return;
        }
        if (r.status === "cancelled") {
          setErrorDetail("El cobro se canceló.");
          setPhase("error");
          return;
        }
      } catch {
        /* transitorio: el próximo tick reintenta */
      }
      if (alive) timer = setTimeout(tick, 2500);
    };
    let timer = setTimeout(tick, 2500);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, phase, intentId]);

  function start() {
    if (!device) return;
    setPhase("creating");
    try {
      window.localStorage.setItem(DEVICE_LS_KEY, device);
    } catch {
      /* sin persistencia, no bloquea */
    }
    posApi
      .createPointIntent(device, base)
      .then((r) => {
        setIntentId(r.intent_id);
        setPhase("on_terminal");
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : "";
        setErrorDetail(
          msg === "payment_method_not_allowed"
            ? "Tu plan no incluye Mercado Point."
            : msg === "not_connected"
              ? "Conectá tu cuenta de Mercado Pago en Medios de pago."
              : "No se pudo enviar el cobro al lector. ¿Está encendido y en modo PDV?",
        );
        setPhase("error");
      });
  }

  function cancel() {
    if (intentId) posApi.cancelPointIntent(intentId).catch(() => null);
    onOpenChange(false);
  }

  const selected = devices?.find((d) => d.id === device) ?? null;
  const needsPdv = selected != null && selected.operating_mode !== "PDV";

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o && phase === "on_terminal") {
          cancel();
          return;
        }
        onOpenChange(o);
      }}
      title="Cobrar con Mercado Point"
      description={`Total a cobrar: ${formatCurrency(base)} · el cliente paga con tarjeta en el lector.`}
      className="max-w-md"
    >
      {phase === "device" && (
        <div className="space-y-4">
          {devicesLoading ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Spinner size={18} /> Buscando lectores Point de tu cuenta…
            </div>
          ) : devicesError ? (
            <div className="rounded-lg border border-danger/40 bg-destructive/10 p-3 text-sm">
              No pudimos listar tus lectores. Revisá la conexión con Mercado
              Pago en Medios de pago.
            </div>
          ) : (devices?.length ?? 0) === 0 ? (
            <div className="rounded-lg border border-border bg-muted/50 p-4 text-sm text-muted-foreground">
              Tu cuenta de Mercado Pago no tiene lectores Point asociados.
              Vinculá el lector desde la app de Mercado Pago y volvé a intentar.
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-sm font-medium">Elegí el lector</p>
              <div className="grid gap-2">
                {(devices ?? []).map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => setDevice(d.id)}
                    className={cn(
                      "flex items-center justify-between rounded-lg border p-3 text-left text-sm transition",
                      device === d.id
                        ? "border-ninja-flame ring-2 ring-ninja-flame/30"
                        : "border-border hover:border-ninja-flameSoft/40",
                    )}
                  >
                    <span className="flex items-center gap-2 font-medium">
                      <CreditCard size={15} className="text-ninja-flameSoft" />
                      {d.id}
                    </span>
                    <span
                      className={cn(
                        "text-xs",
                        d.operating_mode === "PDV"
                          ? "text-success"
                          : "text-warning",
                      )}
                    >
                      {d.operating_mode === "PDV" ? "Listo (PDV)" : d.operating_mode}
                    </span>
                  </button>
                ))}
              </div>
              {needsPdv && (
                <div className="flex items-center justify-between gap-2 rounded-lg border border-warning/40 bg-ninja-flame/[0.06] p-3 text-xs text-muted-foreground">
                  <span>
                    El lector tiene que estar en <strong>modo PDV</strong> para
                    recibir cobros del POS.
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      posApi
                        .pointSetPdv(device!)
                        .then(() => refetchDevices())
                        .then(() =>
                          toast({ title: "Lector en modo PDV", variant: "success" }),
                        )
                        .catch(() =>
                          toast({
                            title: "No se pudo cambiar el modo",
                            description: "Hacelo desde la config del lector.",
                            variant: "error",
                          }),
                        )
                    }
                  >
                    Poner en PDV
                  </Button>
                </div>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button disabled={!device || needsPdv} onClick={start}>
              <CreditCard size={16} /> Enviar al lector
            </Button>
          </div>
        </div>
      )}

      {phase === "creating" && (
        <div className="flex items-center gap-3 py-8 text-sm text-muted-foreground">
          <Spinner size={20} /> Enviando el cobro al lector…
        </div>
      )}

      {phase === "on_terminal" && (
        <div className="space-y-5 py-2 text-center">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-ninja-flame/12 text-ninja-flameSoft">
            <CreditCard size={26} />
          </span>
          <div>
            <p className="font-semibold">
              Cobro de {formatCurrency(base)} en el lector
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Pedile al cliente que pase o apoye la tarjeta en el Point. La
              venta se registra sola cuando el pago se apruebe.
            </p>
          </div>
          <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
            <Spinner size={14} /> Esperando el pago…
          </div>
          <div className="flex justify-center">
            <Button variant="secondary" onClick={cancel}>
              <XCircle size={15} /> Cancelar cobro
            </Button>
          </div>
        </div>
      )}

      {phase === "error" && (
        <div className="space-y-4">
          <div className="rounded-lg border border-danger/40 bg-destructive/10 p-3 text-sm">
            {errorDetail || "No se pudo completar el cobro."}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cerrar
            </Button>
            <Button
              onClick={() => {
                setPhase("device");
                setErrorDetail("");
              }}
            >
              <RefreshCw size={15} /> Reintentar
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
