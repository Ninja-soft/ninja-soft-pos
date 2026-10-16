"use client";

import { useState } from "react";
import { ArrowLeft, KeyRound, Mail, RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Checkbox } from "@/components/ui/Checkbox";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/Toast";
import { apiPublicaErrorMessage, type ApiClientView, type ApiClientWithSecret } from "@/modules/api-publica/api";
import { useApiClientMutations, useSendApiDocs } from "@/modules/api-publica/hooks";
import { envOf } from "./ApiCredentials";

// Enviar la documentación de la API por email (ADR-163), con una credencial
// si el dueño quiere: client_id, ambiente, alcances y URL base siempre; el
// client_secret sólo si se acaba de crear o rotar en esta página (la base
// guarda sólo su hash) o con "Rotar y enviar". Adjunta la colección de Postman
// con las variables cargadas y el HTML de la documentación. Sale por la Edge
// send_api_docs_email, que envía directo sin guardar el cuerpo y audita sin el
// secreto. Mandar el secreto pide una confirmación explícita.

const EMAIL_RE = /^[^@\s<>"',;]+@[^@\s<>"',;]+\.[^@\s<>"',;]+$/;
export const DOCS_NOTE_MAX = 500;
const NONE = "__none__";

export const SECRET_WARNING = "Vas a mandar una clave secreta por email; cualquiera con este email puede operar tu API.";

type Step = { kind: "form" } | { kind: "confirm"; rotate: boolean };

