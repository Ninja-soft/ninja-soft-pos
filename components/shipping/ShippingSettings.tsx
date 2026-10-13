"use client";

import { useMemo, useState } from "react";
import { CheckCircle2, CircleAlert, Lock, PlugZap, Truck } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { SettingsCard } from "@/components/settings/Settings";
import { UpgradeModal } from "@/components/saas/UpgradeModal";
import {
  PLANNED_PROVIDER_NOTE,
  SHIPPING_MODULE_FEATURE,
  guideFor,
  missingRequired,
  shippingProviderFeature,
  splitConnectionValues,
} from "@/lib/shipping/providers";
import { shippingErrorMessage } from "@/lib/shipping/form";
import { useBranchContext } from "@/modules/branches/hooks";
import { useGating } from "@/modules/saas/gating";
import { useMyTenant } from "@/modules/tenants/hooks";
import { useShippingConnections, useShippingMutations, useShippingProviders } from "@/modules/shipping/hooks";
import type { ShippingConnection, ShippingProvider } from "@/modules/shipping/api";

// Configuración > Envíos (ADR-103). Conectar logísticas por negocio o por
// sucursal (la sucursal pisa al negocio, ADR-057), probar credenciales y ver
// qué hay que pedirle a cada carrier. Sólo dueño o encargado escriben; la
// Edge `shipping` lo exige igual (rol, sucursal y plan).

const ALL = "__tenant__";

function when(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" });
}

type Editing = { provider: ShippingProvider; storeId: string | null; current: ShippingConnection | null };

