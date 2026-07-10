"use client";

import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { posApi, type PaymentPlan } from "@/modules/pos/api";
import { useProviderPlans } from "@/modules/pos/hooks";
import { BASE_LABEL, BRAND_LABEL, brandLogo } from "@/modules/pos/planConstants";
import { createClient } from "@/lib/supabase/client";
import { formatCurrency } from "@/lib/utils/format";

type Phase = "select" | "creating" | "waiting" | "approved" | "rejected" | "error";

const round2 = (n: number) => Math.round(n * 100) / 100;

function planText(p: PaymentPlan) {
  const cuotas =
    (p.installments ?? 1) > 1 ? `${p.installments} cuotas` : p.base === "credito" ? "1 pago" : "Pago";
  return `${BASE_LABEL[p.base ?? "otro"] ?? p.base} · ${cuotas}`;
}

// Cobro por QR (Mercado Pago / Mobbex / MODO). Sin planes configurados → genera
// el QR directo. Con planes → el cajero elige la tarjeta (por logo) y la cuota
// (por botón, con el total ya calculado). El recargo del plan se suma al monto.
// MODO resuelve las cuotas en su propia app (las elige el cliente) → el POS sólo
// manda el monto base y no muestra la pantalla de selección de tarjeta/cuota.
export function QrCheckoutModal({
  open,
  onOpenChange,
  base,
  onApproved,
  provider = "mercadopago",
  providerName = "Mercado Pago",
  onQrState,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  base: number;
  onApproved: (
    reference: string,
    amount: number,
    extras: { name: string; amount: number; kind: "warranty" | "surcharge" }[],
  ) => void;
  provider?: "mercadopago" | "mobbex" | "modo";
  providerName?: string;
  // Notifica el QR de cobro activo a la pantalla del cliente (H25). Se llama con
  // el init_point + monto cuando el QR está listo para escanear (fase waiting), y
  // con null cuando ya no hay QR activo (se cerró o cambió de fase).
  onQrState?: (qr: { initPoint: string; amount: number; providerName: string } | null) => void;
}) {
  // Proveedor que maneja su propia selección de cuotas en su app (MODO): las
  // cuotas las define el cliente en la app de MODO, así que el POS no muestra la
  // pantalla de planes y auto-arranca con el monto base. Mercado Pago y Mobbex
  // sí ofrecen la selección de tarjeta/cuota desde el POS.
  const selfManaged = provider === "modo";
  const { toast } = useToast();
  const [phase, setPhase] = useState<Phase>("select");
  const [brand, setBrand] = useState<string | null>(null);
  const [amount, setAmount] = useState(base);
  const [intentId, setIntentId] = useState<string | null>(null);
  const [initPoint, setInitPoint] = useState("");
  const firedRef = useRef(false);
  const startedRef = useRef(false);
  const chosenRef = useRef<{ label: string; surcharge: number } | null>(null);

  const { data: plans = [], isLoading } = useProviderPlans(open ? provider : null);
  // Config del medio: modo "recargo único" + su %.
  const { data: methodCfg } = useQuery({
    queryKey: ["qr-method-cfg", provider],
    enabled: open,
    queryFn: async () => {
      const supabase = createClient();
      const { data } = await supabase
        .from("tenant_payment_methods")
        .select("config, surcharge_pct")
        .eq("provider_key", provider)
        .maybeSingle();
      return {
        mode: ((data?.config as { plan_mode?: string } | null)?.plan_mode ?? "plans") as string,
        pct: Number(data?.surcharge_pct) || 0,
      };
    },
  });
  const globalMode = methodCfg?.mode === "global";
  const globalPct = methodCfg?.pct ?? 0;
  const loadingAll = isLoading || methodCfg === undefined;
  const activePlans = useMemo(() => plans.filter((p) => p.is_active), [plans]);
  const brands = useMemo(
    () => [...new Set(activePlans.map((p) => p.brand).filter(Boolean) as string[])],
    [activePlans],
  );
  const brandPlans = useMemo(
    () =>
      activePlans
        .filter((p) => p.brand === brand)
        .sort((a, b) => (a.installments ?? 1) - (b.installments ?? 1)),
    [activePlans, brand],
  );

  function startQr(amt: number) {
    setAmount(amt);
    setPhase("creating");
    const create =
      provider === "mobbex"
        ? posApi.createMobbexQr
        : provider === "modo"
          ? posApi.createModoQr
          : posApi.createMpQr;
    create(amt, "Venta NinjaPos")
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
              ? `Conectá ${providerName} en Configuración`
              : "No se pudo generar el QR",
          variant: "error",
        });
      });
  }

  function pickPlan(p: PaymentPlan) {
    const sc = round2((base * (Number(p.surcharge_pct) || 0)) / 100);
    chosenRef.current = sc > 0 ? { label: p.label, surcharge: sc } : null;
    startQr(round2(base + sc));
  }
  function payNoPlan() {
    chosenRef.current = null;
    startQr(base);
  }

  // Reset al abrir.
  useEffect(() => {
    if (!open) return;
    setPhase("select");
    setBrand(null);
    setAmount(base);
    setIntentId(null);
    setInitPoint("");
    firedRef.current = false;
    startedRef.current = false;
    chosenRef.current = null;
  }, [open, base]);

  // Auto-arranque sin selección:
  //  - MODO maneja las cuotas en su app → mandamos el base (las cuotas las
  //    resuelve el cliente en MODO; no aplicamos recargo de precio acá).
  //  - modo recargo único → aplica el % global y genera el QR
  //  - sin planes activos → genera el QR por el monto base
  useEffect(() => {
    if (!open || loadingAll || startedRef.current) return;
    if (selfManaged) {
      startedRef.current = true;
      chosenRef.current = null;
      startQr(base);
    } else if (globalMode) {
      startedRef.current = true;
      const sc = round2((base * globalPct) / 100);
      chosenRef.current = sc > 0 ? { label: "Recargo único", surcharge: sc } : null;
      startQr(round2(base + sc));
    } else if (activePlans.length === 0) {
      startedRef.current = true;
      startQr(base);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, loadingAll, globalMode, globalPct, activePlans.length]);

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
      const c = chosenRef.current;
      const extras = c
        ? [{ name: `Recargo ${c.label}`, amount: c.surcharge, kind: "surcharge" as const }]
        : [];
      // El `reference` de la línea qr DEBE ser el intent id (uuid): create_sale lo
      // resuelve contra mp_payment_intents.id para exigir status='approved',
      // validar el monto y anclar sale_id (idempotencia real). Antes acá iba el
      // mp_payment_id numérico, que NUNCA matcheaba el regex uuid del server →
      // la validación quedaba inerte. El mp_payment_id solo sirve para logging.
      onApproved(intentId ?? "", amount, extras);
    } else if (status.status === "rejected" || status.status === "cancelled") {
      setPhase("rejected");
    }
  }, [status, onApproved, intentId, amount]);

  // Espeja el QR de cobro activo a la pantalla del cliente (H25): cuando el QR
  // está listo (waiting), publica init_point + monto; en cualquier otro caso
  // (cerrado / aprobado / rechazado / sin link) limpia. El callback es estable
  // de parte del POS (no se incluye en deps para evitar re-disparos).
  useEffect(() => {
    if (!onQrState) return;
    if (open && phase === "waiting" && initPoint) {
      onQrState({ initPoint, amount, providerName });
    } else {
      onQrState(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, phase, initPoint, amount, providerName]);

  const qrSrc = initPoint
    ? `https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${encodeURIComponent(initPoint)}`
    : "";

  // Pantalla de selección: MP / Mobbex con planes y sin modo recargo único.
  // MODO no la usa (sus cuotas se eligen en la app del cliente).
  const selecting =
    phase === "select" && !selfManaged && !globalMode && (loadingAll || activePlans.length > 0);

  const providerLogo =
    provider === "mobbex"
      ? "/img/medios_de_pago/Mobbex_cube.webp"
      : provider === "modo"
        ? "/img/medios_de_pago/Modo_cube.webp"
        : "/img/medios_de_pago/mercado_pago_cube.webp";

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={`Cobrar con QR · ${providerName}`}>
      <div className="space-y-4 text-center">
        <div className="flex items-center justify-center py-1">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={providerLogo} alt={providerName} className="h-12 w-auto object-contain" />
        </div>

        {selecting && (
          <div className="space-y-3 text-left">
            {loadingAll ? (
              <div className="flex justify-center py-6">
                <Spinner size={24} />
              </div>
            ) : !brand ? (
              <>
                <div className="text-sm font-medium">Elegí la tarjeta</div>
                <div className="grid grid-cols-3 gap-2">
                  {brands.map((b) => {
                    const logo = brandLogo(b);
                    return (
                      <button
                        key={b}
                        onClick={() => setBrand(b)}
                        className="flex flex-col items-center gap-1 rounded-lg border border-border p-3 transition hover:border-ninja-flameSoft hover:bg-ninja-flame/5"
                      >
                        {logo ? (
                          <Image src={logo} alt={b} width={48} height={30} className="h-7 w-auto object-contain" />
                        ) : (
                          <span className="h-7" />
                        )}
                        <span className="text-xs">{BRAND_LABEL[b] ?? b}</span>
                      </button>
                    );
                  })}
                </div>
                <button
                  onClick={payNoPlan}
                  className="w-full rounded-lg border border-dashed border-border py-2 text-sm text-muted-foreground transition hover:border-ninja-flameSoft hover:text-foreground"
                >
                  Sin plan · contado ({formatCurrency(base)})
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => setBrand(null)}
                  className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
                >
                  <ChevronLeft size={15} /> {BRAND_LABEL[brand] ?? brand}
                </button>
                <div className="text-sm font-medium">Elegí el plan</div>
                <div className="grid grid-cols-2 gap-2">
                  {brandPlans.map((p) => {
                    const sc = round2((base * (Number(p.surcharge_pct) || 0)) / 100);
                    const total = round2(base + sc);
                    return (
                      <button
                        key={p.id}
                        onClick={() => pickPlan(p)}
                        className="flex flex-col items-start gap-0.5 rounded-lg border border-border p-3 text-left transition hover:border-ninja-flameSoft hover:bg-ninja-flame/5"
                      >
                        <span className="text-xs text-muted-foreground">{planText(p)}</span>
                        <span className="price-hl font-price text-lg font-black tabular-nums">
                          {formatCurrency(total)}
                        </span>
                        {sc > 0 ? (
                          <span className="text-[11px] text-ninja-flameSoft">
                            +{p.surcharge_pct}% ({formatCurrency(sc)})
                          </span>
                        ) : (
                          <span className="text-[11px] text-emerald-400">sin recargo</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
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
                alt={`QR de pago ${providerName}`}
                className="rounded-lg border border-border bg-white p-2"
                width={260}
                height={260}
              />
            </div>
            <p className="text-sm text-muted-foreground">
              El cliente escanea el QR para pagar con {providerName}. La pantalla se
              actualiza sola al acreditarse.
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
            <div className="text-lg font-bold text-danger">Pago rechazado o cancelado</div>
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

        {(phase === "creating" || phase === "waiting" || selecting) && (
          <Button variant="ghost" className="w-full" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
        )}
      </div>
    </Modal>
  );
}
