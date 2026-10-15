"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  CircleDashed,
  Copy,
  KeyRound,
  Link2,
  PlugZap,
  Store,
  Wallet,
  Webhook,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { CredentialInput } from "@/components/ui/CredentialInput";
import { Modal } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { Skeleton } from "@/components/ui/Skeleton";
import { ThemedLogo } from "@/components/ui/ThemedLogo";
import { useToast } from "@/components/ui/Toast";
import { paymentWordmark } from "@/lib/payments/logos";
import { formatRelative } from "@/lib/utils/format";
import {
  credentialEnvironment,
  validateMpCredential,
  type MpCredentialField,
  type MpEnvironment,
} from "@/supabase/functions/_shared/mpCredentials";

export type MpPlatformStatus = {
  updated_at: string | null;
  client_id: string | null;
  redirect_uri: string | null;
  public_key: string | null;
  environment: string | null;
  client_secret: boolean;
  access_token: boolean;
  webhook_secret: boolean;
  hints?: Partial<Record<"client_secret" | "access_token" | "webhook_secret", string | null>>;
  token_environment?: MpEnvironment | null;
};

export type MpTestResult = {
  ok: boolean;
  error?: string;
  account?: { id: number | null; nickname: string | null; country_id: string | null; is_test: boolean };
  token_environment?: MpEnvironment | null;
  at: string;
};

export type MpWebhookStats = {
  lastAt: string | null;
  total24h: number;
  errors24h: number;
  lastError: string | null;
};

export type SaveResult = { fieldErrors?: Partial<Record<MpCredentialField, string>> } | void;

const TEST_ERRORS: Record<string, string> = {
  no_access_token: "Falta cargar el Access Token de la cuenta que cobra.",
  invalid_token: "Mercado Pago rechazó el Access Token: revisá que sea el de producción vigente.",
  mp_unreachable: "No pudimos conectarnos con Mercado Pago. Probá de nuevo en un rato.",
};

const ENV_LABEL: Record<MpEnvironment, string> = { production: "Producción", test: "Prueba" };

function useCopy() {
  const { toast } = useToast();
  return async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: `${what} copiada`, variant: "success" });
    } catch {
      toast({ title: "No se pudo copiar", variant: "error" });
    }
  };
}

export function Dot({ tone }: { tone: "ok" | "warn" | "bad" | "idle" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "mt-1.5 h-2 w-2 shrink-0 rounded-full",
        tone === "ok" && "bg-success",
        tone === "warn" && "bg-warning",
        tone === "bad" && "bg-danger",
        tone === "idle" && "bg-muted-foreground/40",
      )}
    />
  );
}

