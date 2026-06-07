"use client";

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Check, Mail } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/ui/Toast";
import { Card, CardContent } from "@/components/ui/Card";
import { Heading } from "@/components/ui/Typography";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { cn } from "@/lib/utils/cn";
import { useTenantSmtpStatus } from "@/modules/tickets/hooks";

// Proveedores con presets de host/puerto/seguridad. "otro" deja todo editable.
type ProviderKey = "gmail" | "outlook" | "otro";
const PROVIDERS: { key: ProviderKey; label: string; host: string; port: string; secure: boolean }[] = [
  { key: "gmail", label: "Gmail", host: "smtp.gmail.com", port: "465", secure: true },
  { key: "outlook", label: "Outlook", host: "smtp.office365.com", port: "587", secure: false },
  { key: "otro", label: "Otro", host: "", port: "587", secure: false },
];

function inferProvider(host: string): ProviderKey {
  const h = host.trim().toLowerCase();
  if (h === "smtp.gmail.com") return "gmail";
  if (h === "smtp.office365.com") return "outlook";
  return "otro";
}

// Mapea los errores de la Edge Function a mensajes en español.
function mapError(error: string, detail?: string): string {
  switch (error) {
    case "invalid_port":
      return "El puerto no es válido (debe estar entre 1 y 65535).";
    case "invalid_from_email":
      return "El email no es válido.";
    case "test_failed":
      if (detail && /timeout/i.test(detail)) {
        return "El servidor SMTP no respondió (timeout). Verificá host/puerto/SSL.";
      }
      return detail
        ? `No se pudo enviar: ${detail}`
        : "No se pudo enviar el email de prueba.";
    case "forbidden":
      return "Solo el dueño o un encargado puede configurar el email.";
    case "no_tenant":
      return "No se encontró el negocio activo.";
    case "unauthorized":
      return "Tu sesión expiró. Volvé a iniciar sesión.";
    case "save_failed":
      return "No se pudo guardar la configuración.";
    case "internal":
      return "Error interno del servidor de envío. Probá de nuevo.";
    default:
      if (detail && /timeout/i.test(detail)) {
        return "El servidor SMTP no respondió (timeout). Verificá host/puerto/SSL.";
      }
      return "No se pudo guardar. Revisá los datos e intentá de nuevo.";
  }
}

type SmtpResult =
  | { ok: true; tested?: boolean }
  | { error: string; detail?: string };

