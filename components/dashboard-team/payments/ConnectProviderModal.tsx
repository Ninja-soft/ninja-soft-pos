"use client";

import { useEffect, useState } from "react";
import {
  ArrowLeft,
  Check,
  Copy,
  ExternalLink,
  KeyRound,
  ShieldCheck,
  TriangleAlert,
  Unplug,
} from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { SANDBOX_PROVIDERS, type BrandDef } from "@/lib/payments/catalog";
import { NAVE_WEBHOOK_URL } from "./copy";
import { BrandWordmark, EnvSegmented, Eyebrow, StatusChip, Stepper } from "./ui";
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
};

type FormSpec = { intro: string; fields: Field[]; envNote?: string };

const FORMS: Record<string, FormSpec> = {
  modo: {
    intro: "Pegá las credenciales que te mandó MODO por email.",
    fields: [
      { name: "username", label: "Username", min: 4, placeholder: "Tu Username de MODO" },
      { name: "password", label: "Password", secret: true, min: 6, placeholder: "Tu Password de MODO" },
      { name: "store_id", label: "Store ID", optional: true, placeholder: "Sólo si tenés varias sucursales" },
      { name: "processor_code", label: "Processor code", optional: true, placeholder: "Ej: P1293 (viene en el email)" },
    ],
    envNote: "Si las credenciales terminan en -preprod, son de prueba.",
  },
  nave: {
    intro: "Pegá las credenciales que te dio Nave (Integraciones) y el ID de punto de venta.",
    fields: [
      { name: "client_id", label: "Client ID", min: 6, placeholder: "Tu Client ID de Nave" },
      { name: "client_secret", label: "Client Secret", secret: true, min: 6, placeholder: "Tu Client Secret de Nave" },
      { name: "pos_id", label: "ID de punto de venta (QR y link)", min: 4, placeholder: "pos_id que te dio Nave" },
      {
        name: "point_pos_ids",
        label: "Terminales Nave Point",
        optional: true,
        placeholder: "Caja 1: id-terminal, Caja 2: otro-id",
        hint: "ID de punto de venta de cada terminal (Nave › Integraciones › Sistema de gestión), separados por coma.",
      },
      { name: "audience", label: "Audience", optional: true, placeholder: "Sólo si Nave te dio uno distinto" },
    ],
    envNote: "Prueba y producción usan credenciales distintas.",
  },
  payway: {
    intro: "Pegá tus llaves de Payway (Panel de comercio › Credenciales) y tu Nº de comercio.",
    fields: [
      { name: "public_apikey", label: "API Key pública", min: 10, placeholder: "Tu public API Key" },
      { name: "private_apikey", label: "API Key privada", secret: true, min: 10, placeholder: "Tu private API Key" },
      { name: "site", label: "Nº de comercio (site)", min: 4, placeholder: "Ej: 00097002" },
    ],
  },
  getnet: {
    intro: "Pegá tu Client ID y Client Secret (Portal Getnet › Credenciales).",
    fields: [
      { name: "client_id", label: "Client ID", min: 4, placeholder: "Tu Client ID" },
      { name: "client_secret", label: "Client Secret", secret: true, min: 8, placeholder: "Tu Client Secret" },
    ],
    envNote: "Getnet no ofrece ambiente de prueba: las credenciales son de producción y los cobros son reales.",
  },
  pagos360: {
    intro: "Pegá tu API Key de Pagos360 (Panel › Configuración › Credenciales).",
    fields: [{ name: "api_key", label: "API Key", secret: true, min: 10, placeholder: "Tu API Key" }],
  },
  mobbex: {
    intro: "Pegá tus credenciales de Mobbex (Desarrollo › Credenciales).",
    fields: [
      { name: "api_key", label: "API Key", min: 6, placeholder: "Tu API Key" },
      { name: "access_token", label: "Access Token", secret: true, min: 6, placeholder: "Tu Access Token" },
    ],
    envNote: "Mobbex toma el ambiente de tu cuenta: usá las credenciales con las que vas a cobrar.",
  },
};

const STEPS = ["Credenciales", "Ambiente", "Listo"];

function fieldError(f: Field, v: string): string | undefined {
  const t = v.trim();
  if (f.optional && !t) return undefined;
  if (!t) return `Completá ${f.label}.`;
  if (f.min && t.length < f.min) return `${f.label} parece incompleto: revisá que lo hayas copiado entero.`;
  return undefined;
}

export type ConnectSave = { secrets?: Record<string, string>; token?: string; env?: Env };