export function Block({
  step,
  icon: Icon,
  title,
  description,
  children,
  className,
}: {
  step: number;
  icon: typeof Wallet;
  title: string;
  description: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("min-w-0 rounded-lg border border-border bg-card p-4 sm:p-5", className)}>
      <div className="flex items-start gap-3">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground" aria-hidden>
          <Icon size={16} />
        </span>
        <div className="min-w-0">
          <p className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Paso {step}</p>
          <h3 className="font-display text-base font-bold leading-tight">{title}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

export function CopyField({ label, value, hint }: { label: string; value: string; hint?: React.ReactNode }) {
  const copy = useCopy();
  return (
    <div className="min-w-0">
      <p className="mb-1.5 text-[13px] font-semibold">{label}</p>
      <div className="flex min-w-0 items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg bg-muted px-3 py-2.5 font-mono text-xs" title={value}>
          {value}
        </code>
        <Button variant="secondary" size="sm" onClick={() => copy(value, label)} aria-label={`Copiar ${label}`}>
          <Copy size={14} aria-hidden /> Copiar
        </Button>
      </div>
      {hint && <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function SecretRow({
  label,
  configured,
  hint,
  onReplace,
}: {
  label: string;
  configured: boolean;
  hint: string | null | undefined;
  onReplace: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
      <div className="min-w-0">
        <p className="text-[13px] font-semibold">{label}</p>
        {configured ? (
          <p className="mt-0.5 inline-flex items-center gap-1.5 text-xs text-success">
            <CheckCircle2 size={13} aria-hidden /> Guardada
            {hint && <span className="font-mono text-muted-foreground">termina en {hint.replace("…", "")}</span>}
          </p>
        ) : (
          <p className="mt-0.5 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <CircleDashed size={13} aria-hidden /> Sin cargar
          </p>
        )}
      </div>
      <Button variant="secondary" size="sm" onClick={onReplace}>
        {configured ? "Reemplazar" : "Cargar"}
      </Button>
    </div>
  );
}

const SECRET_COPY: Record<"access_token" | "client_secret" | "webhook_secret", { label: string; hint: string; placeholder: string }> = {
  access_token: {
    label: "Access Token",
    hint: "Mercado Pago > Tus integraciones > tu app > Credenciales de producción. Empieza con APP_USR-.",
    placeholder: "APP_USR-…",
  },
  client_secret: {
    label: "Client Secret",
    hint: "Lo ves junto al Client ID en las credenciales de tu app.",
    placeholder: "Pegá el Client Secret",
  },
  webhook_secret: {
    label: "Clave secreta de firma",
    hint: "Mercado Pago > Tus integraciones > Webhooks > Clave secreta. Con la clave cargada, toda notificación sin firma válida se descarta.",
    placeholder: "Pegá la clave secreta",
  },
};

export function PlatformMpPanel({
  status,
  loading,
  loadError = false,
  onRetry,
  test,
  testing,
  webhook,
  activeMpSubscriptions,
  webhookUrl,
  redirectUri,
  onSave,
  onTest,
}: {
  status: MpPlatformStatus | null;
  loading: boolean;
  /** No se pudo leer el estado: no se muestra el formulario (evita que el
   *  navegador autocomplete el Client ID con un email guardado). */
  loadError?: boolean;
  onRetry?: () => void;
  test: MpTestResult | null;
  testing: boolean;
  webhook: MpWebhookStats | null;
  activeMpSubscriptions: number | null;
  webhookUrl: string;
  redirectUri: string;
  onSave: (fields: Partial<Record<MpCredentialField, string>>) => Promise<SaveResult>;
  onTest: () => void;
}) {
  const { toast } = useToast();
  const copy = useCopy();
  const [clientId, setClientId] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [errors, setErrors] = useState<Partial<Record<MpCredentialField, string>>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [secretOpen, setSecretOpen] = useState<null | "access_token" | "client_secret" | "webhook_secret">(null);
  const [secretValue, setSecretValue] = useState("");

  useEffect(() => {
    if (!status) return;
    setClientId(status.client_id ?? "");
    setPublicKey(status.public_key ?? "");
  }, [status]);

  const env: MpEnvironment = status?.environment === "test" ? "test" : "production";
  const storedClientIdError = status?.client_id ? validateMpCredential("client_id", status.client_id) : null;
  const clientIdError = errors.client_id ?? (clientId ? validateMpCredential("client_id", clientId) : null);
  const publicKeyError = errors.public_key ?? (publicKey ? validateMpCredential("public_key", publicKey) : null);
  const redirectMismatch = Boolean(status?.redirect_uri) && status?.redirect_uri !== redirectUri;
  const tokenEnv = test?.token_environment ?? status?.token_environment ?? null;
  const pkEnv = credentialEnvironment(status?.public_key);
  const envMismatch = (tokenEnv && tokenEnv !== env) || (pkEnv && pkEnv !== env);

  async function save(block: string, fields: Partial<Record<MpCredentialField, string>>) {
    const local: Partial<Record<MpCredentialField, string>> = {};
    for (const [k, v] of Object.entries(fields)) {
      const msg = validateMpCredential(k as MpCredentialField, v ?? "");
      if (msg) local[k as MpCredentialField] = msg;
    }
    if (Object.keys(local).length > 0) {
      setErrors((e) => ({ ...e, ...local }));
      return false;
    }
    setSaving(block);
    try {
      const res = await onSave(fields);
      if (res && res.fieldErrors && Object.keys(res.fieldErrors).length > 0) {
        setErrors((e) => ({ ...e, ...res.fieldErrors }));
        return false;
      }
      setErrors((e) => {
        const next = { ...e };
        for (const k of Object.keys(fields)) delete next[k as MpCredentialField];
        return next;
      });
      toast({ title: "Guardado.", variant: "success" });
      return true;
    } catch {
      toast({ title: "No se pudo guardar", variant: "error" });
      return false;
    } finally {
      setSaving(null);
    }
  }

  // Estado de la conexión.
  const conn = useMemo(() => {
    if (!status?.access_token) return { tone: "bad" as const, text: "Sin cuenta que cobra: falta el Access Token." };
    if (!test) return { tone: "idle" as const, text: "Credenciales cargadas, sin probar en esta sesión." };
    if (!test.ok) return { tone: "bad" as const, text: TEST_ERRORS[test.error ?? ""] ?? "La prueba falló." };
    const a = test.account;
    return {
      tone: (envMismatch ? "warn" : "ok") as "ok" | "warn",
      text: `Conectado en ${ENV_LABEL[tokenEnv ?? env].toUpperCase()} · Cuenta ${a?.nickname ?? "sin nombre"}${a?.id ? ` (id ${a.id})` : ""}${a?.is_test ? " · usuario de prueba" : ""} · probado ${formatRelative(test.at)}`,
    };
  }, [status, test, envMismatch, tokenEnv, env]);

  const whTone: "ok" | "warn" | "bad" | "idle" = !webhook?.lastAt
    ? "idle"
    : webhook.errors24h > 0
      ? "warn"
      : "ok";

  const checklist: { ok: boolean; label: string }[] = [
    {
      ok: Boolean(status?.access_token) && (!test || test.ok),
      label: test?.ok ? "Access Token probado" : "Access Token cargado",
    },
    { ok: Boolean(status?.public_key) && !validateMpCredential("public_key", status?.public_key ?? ""), label: "Public Key cargada" },
    { ok: Boolean(status?.client_id) && !storedClientIdError, label: "Client ID numérico" },
    { ok: Boolean(status?.client_secret), label: "Client Secret cargado" },
    { ok: Boolean(status?.redirect_uri) && !redirectMismatch, label: "Redirect URI del dominio real" },
    { ok: Boolean(status?.webhook_secret), label: "Webhook con firma" },
    { ok: env === "production" && !envMismatch, label: "Cuenta en producción" },
  ];

  if (loading && !status) {
    return (
      <div aria-busy className="space-y-4" aria-label="Cargando credenciales">
        <Skeleton className="h-28 w-full" />
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (loadError || !status) {
    return (
      <Callout
        tone="danger"
        icon={AlertCircle}
        title="No pudimos leer las credenciales de Mercado Pago"
        actions={
          onRetry && (
            <Button size="sm" variant="secondary" onClick={onRetry}>
              Reintentar
            </Button>
          )
        }
      >
        No se muestra el formulario para no pisar lo guardado con datos vacíos o autocompletados.
      </Callout>
    );
  }

  const wordmark = paymentWordmark("mercadopago");

  return (
    <div className="space-y-4">
      {/* ── Encabezado + estado ── */}
      <section className="rounded-lg border border-border bg-card">
        <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:p-5">
          {wordmark && <ThemedLogo src={wordmark} alt="Mercado Pago" className="h-8 w-auto shrink-0 sm:h-9" />}
          <div className="min-w-0">
            <h2 className="font-display text-lg font-bold leading-tight">Cobro de suscripciones con Mercado Pago</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Dos piezas: la cuenta de NinjaSoft que cobra las suscripciones y la app que permite a cada negocio conectar su propio
              Mercado Pago.
            </p>
          </div>
        </div>
        <div className="border-t border-border p-4 sm:p-5">
          <p className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Estado</p>
          <ul className="mt-2 space-y-2 text-sm">
            <li className="flex min-w-0 items-start gap-2.5">
              <Dot tone={conn.tone} />
              <span className="min-w-0 break-words">{conn.text}</span>
            </li>
            <li className="flex min-w-0 items-start gap-2.5">
              <Dot tone={whTone} />
              <span className="min-w-0 break-words">
                {webhook?.lastAt
                  ? `Webhook: último evento ${formatRelative(webhook.lastAt)} · ${webhook.errors24h} con error en 24 h`
                  : "Webhook: sin eventos registrados todavía."}
                {webhook?.lastError && webhook.errors24h > 0 && (
                  <span className="block text-xs text-muted-foreground">Último error: {webhook.lastError}</span>
                )}
              </span>
            </li>
            <li className="flex min-w-0 items-start gap-2.5">
              <Dot tone={activeMpSubscriptions ? "ok" : "idle"} />
              <span>
                {activeMpSubscriptions === null
                  ? "Suscripciones con débito automático: sin datos."
                  : `${activeMpSubscriptions} ${activeMpSubscriptions === 1 ? "suscripción activa" : "suscripciones activas"} con débito automático de Mercado Pago.`}
              </span>
            </li>
          </ul>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <Button variant="secondary" size="sm" loading={testing} onClick={onTest} disabled={!status?.access_token}>
              <PlugZap size={14} aria-hidden /> Probar conexión
            </Button>
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-muted-foreground">Ambiente</span>
              <Segmented
                size="sm"
                aria-label="Ambiente de Mercado Pago"
                value={env}
                options={[
                  { value: "production", label: "Producción" },
                  { value: "test", label: "Prueba" },
                ]}
                onChange={(v) => {
                  if (v !== env) void save("env", { environment: v });
                }}
              />
            </div>
          </div>
          {envMismatch && (
            <Callout tone="warning" icon={AlertCircle} className="mt-3" title="Las credenciales no coinciden con el ambiente">
              Elegiste {ENV_LABEL[env].toLowerCase()} pero las credenciales cargadas son de{" "}
              {ENV_LABEL[(tokenEnv ?? pkEnv)!].toLowerCase()}. Los cobros reales necesitan credenciales de producción (APP_USR-).
            </Callout>
          )}
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ── 1. Cuenta que cobra ── */}
        <Block
          step={1}
          icon={Wallet}
          title="Cuenta que cobra"
          description="La cuenta de Mercado Pago de NinjaSoft. Se usa para los débitos automáticos, los pagos únicos y la conciliación."
        >
          <SecretRow
            label="Access Token"
            configured={Boolean(status?.access_token)}
            hint={status?.hints?.access_token}
            onReplace={() => {
              setSecretValue("");
              setSecretOpen("access_token");
            }}
          />
          <CredentialInput
            label="Public Key"
            mono
            autoComplete="off"
            name="mp-public-key"
            value={publicKey}
            onChange={(e) => {
              setPublicKey(e.target.value);
              setErrors((x) => ({ ...x, public_key: undefined }));
            }}
            placeholder="APP_USR-…"
            error={publicKeyError ?? undefined}
            hint="Es pública: se usa en el checkout del navegador."
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              loading={saving === "pk"}
              disabled={!publicKey.trim() || publicKey.trim() === (status?.public_key ?? "")}
              onClick={() => void save("pk", { public_key: publicKey.trim() })}
            >
              Guardar Public Key
            </Button>
          </div>
        </Block>

        {/* ── 2. App OAuth ── */}
        <Block
          step={2}
          icon={Store}
          title="App para conectar negocios (OAuth)"
          description='Habilita el botón "Conectar con Mercado Pago" de cada negocio, para que cobre en su propia cuenta.'
        >
          <CredentialInput
            label="Client ID"
            mono
            inputMode="numeric"
            autoComplete="off"
            name="mp-client-id"
            value={clientId}
            onChange={(e) => {
              setClientId(e.target.value);
              setErrors((x) => ({ ...x, client_id: undefined }));
            }}
            placeholder="971231514820445"
            error={clientIdError ?? undefined}
            hint="Sólo números. Lo ves en Tus integraciones > tu app > Credenciales."
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              loading={saving === "cid"}
              disabled={!clientId.trim() || clientId.trim() === (status?.client_id ?? "")}
              onClick={() => void save("cid", { client_id: clientId.trim() })}
            >
              Guardar Client ID
            </Button>
          </div>
          <SecretRow
            label="Client Secret"
            configured={Boolean(status?.client_secret)}
            hint={status?.hints?.client_secret}
            onReplace={() => {
              setSecretValue("");
              setSecretOpen("client_secret");
            }}
          />
          <CopyField
            label="Redirect URI"
            value={redirectUri}
            hint="Se calcula con el dominio de la app. Pegala idéntica en tu app de Mercado Pago > Redirect URLs."
          />
          {(redirectMismatch || !status?.redirect_uri) && (
            <Callout
              tone="warning"
              icon={Link2}
              title={status?.redirect_uri ? "La Redirect URI guardada es otra" : "Falta guardar la Redirect URI"}
              actions={
                <Button size="sm" variant="secondary" loading={saving === "ru"} onClick={() => void save("ru", { redirect_uri: redirectUri })}>
                  Usar esta Redirect URI
                </Button>
              }
            >
              {status?.redirect_uri ? (
                <span className="break-all font-mono text-xs">Guardada: {status.redirect_uri}</span>
              ) : (
                "El OAuth de los negocios no funciona hasta guardarla."
              )}
            </Callout>
          )}
        </Block>
      </div>

      {/* ── 3. Webhook ── */}
      <Block
        step={3}
        icon={Webhook}
        title="Notificaciones (webhook)"
        description="Mercado Pago avisa cada cobro, rechazo o baja de una suscripción. Sin esto, las cuentas no se reactivan solas al pagar."
      >
        <CopyField
          label="URL del webhook"
          value={webhookUrl}
          hint="Pegala en Mercado Pago > Tus integraciones > Webhooks > Modo productivo."
        />
        <div>
          <p className="text-[13px] font-semibold">Eventos a marcar</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {["Pagos", "Planes y suscripciones", "Contracargos"].map((e) => (
              <Badge key={e} tone="neutral">
                {e}
              </Badge>
            ))}
          </div>
        </div>
        <SecretRow
          label="Clave secreta de firma"
          configured={Boolean(status?.webhook_secret)}
          hint={status?.hints?.webhook_secret}
          onReplace={() => {
            setSecretValue("");
            setSecretOpen("webhook_secret");
          }}
        />
      </Block>

      {/* ── 4. Checklist ── */}
      <section className="rounded-lg border border-border bg-card p-4 sm:p-5">
        <div className="flex items-center gap-2">
          <KeyRound size={16} className="text-muted-foreground" aria-hidden />
          <h3 className="font-display text-base font-bold">Checklist</h3>
          <span className="ml-auto text-xs tabular-nums text-muted-foreground">
            {checklist.filter((c) => c.ok).length} de {checklist.length}
          </span>
        </div>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {checklist.map((c) => (
            <li key={c.label} className="flex items-center gap-2 text-sm">
              {c.ok ? (
                <CheckCircle2 size={16} className="shrink-0 text-success" aria-hidden />
              ) : (
                <XCircle size={16} className="shrink-0 text-danger" aria-hidden />
              )}
              <span className={c.ok ? undefined : "text-muted-foreground"}>{c.label}</span>
              <span className="sr-only">{c.ok ? "listo" : "pendiente"}</span>
            </li>
          ))}
        </ul>
        {status?.updated_at && (
          <p className="mt-4 text-xs text-muted-foreground">
            Última modificación {formatRelative(status.updated_at)}. Cada cambio queda en la auditoría, sin el valor.
          </p>
        )}
      </section>

      <Modal
        open={secretOpen !== null}
        onOpenChange={(o) => {
          if (!o) setSecretOpen(null);
        }}
        title={secretOpen ? `Reemplazar ${SECRET_COPY[secretOpen].label}` : undefined}
        description="El valor se guarda cifrado del lado del servidor y no se vuelve a mostrar."
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setSecretOpen(null)}>
              Cancelar
            </Button>
            <Button
              loading={saving === "secret"}
              disabled={!secretValue.trim()}
              onClick={async () => {
                if (!secretOpen) return;
                const ok = await save("secret", { [secretOpen]: secretValue.trim() });
                if (ok) {
                  setSecretOpen(null);
                  setSecretValue("");
                }
              }}
            >
              Guardar
            </Button>
          </div>
        }
      >
        {secretOpen && (
          <CredentialInput
            label={SECRET_COPY[secretOpen].label}
            secret
            mono
            autoComplete="off"
            value={secretValue}
            onChange={(e) => {
              setSecretValue(e.target.value);
              setErrors((x) => ({ ...x, [secretOpen]: undefined }));
            }}
            placeholder={SECRET_COPY[secretOpen].placeholder}
            error={errors[secretOpen] ?? undefined}
            hint={SECRET_COPY[secretOpen].hint}
          />
        )}
      </Modal>
    </div>
  );
}
PlatformMpPanel.displayName = "PlatformMpPanel";