export function TenantEmailCard() {
  const supabase = createClient();
  const qc = useQueryClient();
  const { toast } = useToast();

  const [provider, setProvider] = useState<ProviderKey>("gmail");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [host, setHost] = useState("smtp.gmail.com");
  const [port, setPort] = useState("587");
  const [secure, setSecure] = useState(false);
  const [email, setEmail] = useState("");
  const [fromName, setFromName] = useState("");
  const [password, setPassword] = useState("");
  const [hasPassword, setHasPassword] = useState(false);
  const [bodyText, setBodyText] = useState("");
  const [result, setResult] = useState<
    { kind: "ok"; tested: boolean; to?: string } | { kind: "error"; msg: string } | null
  >(null);

  // get_tenant_smtp: allowed:false → no es owner/manager; allowed:true →
  // owner (con configured true/false y los campos del SMTP en el mismo objeto).
  const { data: status, isLoading } = useTenantSmtpStatus();

  // Hidratar campos desde la config guardada (anidada en el mismo payload).
  useEffect(() => {
    if (!status?.allowed) return;
    const cfgHost = String(status.host ?? "");
    setHost(cfgHost || "smtp.gmail.com");
    setPort(String(status.port ?? "587"));
    setSecure(!!status.secure);
    setEmail(String(status.from_email ?? status.username ?? ""));
    setFromName(String(status.from_name ?? ""));
    setBodyText(String(status.body_text ?? ""));
    setHasPassword(!!status.has_password);
    setProvider(cfgHost ? inferProvider(cfgHost) : "gmail");
  }, [status]);

  function pickProvider(key: ProviderKey) {
    setProvider(key);
    const preset = PROVIDERS.find((p) => p.key === key)!;
    if (key !== "otro") {
      setHost(preset.host);
      setPort(preset.port);
      setSecure(preset.secure);
    }
  }

  const save = useMutation({
    mutationFn: async (test: boolean): Promise<SmtpResult> => {
      const { data, error } = await supabase.functions.invoke("set_tenant_smtp", {
        body: {
          host: host.trim(),
          port: Number(port) || 587,
          secure,
          username: email.trim(),
          password: password || undefined,
          from_name: fromName.trim(),
          from_email: email.trim(),
          body_text: bodyText.trim() || undefined,
          test,
          test_to: test ? email.trim() : undefined,
        },
      });
      if (error) throw error;
      return data as SmtpResult;
    },
    onSuccess: (res) => {
      if ("error" in res) {
        const msg = mapError(res.error, res.detail);
        setResult({ kind: "error", msg });
        toast({ title: msg, variant: "error" });
        // Aun con test_failed la config queda guardada en el server.
        if (res.error === "test_failed") {
          qc.invalidateQueries({ queryKey: ["tenant-smtp-status"] });
          setPassword("");
        }
        return;
      }
      setResult({ kind: "ok", tested: !!res.tested, to: res.tested ? email.trim() : undefined });
      toast({
        title: res.tested ? "Email de prueba enviado" : "Email guardado",
        variant: "success",
      });
      setPassword("");
      qc.invalidateQueries({ queryKey: ["tenant-smtp-status"] });
    },
    onError: () => {
      const msg = "No se pudo guardar. Revisá tu conexión e intentá de nuevo.";
      setResult({ kind: "error", msg });
      toast({ title: msg, variant: "error" });
    },
  });

  if (isLoading) return null;

  // No owner/manager: allowed:false.
  if (!status?.allowed) {
    return (
      <Card>
        <CardContent className="p-6">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-lg bg-ninja-flame/12 text-ninja-flameSoft">
              <Mail size={18} />
            </span>
            <div>
              <Heading as="h3" className="text-base">
                Email del negocio
              </Heading>
              <p className="text-sm text-muted-foreground">
                Solo el dueño puede configurar el email del negocio.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Estado persistido (server) para el chip. El estado del formulario
  // (formReady) habilita los botones de guardar.
  const configured = status.configured;
  const formReady = Boolean(host.trim() && email.trim());
  const saving = save.isPending;

  return (
    <Card>
      <CardContent className="space-y-6 p-6">
        {/* Encabezado + chip de estado */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-lg bg-ninja-flame/12 text-ninja-flameSoft">
              <Mail size={18} />
            </span>
            <div>
              <Heading as="h3" className="text-base">
                Email del negocio
              </Heading>
              <p className="text-sm text-muted-foreground">
                Enviá los comprobantes a tus clientes desde tu propio email.
              </p>
            </div>
          </div>
          {configured ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-400">
              <Check size={13} /> Configurado
            </span>
          ) : (
            <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
              Sin configurar
            </span>
          )}
        </div>

        {/* Paso 1 — Proveedor */}
        <Step n={1} title="Elegí tu proveedor de email">
          <div className="grid grid-cols-3 gap-2">
            {PROVIDERS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => pickProvider(p.key)}
                className={cn(
                  "rounded-lg border px-3 py-2.5 text-sm font-medium transition",
                  provider === p.key
                    ? "border-ninja-flame ring-2 ring-ninja-flame/30 text-foreground"
                    : "border-border text-muted-foreground hover:border-ninja-flameSoft/40",
                )}
              >
                {p.label}
              </button>
            ))}
          </div>

          {provider === "outlook" && (
            <p className="mt-2 text-xs text-muted-foreground">
              Si Outlook falla, probá el puerto 465 con SSL si tu proveedor lo
              soporta.
            </p>
          )}

          {provider === "otro" ? (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Input
                label="Servidor SMTP"
                placeholder="smtp.tudominio.com"
                value={host}
                onChange={(e) => setHost(e.target.value)}
              />
              <Input
                label="Puerto"
                inputMode="numeric"
                placeholder="587"
                value={port}
                onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))}
              />
              <label className="flex items-center gap-2 text-sm text-foreground sm:col-span-2">
                <input
                  type="checkbox"
                  className="accent-ninja-flame"
                  checked={secure}
                  onChange={(e) => setSecure(e.target.checked)}
                />
                Conexión segura (SSL/TLS, normalmente puerto 465)
              </label>
            </div>
          ) : (
            <details
              className="mt-3 text-sm"
              open={showAdvanced}
              onToggle={(e) => setShowAdvanced((e.target as HTMLDetailsElement).open)}
            >
              <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                Avanzado (servidor y puerto)
              </summary>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Input
                  label="Servidor SMTP"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                />
                <Input
                  label="Puerto"
                  inputMode="numeric"
                  value={port}
                  onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))}
                />
                <label className="flex items-center gap-2 text-sm text-foreground sm:col-span-2">
                  <input
                    type="checkbox"
                    className="accent-ninja-flame"
                    checked={secure}
                    onChange={(e) => setSecure(e.target.checked)}
                  />
                  Conexión segura (SSL/TLS)
                </label>
              </div>
            </details>
          )}
        </Step>

        {/* Paso 2 — Cuenta */}
        <Step n={2} title="Tu cuenta de email">
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label="Tu email"
              type="email"
              autoComplete="off"
              placeholder="negocio@gmail.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Input
              label="Nombre del remitente (opcional)"
              placeholder="Mi Negocio"
              value={fromName}
              onChange={(e) => setFromName(e.target.value)}
            />
          </div>
          <Input
            label="Contraseña"
            type="password"
            autoComplete="new-password"
            data-1p-ignore
            data-lpignore="true"
            placeholder={
              hasPassword
                ? "•••••• (guardada — dejá vacío para mantener)"
                : "Contraseña de aplicación"
            }
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />

          {provider === "gmail" && (
            <details className="text-sm">
              <summary className="cursor-pointer text-xs font-medium text-ninja-flameSoft hover:underline">
                ¿Cómo consigo la contraseña de aplicación de Gmail?
              </summary>
              <ol className="mt-2 space-y-1.5">
                {[
                  "Activá la verificación en 2 pasos en tu cuenta de Google.",
                  "Entrá a Contraseñas de aplicaciones y creá una nueva.",
                  "Copiá la contraseña de 16 letras y pegala arriba (no es la de tu correo).",
                ].map((step, i) => (
                  <li key={i} className="flex gap-2.5 text-muted-foreground">
                    <span className="mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border border-ninja-flameSoft/50 bg-ninja-flame/15 text-[10px] font-bold text-ninja-flameSoft">
                      {i + 1}
                    </span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
              <a
                href="https://myaccount.google.com/apppasswords"
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-block text-xs font-medium text-ninja-flameSoft hover:underline"
              >
                Abrir Contraseñas de aplicaciones de Google →
              </a>
            </details>
          )}
        </Step>

        {/* Paso 3 — Probar y guardar */}
        <Step n={3} title="Texto del email y guardar">
          <div>
            <label className="mb-2 block text-sm font-medium text-muted-foreground">
              Texto del email del comprobante
            </label>
            <textarea
              value={bodyText}
              onChange={(e) => setBodyText(e.target.value)}
              rows={3}
              placeholder="¡Gracias por tu compra! Te enviamos tu comprobante."
              className="w-full rounded-lg border border-input bg-background p-3 text-sm text-foreground outline-none focus:border-ninja-flameSoft focus:ring-2 focus:ring-ninja-flameSoft/20"
            />
          </div>

          {result && (
            <div
              className={cn(
                "flex items-start gap-2 rounded-lg border p-3 text-sm",
                result.kind === "ok"
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                  : "border-destructive/30 bg-destructive/10 text-destructive",
              )}
            >
              {result.kind === "ok" ? (
                <Check size={16} className="mt-0.5 shrink-0" />
              ) : (
                <AlertCircle size={16} className="mt-0.5 shrink-0" />
              )}
              <span>
                {result.kind === "ok"
                  ? result.tested
                    ? `Conexión OK — email de prueba enviado a ${result.to}`
                    : "Configuración guardada."
                  : result.msg}
              </span>
            </div>
          )}

          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="secondary"
              disabled={saving || !formReady}
              onClick={() => save.mutate(false)}
            >
              {saving ? "Guardando…" : "Guardar"}
            </Button>
            <Button disabled={saving || !formReady} onClick={() => save.mutate(true)}>
              {saving ? "Enviando…" : "Guardar y enviar prueba"}
            </Button>
          </div>
        </Step>
      </CardContent>
    </Card>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-3 border-t border-dashed border-border pt-5 first:border-0 first:pt-0">
      <div className="flex items-center gap-2.5">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ninja-flame/15 text-xs font-bold text-ninja-flameSoft">
          {n}
        </span>
        <span className="text-sm font-semibold text-foreground">{title}</span>
      </div>
      <div className="space-y-3 pl-[34px]">{children}</div>
    </div>
  );
}
