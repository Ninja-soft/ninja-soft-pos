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
//
// H21c: el mismo modal cobra con Nave Point (provider "nave_point", Edge
// nave_point): las terminales son los ids de punto de venta cargados en la
// conexión de Nave (no hay modo PDV) y Nave empuja el cobro a esa terminal.

const DEVICE_LS_KEY = "ninja-point-device";

type PointProvider = "mercadopago_point" | "nave_point";
type PointDevice = { id: string; operating_mode: string; label?: string };
type PointStatus = {
  status: string;
  card_type: "debit" | "credit" | null;
  reason?: string | null;
};

// Motivos de baja que informa Nave para una intención en la terminal.
const NAVE_REASON_COPY: Record<string, string> = {
  low_battery: "La terminal tiene poca batería (menos de 5%). Cargala y reintentá.",
  "low battery": "La terminal tiene poca batería (menos de 5%). Cargala y reintentá.",
  manual_disabled_by_user: "El cobro se canceló desde la terminal.",
  device_already_on_payment_flow: "La terminal está ocupada con otro cobro.",
  disabled_by_user_timeout: "La terminal no respondió a tiempo y el cobro se dio de baja.",
};

const API: Record<
  PointProvider,
  {
    devices: () => Promise<PointDevice[]>;
    create: (deviceId: string, amount: number) => Promise<{ intent_id: string }>;
    status: (intentId: string) => Promise<PointStatus>;
    cancel: (intentId: string) => Promise<void>;
  }
> = {
  mercadopago_point: {
    devices: () => posApi.pointDevices(),
    create: (d, a) => posApi.createPointIntent(d, a),
    status: (id) => posApi.pointIntentStatus(id),
    cancel: (id) => posApi.cancelPointIntent(id),
  },
  nave_point: {
    devices: async () =>
      (await posApi.navePointDevices()).map((d) => ({ ...d, operating_mode: "PDV" })),
    create: (d, a) => posApi.createNavePointIntent(d, a),
    status: (id) => posApi.navePointIntentStatus(id),
    cancel: (id) => posApi.cancelNavePointIntent(id),
  },
};

type Phase = "device" | "creating" | "on_terminal" | "error";

export function PointCheckoutModal({
  open,
  onOpenChange,
  base,
  onApproved,
  provider = "mercadopago_point",
}: {
  provider?: PointProvider;
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
  const isNave = provider === "nave_point";
  const brand = isNave ? "Nave Point" : "Mercado Point";
  const lsKey = isNave ? `${DEVICE_LS_KEY}-nave` : DEVICE_LS_KEY;
  const api = API[provider];

  // Lectores Point de la cuenta MP conectada (solo con el modal abierto).
  const {
    data: devices,
    isLoading: devicesLoading,
    isError: devicesError,
    refetch: refetchDevices,
  } = useQuery({
    queryKey: ["point-devices", provider],
    enabled: open,
    staleTime: 60_000,
    retry: 1,
    queryFn: () => api.devices(),
  });

  // Al abrir: reset + preseleccionar el último lector usado.
  useEffect(() => {
    if (!open) return;
    setPhase("device");
    setIntentId(null);
    setErrorDetail("");
    firedRef.current = false;
    try {
      setDevice(window.localStorage.getItem(lsKey));
    } catch {
      setDevice(null);
    }
  }, [open, lsKey]);

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
        const r = await api.status(intentId);
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
          setErrorDetail(
            (r.reason && NAVE_REASON_COPY[r.reason]) || "El cobro se canceló.",
          );
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
      window.localStorage.setItem(lsKey, device);
    } catch {
      /* sin persistencia, no bloquea */
    }
    api
      .create(device, base)
      .then((r) => {
        setIntentId(r.intent_id);
        setPhase("on_terminal");
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : "";
        setErrorDetail(
          msg === "payment_method_not_allowed"
            ? `Tu plan no incluye ${brand}.`
            : msg === "not_connected"
              ? isNave
                ? "Conectá tu cuenta de Nave en Medios de pago."
                : "Conectá tu cuenta de Mercado Pago en Medios de pago."
              : isNave
                ? "No se pudo enviar el cobro a la terminal Nave. ¿Está encendida y con el punto de venta correcto?"
                : "No se pudo enviar el cobro al lector. ¿Está encendido y en modo PDV?",
        );
        setPhase("error");
      });
  }

  function cancel() {
    if (intentId) api.cancel(intentId).catch(() => null);
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
      title={`Cobrar con ${brand}`}
      description={`Total a cobrar: ${formatCurrency(base)} · el cliente paga con tarjeta en el lector.`}
      className="max-w-md"
    >
      {phase === "device" && (
        <div className="space-y-4">
          {devicesLoading ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Spinner size={18} />{" "}
              {isNave ? "Buscando tus terminales Nave…" : "Buscando lectores Point de tu cuenta…"}
            </div>
          ) : devicesError ? (
            <div className="rounded-lg border border-danger/40 bg-destructive/10 p-3 text-sm">
              No pudimos listar tus lectores. Revisá la conexión con{" "}
              {isNave ? "Nave" : "Mercado Pago"} en Medios de pago.
            </div>
          ) : (devices?.length ?? 0) === 0 ? (
            <div className="rounded-lg border border-border bg-muted/50 p-4 text-sm text-muted-foreground">
              {isNave
                ? "No hay terminales Nave Point cargadas. Agregá el ID de punto de venta de cada terminal al conectar Nave en Medios de pago."
                : "Tu cuenta de Mercado Pago no tiene lectores Point asociados. Vinculá el lector desde la app de Mercado Pago y volvé a intentar."}
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
                      {d.label ?? d.id}
                    </span>
                    <span
                      className={cn(
                        "text-xs",
                        d.operating_mode === "PDV"
                          ? "text-success"
                          : "text-warning",
                      )}
                    >
                      {isNave
                        ? "Listo"
                        : d.operating_mode === "PDV"
                          ? "Listo (PDV)"
                          : d.operating_mode}
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
              {isNave
                ? "Pedile al cliente que pague en la terminal Nave (tarjeta, contactless o QR)."
                : "Pedile al cliente que pase o apoye la tarjeta en el Point."}{" "}
              La venta se registra sola cuando el pago se apruebe.
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
