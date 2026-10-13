"use client";

import { useState } from "react";
import { Copy, KeyRound, Lock, Plus, RefreshCw, ShieldOff, SquarePen } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Checkbox } from "@/components/ui/Checkbox";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { SettingsCard } from "@/components/settings/Settings";
import { useMyTenant } from "@/modules/tenants/hooks";
import { useApiClientMutations, useApiClients } from "@/modules/api-publica/hooks";
import { apiPublicaErrorMessage, type ApiClientView, type ApiClientWithSecret } from "@/modules/api-publica/api";
import { API_SCOPES, SCOPE_INFO, cleanScopes, type ApiScope } from "@/lib/api-publica/scopes";

// Configuración > Integraciones > API (ADR-094). Sólo el dueño: crear
// credenciales con permisos por alcance, ver el secreto UNA vez, rotarlo,
// revocarlo y mirar el último uso. Crear, editar y rotar piden la feature
// `api_publica` (Enterprise); revocar siempre se puede. El servidor lo exige.

function when(iso: string | null): string {
  if (!iso) return "Nunca";
  return new Date(iso).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" });
}

function CopyField({ label, value }: { label: string; value: string }) {
  const { toast } = useToast();
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2">
        <code className="min-w-0 flex-1 break-all font-mono text-xs">{value}</code>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`Copiar ${label}`}
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(
              () => toast({ title: `${label} copiado`, variant: "success" }),
              () => toast({ title: "No se pudo copiar", variant: "error" }),
            );
          }}
        >
          <Copy size={15} />
        </Button>
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

type FormState = { id: string | null; name: string; scopes: ApiScope[]; rateLimit: string };

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
        { name: f.name.trim(), scopes: f.scopes, rateLimit: limit },
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

function SecretModal({ secret, onClose }: { secret: ApiClientWithSecret | null; onClose: () => void }) {
  return (
    <Modal
      open={secret !== null}
      onOpenChange={(o) => !o && onClose()}
      title="Guardá el secreto ahora"
      description="Es la única vez que se muestra. NinjaSoft guarda sólo una huella: si lo perdés, rotalo."
      footer={
        <div className="flex justify-end">
          <Button onClick={onClose}>Ya lo guardé</Button>
        </div>
      }
    >
      {secret && (
        <div className="space-y-3">
          <CopyField label="client_id" value={secret.client_id} />
          <CopyField label="client_secret" value={secret.client_secret} />
          <Callout tone="warning" icon={KeyRound}>
            Guardalo en el gestor de secretos del sistema que se integra, nunca en el navegador ni en un repositorio.
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

const EMPTY_FORM: FormState = { id: null, name: "", scopes: ["products:read"], rateLimit: "600" };

export function ApiSettings() {
  const { toast } = useToast();
  const { data: me, isLoading: meLoading } = useMyTenant();
  const isOwner = me?.role === "owner";
  const q = useApiClients(isOwner);
  const { rotate, revoke } = useApiClientMutations();
  const [form, setForm] = useState<FormState | null>(null);
  const [secret, setSecret] = useState<ApiClientWithSecret | null>(null);
  const [toRotate, setToRotate] = useState<ApiClientView | null>(null);
  const [toRevoke, setToRevoke] = useState<ApiClientView | null>(null);

  if (meLoading || (isOwner && q.isLoading)) return <SpinnerBlock className="py-16" />;
  if (!isOwner) {
    return (
      <Callout tone="info" icon={Lock} title="Sólo el dueño">
        Las credenciales de la API dan acceso a los datos del negocio: las crea y revoca el dueño.
      </Callout>
    );
  }
  if (q.error || !q.data) {
    return (
      <Callout tone="warning" icon={Lock} title="No disponible">
        {apiPublicaErrorMessage(q.error)}
      </Callout>
    );
  }

  const { feature, clients } = q.data;
  const active = clients.filter((c) => c.status === "active");

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
          <Button size="sm" onClick={() => setForm({ ...EMPTY_FORM })} disabled={!feature || active.length >= 10}>
            <Plus size={15} /> Nueva credencial
          </Button>
        }
      >
        {clients.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted-foreground">
            Todavía no hay credenciales. Creá una por cada sistema que se conecta.
          </p>
        ) : (
          clients.map((c) => (
            <ClientRow
              key={c.id}
              c={c}
              canWrite={feature}
              onEdit={() =>
                setForm({ id: c.id, name: c.name, scopes: c.scopes, rateLimit: String(c.rate_limit_per_min) })
              }
              onRotate={() => setToRotate(c)}
              onRevoke={() => setToRevoke(c)}
            />
          ))
        )}
      </SettingsCard>

      <SettingsCard title="Cómo se usa" padded>
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>
            Base: <code className="font-mono text-foreground">/api/v1</code>. Especificación OpenAPI en{" "}
            <a className="font-medium text-foreground underline" href="/api/openapi.json" target="_blank" rel="noreferrer">
              /api/openapi.json
            </a>
            .
          </p>
          <p>
            Productos en lote por SKU (hasta 500 por pedido, con Idempotency-Key), stock por sucursal con motivo,
            precios en lote, ventas por rango (sólo lectura) y clientes. Cada acción queda en la auditoría del negocio.
          </p>
        </div>
      </SettingsCard>

      {form && (
        <ClientForm
          open={form !== null}
          initial={form}
          onOpenChange={(o) => !o && setForm(null)}
          onCreated={(c) => setSecret(c)}
        />
      )}
      <SecretModal secret={secret} onClose={() => setSecret(null)} />

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
              setSecret(c);
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
ApiSettings.displayName = "ApiSettings";
