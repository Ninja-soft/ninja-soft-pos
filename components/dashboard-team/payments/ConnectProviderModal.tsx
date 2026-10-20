"use client";

import { useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BellRing,
  Check,
  Copy,
  FlaskConical,
  KeyRound,
  Lock,
  Mail,
  PlugZap,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Unplug,
} from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button, buttonVariants } from "@/components/ui/Button";
import { CredentialInput } from "@/components/ui/CredentialInput";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { SANDBOX_PROVIDERS, type BrandDef } from "@/lib/payments/catalog";
import {
  probeApiAttemptLine,
  probeAttemptLine,
  probeMismatchEnv,
  probeSecrets,
  type GetnetProbeResult,
} from "@/lib/payments/getnetProbe";
import {
  GETNET_SLOT_BY_KEY,
  GETNET_VTEX_WARNING,
  getnetSaveError,
  getnetSlotSave,
  visibleGetnetSlots,
  type GetnetSlot,
} from "@/lib/payments/getnetSlots";
import {
  CHANNEL_CAPS,
  CONNECT_GUIDE,
  NAVE_WEBHOOK_URL,
  SECURITY_NOTE,
  naveRegistrationEmail,
  type ChannelCap,
} from "./copy";
import { useMyTenant } from "@/modules/tenants/hooks";
import {
  BrandLogo,
  CapBadge,
  EnvPicker,
  Eyebrow,
  GuideSteps,
  Notice,
  SecurityNote,
  StatusChip,
  Stepper,
  WhereRow,
} from "./ui";
import { mpEnvOf, type Env, type Method, type MpEnvChange } from "./types";

// =============================================================================
// Formularios de credenciales por proveedor (config, no JSX repetido). El
// `name` de cada campo es la key con la que viaja en `secrets` a la Edge
// set_payment_secret; los opcionales vacíos no se mandan.
// =============================================================================
type Field = {
  name: string;
  label: string;
  secret?: boolean;
  optional?: boolean;
  min?: number;
  placeholder?: string;
  hint?: string;
  // Validación extra (devuelve el error o undefined).
  validate?: (v: string) => string | undefined;
  // Sólo se pide si "Probar credenciales" detectó esa API (Getnet, ADR-065).
  onlyApi?: "global";
};

const httpsUrl = (v: string) => {
  try {
    const u = new URL(v);
    return u.protocol === "https:" && !u.search && !u.hash ? undefined : "Tiene que ser una URL https, sin parámetros.";
  } catch {
    return "Pegá la URL completa (https://...).";
  }
};

// envNote: aclaración del paso Ambiente para proveedores sin prueba real.
type FormSpec = { fields: Field[]; envNote?: string };

