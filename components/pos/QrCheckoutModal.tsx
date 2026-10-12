"use client";

import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, Copy, Link2, Share2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { posApi, type PaymentPlan } from "@/modules/pos/api";
import { useProviderPlans } from "@/modules/pos/hooks";
import { BASE_LABEL, BRAND_LABEL, brandLogo } from "@/modules/pos/planConstants";
import { createClient } from "@/lib/supabase/client";
import { formatCurrency } from "@/lib/utils/format";
import { encodeQr, qrSvgPath } from "@/lib/qr/qrcode";

type Phase = "select" | "creating" | "waiting" | "approved" | "rejected" | "error";
// Canal de Mercado Pago (ADR-032): "order" = QR dinámico de la caja (Orders
// API, se escanea en el local); "link" = Checkout Pro (link compartible).
type MpChannel = "order" | "link";

// QR dibujado local (SVG) a partir del texto: el qr_data EMVCo de MP o el
// link de pago. Sin servicios externos de imágenes.
function LocalQr({ value, label, size = 260 }: { value: string; label: string; size?: number }) {
  const svg = useMemo(() => {
    try {
      const qr = encodeQr(value, "M");
      return { path: qrSvgPath(qr, 4), dim: qr.size + 8 };
    } catch {
      return null;
    }
  }, [value]);
  if (!svg) return null;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${svg.dim} ${svg.dim}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className="rounded-lg border border-border bg-white"
    >
      <rect width={svg.dim} height={svg.dim} fill="#fff" />
      <path d={svg.path} fill="#000" />
    </svg>
  );
}

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
// Código de error estable de una Edge de cobro. posApi lanza Error(code) cuando
// la Edge devolvió 200 con { error }, y FunctionsHttpError (cuerpo real en
// error.context) cuando devolvió non-2xx: acá se lee de donde venga.
async function edgeErrorCode(e: unknown): Promise<{ code: string; detail?: string }> {
  const ctx = (e as { context?: Response })?.context;
  if (ctx) {
    const body = (await ctx.json().catch(() => null)) as {
      error?: string;
      detail?: string;
    } | null;
    if (body?.error) return { code: body.error, detail: body.detail };
  }
  return { code: e instanceof Error ? e.message : "" };
}

