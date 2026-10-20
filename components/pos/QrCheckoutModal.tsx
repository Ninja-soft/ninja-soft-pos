"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getnetSlotError } from "@/lib/payments/getnetSlots";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Camera,
  Check,
  CheckCircle2,
  ChevronLeft,
  Copy,
  ExternalLink,
  Hourglass,
  Link2,
  Pause,
  Share2,
  XCircle,
} from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Callout } from "@/components/ui/Callout";
import { Button, buttonVariants } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Segmented";
import { cn } from "@/lib/utils/cn";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { posApi, type PaymentPlan, type TaloStatus } from "@/modules/pos/api";
import { TaloTransferPanel } from "@/components/pos/TaloTransferPanel";
import { taloOverpaidNote } from "@/lib/payments/talo";
import { usePosProviderPlans } from "@/modules/pos/hooks";
import { BASE_LABEL, BRAND_LABEL } from "@/modules/pos/planConstants";
import { CardBrandLogo, ThemedLogo } from "@/components/ui/ThemedLogo";
import { createClient } from "@/lib/supabase/client";
import { formatCurrency } from "@/lib/utils/format";
import { LocalQr } from "@/components/pos/LocalQr";
import { paymentIcon } from "@/lib/payments/logos";
import { QR_SELF_MANAGED } from "@/lib/pos/tenders";
import { pickTerminal } from "@/lib/payments/terminals";
import { useBranchContext, useCurrentRegister } from "@/modules/branches/hooks";
import { usePaymentTerminals } from "@/modules/config/hooks";
import { SharePanel } from "@/components/pending-charges/SharePanel";
import { useTicketBranding } from "@/modules/tickets/hooks";
import { brandDisplayName } from "@/lib/branding/businessName";
import {
  defaultTtlMinutes,
  extendOptions,
  isShareableLink,
  pendingChargeErrorCopy,
  type ShareChannel,
} from "@/modules/pending-charges/logic";

type Phase = "select" | "creating" | "waiting" | "approved" | "rejected" | "error" | "parked";

/** Pedido de "Dejar en espera" (ADR-048): el intent vigente y cómo se compartió. */
export interface QrParkRequest {
  intentId: string;
  amount: number;
  surcharges: { name: string; amount: number }[];
  provider: string;
  channel: "qr" | "link";
  shareUrl: string | null;
  qrData: string | null;
  expiresMinutes: number;
  customerEmail: string | null;
  customerPhone: string | null;
  sharedVia: { via: ShareChannel; to: string | null }[];
}

export interface QrParkOptions {
  /** null = se puede; texto = por qué no (se muestra deshabilitado). */
  blockedReason: string | null;
  /** "Dejar en espera" o "Actualizar cobro en espera" (edición). */
  label: string;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  /** Estaciona y devuelve el id del cobro (para el email del servidor). */
  onPark: (r: QrParkRequest) => Promise<{ id: string } | null>;
  /** Email del servidor sobre el cobro ya estacionado. */
  onEmail?: (chargeId: string, to: string, note: string) => Promise<void>;
}
/** Pausar la venta con este cobro abierto (ADR-106). */
export interface QrPauseOptions {
  blockedReason: string | null;
  /** null = no quedó un intent vivo (se canceló el QR de la caja). */
  onPause: (
    live: {
      intentId: string;
      provider: string;
      channel: "qr" | "link";
      amount: number;
      surcharges: { name: string; amount: number }[];
      shareUrl: string | null;
    } | null,
  ) => void;
  registerPause?: (fn: (() => void) | null) => void;
}

// Canal de Mercado Pago (ADR-032): "order" = QR dinámico de la caja (Orders
// API, se escanea en el local); "link" = Checkout Pro (link compartible).
type MpChannel = "order" | "link";

const round2 = (n: number) => Math.round(n * 100) / 100;

