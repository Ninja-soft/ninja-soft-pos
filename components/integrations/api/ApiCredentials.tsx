"use client";

import { useState } from "react";
import { Download, FlaskConical, KeyRound, Lock, Mail, Plus, RefreshCw, ShieldOff, SquarePen } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Checkbox } from "@/components/ui/Checkbox";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { useToast } from "@/components/ui/Toast";
import { SettingsCard } from "@/components/settings/Settings";
import { useApiClientMutations } from "@/modules/api-publica/hooks";
import {
  apiPublicaErrorMessage,
  type ApiClientView,
  type ApiClientWithSecret,
  type ApiClientsState,
  type ApiEnvironment,
} from "@/modules/api-publica/api";
import { API_SCOPES, SCOPE_INFO, cleanScopes, type ApiScope } from "@/lib/api-publica/scopes";
import { MAX_ACTIVE_CLIENTS } from "@/lib/api/spec";
import { CopyButton } from "./CodeBlock";

// Credenciales de la API (ADR-094 + ADR-159). Sólo el dueño: crear (producción
// o prueba) con permisos por alcance, ver el secreto UNA vez, rotarlo,
// revocarlo y mirar el último uso. Crear, editar y rotar piden la feature
// `api_publica` (Enterprise); revocar siempre se puede. El servidor lo exige.

function when(iso: string | null): string {
  if (!iso) return "Nunca";
  return new Date(iso).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" });
}

export function envOf(c: Pick<ApiClientView, "environment" | "client_id">): ApiEnvironment {
  return c.environment ?? (c.client_id.startsWith("nsc_test_") ? "test" : "live");
}

export function EnvBadge({ env }: { env: ApiEnvironment }) {
  return env === "test" ? <Badge tone="info">Prueba</Badge> : <Badge tone="neutral">Producción</Badge>;
}

function CopyField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2">
        <code className="min-w-0 flex-1 break-all font-mono text-xs">{value}</code>
        <CopyButton value={value} label={`Copiar ${label}`} />
      </div>
    </div>
  );
}