const FORMS: Record<string, FormSpec> = {
  modo: {
    fields: [
      { name: "username", label: "Username", min: 4, placeholder: "Tu Username de MODO" },
      { name: "password", label: "Password", secret: true, min: 6, placeholder: "Tu Password de MODO" },
      { name: "store_id", label: "Store ID", optional: true, placeholder: "Sólo si tenés varias sucursales" },
      { name: "processor_code", label: "Processor code", optional: true, placeholder: "Ej: P1293" },
    ],
  },
  nave: {
    fields: [
      { name: "client_id", label: "Client ID", min: 6, placeholder: "Tu Client ID de Nave" },
      { name: "client_secret", label: "Client Secret", secret: true, min: 6, placeholder: "Tu Client Secret de Nave" },
      { name: "pos_id", label: "ID de punto de venta", min: 4, placeholder: "El pos_id que te dio Nave" },
      {
        name: "point_pos_ids",
        label: "Terminales Nave Point",
        optional: true,
        placeholder: "Caja 1: id-terminal, Caja 2: otro-id",
        hint: "Un ID por terminal, separados por coma.",
      },
      { name: "audience", label: "Audience", optional: true, placeholder: "Sólo si Nave te dio uno distinto" },
    ],
  },
  payway: {
    fields: [
      { name: "public_apikey", label: "API Key pública", min: 10, placeholder: "Tu API Key pública" },
      { name: "private_apikey", label: "API Key privada", secret: true, min: 10, placeholder: "Tu API Key privada" },
      { name: "site", label: "Número de comercio (site)", min: 4, placeholder: "Ej: 00097002" },
    ],
  },
  getnet: {
    fields: [
      { name: "client_id", label: "Client ID", min: 4, placeholder: "Tu Client ID" },
      { name: "client_secret", label: "Client Secret", secret: true, min: 8, placeholder: "Tu Client Secret" },
      // Web Checkout exige un comprador: si el cliente no se identifica va
      // "Consumidor Final" con estos datos del comercio.
      { name: "customer_email", label: "Email del comercio", optional: true, onlyApi: "global", placeholder: "ventas@tunegocio.com" },
      { name: "customer_document", label: "CUIT del comercio", optional: true, onlyApi: "global", placeholder: "30712345678" },
      { name: "customer_address", label: "Calle y número", optional: true, onlyApi: "global", placeholder: "Av. Corrientes 1234" },
      { name: "customer_postal_code", label: "Código postal", optional: true, onlyApi: "global", placeholder: "C1043AAZ" },
    ],
    envNote:
      "Prueba usa el sandbox u homologación de Web Checkout. La API Getnet Argentina (la del plugin de WooCommerce) sólo tiene producción.",
  },
  // Getnet, slot Checkout API (ADR-069): credenciales "Checkout API / Plugin
  // VTEX". Se guardan con claves api_* en la misma conexión.
  getnet_api: {
    fields: [
      { name: "api_client_id", label: "Client ID (Checkout API)", min: 4, placeholder: "Client ID de Checkout API / VTEX" },
      {
        name: "api_client_secret",
        label: "Client Secret (Checkout API)",
        secret: true,
        min: 8,
        placeholder: "Client Secret de Checkout API / VTEX",
      },
      {
        name: "api_seller_id",
        label: "Seller ID",
        optional: true,
        placeholder: "Sólo si Getnet te lo dio",
        hint: "Normalmente lo leemos solo al probar las credenciales.",
        validate: (v) => (/^[0-9a-f-]{36}$/i.test(v) ? undefined : "Es un código de 36 caracteres (con guiones)."),
      },
      {
        name: "api_channel_entry",
        label: "Código de canal",
        optional: true,
        placeholder: "Sólo si Getnet te lo pidió",
        hint: "El x-transaction-channel-entry que Getnet asigna a la plataforma.",
      },
    ],
    envNote: "Prueba usa el sandbox u homologación de la Checkout API de Getnet.",
  },
  pagos360: {
    fields: [{ name: "api_key", label: "API Key", secret: true, min: 10, placeholder: "Tu API Key" }],
  },
  gocuotas: {
    fields: [{ name: "api_key", label: "API Key de la sucursal", secret: true, min: 8, placeholder: "Tu API Key" }],
  },
  directo: {
    fields: [
      { name: "api_key", label: "API Key", secret: true, min: 6, placeholder: "Tu API Key de Directo" },
      { name: "merchant_username", label: "Usuario del comercio", min: 2, placeholder: "MERCHANT_USERNAME" },
      { name: "merchant_password", label: "Contraseña del comercio", secret: true, min: 4, placeholder: "MERCHANT_PASSWORD" },
      {
        name: "merchant_name",
        label: "Nombre del comercio",
        min: 2,
        placeholder: "Tal como lo dio de alta Directo",
        hint: "Viaja en cada orden: tiene que coincidir con el alta en Directo.",
      },
      {
        name: "api_base_url",
        label: "URL de la API",
        placeholder: "https://...",
        hint: "Te la da Directo con las credenciales. Es distinta en QA y en producción.",
        validate: httpsUrl,
      },
      {
        name: "subscription_key",
        label: "Subscription Key",
        secret: true,
        optional: true,
        placeholder: "Sólo si Directo te la dio",
      },
    ],
    envNote: "Elegí QA (prueba) sólo si las credenciales y la URL son de QA.",
  },
  // Ualá Bis (ADR-143): las tres credenciales de Cobros online › API. Se
  // prueban al guardar (set_payment_secret pide un token en el ambiente).
  ualabis: {
    fields: [
      { name: "username", label: "Usuario", min: 3, placeholder: "El username de tu cuenta Ualá Bis" },
      { name: "client_id", label: "Client ID", min: 8, placeholder: "Tu Client ID" },
      { name: "client_secret_id", label: "Client Secret", secret: true, min: 8, placeholder: "Tu Client Secret" },
    ],
    envNote: "Prueba usa el ambiente stage de Ualá Bis: los pagos son simulados con la tarjeta de prueba de tu cuenta.",
  },
  // Viumi (ADR-173): Client ID y Client Secret de la API. Se prueban al
  // guardar (set_payment_secret pide un token en el ambiente).
  viumi: {
    fields: [
      { name: "client_id", label: "Client ID", min: 4, placeholder: "Tu Client ID de Viumi" },
      { name: "client_secret", label: "Client Secret", secret: true, min: 8, placeholder: "Tu Client Secret de Viumi" },
    ],
    envNote: "Prueba usa el ambiente de prueba de Viumi: los pagos no mueven plata real.",
  },
  // Clover Point (ADR-047): conexión de la marca Fiserv. Las terminales salen
  // de Clover (GET devices); las series cargadas acá acotan y nombran.
  fiserv: {
    fields: [
      {
        name: "merchant_id",
        label: "Merchant ID de Clover",
        min: 8,
        placeholder: "Ej: ABCD1234EFGH5",
        hint: "Son 13 letras y números: figura en los datos del comercio del Dashboard de Clover.",
        validate: (v) => (/^[A-Za-z0-9]{8,20}$/.test(v) ? undefined : "Sólo letras y números, sin espacios."),
      },
      {
        name: "access_token",
        label: "Token de Clover",
        secret: true,
        min: 16,
        placeholder: "El token de acceso del comercio",
        hint: "En prueba, el token de API del comercio de prueba. En producción, el que te da NinjaSoft al instalar su app de Clover.",
      },
      {
        name: "refresh_token",
        label: "Refresh token",
        secret: true,
        optional: true,
        placeholder: "Sólo si te lo dio NinjaSoft",
        hint: "Con él, el token se renueva solo cuando vence.",
      },
      {
        name: "device_serials",
        label: "Terminales Clover",
        optional: true,
        placeholder: "Caja 1: C043UQ12345678, Caja 2: C043UQ87654321",
        hint: "Número de serie de cada terminal (Configuración › Acerca de). Vacío: se usan todas las de tu cuenta.",
      },
    ],
    envNote: "Prueba usa el sandbox de Clover con un comercio de prueba; producción cobra de verdad en Clover Argentina.",
  },
  mobbex: {
    fields: [
      { name: "api_key", label: "API Key", min: 6, placeholder: "Tu API Key" },
      { name: "access_token", label: "Access Token", secret: true, min: 6, placeholder: "Tu Access Token" },
    ],
    envNote: "Mobbex usa el ambiente de tu cuenta: cargá las credenciales con las que vas a cobrar.",
  },
};

const STEPS = ["Datos", "Ambiente", "Listo"];

function fieldError(f: Field, v: string): string | undefined {
  const t = v.trim();
  if (f.optional && !t) return undefined;
  if (!t) return `Falta ${f.label}.`;
  if (f.min && t.length < f.min) return "Parece incompleto: copialo entero.";
  return f.validate?.(t);
}

export type ConnectSave = {
  secrets?: Record<string, string>;
  token?: string;
  env?: Env;
  /** Getnet (ADR-069): guarda un slot sin pisar el otro. */
  merge?: boolean;
  remove?: string[];
  slot?: GetnetSlot;
};
/** Sin secrets = prueba la credencial guardada del alcance. */
export type ConnectProbe = { secrets?: Record<string, string>; env: Env; slot?: GetnetSlot };