function ConnectModal({ editing, onClose }: { editing: Editing | null; onClose: () => void }) {
  const { toast } = useToast();
  const m = useShippingMutations();
  const provider = editing?.provider;
  const guide = provider ? guideFor(provider.key) : null;
  const initial = useMemo(() => {
    const v: Record<string, string> = {};
    for (const [k, val] of Object.entries(editing?.current?.config ?? {})) v[k] = String(val);
    return v;
  }, [editing]);
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [sandbox, setSandbox] = useState(editing?.current?.sandbox ?? true);
  const [enabled, setEnabled] = useState(editing?.current?.enabled ?? true);
  const [last, setLast] = useState(editing);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  if (editing !== last) {
    setLast(editing);
    setValues(initial);
    setSandbox(editing?.current?.sandbox ?? true);
    setEnabled(editing?.current?.enabled ?? true);
    setResult(null);
  }
  if (!editing || !provider || !guide) return null;
  const stored = editing.current?.secret_keys ?? [];
  const missing = missingRequired(provider.key, values, stored);
  const skeleton = provider.status !== "active";

  const body = () => {
    const { config, secrets } = splitConnectionValues(provider.key, values);
    return { provider_key: provider.key, store_id: editing.storeId, sandbox, enabled, config, secrets };
  };

  const test = () =>
    m.testConnection.mutate(body(), {
      onSuccess: (r) => setResult(r.ok ? { ok: true, text: r.detail ?? "Conexión correcta." } : { ok: false, text: r.error ?? "No conecta." }),
      onError: (e) => setResult({ ok: false, text: shippingErrorMessage(e) }),
    });

  const save = () =>
    m.saveConnection.mutate(body(), {
      onSuccess: () => {
        toast({ title: `${provider.name} guardado`, variant: "success" });
        onClose();
      },
      onError: (e) => toast({ title: shippingErrorMessage(e), variant: "error" }),
    });

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`${editing.current ? "Editar" : "Conectar"} ${provider.name}`}
      description={editing.storeId ? "Sólo para esta sucursal: pisa a la conexión del negocio." : "Para todo el negocio (las sucursales la heredan)."}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          {!skeleton && (
            <Button variant="secondary" onClick={test} loading={m.testConnection.isPending} disabled={missing.length > 0}>
              <PlugZap size={15} /> Probar
            </Button>
          )}
          <Button onClick={save} loading={m.saveConnection.isPending} disabled={!skeleton && missing.length > 0}>
            Guardar
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg bg-muted/50 p-3">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Qué tenés que pedir</p>
          <ol className="list-decimal space-y-1 pl-4 text-sm text-muted-foreground">
            {guide.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        </div>
        {guide.warning && (
          <Callout tone="warning" icon={CircleAlert}>
            {guide.warning}
          </Callout>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          {guide.fields.map((f) =>
            f.type === "select" ? (
              <Select
                key={f.key}
                label={f.label}
                value={values[f.key] ?? null}
                placeholder="Elegí"
                options={(f.options ?? []).map((o) => ({ value: o.value, label: o.label }))}
                onChange={(v) => setValues({ ...values, [f.key]: v })}
              />
            ) : (
              <Input
                key={f.key}
                label={f.label}
                type={f.secret ? "password" : "text"}
                autoComplete="off"
                hint={f.secret && stored.includes(f.key) ? "Cargada. Dejala vacía para no cambiarla." : f.hint}
                placeholder={f.secret && stored.includes(f.key) ? "••••••••" : f.placeholder}
                value={values[f.key] ?? ""}
                onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
              />
            ),
          )}
        </div>
        <div className="space-y-2">
          {provider.key !== "simulador" && (
            <Switch
              checked={sandbox}
              onCheckedChange={setSandbox}
              label={sandbox ? (guide.sandboxLabel ?? "Ambiente de prueba") : "Producción (envíos reales que se cobran)"}
            />
          )}
          <Switch checked={enabled} onCheckedChange={setEnabled} label={enabled ? "Activa" : "Apagada"} />
        </div>
        {missing.length > 0 && !skeleton && <p className="text-xs text-muted-foreground">Falta: {missing.join(", ")}.</p>}
        {result && (
          <Callout tone={result.ok ? "success" : "danger"} icon={result.ok ? CheckCircle2 : CircleAlert}>
            {result.text}
          </Callout>
        )}
      </div>
    </Modal>
  );
}

export function ShippingSettings() {
  const { toast } = useToast();
  const { data: me, isLoading: meLoading } = useMyTenant();
  const { data: gating } = useGating();
  const ctx = useBranchContext();
  const providers = useShippingProviders();
  const connections = useShippingConnections();
  const m = useShippingMutations();
  const [scope, setScope] = useState<string>(ALL);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [removing, setRemoving] = useState<ShippingConnection | null>(null);
  const [upgrade, setUpgrade] = useState<{ key: string; label: string } | null>(null);

  if (meLoading || providers.isLoading || connections.isLoading) return <SpinnerBlock className="py-16" />;
  if (providers.error || connections.error) {
    return (
      <Callout tone="warning" icon={CircleAlert} title="No disponible">
        {shippingErrorMessage(providers.error ?? connections.error)}
      </Callout>
    );
  }
  const canManage = Boolean(me?.canManage);
  const has = (k: string | null) => !k || Boolean(gating?.features[k]);
  const moduleOn = has(SHIPPING_MODULE_FEATURE);
  const multi = has("multi_sucursal") && ctx.allowed.length > 1;
  const storeId = scope === ALL ? null : scope;
  const list = providers.data ?? [];
  const conns = connections.data ?? [];
  const own = (key: string) => conns.find((c) => c.provider_key === key && (c.store_id ?? null) === storeId) ?? null;
  const inherited = (key: string) => (storeId ? (conns.find((c) => c.provider_key === key && c.store_id === null) ?? null) : null);

  const row = (p: ShippingProvider) => {
    const feature = shippingProviderFeature(p.key);
    const locked = !has(feature);
    const mine = own(p.key);
    const parent = inherited(p.key);
    const effective = mine ?? parent;
    const connected = p.key === "simulador" ? effective?.enabled !== false : Boolean(effective && effective.enabled && effective.secret_keys.length > 0);
    return (
      <div key={p.key} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{p.name}</span>
            {p.status === "skeleton" && <Badge tone="neutral">Próximamente</Badge>}
            {locked ? (
              <Badge tone="gold">
                <Lock size={12} className="mr-1 inline" /> Fuera de tu plan
              </Badge>
            ) : connected ? (
              <Badge tone="success">{mine ? "Conectada" : storeId ? "Heredada del negocio" : "Conectada"}</Badge>
            ) : effective && !effective.enabled ? (
              <Badge tone="neutral">Apagada</Badge>
            ) : p.status === "active" ? (
              <Badge tone="neutral">Sin conectar</Badge>
            ) : null}
            {effective && p.key !== "simulador" && <Badge tone={effective.sandbox ? "info" : "brand"}>{effective.sandbox ? "Prueba" : "Producción"}</Badge>}
          </div>
          <p className="text-xs text-muted-foreground">
            {[
              p.capabilities.quote && "cotiza",
              p.capabilities.label && `etiqueta ${p.label_formats.join(" y ").toUpperCase()}`,
              p.capabilities.points && "sucursales",
              p.capabilities.track && "seguimiento",
              p.capabilities.cancel ? "cancela por API" : "no cancela por API",
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          {mine?.last_test_at && (
            <p className="text-xs text-muted-foreground">
              Última prueba {when(mine.last_test_at)}: {mine.last_test_ok ? "correcta" : `falló (${mine.last_test_error ?? "sin detalle"})`}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {locked ? (
            <Button size="sm" variant="secondary" onClick={() => setUpgrade({ key: feature ?? SHIPPING_MODULE_FEATURE, label: p.name })}>
              Ver planes
            </Button>
          ) : (
            <>
              <Button size="sm" variant={mine ? "secondary" : "primary"} disabled={!canManage || !moduleOn} onClick={() => setEditing({ provider: p, storeId, current: mine })}>
                {mine ? "Editar" : storeId && parent ? "Configurar para esta sucursal" : "Conectar"}
              </Button>
              {mine && (
                <Button size="sm" variant="ghost" disabled={!canManage} onClick={() => setRemoving(mine)}>
                  Desconectar
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    );
  };

  const active = list.filter((p) => p.status === "active");
  const soon = list.filter((p) => p.status === "skeleton");
  const planned = list.filter((p) => p.status === "planned");

  return (
    <div className="space-y-5">
      {!moduleOn && (
        <Callout
          tone="warning"
          icon={Lock}
          title="Tu plan no incluye Envíos"
          actions={
            <Button size="sm" onClick={() => setUpgrade({ key: SHIPPING_MODULE_FEATURE, label: "Envíos y logística" })}>
              Ver planes
            </Button>
          }
        >
          Está desde el plan Pro. Podés mirar qué pide cada logística; conectar y crear envíos se habilita con el plan.
        </Callout>
      )}
      {!canManage && (
        <Callout tone="info" icon={Lock}>
          Las logísticas las conecta el dueño o un encargado.
        </Callout>
      )}
      {multi && (
        <div className="max-w-sm">
          <Select
            label="Alcance"
            value={scope}
            onChange={setScope}
            options={[
              { value: ALL, label: "Todo el negocio" },
              ...ctx.allowed.map((b) => ({ value: b.id, label: `Sucursal ${b.short_name || b.name}` })),
            ]}
            hint="Una sucursal puede tener su propio contrato o cuenta: pisa al del negocio."
          />
        </div>
      )}

      <SettingsCard title="Logísticas disponibles" description="Cotizan, generan la etiqueta y siguen el envío desde NinjaSoft." icon={Truck}>
        {active.map(row)}
      </SettingsCard>

      {soon.length > 0 && (
        <SettingsCard
          title="Próximamente"
          description="Podés dejar las credenciales cargadas: se activan cuando terminemos de validar su API con el carrier."
        >
          {soon.map(row)}
        </SettingsCard>
      )}

      {planned.length > 0 && (
        <SettingsCard title="Sin integración directa todavía" padded>
          <p className="text-sm text-muted-foreground">{planned.map((p) => p.name).join(", ")}.</p>
          <p className="mt-2 text-sm text-muted-foreground">{PLANNED_PROVIDER_NOTE}</p>
        </SettingsCard>
      )}

      <ConnectModal editing={editing} onClose={() => setEditing(null)} />

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title="Desconectar la logística"
        description="Se borran las credenciales guardadas. Los envíos ya creados siguen visibles, pero su seguimiento usa la conexión del negocio si la hay."
        confirmLabel="Desconectar"
        danger
        loading={m.deleteConnection.isPending}
        onConfirm={() => {
          if (!removing) return;
          m.deleteConnection.mutate(removing.id, {
            onSuccess: () => {
              setRemoving(null);
              toast({ title: "Logística desconectada", variant: "success" });
            },
            onError: (e) => toast({ title: shippingErrorMessage(e), variant: "error" }),
          });
        }}
      />

      {upgrade && (
        <UpgradeModal open onOpenChange={(o) => !o && setUpgrade(null)} featureKey={upgrade.key} featureLabel={upgrade.label} />
      )}
    </div>
  );
}
ShippingSettings.displayName = "ShippingSettings";
