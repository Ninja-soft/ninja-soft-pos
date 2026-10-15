"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Bell, KeyRound, Link2, PlugZap, Server, Store, Trash2, Webhook } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { CredentialInput } from "@/components/ui/CredentialInput";
import { IntegrationLogo } from "@/components/ui/IntegrationLogo";
import { Modal } from "@/components/ui/Modal";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { Block, CopyField, Dot, SecretRow } from "@/components/internal/payments/PlatformMpPanel";
import { formatRelative } from "@/lib/utils/format";
import { ML_TOPICS, mlReadiness, type MlAppStatus, type MlAppTestResult } from "@/lib/mercadolibre/appSetup";
import { validateMlAppField, type MlAppField } from "@/supabase/functions/_shared/mercadolibre/config";

export type MlSaveResult = { fieldErrors?: Partial<Record<MlAppField, string>> } | void;

const TEST_ERRORS: Record<string, string> = {
  not_configured: "No hay una configuración completa para probar: cargá el App ID y la Clave secreta.",
  invalid_credentials: "Mercado Libre rechazó el App ID o la Clave secreta. Revisalos en DevCenter > Mis aplicaciones.",
  ml_unreachable: "No pudimos conectarnos con Mercado Libre. Probá de nuevo en un rato.",
};

const NOTIF_TONE: Record<string, BadgeTone> = {
  done: "success",
  ignored: "neutral",
  pending: "info",
  processing: "info",
  error: "warning",
  dead: "danger",
};
const NOTIF_LABEL: Record<string, string> = {
  done: "Procesada",
  ignored: "Sin procesar",
  pending: "En cola",
  processing: "Procesando",
  error: "Con error",
  dead: "Descartada",
};