// Copy honesto por código y proveedor (antes todo caía a un genérico que
// mencionaba a Mercado Pago aunque el cobro fuera de MODO/Mobbex/Pagos360).
function qrErrorCopy(code: string, providerName: string): string {
  switch (code) {
    case "not_connected":
      return `Conectá ${providerName} en Configuración → Medios de pago.`;
    case "payment_method_not_allowed":
      return `Tu plan no incluye ${providerName}. Mejorá tu plan para cobrar con este medio.`;
    case "modo_no_token":
      return "MODO rechazó las credenciales del comercio (Username/Password). Verificá que el ambiente coincida con el switch Sandbox o consultá a MODO si falta activarlas.";
    case "getnet_no_token":
      return "Getnet rechazó las credenciales (Client ID / Client Secret). Revisalas en Configuración → Medios de pago.";
    case "mp_error":
    case "mobbex_error":
    case "modo_error":
    case "pagos360_error":
    case "payway_error":
    case "getnet_error":
    case "nave_error":
      return `${providerName} devolvió un error al crear el cobro. Probá de nuevo en unos segundos.`;
    case "gocuotas_min_amount":
      return "GO Cuotas acepta cobros desde $1.500. Para montos menores usá otro medio de pago.";
    case "gocuotas_auth_failed":
      return "GO Cuotas rechazó la API Key de la sucursal. Verificá que sea del mismo ambiente que el switch Sandbox del medio.";
    case "gocuotas_error":
      return "GO Cuotas devolvió un error al crear el cobro. Probá de nuevo en unos segundos.";
    case "nave_auth_failed":
      return "Nave rechazó las credenciales (Client ID / Client Secret). Verificá que el ambiente coincida con el switch Sandbox del medio.";
    case "nave_unreachable":
      return "No pudimos comunicarnos con Nave. Revisá tu conexión y probá de nuevo.";
    case "qr_pos_not_found":
      return "Mercado Pago no encuentra la caja QR del negocio. Volvé a configurarla en Configuración → Medios de pago.";
    case "modo_unreachable":
      return "No pudimos comunicarnos con MODO. Revisá tu conexión y probá de nuevo.";
    default:
      return `No se pudo generar el cobro con ${providerName}.`;
  }
}

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
  provider?:
    | "mercadopago"
    | "mobbex"
    | "modo"
    | "pagos360"
    | "payway"
    | "getnet"
    | "nave"
    | "gocuotas";
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
  // MODO y Pagos360 resuelven medio/cuotas en su propia app/checkout hosted.
  // Payway abre el checkout PROPIO de la tienda (/pagar/{intent}): el CLIENTE
  // elige tarjeta y cuotas ahí (Planes del negocio, recargo en vivo) → acá se
  // auto-arranca con el monto base y el total final viene en el poll.
  // Getnet: checkout hosted de Getnet (tarjeta y cuotas se eligen ahí).
  // Nave: QR interoperable (cualquier billetera/banco) + checkout hosted de
  // Nave; medio y cuotas se resuelven del lado de Nave.
  // GO Cuotas: checkout de GO Cuotas (el cliente elige 2 a 4 cuotas con su
  // débito ahí).
  const selfManaged =
    provider === "modo" ||
    provider === "pagos360" ||
    provider === "payway" ||
    provider === "getnet" ||
    provider === "nave" ||
    provider === "gocuotas";
  const { toast } = useToast();
  const [phase, setPhase] = useState<Phase>("select");
  const [brand, setBrand] = useState<string | null>(null);
  const [amount, setAmount] = useState(base);
  const [intentId, setIntentId] = useState<string | null>(null);
  const [initPoint, setInitPoint] = useState("");
  // Nave devuelve el QR EMV (qr_data) aparte del link: se codifica TAL CUAL.
  const [qrData, setQrData] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [mpChannel, setMpChannel] = useState<MpChannel>("order");
  const [switching, setSwitching] = useState(false);
  const firedRef = useRef(false);
  const startedRef = useRef(false);
  const chosenRef = useRef<{ label: string; surcharge: number } | null>(null);
  // Cuotas del plan elegido (solo Payway: viajan al formulario hosted).
  const instRef = useRef<number>(1);

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

  function onCreated(r: { intent_id: string; init_point: string; qr_data?: string }) {
    setIntentId(r.intent_id);
    setInitPoint(r.init_point);
    setQrData(r.qr_data ?? "");
    setPhase("waiting");
  }

  function onCreateError(code: string) {
    const msg = qrErrorCopy(code, providerName);
    setErrorMsg(msg);
    setPhase("error");
    toast({ title: msg, variant: "error" });
  }

  function startQr(amt: number) {
    setAmount(amt);
    setPhase("creating");
    // Mercado Pago: primero el QR dinámico de la caja (Orders API). Si el
    // negocio todavía no configuró su caja QR, cae al link de Checkout Pro
    // (comportamiento previo: el cliente lo escanea igual).
    if (provider === "mercadopago") {
      setMpChannel("order");
      posApi
        .createMpOrderQr(amt, "Venta NinjaPos")
        .then(onCreated)
        .catch(async (e) => {
          const { code } = await edgeErrorCode(e);
          if (code !== "qr_pos_not_configured") return onCreateError(code);
          setMpChannel("link");
          posApi
            .createMpQr(amt, "Venta NinjaPos")
            .then(onCreated)
            .catch(async (e2) => onCreateError((await edgeErrorCode(e2)).code));
        });
      return;
    }
    const create =
      provider === "mobbex"
        ? posApi.createMobbexQr
        : provider === "modo"
          ? posApi.createModoQr
          : provider === "pagos360"
            ? posApi.createPagos360Link
            : provider === "payway"
              ? posApi.createPaywayLink
              : provider === "getnet"
                ? posApi.createGetnetLink
                : provider === "nave"
                  ? posApi.createNaveQr
                  : provider === "gocuotas"
                    ? posApi.createGoCuotasLink
                    : posApi.createMpQr;
    create(amt, "Venta NinjaPos")
      .then(onCreated)
      .catch(async (e) => onCreateError((await edgeErrorCode(e)).code));
  }

  // "Enviar link" (sólo MP con QR de caja): cancela la order QR y genera un
  // link de Checkout Pro por el mismo monto, para mandar por WhatsApp o mail.
  // Antes de generar el link se cancela la order y se re-consulta su estado:
  // si el cliente justo pagó el QR, se registra ESE cobro (nunca dos cobros).
  async function switchToLink() {
    if (!intentId || switching) return;
    const prev = intentId;
    setSwitching(true);
    try {
      await posApi.cancelMpOrder(prev).catch(() => null);
      const last = await posApi.mpOrderStatus(prev).catch(() => null);
      if (last?.status === "approved") {
        if (!firedRef.current) {
          firedRef.current = true;
          setPhase("approved");
          const c = chosenRef.current;
          onApproved(
            prev,
            amount,
            c ? [{ name: `Recargo ${c.label}`, amount: c.surcharge, kind: "surcharge" }] : [],
          );
        }
        return;
      }
      if (!last || last.status === "pending") {
        // No se pudo cancelar (sigue pagable): no se ofrece un segundo cobro.
        toast({ title: "No se pudo cambiar a link. Probá de nuevo.", variant: "error" });
        return;
      }
      const r = await posApi.createMpQr(amount, "Venta NinjaPos");
      setMpChannel("link");
      onCreated(r);
    } catch (e) {
      onCreateError((await edgeErrorCode(e)).code);
    } finally {
      setSwitching(false);
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(initPoint);
      toast({ title: "Link copiado", variant: "success" });
    } catch {
      toast({ title: "No se pudo copiar el link", variant: "error" });
    }
  }

  async function shareLink() {
    if (typeof navigator.share !== "function") return copyLink();
    try {
      await navigator.share({
        title: "Link de pago",
        text: `Pagá ${formatCurrency(amount)}`,
        url: initPoint,
      });
    } catch {
      /* el usuario cerró el diálogo de compartir */
    }
  }

  // Cerrar el modal con un cobro abierto lo da de baja en el proveedor
  // (best-effort; si el cliente ya pagó, el pago gana y queda para conciliar
  // en Cobros QR):
  //  - Mercado Pago, order QR de la caja: se cancela para que el QR deje de
  //    ser pagable. El link de Checkout Pro NO se cancela (sigue siendo
  //    compartible y, si se paga, la conciliación lo muestra).
  //  - Nave: se da de baja la intención (QR EMV + link).
  //  - GO Cuotas: baja local del intent (Redirect no anula checkouts).
  function close() {
    if (intentId && phase === "waiting") {
      if (provider === "mercadopago" && mpChannel === "order") {
        posApi.cancelMpOrder(intentId).catch(() => null);
      } else if (provider === "nave") {
        posApi.cancelNaveIntent(intentId).catch(() => null);
      } else if (provider === "gocuotas") {
        posApi.cancelGoCuotasIntent(intentId).catch(() => null);
      }
    }
    onOpenChange(false);
  }

  function pickPlan(p: PaymentPlan) {
    const sc = round2((base * (Number(p.surcharge_pct) || 0)) / 100);
    chosenRef.current = sc > 0 ? { label: p.label, surcharge: sc } : null;
    instRef.current = Math.max(1, Number(p.installments) || 1);
    startQr(round2(base + sc));
  }
  function payNoPlan() {
    chosenRef.current = null;
    instRef.current = 1;
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
    setQrData("");
    setErrorMsg("");
    setMpChannel("order");
    setSwitching(false);
    firedRef.current = false;
    instRef.current = 1;
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
      // El medio puede definir un recargo % plano (input de Medios de pago):
      // se aplica acá porque el checkout hosted cobra el monto que le mandemos.
      const sc = round2((base * globalPct) / 100);
      chosenRef.current = sc > 0 ? { label: "Recargo", surcharge: sc } : null;
      startQr(round2(base + sc));
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
    queryKey: ["mp-intent", provider, mpChannel, intentId],
    // Mobbex/MODO y el link de MP actualizan el intent por webhook → basta
    // leer la fila. Pagos360 y el QR de caja de MP (Orders API) sincronizan
    // contra la API del proveedor en cada poll (no dependen del webhook).
    queryFn: () =>
      provider === "mercadopago" && mpChannel === "order"
        ? posApi.mpOrderStatus(intentId!)
        : provider === "pagos360"
        ? posApi.pagos360IntentStatus(intentId!)
        : provider === "modo"
          ? posApi.modoIntentStatus(intentId!)
          : provider === "payway"
            ? posApi.paywayIntentStatus(intentId!)
            : provider === "getnet"
              ? posApi.getnetIntentStatus(intentId!)
              : provider === "nave"
                ? posApi.naveIntentStatus(intentId!)
                : provider === "gocuotas"
                  ? posApi.gocuotasIntentStatus(intentId!)
                  : posApi.mpIntentStatus(intentId!),
    // Mientras se pasa del QR de caja al link no se sondea: la order vieja se
    // está cancelando y su "cancelled" no debe cerrar el cobro.
    enabled: open && phase === "waiting" && Boolean(intentId) && !switching,
    refetchInterval: 3000,
  });

  useEffect(() => {
    if (!status || firedRef.current || switching) return;
    if (status.status === "approved") {
      firedRef.current = true;
      setPhase("approved");
      // Payway (checkout propio): el cliente pudo elegir cuotas con recargo →
      // el total final viene en el poll y la venta se registra por ese monto.
      const polled = (status as { amount?: number }).amount;
      const finalAmount =
        provider === "payway" && typeof polled === "number" ? polled : amount;
      const c = chosenRef.current;
      const extras =
        provider === "payway" && finalAmount > amount
          ? [
              {
                name: "Recargo cuotas",
                amount: round2(finalAmount - amount),
                kind: "surcharge" as const,
              },
            ]
          : c
            ? [{ name: `Recargo ${c.label}`, amount: c.surcharge, kind: "surcharge" as const }]
            : [];
      // El `reference` de la línea qr DEBE ser el intent id (uuid): create_sale lo
      // resuelve contra mp_payment_intents.id para exigir status='approved',
      // validar el monto y anclar sale_id (idempotencia real). Antes acá iba el
      // mp_payment_id numérico, que NUNCA matcheaba el regex uuid del server →
      // la validación quedaba inerte. El mp_payment_id solo sirve para logging.
      onApproved(intentId ?? "", finalAmount, extras);
    } else if (status.status === "rejected" || status.status === "cancelled") {
      setPhase("rejected");
    }
  }, [status, onApproved, intentId, amount, provider, switching]);

  // Espeja el QR de cobro activo a la pantalla del cliente (H25): cuando el QR
  // está listo (waiting), publica init_point + monto; en cualquier otro caso
  // (cerrado / aprobado / rechazado / sin link) limpia. El callback es estable
  // de parte del POS (no se incluye en deps para evitar re-disparos).
  useEffect(() => {
    if (!onQrState) return;
    if (open && phase === "waiting" && initPoint) {
      // Nave: la pantalla del cliente muestra el QR interoperable (qr_data).
      onQrState({ initPoint: qrData || initPoint, amount, providerName });
    } else {
      onQrState(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, phase, initPoint, qrData, amount, providerName]);

  // Contenido del QR: qr_data cuando el proveedor lo devuelve aparte (Nave:
  // EMV interoperable, se codifica TAL CUAL); si no, init_point (la order QR
  // de MP ya trae su qr_data ahí; el resto es la URL del link de pago).
  const qrValue = qrData || initPoint;
  const isMpOrder = provider === "mercadopago" && mpChannel === "order";
  const isLink = !isMpOrder && /^https?:\/\//.test(initPoint);

  // Pantalla de selección: MP / Mobbex con planes y sin modo recargo único.
  // MODO no la usa (sus cuotas se eligen en la app del cliente).
  const selecting =
    phase === "select" && !selfManaged && !globalMode && (loadingAll || activePlans.length > 0);

  // Logo del proveedor REAL del cobro (antes todo lo no mapeado caía al logo
  // de Mercado Pago: Payway/Pagos360 mostraban la marca equivocada).
  const PROVIDER_LOGOS: Record<string, string> = {
    mercadopago: "/img/medios_de_pago/mercado_pago_cube.webp",
    mobbex: "/img/medios_de_pago/Mobbex_cube.webp",
    modo: "/img/medios_de_pago/Modo_cube.webp",
    pagos360: "/img/medios_de_pago/Pagos360_cube.webp",
    payway: "/img/medios_de_pago/payway_cube.webp",
    getnet: "/img/medios_de_pago/getnet_cube.webp",
    nave: "/img/medios_de_pago/nave_cube.webp",
    gocuotas: "/images/payments/gocuotas.webp",
  };
  const providerLogo =
    PROVIDER_LOGOS[provider] ?? "/img/medios_de_pago/mercado_pago_cube.webp";

  return (
    <Modal
      open={open}
      onOpenChange={(o) => (o ? onOpenChange(true) : close())}
      title={`Cobrar con QR · ${providerName}`}
    >
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
                          <span className="text-[11px] text-success">sin recargo</span>
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
            <span className="sr-only">Generando QR</span>
          </div>
        )}

        {phase === "waiting" && (
          <>
            <div className="flex justify-center">
              <LocalQr value={qrValue} label={`QR de pago ${providerName}`} />
            </div>
            <p className="text-sm text-muted-foreground">
              {isMpOrder
                ? "El cliente escanea el QR con la app de Mercado Pago o su billetera. La pantalla se actualiza sola al acreditarse."
                : `El cliente escanea el QR para pagar con ${providerName}. La pantalla se actualiza sola al acreditarse.`}
            </p>
            {isMpOrder ? (
              <Button variant="secondary" size="sm" disabled={switching} onClick={switchToLink}>
                {switching ? <Spinner size={14} /> : <Link2 size={14} />} Enviar link
              </Button>
            ) : (
              isLink && (
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <a
                    href={initPoint}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-block text-xs text-ninja-flameSoft hover:underline"
                  >
                    Abrir link de pago
                  </a>
                  {provider === "mercadopago" && (
                    <>
                      <Button variant="ghost" size="sm" onClick={copyLink}>
                        <Copy size={14} /> Copiar link
                      </Button>
                      <Button variant="ghost" size="sm" onClick={shareLink}>
                        <Share2 size={14} /> Compartir
                      </Button>
                    </>
                  )}
                </div>
              )
            )}
            <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
              <Spinner size={14} /> Esperando pago
            </div>
          </>
        )}

        {phase === "approved" && (
          <div className="py-8 text-success">
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
              {errorMsg ||
                `No se pudo generar el cobro con ${providerName}. Revisá la conexión del medio en Configuración → Medios de pago.`}
            </div>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cerrar
            </Button>
          </div>
        )}

        {(phase === "creating" || phase === "waiting" || selecting) && (
          <Button variant="ghost" className="w-full" onClick={close}>
            Cancelar
          </Button>
        )}
      </div>
    </Modal>
  );
}