export function ConnectProviderModal({
  open,
  onOpenChange,
  brand,
  providerKey,
  method,
  channelNames,
  onSave,
  onDisconnect,
  onOAuth,
  oauthPending = false,
  onMpEnv,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  brand: BrandDef;
  providerKey: string;
  method: Method | undefined;
  // Canales de la marca que usan esta conexión (para el resumen).
  channelNames: string[];
  onSave: (v: ConnectSave) => Promise<void>;
  onDisconnect: () => Promise<void>;
  onOAuth?: () => void;
  oauthPending?: boolean;
  onMpEnv?: (v: MpEnvChange) => Promise<void>;
}) {
  const { toast } = useToast();
  const isMp = providerKey === "mercadopago";
  const spec = FORMS[providerKey];
  const connected = Boolean(method?.config?.connected);
  const hasSandbox = SANDBOX_PROVIDERS.has(providerKey) || isMp;
  const currentEnv: Env = isMp ? mpEnvOf(method) : method?.sandbox && hasSandbox ? "test" : "prod";

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const fields = spec?.fields ?? [];
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
    } catch {
      setServerError("No pudimos guardar la conexión. Revisá los datos y probá de nuevo.");
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

  const finish = () => {
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
    const secrets: Record<string, string> = {};
    for (const f of fields) {
      const v = (values[f.name] ?? "").trim();
      if (v) secrets[f.name] = v;
    }
    run(() => onSave({ secrets, env: SANDBOX_PROVIDERS.has(providerKey) ? env : undefined }), () => setStep(2));
  };

  const title = view === "manage" ? brand.name : `Conectar ${brand.name}`;

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={title}>
      <form className="space-y-5" autoComplete="off" onSubmit={(e) => e.preventDefault()}>
        {/* Señuelos anti-autocompletado del navegador. */}
        <input type="text" name="username" autoComplete="username" className="hidden" tabIndex={-1} />
        <input type="password" name="password" autoComplete="new-password" className="hidden" tabIndex={-1} />

        <div className="flex flex-col items-center gap-3">
          <BrandWordmark brandKey={brand.key} name={brand.name} />
          {view === "manage" && (
            <StatusChip tone={currentEnv === "test" ? "test" : "ok"}>
              {currentEnv === "test" ? "Conectado en prueba" : "Conectado"}
            </StatusChip>
          )}
        </div>

        {view === "wizard" && <Stepper steps={STEPS} current={step} />}

        {/* ── Administrar ─────────────────────────────────────────────── */}
        {view === "manage" && (
          <div className="space-y-4">
            <dl className="divide-y divide-border overflow-hidden rounded-xl bg-[color-mix(in_srgb,var(--foreground)_5%,transparent)] text-sm">
              <div className="flex items-center justify-between gap-3 px-4 py-3">
                <dt className="text-muted-foreground">Ambiente</dt>
                <dd className="font-semibold">{currentEnv === "test" ? "Prueba (sin plata real)" : "Producción"}</dd>
              </div>
              <div className="flex items-start justify-between gap-3 px-4 py-3">
                <dt className="shrink-0 text-muted-foreground">Usan esta conexión</dt>
                <dd className="text-right font-medium">{channelNames.join(" · ")}</dd>
              </div>
              <div className="flex items-center justify-between gap-3 px-4 py-3">
                <dt className="text-muted-foreground">Credenciales</dt>
                <dd className="flex items-center gap-1.5 font-medium">
                  <ShieldCheck size={15} className="text-success" /> Cifradas
                </dd>
              </div>
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

            <div className="grid gap-2 sm:grid-cols-2">
              {isMp && onOAuth ? (
                <Button variant="secondary" loading={oauthPending} onClick={onOAuth}>
                  Reconectar cuenta
                </Button>
              ) : null}
              <Button
                variant="secondary"
                className={cn(!(isMp && onOAuth) && "sm:col-span-2")}
                onClick={() => {
                  setView("wizard");
                  setStep(0);
                }}
              >
                <KeyRound size={15} /> {isMp ? "Pegar Access Token" : "Actualizar credenciales"}
              </Button>
            </div>

            {serverError && <ErrorBox msg={serverError} />}

            <div className="rounded-xl bg-[color-mix(in_srgb,var(--destructive)_7%,transparent)] p-3.5">
              {confirmOff ? (
                <div className="space-y-3">
                  <p className="text-sm">
                    <strong>¿Desconectar {brand.name}?</strong>{" "}
                    <span className="text-muted-foreground">
                      Se borran las credenciales y dejás de poder cobrar con {channelNames.join(" ni con ")}.
                    </span>
                  </p>
                  <div className="flex gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setConfirmOff(false)} disabled={saving}>
                      Cancelar
                    </Button>
                    <Button
                      size="sm"
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
                <button
                  type="button"
                  onClick={() => setConfirmOff(true)}
                  className="flex w-full items-center gap-2 text-left text-sm font-semibold text-destructive"
                >
                  <Unplug size={15} /> Desconectar {brand.name}
                </button>
              )}
            </div>
          </div>
        )}

        {/* ── Paso 1: credenciales ────────────────────────────────────── */}
        {view === "wizard" && step === 0 && (
          <div className="space-y-4">
            {isMp ? (
              <>
                <div className="space-y-3 rounded-xl bg-[color-mix(in_srgb,var(--foreground)_5%,transparent)] p-4 text-center">
                  <p className="text-sm text-muted-foreground">
                    Te llevamos a Mercado Pago para autorizar. No tenés que copiar nada.
                  </p>
                  <Button className="w-full" loading={oauthPending} onClick={onOAuth}>
                    {connected ? "Reconectar con Mercado Pago" : "Conectar con Mercado Pago"}
                  </Button>
                  <p className="text-[11px] text-muted-foreground">Recomendado</p>
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="h-px flex-1 bg-border" /> o con Access Token{" "}
                  <span className="h-px flex-1 bg-border" />
                </div>
                {showManual ? (
                  <Input
                    label="Access Token de producción"
                    type="password"
                    name="mp_access_token"
                    autoComplete="new-password"
                    data-1p-ignore
                    data-lpignore="true"
                    value={mpToken}
                    onChange={(e) => setMpToken(e.target.value)}
                    placeholder="APP_USR-..."
                    error={showErrors && !credsValid ? "Pegá el Access Token completo." : undefined}
                    hint="Mercado Pago › Tus integraciones › Credenciales de producción."
                  />
                ) : (
                  <Button variant="secondary" className="w-full" onClick={() => setShowManual(true)}>
                    <KeyRound size={15} /> Pegar Access Token
                  </Button>
                )}
              </>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">{spec?.intro}</p>
                {fields.map((f) => (
                  <Input
                    key={f.name}
                    label={f.optional ? `${f.label} (opcional)` : f.label}
                    type={f.secret ? "password" : "text"}
                    name={`${providerKey}_${f.name}`}
                    autoComplete={f.secret ? "new-password" : "off"}
                    data-1p-ignore
                    data-lpignore="true"
                    value={values[f.name] ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                    onBlur={() => setTouched((t) => ({ ...t, [f.name]: true }))}
                    placeholder={f.placeholder}
                    hint={f.hint}
                    error={errorOf(f)}
                  />
                ))}
                {providerKey === "nave" && <NaveWebhookBox />}
              </>
            )}

            <HelpLink brand={brand} />
            {serverError && <ErrorBox msg={serverError} />}

            {(!isMp || showManual) && (
              <div className="flex gap-2 pt-1">
                <Button variant="ghost" onClick={() => (connected ? setView("manage") : onOpenChange(false))}>
                  {connected ? "Volver" : "Cancelar"}
                </Button>
                <Button className="flex-1" loading={saving} onClick={nextFromCreds}>
                  {isMp ? "Guardar y seguir" : "Siguiente"}
                </Button>
              </div>
            )}
            <p className="flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
              <ShieldCheck size={13} /> Se guardan cifradas del lado del servidor. Nunca llegan al navegador.
            </p>
          </div>
        )}

        {/* ── Paso 2: ambiente ────────────────────────────────────────── */}
        {view === "wizard" && step === 1 && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Eyebrow>{isMp ? "¿Dónde vas a cobrar?" : "¿De qué ambiente son estas credenciales?"}</Eyebrow>
              <EnvSegmented
                value={hasSandbox ? env : "prod"}
                onChange={setEnv}
                disabledTest={!hasSandbox}
                testHint={hasSandbox ? undefined : "No disponible"}
              />
              <p className="text-xs text-muted-foreground">
                {!hasSandbox
                  ? spec?.envNote
                  : env === "test"
                    ? "Los cobros no mueven plata real. Ideal para probar antes de abrir."
                    : "Los cobros son reales y la plata entra a tu cuenta."}
                {hasSandbox && spec?.envNote ? ` ${spec.envNote}` : ""}
              </p>
            </div>

            {isMp && env === "test" && (
              <Input
                label="Access Token de prueba"
                type="password"
                name="mp_test_access_token"
                autoComplete="new-password"
                data-1p-ignore
                data-lpignore="true"
                value={mpTestToken}
                onChange={(e) => setMpTestToken(e.target.value)}
                placeholder={hasTest ? "•••••• (ya cargado)" : "APP_USR-... o TEST-..."}
                hint="Mercado Pago › Tus integraciones › Credenciales de prueba. Convive con la conexión de producción."
                error={showErrors && needsTestToken && !mpTestValid ? "Pegá el Access Token de prueba." : undefined}
              />
            )}

            {serverError && <ErrorBox msg={serverError} />}

            <div className="flex gap-2 pt-1">
              <Button variant="ghost" onClick={() => setStep(0)} disabled={saving || isMp}>
                <ArrowLeft size={15} /> Atrás
              </Button>
              <Button className="flex-1" loading={saving} onClick={finish}>
                {isMp ? "Continuar" : connected ? "Guardar cambios" : `Conectar ${brand.name}`}
              </Button>
            </div>
          </div>
        )}

        {/* ── Paso 3: listo ───────────────────────────────────────────── */}
        {view === "wizard" && step === 2 && (
          <div className="space-y-5 text-center">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-success/15 text-success">
              <Check size={32} strokeWidth={2.5} />
            </div>
            <div>
              <p className="text-lg font-bold">{brand.name} quedó conectado</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {(isMp ? env : hasSandbox ? env : "prod") === "test"
                  ? "Ambiente de prueba: los cobros no mueven plata real."
                  : "Ambiente de producción: ya podés cobrar de verdad."}
              </p>
            </div>
            <ul className="space-y-2 rounded-xl bg-[color-mix(in_srgb,var(--foreground)_5%,transparent)] p-4 text-left text-sm">
              <NextStep n={1}>Activá los canales que vas a usar ({channelNames.join(", ")}).</NextStep>
              {isMp && <NextStep n={2}>Configurá la caja QR para cobrar con un QR único por venta.</NextStep>}
              {providerKey === "nave" && <NextStep n={2}>Pasale a Nave la URL de notificaciones.</NextStep>}
              {(providerKey === "payway" || providerKey === "mobbex") && (
                <NextStep n={2}>Armá tus Planes de cuotas y recargo por tarjeta.</NextStep>
              )}
            </ul>
            <Button className="w-full" onClick={() => onOpenChange(false)}>
              Listo
            </Button>
          </div>
        )}
      </form>
    </Modal>
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

function ErrorBox({ msg }: { msg: string }) {
  return (
    <div role="alert" className="flex items-start gap-2 rounded-xl bg-[color-mix(in_srgb,var(--destructive)_10%,transparent)] p-3 text-sm text-destructive">
      <TriangleAlert size={16} className="mt-0.5 shrink-0" /> {msg}
    </div>
  );
}

function HelpLink({ brand }: { brand: BrandDef }) {
  if (!brand.credentialsUrl) return null;
  return (
    <a
      href={brand.credentialsUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center justify-between gap-2 rounded-xl bg-[color-mix(in_srgb,var(--foreground)_5%,transparent)] px-4 py-3 text-sm transition hover:bg-[color-mix(in_srgb,var(--foreground)_8%,transparent)]"
    >
      <span>
        <span className="block font-semibold">¿Dónde las encuentro?</span>
        <span className="text-xs text-muted-foreground">{brand.credentialsLabel ?? brand.name}</span>
      </span>
      <ExternalLink size={16} className="shrink-0 text-muted-foreground" />
    </a>
  );
}

function NaveWebhookBox() {
  const { toast } = useToast();
  return (
    <div className="space-y-2 rounded-xl bg-[color-mix(in_srgb,var(--foreground)_5%,transparent)] p-4 text-sm">
      <p className="font-semibold">URL de notificaciones para Nave</p>
      <p className="text-xs text-muted-foreground">
        Pasásela a Nave al pedir las credenciales (una para prueba y otra para producción): así nos avisan
        cada pago al instante.
      </p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg bg-background px-2.5 py-2 text-[11px]">
          {NAVE_WEBHOOK_URL}
        </code>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() =>
            navigator.clipboard
              .writeText(NAVE_WEBHOOK_URL)
              .then(() => toast({ title: "URL copiada", variant: "success" }))
              .catch(() => toast({ title: "No se pudo copiar", variant: "error" }))
          }
        >
          <Copy size={14} /> Copiar
        </Button>
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
    <div className="space-y-2">
      <Eyebrow>Ambiente de cobro</Eyebrow>
      <EnvSegmented
        value={want}
        onChange={(v) => {
          setWant(v);
          if (v === "prod" && env !== "prod") onChange({ env: "prod" });
          if (v === "test" && hasTest && env !== "test") onChange({ env: "test" });
        }}
      />
      {want === "test" && (
        <div className="space-y-2 pt-1">
          <Input
            label="Access Token de prueba"
            type="password"
            name="mp_test_access_token"
            autoComplete="new-password"
            data-1p-ignore
            data-lpignore="true"
            value={token}
            onChange={(e) => onToken(e.target.value)}
            placeholder={hasTest ? "•••••• (ya cargado)" : "APP_USR-... o TEST-..."}
            hint="Mercado Pago › Tus integraciones › Credenciales de prueba."
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
                className="text-destructive"
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