export function MlAppPanel({
  status,
  loading,
  loadError = false,
  onRetry,
  test,
  testing,
  webhookUrl,
  webhookDirectUrl,
  redirectUri,
  onSave,
  onTest,
  onClear,
}: {
  status: MlAppStatus | null;
  loading: boolean;
  loadError?: boolean;
  onRetry?: () => void;
  test: MlAppTestResult | null;
  testing: boolean;
  webhookUrl: string;
  webhookDirectUrl: string | null;
  redirectUri: string;
  onSave: (fields: Partial<Record<MlAppField, string>>) => Promise<MlSaveResult>;
  onTest: () => void;
  onClear: () => Promise<void>;
}) {
  const { toast } = useToast();
  const [appId, setAppId] = useState("");
  const [errors, setErrors] = useState<Partial<Record<MlAppField, string>>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [secretOpen, setSecretOpen] = useState(false);
  const [secretValue, setSecretValue] = useState("");
  const [clearOpen, setClearOpen] = useState(false);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    if (status) setAppId(status.client_id ?? "");
  }, [status]);

  async function save(block: string, fields: Partial<Record<MlAppField, string>>) {
    const local: Partial<Record<MlAppField, string>> = {};
    for (const [k, v] of Object.entries(fields)) {
      const msg = validateMlAppField(k as MlAppField, v ?? "");
      if (msg) local[k as MlAppField] = msg;
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
        for (const k of Object.keys(fields)) delete next[k as MlAppField];
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

  const readiness = useMemo(() => (status ? mlReadiness(status) : null), [status]);

  if (loading && !status) {
    return (
      <div aria-busy className="space-y-4" aria-label="Cargando la app de Mercado Libre">
        <Skeleton className="h-32 w-full" />
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  if (loadError || !status || !readiness) {
    return (
      <Callout
        tone="danger"
        icon={AlertCircle}
        title="No pudimos leer la configuración de la app de Mercado Libre"
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

  const appIdError = errors.client_id ?? (appId ? validateMlAppField("client_id", appId) : null);
  const savedRedirect = status.redirect_uri;
  const redirectMismatch = Boolean(savedRedirect) && savedRedirect !== redirectUri;
  const stats = status.stats ?? null;
  const panelHasConfig = Boolean(status.client_id || status.client_secret || status.redirect_uri);

  const testLine = (() => {
    if (!test) return { tone: "idle" as const, text: "Sin probar en esta sesión." };
    if (!test.ok) return { tone: "bad" as const, text: TEST_ERRORS[test.error ?? ""] ?? `La prueba falló (${test.error ?? "sin detalle"}).` };
    const name = test.app?.name ? ` · App ${test.app.name}` : "";
    const from = test.origin === "platform" ? "este panel" : "los secrets de Edge";
    return {
      tone: "ok" as const,
      text: `App ID y Clave secreta válidos (${from})${name} · probado ${formatRelative(test.at)}`,
    };
  })();

  // Lo que ML tiene registrado en la app (sólo si la prueba pudo leerlo).
  const remoteRedirect = test?.ok ? test.app?.redirect_uri ?? null : null;
  const remoteWebhook = test?.ok ? test.app?.notifications_url ?? null : null;
  const effectiveRedirect = status.effective?.redirect_uri ?? null;
  const remoteRedirectMismatch = Boolean(remoteRedirect && effectiveRedirect && remoteRedirect !== effectiveRedirect);
  const remoteWebhookMismatch = Boolean(
    remoteWebhook && remoteWebhook !== webhookUrl && remoteWebhook !== webhookDirectUrl,
  );

  const mvpTopics = ML_TOPICS.filter((t) => t.phase === "mvp");
  const laterTopics = ML_TOPICS.filter((t) => t.phase !== "mvp");

  return (
    <div className="space-y-4">
      {/* Encabezado + estado */}
      <section className="rounded-lg border border-border bg-card">
        <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:p-5">
          <IntegrationLogo name="mercadolibre" bare size={40} />
          <div className="min-w-0">
            <h2 className="font-display text-lg font-bold leading-tight">App de Mercado Libre</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              La app de NinjaSoft en el DevCenter de Mercado Libre. Con ella cada negocio conecta su cuenta para sincronizar
              stock, precios, ventas y envíos.
            </p>
          </div>
          <Badge tone={readiness.tone === "ok" ? "success" : readiness.tone === "warn" ? "warning" : "danger"} className="sm:ml-auto">
            {readiness.title}
          </Badge>
        </div>
        <div className="border-t border-border p-4 sm:p-5">
          <p className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Estado</p>
          <ul className="mt-2 space-y-2 text-sm">
            <li className="flex min-w-0 items-start gap-2.5">
              <Dot tone={readiness.tone} />
              <span className="min-w-0 break-words">{readiness.detail}</span>
            </li>
            <li className="flex min-w-0 items-start gap-2.5">
              <Dot tone={testLine.tone} />
              <span className="min-w-0 break-words">Conexión: {testLine.text}</span>
            </li>
            <li className="flex min-w-0 items-start gap-2.5">
              <Dot tone={stats ? (stats.tenants_connected > 0 ? "ok" : "idle") : "idle"} />
              <span className="min-w-0 break-words">
                {stats
                  ? `${stats.tenants_connected} ${stats.tenants_connected === 1 ? "negocio conectado" : "negocios conectados"} · ${stats.accounts_active} ${stats.accounts_active === 1 ? "cuenta activa" : "cuentas activas"}${stats.accounts_reauth > 0 ? ` · ${stats.accounts_reauth} piden reconectar` : ""}`
                  : "Negocios conectados: sin datos."}
              </span>
            </li>
            <li className="flex min-w-0 items-start gap-2.5">
              <Dot tone={!stats?.last_notifications.length ? "idle" : stats.notifications_errors_24h > 0 ? "warn" : "ok"} />
              <span className="min-w-0 break-words">
                {stats?.last_notifications.length
                  ? `Notificaciones: última ${formatRelative(stats.last_notifications[0]!.received_at)} · ${stats.notifications_24h} en 24 h, ${stats.notifications_errors_24h} con error`
                  : "Notificaciones: sin avisos recibidos todavía."}
              </span>
            </li>
          </ul>
          <div className="slim-scrollbar -mx-1 mt-4 flex gap-2 overflow-x-auto px-1 pb-1">
            <Button
              variant="secondary"
              size="sm"
              className="shrink-0"
              loading={testing}
              onClick={onTest}
              disabled={!status.origin}
            >
              <PlugZap size={14} aria-hidden /> Probar conexión
            </Button>
            {panelHasConfig && (
              <Button variant="ghost" size="sm" className="shrink-0" onClick={() => setClearOpen(true)}>
                <Trash2 size={14} aria-hidden /> Borrar lo cargado acá
              </Button>
            )}
          </div>
          {(remoteRedirectMismatch || remoteWebhookMismatch) && (
            <Callout tone="warning" icon={AlertCircle} className="mt-3" title="Mercado Libre tiene registrada otra URL">
              {remoteRedirectMismatch && (
                <span className="block break-all">
                  Redirect URI en DevCenter: <span className="font-mono text-xs">{remoteRedirect}</span>
                </span>
              )}
              {remoteWebhookMismatch && (
                <span className="block break-all">
                  Notificaciones en DevCenter: <span className="font-mono text-xs">{remoteWebhook}</span>
                </span>
              )}
            </Callout>
          )}
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* 1. Credenciales */}
        <Block
          step={1}
          icon={Store}
          title="Credenciales de la app"
          description="De DevCenter > Mis aplicaciones > tu app. Habilitan el botón Conectar con Mercado Libre de cada negocio."
        >
          <CredentialInput
            label="App ID"
            mono
            inputMode="numeric"
            autoComplete="off"
            name="ml-app-id"
            value={appId}
            onChange={(e) => {
              setAppId(e.target.value);
              setErrors((x) => ({ ...x, client_id: undefined }));
            }}
            placeholder="1234567890123456"
            error={appIdError ?? undefined}
            hint="Sólo números. Es público: viaja en el link de autorización."
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              loading={saving === "cid"}
              disabled={!appId.trim() || appId.trim() === (status.client_id ?? "")}
              onClick={() => void save("cid", { client_id: appId.trim() })}
            >
              Guardar App ID
            </Button>
          </div>
          <SecretRow
            label="Clave secreta"
            configured={status.client_secret}
            hint={status.hints?.client_secret}
            onReplace={() => {
              setSecretValue("");
              setSecretOpen(true);
            }}
          />
          <CopyField
            label="Redirect URI"
            value={redirectUri}
            hint="Se calcula con el dominio de la app. Pegala idéntica en DevCenter > URI de redirect (sin parámetros)."
          />
          {(redirectMismatch || !savedRedirect) && (
            <Callout
              tone={savedRedirect ? "warning" : "info"}
              icon={Link2}
              title={savedRedirect ? "La Redirect URI guardada es otra" : "Guardá la Redirect URI"}
              actions={
                <Button size="sm" variant="secondary" loading={saving === "ru"} onClick={() => void save("ru", { redirect_uri: redirectUri })}>
                  Usar esta Redirect URI
                </Button>
              }
            >
              {savedRedirect ? (
                <span className="break-all font-mono text-xs">Guardada: {savedRedirect}</span>
              ) : status.env.redirect_uri ? (
                <span className="break-all">
                  Mientras tanto se usa la de los secrets de Edge: <span className="font-mono text-xs">{status.env.redirect_uri}</span>
                </span>
              ) : (
                "Mientras no esté guardada se arma con APP_URL de los secrets de Edge."
              )}
            </Callout>
          )}
        </Block>

        {/* 2. Notificaciones */}
        <Block
          step={2}
          icon={Webhook}
          title="Notificaciones (webhook)"
          description="Mercado Libre avisa cada venta, cambio de publicación, pregunta y envío. Sin esto, todo depende de la reconciliación cada pocos minutos."
        >
          <CopyField
            label="URL de notificaciones"
            value={webhookUrl}
            hint="Pegala en DevCenter > tu app > URL de notificaciones. Usa el dominio propio de webhooks."
          />
          {webhookDirectUrl && (
            <p className="text-xs text-muted-foreground">
              Si el dominio propio no responde, la URL directa de la Edge también sirve:{" "}
              <span className="break-all font-mono">{webhookDirectUrl}</span>
            </p>
          )}
          <div>
            <p className="text-[13px] font-semibold">Tópicos a tildar</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {mvpTopics.map((t) => (
                <Badge key={t.topic} tone="info" title={t.use}>
                  <span className="font-mono">{t.topic}</span>
                </Badge>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Estos se procesan hoy. Tildar también los de las próximas fases no cuesta nada: llegan, se guardan sin procesar y se
              borran a los 15 días.
            </p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {laterTopics.map((t) => (
                <Badge key={t.topic} tone="neutral" title={t.use}>
                  <span className="font-mono">{t.topic}</span>
                </Badge>
              ))}
            </div>
          </div>
        </Block>
      </div>

      {/* 3. Uso */}
      <section className="rounded-lg border border-border bg-card p-4 sm:p-5">
        <div className="flex items-center gap-2">
          <Bell size={16} className="text-muted-foreground" aria-hidden />
          <h3 className="font-display text-base font-bold">Últimas notificaciones</h3>
        </div>
        {stats?.last_notifications.length ? (
          <ul className="mt-3 divide-y divide-border">
            {stats.last_notifications.map((n, i) => (
              <li key={`${n.received_at}-${i}`} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                <span className="min-w-0 truncate font-mono text-xs">{n.topic}</span>
                <Badge tone={NOTIF_TONE[n.status] ?? "neutral"}>{NOTIF_LABEL[n.status] ?? n.status}</Badge>
                {n.source !== "webhook" && <span className="text-xs text-muted-foreground">por {n.source}</span>}
                <span className="ml-auto text-xs tabular-nums text-muted-foreground">{formatRelative(n.received_at)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">
            Todavía no llegó ninguna. Aparecen cuando un negocio conectado tiene movimiento en Mercado Libre.
          </p>
        )}
      </section>

      {/* 4. De dónde sale */}
      <section className="rounded-lg border border-border bg-card p-4 sm:p-5">
        <div className="flex items-center gap-2">
          <Server size={16} className="text-muted-foreground" aria-hidden />
          <h3 className="font-display text-base font-bold">De dónde se lee</h3>
        </div>
        <ul className="mt-3 space-y-2 text-sm">
          <li className="flex min-w-0 items-start gap-2.5">
            <KeyRound size={15} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 break-words">
              Primero este panel, si tiene App ID y Clave secreta. Si no, los secrets de Edge
              {status.env.client_id ? (
                <>
                  {" "}
                  (App ID <span className="font-mono">{status.env.client_id}</span>
                  {status.env.client_secret ? ", con Clave secreta" : ", sin Clave secreta"})
                </>
              ) : (
                " (no hay cargados)"
              )}
              .
            </span>
          </li>
          {status.effective && (
            <li className="flex min-w-0 items-start gap-2.5">
              <Link2 size={15} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 break-all">
                Rige el App ID <span className="font-mono">{status.effective.client_id}</span> con la Redirect URI{" "}
                <span className="font-mono text-xs">{status.effective.redirect_uri}</span>
              </span>
            </li>
          )}
        </ul>
        {status.updated_at && (
          <p className="mt-4 text-xs text-muted-foreground">
            Última modificación {formatRelative(status.updated_at)}. Cada cambio queda en la auditoría, sin el valor.
          </p>
        )}
      </section>

      <Modal
        open={secretOpen}
        onOpenChange={(o) => {
          if (!o) setSecretOpen(false);
        }}
        title={status.client_secret ? "Reemplazar Clave secreta" : "Cargar Clave secreta"}
        description="Se guarda del lado del servidor y no se vuelve a mostrar."
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setSecretOpen(false)}>
              Cancelar
            </Button>
            <Button
              loading={saving === "secret"}
              disabled={!secretValue.trim()}
              onClick={async () => {
                const ok = await save("secret", { client_secret: secretValue.trim() });
                if (ok) {
                  setSecretOpen(false);
                  setSecretValue("");
                }
              }}
            >
              Guardar
            </Button>
          </div>
        }
      >
        <CredentialInput
          label="Clave secreta"
          secret
          mono
          autoComplete="off"
          value={secretValue}
          onChange={(e) => {
            setSecretValue(e.target.value);
            setErrors((x) => ({ ...x, client_secret: undefined }));
          }}
          placeholder="Pegá la Clave secreta"
          error={errors.client_secret ?? undefined}
          hint="DevCenter > Mis aplicaciones > tu app > Clave secreta. Para rotarla usá Programar renovación y cargá la nueva acá dentro de esa ventana."
        />
      </Modal>

      <ConfirmDialog
        open={clearOpen}
        onOpenChange={setClearOpen}
        title="Borrar la configuración de este panel"
        description={
          status.env.client_id && status.env.client_secret
            ? "Se borran el App ID, la Clave secreta y la Redirect URI cargados acá. Vuelven a regir los secrets de Edge."
            : "Se borran el App ID, la Clave secreta y la Redirect URI cargados acá. No hay secrets de Edge: los negocios no van a poder conectar ni sincronizar."
        }
        confirmLabel="Borrar"
        danger
        loading={clearing}
        onConfirm={async () => {
          setClearing(true);
          try {
            await onClear();
            toast({ title: "Configuración borrada.", variant: "success" });
            setClearOpen(false);
          } catch {
            toast({ title: "No se pudo borrar", variant: "error" });
          } finally {
            setClearing(false);
          }
        }}
      />
    </div>
  );
}
MlAppPanel.displayName = "MlAppPanel";