function ScopePicker({ value, onChange }: { value: ApiScope[]; onChange: (v: ApiScope[]) => void }) {
  return (
    <fieldset className="space-y-1">
      <legend className="mb-1 text-sm font-medium">Permisos</legend>
      {API_SCOPES.map((s) => {
        const on = value.includes(s);
        return (
          <label key={s} className="flex cursor-pointer items-start gap-3 rounded-lg px-1 py-2 hover:bg-secondary/40">
            <Checkbox
              checked={on}
              onCheckedChange={(next) => onChange(cleanScopes(next ? [...value, s] : value.filter((x) => x !== s)) ?? [])}
              aria-label={SCOPE_INFO[s].label}
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{SCOPE_INFO[s].label}</span>
              <span className="block text-xs text-muted-foreground">
                <code className="font-mono">{s}</code> · {SCOPE_INFO[s].desc}
              </span>
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

type FormState = { id: string | null; name: string; scopes: ApiScope[]; rateLimit: string; environment: ApiEnvironment };

function ClientForm({
  open,
  initial,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  initial: FormState;
  onOpenChange: (o: boolean) => void;
  onCreated: (c: ApiClientWithSecret) => void;
}) {
  const { toast } = useToast();
  const { create, update } = useApiClientMutations();
  const [f, setF] = useState<FormState>(initial);
  const [lastInitial, setLastInitial] = useState(initial);
  if (initial !== lastInitial) {
    setLastInitial(initial);
    setF(initial);
  }
  const limit = Number(f.rateLimit);
  const limitOk = Number.isInteger(limit) && limit >= 10 && limit <= 10000;
  const valid = f.name.trim().length > 0 && f.scopes.length > 0 && limitOk;
  const busy = create.isPending || update.isPending;

  const submit = () => {
    if (!valid) return;
    if (f.id) {
      update.mutate(
        { id: f.id, name: f.name.trim(), scopes: f.scopes, rateLimit: limit },
        {
          onSuccess: () => {
            toast({ title: "Credencial actualizada", variant: "success" });
            onOpenChange(false);
          },
          onError: (e) => toast({ title: apiPublicaErrorMessage(e), variant: "error" }),
        },
      );
    } else {
      create.mutate(
        { name: f.name.trim(), scopes: f.scopes, rateLimit: limit, environment: f.environment },
        {
          onSuccess: (c) => {
            onOpenChange(false);
            onCreated(c);
          },
          onError: (e) => toast({ title: apiPublicaErrorMessage(e), variant: "error" }),
        },
      );
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={f.id ? "Editar credencial" : "Nueva credencial"}
      description="Cada integración con su propia credencial: si una se compromete, la revocás sin cortar las demás."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={!valid || busy}>
            {f.id ? "Guardar" : "Crear credencial"}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {!f.id && (
          <div className="space-y-2">
            <p className="text-sm font-medium">Ambiente</p>
            <Segmented
              aria-label="Ambiente"
              fill
              value={f.environment}
              onChange={(environment) => setF({ ...f, environment })}
              options={[
                { value: "test", label: "Prueba (sandbox)" },
                { value: "live", label: "Producción" },
              ]}
            />
            <p className="text-xs text-muted-foreground">
              {f.environment === "test"
                ? "Lee datos reales y simula las escrituras: valida todo y no guarda nada. Ideal para desarrollar y para el Probar de esta página."
                : "Lee y escribe de verdad en el negocio. Usala cuando la integración ya está probada."}
            </p>
          </div>
        )}
        <Input
          label="Nombre"
          placeholder="Tienda online, ERP, planilla de precios"
          value={f.name}
          maxLength={80}
          onChange={(e) => setF({ ...f, name: e.target.value })}
        />
        <ScopePicker value={f.scopes} onChange={(scopes) => setF({ ...f, scopes })} />
        <Input
          label="Pedidos por minuto"
          type="number"
          inputMode="numeric"
          min={10}
          max={10000}
          value={f.rateLimit}
          error={limitOk ? undefined : "De 10 a 10.000"}
          hint="Al pasarlo, la API responde 429 hasta que se libera la ventana."
          onChange={(e) => setF({ ...f, rateLimit: e.target.value })}
        />
        {f.id && (
          <p className="text-xs text-muted-foreground">
            Si quitás permisos, los tokens vigentes de esta credencial dejan de servir y la integración pide uno nuevo.
          </p>
        )}
      </div>
    </Modal>
  );
}

function SecretModal({
  secret,
  onClose,
  onPostman,
  onSandbox,
  onEmail,
}: {
  secret: ApiClientWithSecret | null;
  onClose: () => void;
  onPostman: (c: ApiClientWithSecret) => void;
  onSandbox: (c: ApiClientWithSecret) => void;
  onEmail?: (c: ApiClientWithSecret) => void;
}) {
  const env = secret ? envOf(secret) : "live";
  return (
    <Modal
      open={secret !== null}
      onOpenChange={(o) => !o && onClose()}
      title="Guardá el secreto ahora"
      description="Es la única vez que se muestra. NinjaSoft guarda sólo una huella: si lo perdés, rotalo."
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          {secret && (
            <Button variant="secondary" onClick={() => onPostman(secret)}>
              <Download size={15} /> Colección de Postman
            </Button>
          )}
          {secret && onEmail && (
            <Button variant="secondary" onClick={() => onEmail(secret)}>
              <Mail size={15} /> Enviar por email
            </Button>
          )}
          {secret && env === "test" && (
            <Button variant="secondary" onClick={() => onSandbox(secret)}>
              <FlaskConical size={15} /> Usar en el sandbox
            </Button>
          )}
          <Button onClick={onClose}>Ya lo guardé</Button>
        </div>
      }
    >
      {secret && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{secret.name}</span>
            <EnvBadge env={env} />
          </div>
          <CopyField label="client_id" value={secret.client_id} />
          <CopyField label="client_secret" value={secret.client_secret} />
          <Callout tone="warning" icon={KeyRound}>
            Guardalo en el gestor de secretos del sistema que se integra, nunca en un repositorio. La colección de Postman
            con el secreto incluido es tan sensible como el secreto.
          </Callout>
        </div>
      )}
    </Modal>
  );
}

function ClientRow({
  c,
  canWrite,
  onEdit,
  onRotate,
  onRevoke,
}: {
  c: ApiClientView;
  canWrite: boolean;
  onEdit: () => void;
  onRotate: () => void;
  onRevoke: () => void;
}) {
  const revoked = c.status === "revoked";
  return (
    <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{c.name}</span>
          <EnvBadge env={envOf(c)} />
          {revoked ? <Badge tone="danger">Revocada</Badge> : <Badge tone="success">Activa</Badge>}
        </div>
        <p className="break-all font-mono text-xs text-muted-foreground">
          {c.client_id} · secreto terminado en {c.secret_hint}
        </p>
        <div className="flex flex-wrap gap-1">
          {c.scopes.map((s) => (
            <Badge key={s} tone="neutral" className="font-mono">
              {s}
            </Badge>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Último uso: {when(c.last_used_at)} · {c.rate_limit_per_min} pedidos por minuto · creada {when(c.created_at)}
          {c.rotated_at ? ` · rotada ${when(c.rotated_at)}` : ""}
          {revoked ? ` · revocada ${when(c.revoked_at)}${c.revoke_reason ? ` (${c.revoke_reason})` : ""}` : ""}
        </p>
      </div>
      {!revoked && (
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={onEdit} disabled={!canWrite}>
            <SquarePen size={15} /> Editar
          </Button>
          <Button variant="secondary" size="sm" onClick={onRotate} disabled={!canWrite}>
            <RefreshCw size={15} /> Rotar secreto
          </Button>
          <Button variant="ghost" size="sm" onClick={onRevoke}>
            <ShieldOff size={15} /> Revocar
          </Button>
        </div>
      )}
    </div>
  );
}

const EMPTY_FORM: FormState = { id: null, name: "", scopes: ["products:read"], rateLimit: "600", environment: "test" };

export function ApiCredentials({
  state,
  onSecret,
  onPostman,
  onSandbox,
  onEmail,
}: {
  state: ApiClientsState;
  /** Secreto recién creado o rotado (vive sólo en memoria de la página). */
  onSecret: (c: ApiClientWithSecret) => void;
  onPostman: (c: ApiClientWithSecret) => void;
  onSandbox: (c: ApiClientWithSecret) => void;
  /** Mandar la documentación con esta credencial por email (ADR-163). */
  onEmail?: (c: ApiClientWithSecret) => void;
}) {
  const { toast } = useToast();
  const { rotate, revoke } = useApiClientMutations();
  const [form, setForm] = useState<FormState | null>(null);
  const [secret, setSecret] = useState<ApiClientWithSecret | null>(null);
  const [toRotate, setToRotate] = useState<ApiClientView | null>(null);
  const [toRevoke, setToRevoke] = useState<ApiClientView | null>(null);

  const { feature, clients } = state;
  const active = clients.filter((c) => c.status === "active");
  const showSecret = (c: ApiClientWithSecret) => {
    setSecret(c);
    onSecret(c);
  };

  return (
    <div className="space-y-5">
      {!feature && (
        <Callout tone="warning" icon={Lock} title="Tu plan no incluye la API pública">
          Está en el plan Enterprise. Podés ver y revocar las credenciales existentes, pero no crear ni rotar; la API
          rechaza los pedidos mientras el plan no la incluya.
        </Callout>
      )}

      <SettingsCard
        title="Credenciales"
        description="OAuth2 client_credentials: la integración pide un token de 1 hora con su client_id y secreto y lo usa como Bearer."
        icon={KeyRound}
        actions={
          <Button
            size="sm"
            onClick={() => setForm({ ...EMPTY_FORM })}
            disabled={!feature || active.length >= MAX_ACTIVE_CLIENTS}
          >
            <Plus size={15} /> Nueva credencial
          </Button>
        }
      >
        {clients.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted-foreground">
            Todavía no hay credenciales. Empezá con una de prueba para desarrollar sin tocar el negocio.
          </p>
        ) : (
          clients.map((c) => (
            <ClientRow
              key={c.id}
              c={c}
              canWrite={feature}
              onEdit={() =>
                setForm({
                  id: c.id,
                  name: c.name,
                  scopes: c.scopes,
                  rateLimit: String(c.rate_limit_per_min),
                  environment: envOf(c),
                })
              }
              onRotate={() => setToRotate(c)}
              onRevoke={() => setToRevoke(c)}
            />
          ))
        )}
      </SettingsCard>

      {form && (
        <ClientForm open={form !== null} initial={form} onOpenChange={(o) => !o && setForm(null)} onCreated={showSecret} />
      )}
      <SecretModal
        secret={secret}
        onClose={() => setSecret(null)}
        onPostman={(c) => {
          setSecret(null);
          onPostman(c);
        }}
        onEmail={
          onEmail
            ? (c) => {
                setSecret(null);
                onEmail(c);
              }
            : undefined
        }
        onSandbox={(c) => {
          setSecret(null);
          onSandbox(c);
        }}
      />

      <ConfirmDialog
        open={toRotate !== null}
        onOpenChange={(o) => !o && setToRotate(null)}
        title="Rotar el secreto"
        description="El secreto actual y los tokens emitidos dejan de servir ahora mismo. Vas a ver el secreto nuevo una sola vez."
        confirmLabel="Rotar"
        loading={rotate.isPending}
        onConfirm={() => {
          if (!toRotate) return;
          rotate.mutate(toRotate.id, {
            onSuccess: (c) => {
              setToRotate(null);
              showSecret(c);
            },
            onError: (e) => toast({ title: apiPublicaErrorMessage(e), variant: "error" }),
          });
        }}
      />
      <ConfirmDialog
        open={toRevoke !== null}
        onOpenChange={(o) => !o && setToRevoke(null)}
        title="Revocar la credencial"
        description="La integración deja de tener acceso en el acto y no se puede reactivar. Para volver a conectarla, creá una nueva."
        confirmLabel="Revocar"
        danger
        withReason
        reasonLabel="Motivo"
        reasonPlaceholder="Ya no se usa, se filtró, cambio de proveedor"
        loading={revoke.isPending}
        onConfirm={(reason) => {
          if (!toRevoke) return;
          revoke.mutate(
            { id: toRevoke.id, reason },
            {
              onSuccess: () => {
                setToRevoke(null);
                toast({ title: "Credencial revocada", variant: "success" });
              },
              onError: (e) => toast({ title: apiPublicaErrorMessage(e), variant: "error" }),
            },
          );
        }}
      />
    </div>
  );
}
ApiCredentials.displayName = "ApiCredentials";