// Mercado Pago sin caja QR (Orders API): se recuerda 10 min en la sesión para
// no pedir primero la order que va a fallar y recién después el link.
const MP_QR_MISSING_KEY = "mp_qr_pos_missing_at";
function mpQrPosMissingRecently(): boolean {
  try {
    const at = Number(sessionStorage.getItem(MP_QR_MISSING_KEY) ?? 0);
    return at > 0 && Date.now() - at < 10 * 60_000;
  } catch {
    return false;
  }
}
function rememberMpQrPosMissing() {
  try {
    sessionStorage.setItem(MP_QR_MISSING_KEY, String(Date.now()));
  } catch {
    /* sin storage: se vuelve a probar la order la próxima vez */
  }
}

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
function qrErrorCopy(code: string, providerName: string, detail?: string): string {
  // Getnet (ADR-065): la Edge manda un diagnóstico legible y sin secretos
  // (API, ambiente, HTTP y código del proveedor).
  if (code === "getnet_no_token" && detail) {
    return `Getnet no aceptó las credenciales. ${detail} Probalas en Configuración → Medios de pago → Getnet.`;
  }
  if (code === "getnet_error" && detail) return `Getnet no pudo crear el cobro: ${detail}`;
  // Getnet (ADR-069): credenciales del juego equivocado o checkout propio apagado.
  const slotMsg = getnetSlotError(code);
  if (slotMsg) return slotMsg;
  switch (code) {
    case "payment_method_disabled_in_store":
      return `${providerName} está apagado en esta sucursal o caja (Configuración → Medios de pago).`;
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
    case "directo_auth_failed":
      return "Directo rechazó las credenciales del comercio. Verificá que sean del mismo ambiente que el switch Sandbox del medio.";
    case "directo_base_url_missing":
      return "Falta la URL de la API de Directo. Cargala en Configuración → Medios de pago.";
    case "directo_error":
      return "Directo devolvió un error al crear el cobro. Probá de nuevo en unos segundos.";
    case "ualabis_min_amount":
      return "Ualá Bis acepta cobros desde $25. Para montos menores usá otro medio de pago.";
    case "ualabis_max_amount":
      return "Ualá Bis acepta cobros de hasta $9.999.999 por link. Dividí el cobro o usá otro medio.";
    case "ualabis_auth_failed":
      return "Ualá Bis rechazó las credenciales. Probalas en Configuración → Medios de pago → Ualá Bis (y revisá que sean del mismo ambiente que el switch Sandbox).";
    case "ualabis_error":
      return "Ualá Bis devolvió un error al crear el cobro. Probá de nuevo en unos segundos.";
    case "viumi_min_amount":
      return "Viumi no acepta cobros de menos de $1. Usá otro medio de pago.";
    case "viumi_max_amount":
      return "El monto supera el máximo que acepta Viumi por link. Dividí el cobro o usá otro medio.";
    case "viumi_auth_failed":
      return "Viumi rechazó las credenciales. Probalas en Configuración → Medios de pago → Viumi (y revisá que sean del mismo ambiente que el switch Sandbox).";
    case "viumi_error":
      return "Viumi devolvió un error al crear el cobro. Probá de nuevo en unos segundos.";
    case "talo_auth_failed":
      return "Talo rechazó las credenciales. Probalas en Configuración → Medios de pago → Talo (y revisá que sean del mismo ambiente que el switch Sandbox).";
    case "talo_max_amount":
      return "El monto supera el máximo por cobro de Talo. Dividí el cobro o usá otro medio.";
    case "talo_error":
      return "Talo devolvió un error al crear el cobro. Probá de nuevo en unos segundos.";
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
  channel = "qr",
  customerId = null,
  prefetched,
  park,
  mode,
  pause,
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
    | "gocuotas"
    | "directo"
    | "ualabis"
    | "viumi"
    | "talo";
  providerName?: string;
  // Notifica el QR de cobro activo a la pantalla del cliente (H25). Se llama con
  // el init_point + monto cuando el QR está listo para escanear (fase waiting), y
  // con null cuando ya no hay QR activo (se cerró o cambió de fase).
  onQrState?: (qr: { initPoint: string; amount: number; providerName: string } | null) => void;
  // Canal elegido en la hoja de cobro: "link" arranca directo con un link
  // compartible (Mercado Pago: Checkout Pro) y ofrece copiarlo o compartirlo.
  channel?: "qr" | "link";
  // Cliente de la venta (sólo lo usa Mobbex para el customer del checkout).
  customerId?: string | null;
  // Planes y modo del medio ya cargados por la hoja de cobro: el QR arranca
  // sin esperar consultas (ADR-048, "QR más rápido").
  prefetched?: { plans: PaymentPlan[]; mode: string; pct: number } | null;
  // Cobros en espera: compartir el link y seguir cobrando.
  park?: QrParkOptions | null;
  // Getnet (ADR-069): "own" = checkout PROPIO /pagar con la Checkout API.
  mode?: "own";
  // Pausar la venta (ADR-106): el QR o link sigue vivo y queda con la venta.
  pause?: QrPauseOptions | null;
}) {
  // Checkout propio (Payway y Getnet con Checkout API): el cliente elige
  // cuotas con recargo en /pagar y el total final viene en el poll.
  const ownCheckout = provider === "payway" || (provider === "getnet" && mode === "own");
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
  // Directo: el cliente arma su crédito en la página de Directo.
  // Ualá Bis: checkout de Ualá (tarjeta y cuotas se eligen ahí).
  // Viumi: checkout de Viumi (tarjeta y cuotas se eligen ahí).
  const selfManaged = QR_SELF_MANAGED.has(provider);
  const { toast } = useToast();
  // Caja QR de MP registrada para esta caja (F17 · H93, ADR-049).
  const branchCtx = useBranchContext();
  const currentRegister = useCurrentRegister();
  const { data: terminals } = usePaymentTerminals();
  const qrLoc = useMemo(() => {
    const storeId = branchCtx.posStoreId;
    const registerId = currentRegister.data?.id ?? null;
    const pick = pickTerminal({ terminals: terminals ?? [], providerKey: "mercadopago", storeId, registerId });
    return { terminalId: pick.terminal?.id ?? null, storeId, registerId };
  }, [terminals, branchCtx.posStoreId, currentRegister.data?.id]);
  const [phase, setPhase] = useState<Phase>("select");
  const [brand, setBrand] = useState<string | null>(null);
  const [amount, setAmount] = useState(base);
  const [intentId, setIntentId] = useState<string | null>(null);
  const [initPoint, setInitPoint] = useState("");
  // Nave devuelve el QR EMV (qr_data) aparte del link: se codifica TAL CUAL.
  const [qrData, setQrData] = useState("");
  // Talo (ADR-175): CVU y alias únicos del cobro.
  const [transfer, setTransfer] = useState<{ cvu: string | null; alias: string | null } | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [mpChannel, setMpChannel] = useState<MpChannel>("order");
  const [switching, setSwitching] = useState(false);
  const firedRef = useRef(false);
  const startedRef = useRef(false);
  const chosenRef = useRef<{ label: string; surcharge: number } | null>(null);
  // Cuotas del plan elegido (solo Payway: viajan al formulario hosted).
  const instRef = useRef<number>(1);
  // Cobros en espera (ADR-048).
  const [shareOpen, setShareOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [parking, setParking] = useState(false);
  const parkingRef = useRef(false);
  const parkedRef = useRef(false);
  const sharedRef = useRef<{ via: ShareChannel; to: string | null }[]>([]);
  const [ttl, setTtl] = useState(() => defaultTtlMinutes(provider));
  const { data: branding } = useTicketBranding(open && Boolean(park));

  const { data: fetchedPlans, isLoading: plansLoading } = usePosProviderPlans(
    open && !prefetched ? provider : null,
  );
  const plans = prefetched?.plans ?? fetchedPlans;
  const isLoading = prefetched ? false : plansLoading;
  // Config del medio: modo "recargo único" + su %.
  const { data: fetchedCfg } = useQuery({
    queryKey: ["qr-method-cfg", provider],
    enabled: open && !prefetched,
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
  const methodCfg = prefetched ? { mode: prefetched.mode, pct: prefetched.pct } : fetchedCfg;
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

  function onCreated(r: {
    intent_id: string;
    init_point: string;
    qr_data?: string;
    cvu?: string | null;
    alias?: string | null;
  }) {
    setIntentId(r.intent_id);
    setInitPoint(r.init_point);
    setQrData(r.qr_data ?? "");
    setTransfer(r.cvu || r.alias ? { cvu: r.cvu ?? null, alias: r.alias ?? null } : null);
    setPhase("waiting");
  }

  function onCreateError(code: string, detail?: string) {
    const msg = qrErrorCopy(code, providerName, detail);
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
    if (provider === "mercadopago" && channel === "link") {
      setMpChannel("link");
      posApi
        .createMpQr(amt, "Venta NinjaPos")
        .then(onCreated)
        .catch(async (e) => onCreateError((await edgeErrorCode(e)).code));
      return;
    }
    if (provider === "mercadopago" && mpQrPosMissingRecently()) {
      // Sin caja QR configurada (se supo hace poco): directo al link, sin la
      // ronda que ya sabemos que falla (ADR-048, "QR más rápido").
      setMpChannel("link");
      posApi
        .createMpQr(amt, "Venta NinjaPos")
        .then(onCreated)
        .catch(async (e) => onCreateError((await edgeErrorCode(e)).code));
      return;
    }
    if (provider === "mercadopago") {
      setMpChannel("order");
      // F17 · ADR-049: caja QR de ESTA caja (o la flotante de la sucursal) si
      // está registrada; si la terminal no sirve (otro ambiente, archivada),
      // se reintenta con la caja única de siempre.
      const legacy = { storeId: qrLoc.storeId, registerId: qrLoc.registerId };
      posApi
        .createMpOrderQr(amt, "Venta NinjaPos", qrLoc)
        .catch(async (e) => {
          const { code } = await edgeErrorCode(e);
          if (qrLoc.terminalId && code.startsWith("terminal_")) {
            return posApi.createMpOrderQr(amt, "Venta NinjaPos", legacy);
          }
          throw e;
        })
        .then(onCreated)
        .catch(async (e) => {
          const { code } = await edgeErrorCode(e);
          if (code !== "qr_pos_not_configured") return onCreateError(code);
          rememberMpQrPosMissing();
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
        ? (a: number, t: string) => posApi.createMobbexQr(a, t, customerId)
        : provider === "modo"
          ? posApi.createModoQr
          : provider === "pagos360"
            ? posApi.createPagos360Link
            : provider === "payway"
              ? posApi.createPaywayLink
              : provider === "getnet"
                ? (a: number, t: string) => posApi.createGetnetLink(a, t, mode)
                : provider === "nave"
                  ? posApi.createNaveQr
                  : provider === "gocuotas"
                    ? posApi.createGoCuotasLink
                    : provider === "directo"
                      ? posApi.createDirectoLink
                      : provider === "ualabis"
                        ? posApi.createUalaBisLink
                        : provider === "viumi"
                          ? posApi.createViumiLink
                          : provider === "talo"
                            ? posApi.createTaloPayment
                            : posApi.createMpQr;
    create(amt, "Venta NinjaPos")
      .then(onCreated)
      .catch(async (e) => {
        const { code, detail } = await edgeErrorCode(e);
        onCreateError(code, detail);
      });
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

  // Cerrar el modal con un cobro abierto lo da de baja en el proveedor
  // (best-effort; si el cliente ya pagó, el pago gana y queda para conciliar
  // en Cobros QR):
  //  - Mercado Pago, order QR de la caja: se cancela para que el QR deje de
  //    ser pagable. El link de Checkout Pro NO se cancela (sigue siendo
  //    compartible y, si se paga, la conciliación lo muestra).
  //  - Nave: se da de baja la intención (QR EMV + link).
  //  - GO Cuotas, Directo, Ualá Bis, Viumi y Talo: baja local del intent (no
  //    anulan órdenes por API; en Talo el CVU vence solo).
  function close() {
    if (intentId && phase === "waiting" && !parkedRef.current && !parkingRef.current) {
      if (provider === "mercadopago" && mpChannel === "order") {
        posApi.cancelMpOrder(intentId).catch(() => null);
      } else if (provider === "nave") {
        posApi.cancelNaveIntent(intentId).catch(() => null);
      } else if (provider === "gocuotas") {
        posApi.cancelGoCuotasIntent(intentId).catch(() => null);
      } else if (provider === "directo") {
        posApi.cancelDirectoIntent(intentId).catch(() => null);
      } else if (provider === "ualabis") {
        posApi.cancelUalaBisIntent(intentId).catch(() => null);
      } else if (provider === "viumi") {
        posApi.cancelViumiIntent(intentId).catch(() => null);
      } else if (provider === "talo") {
        posApi.cancelTaloIntent(intentId).catch(() => null);
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
    setTransfer(null);
    setErrorMsg("");
    setMpChannel(channel === "link" ? "link" : "order");
    setSwitching(false);
    firedRef.current = false;
    instRef.current = 1;
    startedRef.current = false;
    chosenRef.current = null;
    setShareOpen(false);
    setCopied(false);
    setParking(false);
    parkingRef.current = false;
    parkedRef.current = false;
    sharedRef.current = [];
    setTtl(defaultTtlMinutes(provider));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, base, channel]);

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
                  : provider === "directo"
                    ? posApi.directoIntentStatus(intentId!)
                    : provider === "ualabis"
                      ? posApi.ualabisIntentStatus(intentId!)
                      : provider === "viumi"
                        ? posApi.viumiIntentStatus(intentId!)
                        : provider === "talo"
                          ? posApi.taloIntentStatus(intentId!)
                          : posApi.mpIntentStatus(intentId!),
    // Mientras se pasa del QR de caja al link no se sondea: la order vieja se
    // está cancelando y su "cancelled" no debe cerrar el cobro.
    enabled: open && phase === "waiting" && Boolean(intentId) && !switching && !parking,
    refetchInterval: 3000,
  });

  // Cobro aprobado → la venta se registra en el POS (también si el cliente
  // pagó justo mientras se dejaba en espera).
  function fireApproved(polled?: number) {
    if (firedRef.current) return;
    firedRef.current = true;
    setPhase("approved");
    // Checkout propio (Payway, Getnet Checkout API): el cliente pudo elegir
    // cuotas con recargo → el total final viene en el poll y la venta se
    // registra por ese monto.
    const finalAmount =
      ownCheckout && typeof polled === "number" ? polled : amount;
    const c = chosenRef.current;
    const extras =
      ownCheckout && finalAmount > amount
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
  }

  useEffect(() => {
    if (!status || firedRef.current || switching || parkingRef.current || parkedRef.current) return;
    if (status.status === "approved") {
      // Talo (ADR-175): transferencia de más → la venta va por el total y se
      // avisa la diferencia para devolverla.
      const over = provider === "talo" ? taloOverpaidNote((status as TaloStatus).overpaid) : null;
      if (over) toast({ title: over.title, description: over.text, variant: "info" });
      fireApproved((status as { amount?: number }).amount);
    } else if (status.status === "rejected" || status.status === "cancelled") {
      setPhase("rejected");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, onApproved, intentId, amount, provider, switching]);

  // ── Cobros en espera (ADR-048) ────────────────────────────────────────────
  // El QR de la caja de Mercado Pago (Orders API) no se puede dejar esperando:
  // bloquea la caja para la venta siguiente. Se pasa a link antes.
  async function ensureLink(): Promise<{ intentId: string; url: string } | null> {
    if (provider === "mercadopago" && mpChannel === "order") {
      if (!intentId) return null;
      const prev = intentId;
      setSwitching(true);
      try {
        await posApi.cancelMpOrder(prev).catch(() => null);
        const last = await posApi.mpOrderStatus(prev).catch(() => null);
        if (last?.status === "approved") {
          fireApproved();
          return null;
        }
        if (!last || last.status === "pending") {
          toast({ title: "No se pudo pasar el QR a link. Probá de nuevo.", variant: "error" });
          return null;
        }
        const r = await posApi.createMpQr(amount, "Venta NinjaPos");
        setMpChannel("link");
        onCreated(r);
        return { intentId: r.intent_id, url: r.init_point };
      } catch (e) {
        onCreateError((await edgeErrorCode(e)).code);
        return null;
      } finally {
        setSwitching(false);
      }
    }
    return intentId ? { intentId, url: initPoint } : null;
  }

  function onShared(via: ShareChannel, to?: string | null) {
    sharedRef.current.push({ via, to: to ?? null });
  }

  // Copiar el link sin abrir el panel de compartir (cuenta como compartido).
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(initPoint);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
      onShared("copy");
      toast({ title: "Link copiado", variant: "success" });
    } catch {
      toast({ title: "No se pudo copiar el link", variant: "error" });
    }
  }

  // ── Pausar venta (ADR-106) ─────────────────────────────────────────────────
  // El intent queda con la venta pausada y su webhook la sigue conciliando.
  // El QR de la caja de Mercado Pago (Orders API) bloquea la caja para la
  // venta siguiente: se da de baja y, si el cliente justo pagó, entra el cobro.
  const [pausing, setPausing] = useState(false);
  const pausingRef = useRef(false);
  async function pauseNow() {
    if (!pause || pause.blockedReason || pausingRef.current || parkingRef.current || switching) return;
    if (phase === "creating") return;
    if (phase !== "waiting" || !intentId) {
      parkedRef.current = true;
      onQrState?.(null);
      pause.onPause(null);
      return;
    }
    pausingRef.current = true;
    setPausing(true);
    try {
      if (provider === "mercadopago" && mpChannel === "order") {
        await posApi.cancelMpOrder(intentId).catch(() => null);
        const last = await posApi.mpOrderStatus(intentId).catch(() => null);
        if (last?.status === "approved") {
          pausingRef.current = false;
          fireApproved();
          return;
        }
        if (!last || last.status === "pending") {
          toast({ title: "No se pudo liberar el QR de la caja. Probá de nuevo.", variant: "error" });
          return;
        }
        parkedRef.current = true;
        onQrState?.(null);
        pause.onPause(null);
        return;
      }
      const c = chosenRef.current;
      parkedRef.current = true;
      onQrState?.(null);
      pause.onPause({
        intentId,
        provider,
        channel: /^https?:\/\//.test(initPoint) ? "link" : "qr",
        amount,
        surcharges: c && c.surcharge > 0 ? [{ name: `Recargo ${c.label}`, amount: c.surcharge }] : [],
        shareUrl: /^https?:\/\//.test(initPoint) ? initPoint : null,
      });
    } finally {
      pausingRef.current = false;
      setPausing(false);
    }
  }
  const pauseNowRef = useRef(pauseNow);
  pauseNowRef.current = pauseNow;
  const pauseRegister = pause?.registerPause;
  useEffect(() => {
    if (!pauseRegister) return;
    pauseRegister(() => void pauseNowRef.current());
    return () => pauseRegister(null);
  }, [pauseRegister]);

  async function doPark(): Promise<{ id: string } | null> {
    if (!park || park.blockedReason || parkingRef.current) return null;
    const target = await ensureLink();
    if (!target) return null;
    parkingRef.current = true;
    setParking(true);
    try {
      const c = chosenRef.current;
      const link = isShareableLink(target.url) ? target.url : null;
      const res = await park.onPark({
        intentId: target.intentId,
        amount,
        surcharges: c && c.surcharge > 0 ? [{ name: `Recargo ${c.label}`, amount: c.surcharge }] : [],
        provider,
        channel: link ? "link" : "qr",
        shareUrl: link,
        qrData: link ? (qrData || null) : (qrData || target.url || null),
        expiresMinutes: ttl,
        customerEmail: park.customerEmail,
        customerPhone: park.customerPhone,
        sharedVia: sharedRef.current,
      });
      parkedRef.current = Boolean(res);
      if (res) {
        setPhase("parked");
        onQrState?.(null);
      }
      return res;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      if (msg.includes("intent_already_paid")) {
        // El cliente pagó justo: se registra la venta ahora, como siempre.
        parkingRef.current = false;
        fireApproved();
        return null;
      }
      toast({ title: pendingChargeErrorCopy(msg), variant: "error" });
      return null;
    } finally {
      parkingRef.current = parkedRef.current;
      setParking(false);
    }
  }

  async function parkAndEmail(to: string, note: string) {
    if (!park?.onEmail) throw new Error("no_email");
    const res = await doPark();
    if (!res) throw new Error("not_parked");
    await park.onEmail(res.id, to, note);
  }

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
  const providerLogo = paymentIcon(provider) ?? paymentIcon("mercadopago")!;

  // Panel visual (columna izquierda desde md): el QR, o un recuadro del mismo
  // tamaño con el estado, para que el modal no cambie de alto entre fases.
  // En mobile el QR es más chico y los estados finales van compactos.
  const qrSize = "h-[min(260px,64vw)] w-[min(260px,64vw)] md:h-[min(320px,45vh)] md:w-[min(320px,45vh)]";
  const stateBox = cn(
    "flex flex-col items-center justify-center gap-2 rounded-lg border border-border bg-fg-4 p-4 text-center",
    "w-full py-6 md:aspect-square md:h-[min(320px,45vh)] md:w-[min(320px,45vh)] md:py-4",
  );

  return (
    <Modal
      open={open}
      onOpenChange={(o) => (o ? onOpenChange(true) : close())}
      title={
        provider === "talo"
          ? `Cobrar con transferencia · ${providerName}`
          : `Cobrar con ${channel === "link" ? "link" : "QR"} · ${providerName}`
      }
      className="md:max-w-3xl"
    >
      <div className="flex flex-col gap-5 md:flex-row md:items-stretch md:gap-6">
        {/* ── Columna izquierda: QR y estado ─────────────────────────────── */}
        <div
          className={cn(
            "flex shrink-0 flex-col items-center gap-3",
            // En mobile, la selección de plan no necesita el recuadro.
            selecting && "hidden md:flex",
          )}
        >
          {selecting && (
            <div className={stateBox}>
              <ThemedLogo src={providerLogo} alt={providerName} className="h-12 w-auto" />
              <p className="max-w-[16rem] text-xs text-muted-foreground">
                Elegí la tarjeta y el plan. El QR aparece acá con el total final.
              </p>
            </div>
          )}

          {phase === "creating" && (
            <div className={cn(stateBox, "aspect-square p-0 py-0 md:py-0", qrSize)}>
              <Spinner size={28} />
              <span className="text-xs text-muted-foreground">Generando QR…</span>
            </div>
          )}

          {phase === "waiting" && (
            <>
              {qrValue ? (
                <LocalQr value={qrValue} label={`QR de pago ${providerName}`} className={qrSize} />
              ) : (
                // Talo sin link de pago: alcanzan el CVU y el alias de la derecha.
                <div className={stateBox}>
                  <ThemedLogo src={providerLogo} alt={providerName} className="h-12 w-auto" />
                </div>
              )}
              <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
                <Spinner size={14} />
                {switching ? "Pasando a link…" : parking ? "Dejando en espera…" : "Esperando pago"}
              </div>
            </>
          )}

          {phase === "approved" && (
            <div className={cn(stateBox, "text-success")} role="status">
              <CheckCircle2 size={44} aria-hidden />
              <div className="text-lg font-bold">¡Pago aprobado!</div>
              <div className="text-xs text-muted-foreground">Acreditado. Registrando la venta…</div>
            </div>
          )}

          {phase === "parked" && (
            <div className={stateBox} role="status">
              <Hourglass size={40} aria-hidden className="text-muted-foreground" />
              <div className="text-lg font-bold">Cobro en espera</div>
            </div>
          )}

          {phase === "rejected" && (
            <div className={cn(stateBox, "text-danger")} role="status">
              <XCircle size={44} aria-hidden />
              <div className="text-lg font-bold">Pago rechazado o cancelado</div>
            </div>
          )}

          {phase === "error" && (
            <div className={stateBox} role="status">
              <AlertTriangle size={40} aria-hidden className="text-danger" />
              <div className="text-sm font-semibold">No se pudo generar el cobro</div>
            </div>
          )}
        </div>

        {/* ── Columna derecha: monto, acciones y espera ─────────────────── */}
        {/* En mobile la columna se "disuelve" (contents) para que el monto
            quede arriba del QR; desde md es una columna propia. */}
        <div
          className={cn(
            "contents text-left md:flex md:min-w-0 md:flex-1 md:flex-col",
            shareOpen ? "md:gap-3" : "md:gap-4",
          )}
        >
          <div className="order-first flex items-start justify-between gap-3 md:order-none">
            <div className="min-w-0">
              <div className="text-sm text-muted-foreground">
                {phase === "select" ? "Monto base" : "Total a cobrar"}
              </div>
              <div className="price-solid font-price text-3xl font-black tabular-nums">
                {formatCurrency(phase === "select" ? base : amount)}
              </div>
            </div>
            <ThemedLogo src={providerLogo} alt={providerName} className="h-9 w-auto shrink-0" />
          </div>

          {selecting && (
            <div className="space-y-3">
              {loadingAll ? (
                <div className="flex justify-center py-6">
                  <Spinner size={24} />
                </div>
              ) : !brand ? (
                <>
                  <div className="text-sm font-medium">Elegí la tarjeta</div>
                  <div className="grid grid-cols-3 gap-2">
                    {brands.map((b) => (
                      <button
                        key={b}
                        onClick={() => setBrand(b)}
                        className="flex flex-col items-center gap-1.5 rounded-lg bg-fg-6 p-3 transition hover:bg-fg-10"
                      >
                        <CardBrandLogo brand={b} label={BRAND_LABEL[b] ?? b} height={28} />
                        <span className="text-xs">{BRAND_LABEL[b] ?? b}</span>
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={payNoPlan}
                    className="w-full rounded-lg bg-fg-4 py-2.5 text-sm text-muted-foreground transition hover:bg-fg-6 hover:text-foreground"
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
                          <span className="price-solid font-price text-lg font-black tabular-nums">
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

          {phase === "creating" && (
            <p className="text-center text-sm text-muted-foreground md:text-left">Generando el cobro con {providerName}…</p>
          )}

          {phase === "waiting" && (
            <>
              {provider === "ualabis" && !shareOpen && (
                // El QR de Ualá Bis es el link de pago: no lo leen las billeteras (no es interoperable).
                <Callout tone="warning" icon={Camera} title="Escaneá con la cámara del celular">
                  No sirve con billeteras virtuales (Mercado Pago, MODO, etc.). Abre la página de Ualá Bis para pagar con tarjeta.
                </Callout>
              )}
              {provider === "viumi" && !shareOpen && (
                // El QR de Viumi es el link de pago: abre su checkout para pagar con tarjeta.
                <Callout tone="info" icon={Camera} title="Escaneá con la cámara del celular">
                  El QR abre el checkout de Viumi para pagar con tarjeta. No lo leen las billeteras virtuales.
                </Callout>
              )}
              {provider === "talo" && !shareOpen && (
                <TaloTransferPanel
                  cvu={transfer?.cvu ?? (status as TaloStatus | undefined)?.cvu ?? null}
                  alias={transfer?.alias ?? (status as TaloStatus | undefined)?.alias ?? null}
                  amount={amount}
                  status={status as TaloStatus | undefined}
                />
              )}
              <p
                className={cn(
                  "text-center text-sm text-muted-foreground md:text-left",
                  shareOpen && "md:hidden",
                  provider === "talo" && "hidden",
                )}
              >
                {isMpOrder
                  ? "El cliente escanea el QR con la app de Mercado Pago o su billetera. La pantalla se actualiza sola al acreditarse."
                  : provider === "ualabis" || provider === "viumi"
                    ? "También podés compartirle el link. La pantalla se actualiza sola al acreditarse."
                  : channel === "link"
                    ? `Compartí el link para que el cliente pague con ${providerName}, o que escanee el QR. La pantalla se actualiza sola al acreditarse.`
                    : `El cliente escanea el QR para pagar con ${providerName}. La pantalla se actualiza sola al acreditarse.`}
              </p>
              {isMpOrder ? (
                <div className="flex justify-center md:justify-start">
                  <Button variant="secondary" size="sm" disabled={switching || parking} onClick={switchToLink}>
                    {switching ? <Spinner size={14} /> : <Link2 size={14} />} Enviar link
                  </Button>
                </div>
              ) : (
                isLink && (
                  <div className="flex flex-wrap items-center justify-center gap-2 md:justify-start">
                    <Button
                      variant="secondary"
                      size="sm"
                      aria-expanded={shareOpen}
                      className={cn(shareOpen && "bg-fg-10")}
                      onClick={() => setShareOpen((v) => !v)}
                    >
                      <Share2 size={14} aria-hidden /> Compartir
                    </Button>
                    <a
                      href={initPoint}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={buttonVariants({ variant: "ghost", size: "sm" })}
                    >
                      <ExternalLink size={14} aria-hidden /> Abrir link
                    </a>
                    <Button variant="ghost" size="sm" onClick={copyLink}>
                      {copied ? (
                        <Check size={14} aria-hidden className="text-success" />
                      ) : (
                        <Copy size={14} aria-hidden />
                      )}
                      {copied ? "Copiado" : "Copiar"}
                    </Button>
                  </div>
                )
              )}
              {shareOpen && isLink && (
                <SharePanel
                  url={initPoint}
                  amountLabel={formatCurrency(amount)}
                  businessName={branding ? brandDisplayName(branding, "") || null : null}
                  customerName={park?.customerName ?? null}
                  customerPhone={park?.customerPhone ?? null}
                  customerEmail={park?.customerEmail ?? null}
                  onShared={onShared}
                  onServerEmail={park && !park.blockedReason && park.onEmail ? parkAndEmail : undefined}
                  serverEmailLabel="Enviar y dejar en espera"
                />
              )}
              {park && (
                <div className="space-y-2.5 rounded-lg border border-border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">El link vence en</span>
                    <div
                      className={cn(park.blockedReason && "pointer-events-none opacity-50")}
                      aria-disabled={Boolean(park.blockedReason) || undefined}
                    >
                      <Segmented
                        size="sm"
                        aria-label="Vencimiento del cobro en espera"
                        value={String(ttl)}
                        options={extendOptions(provider).map((o) => ({
                          value: String(o.minutes),
                          label: o.label,
                        }))}
                        onChange={(v) => setTtl(Number(v))}
                      />
                    </div>
                  </div>
                  <Button
                    className="w-full"
                    variant="secondary"
                    disabled={Boolean(park.blockedReason) || switching}
                    loading={parking}
                    onClick={() => void doPark()}
                  >
                    <Hourglass size={16} aria-hidden /> {park.label}
                  </Button>
                  <p className="text-[11px] leading-snug text-muted-foreground">
                    {park.blockedReason ??
                      "Ya lo compartí, sigo cobrando: la venta queda esperando el pago y se registra sola cuando el cliente paga. Te avisamos para imprimir el ticket."}
                  </p>
                </div>
              )}
            </>
          )}

          {phase === "parked" && (
            <p className="text-sm text-muted-foreground">Seguí cobrando: te avisamos cuando se acredite.</p>
          )}

          {phase === "approved" && (
            <p className="text-sm text-muted-foreground">
              El pago se acreditó. Estamos registrando la venta.
            </p>
          )}

          {phase === "rejected" && (
            <p className="text-sm text-muted-foreground">
              El cliente no completó el pago. Podés cerrar y cobrar de nuevo con este u otro medio.
            </p>
          )}

          {phase === "error" && (
            <p className="text-sm text-muted-foreground">
              {errorMsg ||
                `No se pudo generar el cobro con ${providerName}. Revisá la conexión del medio en Configuración → Medios de pago.`}
            </p>
          )}

          <div className="mt-auto flex justify-end gap-2 pt-1">
            {(phase === "creating" || phase === "waiting" || selecting) && (
              <Button variant="ghost" className="w-full md:w-auto" onClick={close}>
                Cancelar
              </Button>
            )}
            {pause && (phase === "waiting" || selecting || phase === "error" || phase === "rejected") && (
              <Button
                variant="secondary"
                className="w-full md:w-auto"
                disabled={Boolean(pause.blockedReason) || switching || parking}
                loading={pausing}
                title={pause.blockedReason ?? "Guarda la venta con este cobro y deja el POS libre"}
                aria-keyshortcuts="Shift+F8 Pause"
                onClick={() => void pauseNow()}
              >
                <Pause size={16} aria-hidden /> Pausar venta
              </Button>
            )}
            {(phase === "rejected" || phase === "error") && (
              <Button variant="secondary" className="w-full md:w-auto" onClick={() => onOpenChange(false)}>
                Cerrar
              </Button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
