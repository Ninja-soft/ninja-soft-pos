"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CreditCard, RefreshCw, XCircle } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { choiceClass } from "@/components/ui/ChoiceCard";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import { posApi } from "@/modules/pos/api";

// F8 · H15 (resto) — Cobro presencial con lectores Mercado Point.
// Flujo: elegir lector → la Edge mp_point empuja una order "point" (Orders
// API, ADR-032) AL dispositivo → el cliente pasa/apoya la tarjeta en el Point
// → el POS sondea el estado y, con "approved" (pago processed + monto exacto),
// registra la venta como débito/crédito según la tarjeta usada. Por defecto
// medio y cuotas se eligen en el lector; el cajero puede preseleccionar
// débito o crédito en cuotas (las cuotas preconfiguradas requieren que MP las
// haya habilitado en la cuenta).
//
// El último lector usado se recuerda por caja (localStorage) para que el cobro
// habitual sea de un toque.
//
// H21c: el mismo modal cobra con Nave Point (provider "nave_point", Edge
// nave_point): las terminales son los ids de punto de venta cargados en la
// conexión de Nave (no hay modo PDV) y Nave empuja el cobro a esa terminal.

const DEVICE_LS_KEY = "ninja-point-device";

type Phase = "device" | "creating" | "on_terminal" | "cancelling" | "error";

// Preselección del medio en el lector. "reader" = lo elige el cliente ahí.
type PayPreset = "reader" | "debit" | "c1" | "c3" | "c6" | "c12";
const PRESETS: { key: PayPreset; label: string }[] = [
  { key: "reader", label: "En el lector" },
  { key: "debit", label: "Débito" },
  { key: "c1", label: "Crédito 1 pago" },
  { key: "c3", label: "3 cuotas" },
  { key: "c6", label: "6 cuotas" },
  { key: "c12", label: "12 cuotas" },
];
type PresetOpts = { installments?: number; defaultType?: "debit_card" | "credit_card" };
// Sólo Mercado Point acepta preselección (Nave resuelve medio y cuotas en la
// terminal): para nave_point el selector no se muestra y no se envía nada.
function presetOpts(p: PayPreset): PresetOpts | undefined {
  if (p === "reader") return undefined;
  if (p === "debit") return { defaultType: "debit_card" };
  const n = Number(p.slice(1));
  return n > 1 ? { installments: n } : { defaultType: "credit_card" };
}

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
    create: (deviceId: string, amount: number, opts?: PresetOpts) => Promise<{ intent_id: string }>;
    status: (intentId: string) => Promise<PointStatus>;
    // MP (Orders API) devuelve si la cancelación quedó pedida en la terminal
    // (asíncrona); Nave da de baja al toque (void).
    cancel: (intentId: string) => Promise<{ status: string; cancel_requested: boolean } | void>;
  }
> = {
  mercadopago_point: {
    devices: () => posApi.pointDevices(),
    create: (d, a, o) => posApi.createPointIntent(d, a, o),
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
  const [preset, setPreset] = useState<PayPreset>("reader");
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
    setPreset("reader");
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

  // Sondeo del estado mientras el cobro está en el lector (o mientras se
  // cancela desde el POS: si el cliente ya pagó, la venta se registra igual).
  useEffect(() => {
    if (!open || (phase !== "on_terminal" && phase !== "cancelling") || !intentId) return;
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
        if (r.status === "cancelled" || r.status === "expired") {
          if (phase === "cancelling") {
            onOpenChange(false);
            return;
          }
          setErrorDetail(
            r.status === "expired"
              ? "El cobro venció en el lector."
              : (r.reason && NAVE_REASON_COPY[r.reason]) || "El cobro se canceló.",
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
      .create(device, base, isNave ? undefined : presetOpts(preset))
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
                : preset !== "reader"
                  ? "No se pudo enviar el cobro al lector. Si elegiste cuotas, puede que Mercado Pago no las tenga habilitadas en tu cuenta: probá con En el lector."
                  : "No se pudo enviar el cobro al lector. ¿Está encendido y en modo PDV?",
        );
        setPhase("error");
      });
  }

  // Cancelar: si la order sigue sin tomar en el lector se cancela al toque;
  // si ya está en la terminal, MP la cancela de forma asíncrona (202) y el
  // modal espera la confirmación sondeando (nunca se pierde un pago hecho).
  function cancel() {
    if (!intentId) {
      onOpenChange(false);
      return;
    }
    setPhase("cancelling");
    api
      .cancel(intentId)
      .then((r) => {
        // Nave (void) o MP que ya resolvió la order: se cierra. MP con la
        // cancelación pedida en la terminal: se espera el "cancelled" del poll.
        if (!r || (!r.cancel_requested && r.status !== "pending" && r.status !== "approved")) {
          onOpenChange(false);
        }
      })
      .catch(() => onOpenChange(false));
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
        if (!o && phase === "cancelling") return;
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
              {isNave ? "Buscando tus terminales Nave" : "Buscando lectores Point de tu cuenta"}
            </div>
          ) : devicesError ? (
            <div className="rounded-xl bg-danger/10 p-3 text-sm">
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
                    className={choiceClass(device === d.id, "flex items-center justify-between p-3 text-sm", {
                      check: false,
                    })}
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
                <div className="flex items-center justify-between gap-2 rounded-xl bg-warning/10 p-3 text-xs text-muted-foreground">
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

          {!isNave && (devices?.length ?? 0) > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium">Medio en el lector</p>
              <div className="grid grid-cols-3 gap-2">
                {PRESETS.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => setPreset(p.key)}
                    className={choiceClass(
                      preset === p.key,
                      cn("px-2 py-2 text-center text-xs", preset === p.key ? "font-semibold" : "text-muted-foreground"),
                      { check: false },
                    )}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
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
          <Spinner size={20} /> {isNave ? "Enviando el cobro a la terminal" : "Enviando el cobro al lector"}
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
            <Spinner size={14} /> Esperando el pago
          </div>
          <div className="flex justify-center">
            <Button variant="secondary" onClick={cancel}>
              <XCircle size={15} /> Cancelar cobro
            </Button>
          </div>
        </div>
      )}

      {phase === "cancelling" && (
        <div className="flex flex-col items-center gap-3 py-8 text-center text-sm text-muted-foreground">
          <Spinner size={22} />
          <p>
            Cancelando el cobro en el lector. Si el cliente ya pagó, la venta se
            registra igual.
          </p>
          <p className="text-xs">
            Si {isNave ? "la terminal no responde, cancelalo también desde la terminal Nave" : "el lector no responde, cancelalo también desde el Point"}.
          </p>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cerrar igual
          </Button>
        </div>
      )}

      {phase === "error" && (
        <div className="space-y-4">
          <div className="rounded-xl bg-danger/10 p-3 text-sm">
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