export function ConnectProviderModal({
  open,
  onOpenChange,
  brand,
  providerKey,
  method,
  channelNames,
  channelKeys = [],
  onSave,
  onDisconnect,
  onOAuth,
  oauthPending = false,
  onMpEnv,
  scopeSlot,
  scopeName = null,
  onProbe,
  getnetSlots,
  getnetOwnCheckout = false,
  onClearSlot,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  brand: BrandDef;
  providerKey: string;
  method: Method | undefined;
  // Canales de la marca que usan esta conexión (para el resumen).
  channelNames: string[];
  channelKeys?: string[];
  onSave: (v: ConnectSave) => Promise<void>;
  onDisconnect: () => Promise<void>;
  onOAuth?: () => void;
  oauthPending?: boolean;
  onMpEnv?: (v: MpEnvChange) => Promise<void>;
  /** Selector "Todo el negocio / Sucursal X" (F17 · ADR-057). */
  scopeSlot?: React.ReactNode;
  /** Sucursal de la credencial que se edita (null = la del negocio). */
  scopeName?: string | null;
  /** "Probar credenciales" (hoy sólo Getnet, ADR-065). */
  onProbe?: (v: ConnectProbe) => Promise<GetnetProbeResult>;
  /** Getnet: slots cargados en este alcance (ADR-069). */
  getnetSlots?: Record<GetnetSlot, boolean>;
  /**
   * Getnet (ADR-069 adenda): checkout propio habilitado (flag PCI, booleano de
   * la Edge). Apagado: sólo se muestra y se carga Web Checkout.
   */
  getnetOwnCheckout?: boolean;
  /** Getnet: borra sólo un slot. */
  onClearSlot?: (slot: GetnetSlot) => Promise<void>;
}) {
  const { toast } = useToast();
  const isMp = providerKey === "mercadopago";
  const isGetnet = providerKey === "getnet" && Boolean(getnetSlots);
  // Getnet: slot que se edita (Web Checkout o Checkout API).
  const firstSlot: GetnetSlot =
    getnetOwnCheckout && getnetSlots && !getnetSlots.web_checkout && getnetSlots.checkout_api ? "checkout_api" : "web_checkout";
  const [slot, setSlot] = useState<GetnetSlot>(firstSlot);
  const spec = isGetnet && slot === "checkout_api" ? FORMS.getnet_api : FORMS[providerKey];
  const guide = CONNECT_GUIDE[providerKey];
  const connected = Boolean(method?.config?.connected);
  // Credencial cargada en el slot que se edita (Getnet) o en la conexión.
  const slotConnected = isGetnet ? Boolean(getnetSlots?.[slot]) : connected;
  const hasSandbox = SANDBOX_PROVIDERS.has(providerKey) || isMp;
  const currentEnv: Env = isMp ? mpEnvOf(method) : method?.sandbox && hasSandbox ? "test" : "prod";
  const caps: ChannelCap[] = Array.from(new Set(channelKeys.flatMap((k) => CHANNEL_CAPS[k] ?? [])));

  const [view, setView] = useState<"manage" | "wizard">(connected ? "manage" : "wizard");
  const [step, setStep] = useState(0);
  const [values, setValues] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [showErrors, setShowErrors] = useState(false);
  const [env, setEnv] = useState<Env>(currentEnv);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  // MP: token manual (paso 1) y token de prueba (paso 2 / administrar).
  const [mpToken, setMpToken] = useState("");
  const [mpTestToken, setMpTestToken] = useState("");
  const [showManual, setShowManual] = useState(false);
  // Resultado de "Probar credenciales" (null = sin probar).
  const [probe, setProbe] = useState<GetnetProbeResult | null>(null);
  const [probing, setProbing] = useState(false);

  // Cada apertura arranca limpia.
  useEffect(() => {
    if (!open) return;
    setView(connected ? "manage" : "wizard");
    setStep(0);
    setValues({});
    setTouched({});
    setShowErrors(false);
    setEnv(currentEnv);
    setSaving(false);
    setServerError(null);
    setConfirmOff(false);
    setMpToken("");
    setMpTestToken("");
    setShowManual(false);
    setProbe(null);
    setProbing(false);
    setSlot(firstSlot);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Getnet: cambiar de slot arranca el formulario limpio.
  const pickSlot = (s: GetnetSlot) => {
    if (s === slot) return;
    setSlot(s);
    setValues({});
    setTouched({});
    setShowErrors(false);
    setProbe(null);
    setServerError(null);
  };

  const allFields = spec?.fields ?? [];
  // Paso 1: credenciales. Los campos de una API puntual aparecen en el paso
  // Ambiente, cuando la prueba detectó esa API.
  const fields = allFields.filter((f) => !f.onlyApi);
  const apiFields = allFields.filter((f) => f.onlyApi && probe?.ok && probe.api === f.onlyApi);
  const errorOf = (f: Field) =>
    showErrors || touched[f.name] ? fieldError(f, values[f.name] ?? "") : undefined;
  const credsValid = isMp
    ? mpToken.trim().length >= 8
    : fields.every((f) => !fieldError(f, values[f.name] ?? ""));
  const hasTest = Boolean(method?.config?.test_connected);
  const needsTestToken = isMp && env === "test" && !hasTest;
  const mpTestValid = mpTestToken.trim().length >= 8;

  const run = async (fn: () => Promise<void>, onOk: () => void) => {
    setSaving(true);
    setServerError(null);
    try {
      await fn();
      onOk();
    } catch (e) {
      // Getnet (ADR-069 adenda): el servidor no guarda credenciales de
      // Checkout API / Plugin VTEX ni credenciales rechazadas.
      const getnetMsg = isGetnet ? getnetSaveError(e instanceof Error ? e.message : undefined) : null;
      // Ualá Bis (ADR-143): el servidor prueba las credenciales antes de guardarlas.
      const ualaMsg =
        providerKey === "ualabis" && e instanceof Error && e.message === "ualabis_invalid_credentials"
          ? "Ualá Bis no aceptó estas credenciales en el ambiente elegido. Revisalas o probá el otro ambiente."
          : null;
      // Viumi (ADR-173): mismo criterio, el servidor pide un token antes de guardar.
      const viumiMsg =
        providerKey === "viumi" && e instanceof Error && e.message === "viumi_invalid_credentials"
          ? "Viumi no aceptó estas credenciales en el ambiente elegido. Revisalas o probá el otro ambiente."
          : null;
      setServerError(getnetMsg ?? ualaMsg ?? viumiMsg ?? "No pudimos guardar la conexión. Revisá los datos y probá de nuevo.");
    } finally {
      setSaving(false);
    }
  };

  const nextFromCreds = () => {
    if (!credsValid) {
      setShowErrors(true);
      return;
    }
    if (isMp) {
      run(() => onSave({ token: mpToken.trim() }), () => setStep(1));
      return;
    }
    setStep(1);
  };

  const finish = async () => {
    if (isMp) {
      if (needsTestToken && !mpTestValid) {
        setShowErrors(true);
        return;
      }
      const change: MpEnvChange | null =
        env === "test" && mpTestValid
          ? { env: "test", testToken: mpTestToken.trim() }
          : env !== currentEnv
            ? { env }
            : null;
      if (!change || !onMpEnv) {
        setStep(2);
        return;
      }
      run(() => onMpEnv(change), () => setStep(2));
      return;
    }
    const secrets = typedSecrets();
    if (isGetnet) {
      // Getnet (ADR-069 adenda): no se guardan credenciales que fallan la
      // prueba. Si no se probaron, se prueban ahora; si fallan, el resultado
      // queda a la vista (en rojo) y no se guarda nada.
      const checked = probe ?? (await runProbe(false));
      if (!checked?.ok) return;
      Object.assign(secrets, probeSecrets(checked, env));
      // Un slot por vez, sin pisar el otro (merge) y sin dejar datos viejos del mismo.
      const save = getnetSlotSave(slot, secrets, env);
      run(
        () => onSave({ secrets: save.secrets, remove: save.remove, merge: true, slot, env: slot === "web_checkout" ? env : undefined }),
        () => setStep(2),
      );
      return;
    }
    // Ambiente explícito + API detectada por la prueba (si la hubo).
    if (onProbe) Object.assign(secrets, probeSecrets(probe, env));
    run(() => onSave({ secrets, env: SANDBOX_PROVIDERS.has(providerKey) ? env : undefined }), () => setStep(2));
  };

  function typedSecrets(): Record<string, string> {
    const secrets: Record<string, string> = {};
    for (const f of [...fields, ...apiFields]) {
      const v = (values[f.name] ?? "").trim();
      if (v) secrets[f.name] = v;
    }
    return secrets;
  }

  // Prueba las credenciales tipeadas (o, sin tipear, las guardadas) sin guardar.
  const runProbe = async (saved: boolean): Promise<GetnetProbeResult | null> => {
    if (!onProbe) return null;
    setProbing(true);
    setProbe(null);
    let r: GetnetProbeResult;
    try {
      const probeEnv = saved ? currentEnv : env;
      const slotArg = isGetnet ? { slot } : {};
      r = await onProbe(saved ? { env: probeEnv, ...slotArg } : { secrets: typedSecrets(), env: probeEnv, ...slotArg });
    } catch {
      r = { ok: false, summary: "No pudimos probar las credenciales. Revisá tu conexión y probá de nuevo." };
    } finally {
      setProbing(false);
    }
    setProbe(r);
    return r;
  };

  const closeOrBack = () => (connected ? setView("manage") : onOpenChange(false));
  const finalEnv = isMp ? env : hasSandbox ? env : "prod";

  // ── Encabezado: logo + nombre + estado ──────────────────────────────────
  const header = (
    <div className="flex items-center gap-3">
      <BrandLogo brandKey={brand.key} name={brand.name} size={44} />
      <div className="min-w-0">
        <p className="truncate text-lg font-bold leading-tight tracking-tight">{brand.name}</p>
        <div className="mt-1">
          {connected ? (
            <StatusChip tone={currentEnv === "test" ? "test" : "ok"}>
              {currentEnv === "test" ? "Conectado en prueba" : "Conectado"}
            </StatusChip>
          ) : (
            <StatusChip tone="idle">Sin conectar</StatusChip>
          )}
        </div>
      </div>
    </div>
  );

  // ── Pie: acción principal a todo el ancho + acción secundaria en texto ──
  const textBtn =
    "inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-xl text-sm font-medium text-muted-foreground transition hover:bg-fg-4 hover:text-foreground disabled:opacity-50";
  let footer: React.ReactNode = null;
  if (view === "manage") {
    footer = confirmOff ? (
      <div className="space-y-2.5 rounded-lg bg-danger/10 p-3.5">
        <p className="text-sm">
          <strong className="text-danger">¿Desconectar {brand.name}?</strong>{" "}
          <span className="text-muted-foreground">
            {scopeName
              ? `Se borran las credenciales propias de ${scopeName} y vuelve a cobrar con las del negocio.`
              : `Se borran las credenciales y dejás de cobrar con ${channelNames.join(" ni con ")}.`}
          </span>
        </p>
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" onClick={() => setConfirmOff(false)} disabled={saving}>
            Cancelar
          </Button>
          <Button
            variant="destructive"
            loading={saving}
            onClick={() =>
              run(onDisconnect, () => {
                toast({ title: `${brand.name} desconectado`, variant: "success" });
                onOpenChange(false);
              })
            }
          >
            Sí, desconectar
          </Button>
        </div>
      </div>
    ) : (
      <>
        {isMp && onOAuth ? (
          <Button className="w-full" loading={oauthPending} onClick={onOAuth}>
            <RefreshCw size={15} /> Reconectar con Mercado Pago
          </Button>
        ) : (
          <Button
            className="w-full"
            onClick={() => {
              setView("wizard");
              setStep(0);
            }}
          >
            <KeyRound size={15} /> Actualizar credenciales
          </Button>
        )}
        <button type="button" onClick={() => setConfirmOff(true)} className={cn(textBtn, "text-danger hover:text-danger")}>
          <Unplug size={15} /> {scopeName ? `Volver a las credenciales del negocio` : `Desconectar ${brand.name}`}
        </button>
      </>
    );
  } else if (step === 0) {
    footer =
      isMp && !showManual ? (
        <>
          <Button className="w-full" loading={oauthPending} onClick={onOAuth}>
            {connected ? "Reconectar con Mercado Pago" : "Conectar con Mercado Pago"} <ArrowRight size={15} />
          </Button>
          <button type="button" onClick={closeOrBack} className={textBtn}>
            {connected ? "Volver" : "Cancelar"}
          </button>
        </>
      ) : (
        <>
          <Button className="w-full" loading={saving} onClick={nextFromCreds}>
            {isMp ? "Guardar y seguir" : "Siguiente"} <ArrowRight size={15} />
          </Button>
          <button type="button" onClick={isMp ? () => setShowManual(false) : closeOrBack} className={textBtn}>
            {isMp ? "Conectar con Mercado Pago" : connected ? "Volver" : "Cancelar"}
          </button>
        </>
      );
  } else if (step === 1) {
    footer = (
      <>
        <Button className="w-full" loading={saving || probing} onClick={() => void finish()}>
          {isMp ? "Continuar" : connected ? "Guardar cambios" : `Conectar ${brand.name}`}
        </Button>
        {!isMp && (
          <button type="button" onClick={() => setStep(0)} disabled={saving} className={textBtn}>
            <ArrowLeft size={15} /> Atrás
          </button>
        )}
      </>
    );
  } else {
    footer = (
      <Button className="w-full" onClick={() => onOpenChange(false)}>
        Listo
      </Button>
    );
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={view === "manage" ? brand.name : `Conectar ${brand.name}`}
      header={header}
      footer={<div className="flex w-full flex-col gap-1.5 sm:!w-full">{footer}</div>}
    >
      <form className="space-y-5" autoComplete="off" onSubmit={(e) => e.preventDefault()}>
        {/* Señuelos anti-autocompletado del navegador. */}
        <input type="text" name="username" autoComplete="username" className="hidden" tabIndex={-1} />
        <input type="password" name="password" autoComplete="new-password" className="hidden" tabIndex={-1} />

        {scopeSlot}

        {view === "wizard" && <Stepper steps={STEPS} current={step} />}

        {/* ── Administrar ─────────────────────────────────────────────── */}
        {view === "manage" && (
          <div className="space-y-4">
            <dl className="divide-y divide-border overflow-hidden rounded-lg bg-fg-4 text-sm">
              <SummaryRow
                icon={currentEnv === "test" ? <FlaskConical size={16} /> : <ShieldCheck size={16} />}
                tile={currentEnv === "test" ? "bg-warning/15 text-warning" : "bg-success/15 text-success"}
                label="Ambiente"
              >
                {currentEnv === "test" ? "Prueba · sin plata real" : "Producción · cobros reales"}
              </SummaryRow>
              {caps.length > 0 && (
                <SummaryRow icon={<Sparkles size={16} />} label="Con esta cuenta cobrás">
                  <span className="mt-1 flex flex-wrap gap-1.5">
                    {caps.map((c) => (
                      <CapBadge key={c} cap={c} />
                    ))}
                  </span>
                </SummaryRow>
              )}
              <SummaryRow icon={<Lock size={16} />} label="Credenciales">
                Cifradas en el servidor
              </SummaryRow>
            </dl>

            {isMp && onMpEnv && (
              <MpEnvPanel
                env={currentEnv}
                hasTest={hasTest}
                pending={saving}
                token={mpTestToken}
                onToken={setMpTestToken}
                onChange={(v) => run(() => onMpEnv(v), () => setMpTestToken(""))}
              />
            )}

            {isMp && (
              <button
                type="button"
                onClick={() => {
                  setView("wizard");
                  setStep(0);
                  setShowManual(true);
                }}
                className="flex w-full items-center gap-2 rounded-xl bg-fg-4 px-3.5 py-3 text-left text-sm font-medium transition hover:bg-fg-6"
              >
                <KeyRound size={15} className="text-muted-foreground" /> Pegar un Access Token
              </button>
            )}

            {isGetnet && getnetSlots && (
              <GetnetSlotCards
                slots={getnetSlots}
                ownCheckout={getnetOwnCheckout}
                active={slot}
                onPick={pickSlot}
                onEdit={(s) => {
                  pickSlot(s);
                  setView("wizard");
                  setStep(0);
                }}
                onClear={
                  onClearSlot && getnetOwnCheckout && getnetSlots.web_checkout && getnetSlots.checkout_api
                    ? (s) =>
                        run(
                          () => onClearSlot(s),
                          () => toast({ title: `Credenciales de ${GETNET_SLOT_BY_KEY[s].short} quitadas`, variant: "success" }),
                        )
                    : undefined
                }
                pending={saving}
              />
            )}
            {isGetnet && !getnetOwnCheckout && <Notice tone="warning">{GETNET_VTEX_WARNING}</Notice>}

            {onProbe && (!isGetnet || getnetSlots?.[slot]) && (
              <div className="space-y-2.5">
                <button
                  type="button"
                  onClick={() => runProbe(true)}
                  disabled={probing}
                  className="flex w-full items-center gap-2 rounded-xl bg-fg-4 px-3.5 py-3 text-left text-sm font-medium transition hover:bg-fg-6 disabled:opacity-50"
                >
                  <PlugZap size={15} className="text-muted-foreground" />
                  {probing
                    ? "Probando la conexión..."
                    : isGetnet
                      ? `Probar ${GETNET_SLOT_BY_KEY[slot].short}`
                      : "Probar conexión"}
                </button>
                {probe && <ProbePanel result={probe} brandName={brand.name} />}
              </div>
            )}

            {serverError && <Notice tone="danger">{serverError}</Notice>}
          </div>
        )}

        {/* ── Paso 1: datos ───────────────────────────────────────────── */}
        {view === "wizard" && step === 0 && (
          <div className="space-y-4">
            {isMp && !showManual ? (
              <>
                <div className="rounded-lg bg-fg-4 p-4">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center gap-1 rounded-md bg-success/15 px-2 py-0.5 text-[11px] font-semibold text-success">
                      <Check size={11} strokeWidth={3} /> Recomendado
                    </span>
                  </div>
                  <p className="mt-2 text-[15px] font-semibold">Conectá en un toque</p>
                  <p className="mt-0.5 text-[13px] text-muted-foreground">
                    Te llevamos a Mercado Pago, autorizás y volvés. No tenés que copiar nada.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowManual(true)}
                  className="flex w-full items-center gap-2 rounded-xl px-1 text-left text-[13px] font-medium text-muted-foreground transition hover:text-foreground"
                >
                  <KeyRound size={14} /> Prefiero pegar el Access Token
                </button>
              </>
            ) : (
              <>
                {isGetnet && getnetSlots && (
                  <div className="space-y-2.5">
                    <Eyebrow>{getnetOwnCheckout ? "¿Qué credenciales vas a cargar?" : "Las credenciales que tenés que cargar"}</Eyebrow>
                    <GetnetSlotCards slots={getnetSlots} ownCheckout={getnetOwnCheckout} active={slot} onPick={pickSlot} />
                    {slot === "web_checkout" && <Notice tone="warning">{GETNET_VTEX_WARNING}</Notice>}
                  </div>
                )}
                {guide && (
                  <div className="space-y-3">
                    <Eyebrow>Cómo conectarlo</Eyebrow>
                    <GuideSteps steps={guide.steps} />
                    <WhereRow href={brand.credentialsUrl} label={brand.credentialsLabel} path={guide.where} />
                  </div>
                )}
                {guide?.warning && <Notice tone="warning" title={guide.warning.title}>{guide.warning.text}</Notice>}

                <div className="space-y-3.5">
                  <Eyebrow>Tus credenciales</Eyebrow>
                  {isMp ? (
                    <CredentialInput
                      label="Access Token de producción"
                      secret
                      mono
                      name="mp_access_token"
                      autoComplete="new-password"
                      data-1p-ignore
                      data-lpignore="true"
                      configured={connected}
                      value={mpToken}
                      onChange={(e) => setMpToken(e.target.value)}
                      placeholder="APP_USR-..."
                      error={showErrors && !credsValid ? "Pegá el Access Token completo." : undefined}
                    />
                  ) : (
                    fields.map((f) => (
                      <CredentialInput
                        key={f.name}
                        label={f.label}
                        optional={f.optional}
                        secret={f.secret}
                        mono
                        configured={slotConnected && !f.optional}
                        configuredLabel="Configurada"
                        name={`${providerKey}_${f.name}`}
                        autoComplete={f.secret ? "new-password" : "off"}
                        data-1p-ignore
                        data-lpignore="true"
                        value={values[f.name] ?? ""}
                        onChange={(e) => {
                          setValues((v) => ({ ...v, [f.name]: e.target.value }));
                          setProbe(null);
                        }}
                        onBlur={() => setTouched((t) => ({ ...t, [f.name]: true }))}
                        placeholder={slotConnected && !f.optional ? "Pegá el valor nuevo" : f.placeholder}
                        hint={f.hint}
                        error={errorOf(f)}
                      />
                    ))
                  )}
                </div>
                {guide?.note && <Notice>{guide.note}</Notice>}
                {providerKey === "nave" && <NaveWebhookBox />}
              </>
            )}

            {serverError && <Notice tone="danger">{serverError}</Notice>}
            <SecurityNote>{SECURITY_NOTE}</SecurityNote>
          </div>
        )}

        {/* ── Paso 2: ambiente ────────────────────────────────────────── */}
        {view === "wizard" && step === 1 && (
          <div className="space-y-4">
            <div className="space-y-2.5">
              <Eyebrow>{isMp ? "¿Dónde vas a cobrar?" : "¿De qué ambiente son estas credenciales?"}</Eyebrow>
              <EnvPicker
                value={hasSandbox ? env : "prod"}
                onChange={(v) => {
                  setEnv(v);
                  setProbe(null);
                }}
                disabledTest={!hasSandbox}
                testHint={hasSandbox ? undefined : "No disponible"}
              />
            </div>
            {!hasSandbox && spec?.envNote ? (
              <Notice tone="warning" title="Sin ambiente de prueba">
                {spec.envNote}
              </Notice>
            ) : (
              <Notice>
                {env === "test"
                  ? "Probá el circuito completo sin mover plata real. Cuando abras, pasá a producción."
                  : "Los cobros son reales y la plata entra a tu cuenta."}
                {hasSandbox && spec?.envNote ? ` ${spec.envNote}` : ""}
              </Notice>
            )}

            {onProbe && (
              <div className="space-y-2.5">
                <Button variant="secondary" className="w-full" loading={probing} onClick={() => runProbe(false)}>
                  <PlugZap size={15} /> Probar credenciales
                </Button>
                {probe && (
                  <ProbePanel
                    result={probe}
                    brandName={brand.name}
                    onSwitchEnv={(v) => {
                      setEnv(v);
                      setProbe(null);
                    }}
                  />
                )}
                {apiFields.length > 0 && (
                  <div className="space-y-3.5">
                    <Eyebrow>Comprador por defecto (opcional)</Eyebrow>
                    <p className="text-[13px] text-muted-foreground">
                      Web Checkout pide datos del comprador. Si el cliente no se identifica, mandamos
                      &quot;Consumidor Final&quot; con estos datos de tu comercio.
                    </p>
                    {apiFields.map((f) => (
                      <CredentialInput
                        key={f.name}
                        label={f.label}
                        optional
                        mono
                        name={`${providerKey}_${f.name}`}
                        autoComplete="off"
                        data-1p-ignore
                        data-lpignore="true"
                        value={values[f.name] ?? ""}
                        onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                        placeholder={f.placeholder}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}

            {isMp && env === "test" && (
              <CredentialInput
                label="Access Token de prueba"
                secret
                mono
                name="mp_test_access_token"
                autoComplete="new-password"
                data-1p-ignore
                data-lpignore="true"
                configured={hasTest}
                configuredLabel="Cargado"
                value={mpTestToken}
                onChange={(e) => setMpTestToken(e.target.value)}
                placeholder={hasTest ? "Pegá uno nuevo para reemplazarlo" : "APP_USR-... o TEST-..."}
                hint="Tus integraciones › Credenciales de prueba. Convive con la conexión de producción."
                error={showErrors && needsTestToken && !mpTestValid ? "Pegá el Access Token de prueba." : undefined}
              />
            )}

            {serverError && <Notice tone="danger">{serverError}</Notice>}
          </div>
        )}

        {/* ── Paso 3: listo ───────────────────────────────────────────── */}
        {view === "wizard" && step === 2 && (
          <div className="space-y-5 text-center">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-success/15 text-success">
              <Check size={32} strokeWidth={2.5} />
            </div>
            <div>
              <p className="text-lg font-bold">
                {isGetnet ? `${GETNET_SLOT_BY_KEY[slot].short} de ${brand.name} quedó conectado` : `${brand.name} quedó conectado`}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {finalEnv === "test"
                  ? "Ambiente de prueba: los cobros no mueven plata real."
                  : "Ambiente de producción: ya podés cobrar de verdad."}
              </p>
            </div>
            <ul className="space-y-2.5 rounded-lg bg-fg-4 p-4 text-left text-sm">
              <NextStep n={1}>Activá los canales que vas a usar ({channelNames.join(", ")}).</NextStep>
              {isMp && <NextStep n={2}>Configurá la caja QR para mostrar un QR único por venta.</NextStep>}
              {providerKey === "nave" && <NextStep n={2}>Pasale a Nave la URL de notificaciones.</NextStep>}
              {providerKey === "ualabis" && (
                <NextStep n={2}>
                  Al cobrar elegís Ualá Bis, Link o QR: la venta se cierra sola cuando Ualá acredita el pago.
                </NextStep>
              )}
              {providerKey === "viumi" && (
                <NextStep n={2}>
                  Al cobrar elegís Viumi, Link o QR: la venta se cierra sola cuando Viumi acredita el pago.
                </NextStep>
              )}
              {providerKey === "directo" && (
                <NextStep n={2}>
                  Al cobrar elegís Directo QR o Link: la venta se cierra sola cuando Directo aprueba el crédito.
                </NextStep>
              )}
              {providerKey === "fiserv" && (
                <NextStep n={2}>
                  Abrí la app Cloud Pay Display en cada terminal Clover y dejala abierta: ahí llegan los cobros.
                </NextStep>
              )}
              {(providerKey === "payway" || providerKey === "mobbex") && (
                <NextStep n={2}>Armá tus planes de cuotas y recargo por tarjeta.</NextStep>
              )}
              {isGetnet && slot === "checkout_api" && (
                <NextStep n={2}>
                  Armá tus planes de cuotas de Getnet: son las cuotas que el cliente ve en tu checkout. En el POS elegís
                  Getnet, Link (checkout propio).
                </NextStep>
              )}
              {isGetnet && slot === "web_checkout" && (
                <NextStep n={2}>En el POS elegís Getnet, QR o Link: el cliente paga en la página de Getnet.</NextStep>
              )}
            </ul>
          </div>
        )}
      </form>
    </Modal>
  );
}

function SummaryRow({
  icon,
  tile = "bg-fg-6 text-foreground",
  label,
  children,
}: {
  icon: React.ReactNode;
  tile?: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 px-3.5 py-3">
      <span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-lg", tile)}>{icon}</span>
      <div className="min-w-0 flex-1">
        <dt className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">{label}</dt>
        <dd className="text-[13px] font-medium text-foreground">{children}</dd>
      </div>
    </div>
  );
}

function NextStep({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-foreground text-[10px] font-bold text-background">
        {n}
      </span>
      <span className="text-muted-foreground">{children}</span>
    </li>
  );
}

// Resultado de "Probar credenciales" (Getnet, ADR-065): qué API respondió, y
// si falló, cada servicio probado con su HTTP y el código de Getnet.
function ProbePanel({
  result,
  onSwitchEnv,
  brandName = "Getnet",
}: {
  result: GetnetProbeResult;
  onSwitchEnv?: (v: Env) => void;
  brandName?: string;
}) {
  const { toast } = useToast();
  const attempts = result.attempts ?? [];
  const switchTo = probeMismatchEnv(result);
  if (result.error === "not_connected") {
    return <Notice tone="warning">Cargá las credenciales para probarlas.</Notice>;
  }
  if (result.error === "checkout_api_unavailable") {
    return (
      <Notice tone="warning">
        El checkout propio con Getnet no está habilitado. Cargá las de Web Checkout / Plugin Magento / Plugin WooCommerce.
      </Notice>
    );
  }
  if (!result.ok && result.slot_mismatch) {
    // ADR-069 adenda: credenciales del otro juego. No se guardan.
    return (
      <Notice tone="danger" title="Estas credenciales no sirven acá">
        {result.summary}
      </Notice>
    );
  }
  if (result.slot === "checkout_api") {
    const apiAttempts = result.api_attempts ?? [];
    return result.ok ? (
      <div className="space-y-2">
        <Notice title="Las credenciales funcionan">
          {result.label}
          {result.seller_id ? ` · Seller ID ${result.seller_id}` : ""}. Se guarda con la conexión.
        </Notice>
        {(result.warnings ?? []).map((w) => (
          <Notice key={w} tone="warning">
            {w}
          </Notice>
        ))}
      </div>
    ) : (
      <div className="space-y-2">
        <Notice tone="danger" title="Getnet no aceptó las credenciales">
          {result.summary ?? "No pudimos validar las credenciales."}
        </Notice>
        {apiAttempts.length > 0 && (
          <ul className="space-y-1 rounded-lg bg-fg-4 p-3 text-xs text-muted-foreground">
            {apiAttempts.map((a) => (
              <li key={a.endpoint} className="break-words">
                {probeApiAttemptLine(a)}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  if (result.ok) {
    return (
      <div className="space-y-2">
        <Notice title="Las credenciales funcionan">
          {result.label}
          {result.seller?.trade_name ? ` · Comercio: ${result.seller.trade_name}` : ""}. Se guarda esta API con la conexión.
        </Notice>
        {(result.warnings ?? []).map((w) => (
          <Notice key={w} tone="warning">
            {w}
          </Notice>
        ))}
        {result.api === "global" && result.webhook_url && (
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg bg-fg-4 px-2.5 py-2 font-mono text-[11px]">
              {result.webhook_url}
            </code>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() =>
                navigator.clipboard
                  .writeText(result.webhook_url ?? "")
                  .then(() => toast({ title: "URL copiada", variant: "success" }))
                  .catch(() => toast({ title: "No se pudo copiar", variant: "error" }))
              }
            >
              <Copy size={14} /> Copiar
            </Button>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <Notice tone="danger" title={`${brandName} no aceptó las credenciales`}>
        {result.summary ?? "No pudimos validar las credenciales."}
      </Notice>
      {switchTo && onSwitchEnv && (
        <Button type="button" size="sm" variant="secondary" className="w-full" onClick={() => onSwitchEnv(switchTo)}>
          Cambiar a {switchTo === "test" ? "Prueba" : "Producción"}
        </Button>
      )}
      {attempts.length > 0 && (
        <ul className="space-y-1 rounded-lg bg-fg-4 p-3 text-xs text-muted-foreground">
          {attempts.map((a) => (
            <li key={`${a.profile}:${a.step}`} className="break-words">
              {probeAttemptLine(a)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Getnet (ADR-069): los dos juegos de credenciales, qué es cada uno y si está
// cargado. Elegible (paso de datos) o con acciones (Administrar).
function GetnetSlotCards({
  slots,
  ownCheckout,
  active,
  onPick,
  onEdit,
  onClear,
  pending = false,
}: {
  slots: Record<GetnetSlot, boolean>;
  /** Checkout propio habilitado: muestra también la tarjeta Checkout API. */
  ownCheckout: boolean;
  active: GetnetSlot;
  onPick: (s: GetnetSlot) => void;
  onEdit?: (s: GetnetSlot) => void;
  onClear?: (s: GetnetSlot) => void;
  pending?: boolean;
}) {
  // ADR-069 adenda: con el checkout propio apagado hay UNA sola tarjeta
  // (Web Checkout), sin elección.
  const defs = visibleGetnetSlots(ownCheckout);
  const single = defs.length === 1;
  return (
    <div className="grid gap-2.5" role={single ? undefined : "radiogroup"} aria-label="Credenciales de Getnet">
      {defs.map((d) => {
        const on = active === d.key;
        const loaded = slots[d.key];
        return (
          <div
            key={d.key}
            role={single ? undefined : "radio"}
            aria-checked={single ? undefined : on}
            tabIndex={single ? undefined : 0}
            onClick={single ? undefined : () => onPick(d.key)}
            onKeyDown={
              single
                ? undefined
                : (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onPick(d.key);
                    }
                  }
            }
            className={cn(
              "rounded-lg border p-3.5 text-left transition",
              single && "border-border bg-fg-4",
              !single && "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              !single && (on ? "border-foreground/40 bg-fg-4" : "border-border hover:bg-fg-4"),
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold">{d.title}</p>
              <StatusChip tone={loaded ? "ok" : "idle"}>{loaded ? "Cargadas" : "Sin cargar"}</StatusChip>
            </div>
            <p className="mt-1 text-[13px] text-muted-foreground">{d.purpose}</p>
            <p className="mt-1 text-[13px] text-muted-foreground">{d.credentials}</p>
            {(onEdit || (onClear && loaded)) && (
              <div className="mt-2.5 flex flex-wrap gap-2">
                {onEdit && (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={pending}
                    onClick={(e) => {
                      e.stopPropagation();
                      onEdit(d.key);
                    }}
                  >
                    <KeyRound size={14} /> {loaded ? "Actualizar" : "Cargar credenciales"}
                  </Button>
                )}
                {onClear && loaded && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="text-danger"
                    disabled={pending}
                    onClick={(e) => {
                      e.stopPropagation();
                      onClear(d.key);
                    }}
                  >
                    Quitar
                  </Button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function NaveWebhookBox() {
  const { toast } = useToast();
  const { data: me } = useMyTenant();
  const email = naveRegistrationEmail(me?.name);
  const copy = (text: string, title: string) =>
    navigator.clipboard
      .writeText(text)
      .then(() => toast({ title, variant: "success" }))
      .catch(() => toast({ title: "No se pudo copiar", variant: "error" }));
  return (
    <div className="space-y-2.5 rounded-lg bg-fg-4 p-3.5">
      <div className="flex items-center gap-2.5">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--seg-thumb)] text-foreground shadow-[var(--seg-thumb-shadow)]">
          <BellRing size={15} />
        </span>
        <div className="min-w-0 leading-tight">
          <p className="text-[13px] font-semibold">URL de notificaciones</p>
          <p className="text-xs text-muted-foreground">Pasásela a Nave: así nos avisa cada pago al instante.</p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg bg-[var(--background)] px-2.5 py-2 font-mono text-[11px]">
          {NAVE_WEBHOOK_URL}
        </code>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => copy(NAVE_WEBHOOK_URL, "URL copiada")}
        >
          <Copy size={14} /> Copiar
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Te armamos el mail para {email.to}: pide registrar la URL en sandbox y producción, y tus credenciales.
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Button type="button" size="sm" variant="secondary" onClick={() => copy(email.text, "Copiado")}>
          <Copy size={14} /> Copiar mail para Nave
        </Button>
        <a
          href={email.mailto}
          className={buttonVariants({ variant: "ghost", size: "sm" })}
        >
          <Mail size={14} /> Abrir en mi correo
        </a>
      </div>
    </div>
  );
}

// Ambiente de Mercado Pago desde Administrar (ADR-032): producción usa la
// conexión; prueba usa un Access Token de prueba que convive con ella.
function MpEnvPanel({
  env,
  hasTest,
  pending,
  token,
  onToken,
  onChange,
}: {
  env: Env;
  hasTest: boolean;
  pending: boolean;
  token: string;
  onToken: (v: string) => void;
  onChange: (v: MpEnvChange) => void;
}) {
  const [want, setWant] = useState<Env>(env);
  useEffect(() => setWant(env), [env]);
  return (
    <div className="space-y-2.5">
      <Eyebrow>Ambiente de cobro</Eyebrow>
      <EnvPicker
        value={want}
        onChange={(v) => {
          setWant(v);
          if (v === "prod" && env !== "prod") onChange({ env: "prod" });
          if (v === "test" && hasTest && env !== "test") onChange({ env: "test" });
        }}
      />
      {want === "test" && (
        <div className="space-y-2.5 pt-1">
          <CredentialInput
            label="Access Token de prueba"
            secret
            mono
            name="mp_test_access_token"
            autoComplete="new-password"
            data-1p-ignore
            data-lpignore="true"
            configured={hasTest}
            configuredLabel="Cargado"
            value={token}
            onChange={(e) => onToken(e.target.value)}
            placeholder={hasTest ? "Pegá uno nuevo para reemplazarlo" : "APP_USR-... o TEST-..."}
            hint="Tus integraciones › Credenciales de prueba."
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              loading={pending}
              disabled={token.trim().length < 8}
              onClick={() => onChange({ env: "test", testToken: token.trim() })}
            >
              {hasTest ? "Reemplazar token" : "Guardar y usar prueba"}
            </Button>
            {hasTest && (
              <Button
                size="sm"
                variant="ghost"
                className="text-danger"
                disabled={pending}
                onClick={() => onChange({ env: "prod", clearTest: true })}
              >
                Quitar token de prueba
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