export function EmailDocsDialog({
  open,
  onOpenChange,
  clients = [],
  fresh = null,
  onRotated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  clients?: ApiClientView[];
  /** Credencial recién creada o rotada (con su secreto en memoria). */
  fresh?: ApiClientWithSecret | null;
  /** Avisa al contenedor el secreto nuevo de "Rotar y enviar". */
  onRotated?: (c: ApiClientWithSecret) => void;
}) {
  const { toast } = useToast();
  const send = useSendApiDocs();
  const { rotate } = useApiClientMutations();
  const active = clients.filter((c) => c.status === "active");
  const initialClient = () => (fresh && active.some((c) => c.client_id === fresh.client_id) ? fresh.client_id : NONE);

  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [selected, setSelected] = useState<string>(initialClient);
  const [includeSecret, setIncludeSecret] = useState(false);
  const [includePostman, setIncludePostman] = useState(true);
  const [includeHtml, setIncludeHtml] = useState(true);
  const [step, setStep] = useState<Step>({ kind: "form" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastOpen, setLastOpen] = useState(open);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      setEmail("");
      setNote("");
      setSelected(initialClient());
      setIncludeSecret(false);
      setIncludePostman(true);
      setIncludeHtml(true);
      setStep({ kind: "form" });
      setError(null);
    }
  }

  const client = active.find((c) => c.client_id === selected) ?? null;
  const env = client ? envOf(client) : null;
  const canSecret = Boolean(client && fresh && fresh.client_id === client.client_id);
  const willSendSecret = canSecret && includeSecret;

  const validate = (): string | null => {
    const to = email.trim();
    if (!EMAIL_RE.test(to) || to.length > 254) return "Revisá el email: no parece válido.";
    if (note.length > DOCS_NOTE_MAX) return `La nota puede tener hasta ${DOCS_NOTE_MAX} caracteres.`;
    return null;
  };

  const doSend = async (secret: string | null, target: ApiClientView | null) => {
    const r = await send.mutateAsync({
      email: email.trim(),
      note: note.trim() || null,
      client: target ? { client_id: target.client_id, environment: envOf(target) } : null,
      clientSecret: secret,
      ackSecret: Boolean(secret),
      includePostman,
      includeHtml,
    });
    toast({
      title: "Documentación enviada",
      description: r.fallback
        ? `Le llega a ${email.trim().toLowerCase()} un link a la documentación (sin adjuntos).`
        : `Le llega a ${email.trim().toLowerCase()} en unos minutos${r.with_secret ? ", con la clave secreta" : ""}.`,
      variant: "success",
    });
    onOpenChange(false);
  };

  const run = async (fn: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(apiPublicaErrorMessage(e));
      setStep({ kind: "form" });
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = () => {
    const v = validate();
    if (v) {
      setError(v);
      return;
    }
    if (willSendSecret) {
      setError(null);
      setStep({ kind: "confirm", rotate: false });
      return;
    }
    void run(() => doSend(null, client));
  };

  const onRotateAndSend = () => {
    const v = validate();
    if (v) {
      setError(v);
      return;
    }
    setError(null);
    setStep({ kind: "confirm", rotate: true });
  };

  const onConfirm = () =>
    run(async () => {
      if (!client) return;
      if (step.kind === "confirm" && step.rotate) {
        const rotated = await rotate.mutateAsync(client.id);
        onRotated?.(rotated);
        await doSend(rotated.client_secret, rotated);
        return;
      }
      await doSend(fresh!.client_secret, client);
    });

  const confirming = step.kind === "confirm";

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Enviar la documentación por email"
      description="Le llega el link al portal de desarrolladores y, si querés, la colección de Postman, la documentación en HTML y los datos de una credencial."
      footer={
        confirming ? (
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={() => setStep({ kind: "form" })} disabled={busy}>
              <ArrowLeft size={15} /> Volver
            </Button>
            <Button variant="destructive" onClick={() => void onConfirm()} disabled={busy}>
              {step.rotate ? <RefreshCw size={15} /> : <KeyRound size={15} />}
              {step.rotate ? "Rotar y enviar" : "Enviar con la clave"}
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            {client && !canSecret && (
              <Button variant="secondary" onClick={onRotateAndSend} disabled={busy}>
                <RefreshCw size={15} /> Rotar y enviar con secreto
              </Button>
            )}
            <Button onClick={onSubmit} disabled={busy}>
              <Mail size={15} /> Enviar
            </Button>
          </div>
        )
      }
    >
      {confirming ? (
        <div className="space-y-4">
          <Callout tone="danger" icon={TriangleAlert} title="Clave secreta por email">
            {SECRET_WARNING}
          </Callout>
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
            <li>
              Destinatario: <span className="font-medium text-foreground">{email.trim().toLowerCase()}</span>
            </li>
            <li>
              Credencial: <span className="font-medium text-foreground">{client?.name}</span> (
              {env === "test" ? "Prueba" : "Producción"})
            </li>
            {env === "live" ? (
              <li className="text-danger">
                Es de producción: con ella se leen y escriben datos reales del negocio. Recomendamos mandar una credencial de
                prueba y crear la de producción cuando la integración funcione.
              </li>
            ) : (
              <li>Es de prueba: las escrituras no se guardan, pero las lecturas ven datos reales del negocio.</li>
            )}
            {step.kind === "confirm" && step.rotate && (
              <li className="text-danger">
                Rotar genera un secreto nuevo: el actual deja de funcionar ya y la integración que lo use se corta hasta
                cargar el nuevo.
              </li>
            )}
            <li>Si el email se filtra, rotá o revocá la credencial. NinjaSoft no guarda el secreto ni el email enviado.</li>
          </ul>
          {error && <p className="text-sm text-danger">{error}</p>}
        </div>
      ) : (
        <div className="space-y-4">
          <Input
            variant="filled"
            type="email"
            label="Email del integrador"
            placeholder="dev@tuproveedor.com"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Select
            label="Credencial"
            value={selected}
            onChange={(v) => {
              setSelected(v);
              setIncludeSecret(false);
            }}
            options={[
              { value: NONE, label: "Sin credencial", description: "Sólo la documentación." },
              ...active.map((c) => ({
                value: c.client_id,
                label: `${c.name} · ${envOf(c) === "test" ? "Prueba" : "Producción"}`,
                description: c.client_id,
              })),
            ]}
          />
          {client && (
            <div className="space-y-2 rounded-lg bg-muted/60 p-3 text-sm">
              <p className="text-muted-foreground">
                Va el client_id, el ambiente, los alcances y la URL base. La colección de Postman sale con esas variables
                cargadas.
              </p>
              {canSecret ? (
                <label className="flex cursor-pointer items-start gap-3">
                  <Checkbox
                    checked={includeSecret}
                    onCheckedChange={(v) => setIncludeSecret(Boolean(v))}
                    aria-label="Incluir el client_secret"
                  />
                  <span>
                    Incluir el client_secret que acabás de ver
                    <span className="block text-xs text-muted-foreground">
                      Va en el email y en la colección. Antes de enviar te pedimos confirmarlo.
                    </span>
                  </span>
                </label>
              ) : (
                <p className="text-xs text-muted-foreground">
                  El secreto de esta credencial no se puede volver a ver (se guarda cifrado). Va sin secreto, o usá Rotar y
                  enviar para mandar uno nuevo.
                </p>
              )}
              {env === "live" && (
                <p className="flex items-start gap-2 text-xs text-warning">
                  <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden /> Credencial de producción.
                  Recomendamos mandar una de prueba.
                </p>
              )}
            </div>
          )}
          <div className="space-y-2">
            <span className="block text-xs font-medium text-muted-foreground">Adjuntos</span>
            <label className="flex cursor-pointer items-center gap-3 text-sm">
              <Checkbox
                checked={includePostman}
                onCheckedChange={(v) => setIncludePostman(Boolean(v))}
                aria-label="Adjuntar la colección de Postman"
              />
              Colección de Postman{client ? " con las variables cargadas" : ""}
            </label>
            <label className="flex cursor-pointer items-center gap-3 text-sm">
              <Checkbox
                checked={includeHtml}
                onCheckedChange={(v) => setIncludeHtml(Boolean(v))}
                aria-label="Adjuntar la documentación en HTML"
              />
              Documentación completa en HTML
            </label>
          </div>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Nota (opcional)</span>
            <textarea
              className="min-h-20 w-full rounded-xl border-0 bg-muted px-3 py-2 text-sm text-foreground outline-none transition focus:bg-secondary"
              maxLength={DOCS_NOTE_MAX}
              placeholder="Por ejemplo: es para sincronizar la tienda online."
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <span className="mt-1 block text-right text-xs text-muted-foreground">
              {note.length}/{DOCS_NOTE_MAX}
            </span>
          </label>
          {error && <p className="text-sm text-danger">{error}</p>}
          <p className="text-xs text-muted-foreground">
            Queda registrado en la auditoría del negocio (sin el secreto). Hasta 20 envíos por día.
          </p>
        </div>
      )}
    </Modal>
  );
}
EmailDocsDialog.displayName = "EmailDocsDialog";
