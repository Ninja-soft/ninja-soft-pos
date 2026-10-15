"use client";

import { useMemo, useState } from "react";
import { Copy, KeyRound, Link2, Lock, Plug, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { CredentialInput } from "@/components/ui/CredentialInput";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { Select } from "@/components/ui/Select";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { useStores } from "@/modules/stock/hooks";
import { useMyTenant } from "@/modules/tenants/hooks";
import {
  CHANNEL_LABELS,
  channelErrorMessage,
  webhookUrl,
  type ChannelConnection,
  type ChannelProvider,
} from "@/modules/deliveryChannels/api";
import {
  useChannelConnections,
  useChannelEvents,
  useChannelMutations,
  useChannelOutbox,
  useChannelProviders,
  useChannelsAccess,
  useCredentialKeys,
} from "@/modules/deliveryChannels/hooks";
import { ChannelMapping } from "./ChannelMapping";
import { SimulatorPanel } from "./SimulatorPanel";

const STATUS_TONE: Record<ChannelConnection["status"], BadgeTone> = {
  activa: "success",
  pausada: "neutral",
  pendiente: "warning",
  error: "danger",
};
const STATUS_LABEL: Record<ChannelConnection["status"], string> = {
  activa: "Activa",
  pausada: "Pausada",
  pendiente: "Pendiente de alta",
  error: "Con error",
};

const fmtDate = (s: string | null) =>
  s ? new Date(s).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "nunca";

// Configuración > Canales de delivery (ADR-102): conectar PedidosYa, Rappi,
// Uber Eats, Mercado Pago Delivery o el simulador por sucursal, auto-aceptar,
// tiempo de preparación, facturación automática o manual, credenciales (sólo
// escritura), mapeo de productos y simulador. Dueño o encargado.
export function ChannelsSettings() {
  const access = useChannelsAccess();
  const { data: me } = useMyTenant();
  const conns = useChannelConnections(access.enabled);
  const [newOpen, setNewOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);

  if (!access.ready || (access.enabled && conns.isLoading)) return <SpinnerBlock className="py-16" />;
  if (access.locked) {
    return (
      <Callout tone="warning" icon={Lock} title="Tu plan no incluye los canales de delivery">
        Los pedidos de PedidosYa, Rappi y Uber Eats entrando solos al tablero y a la cocina están en los planes Pro,
        Business y Enterprise.
      </Callout>
    );
  }
  if (me && !me.canManage) {
    return (
      <Callout tone="neutral" icon={Lock} title="Sólo el dueño o un encargado">
        Los pedidos de las apps se atienden desde Delivery. La configuración de los canales la hace el dueño o un encargado.
      </Callout>
    );
  }

  const list = conns.data ?? [];
  const active = list.find((c) => c.id === activeId) ?? list[0] ?? null;

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-5 sm:flex-row sm:items-center sm:justify-between">
        <p className="min-w-0 text-sm text-muted-foreground">
          Los pedidos de las apps entran solos al tablero de Delivery, mandan la comanda a cocina, se facturan con tu
          facturación electrónica y muestran al repartidor. Mientras tramitás el alta con cada app, probalo todo con el
          simulador.
        </p>
        <Button size="sm" onClick={() => setNewOpen(true)} className="shrink-0">
          <Plus size={16} /> Conectar canal
        </Button>
      </div>

      {list.length === 0 ? (
        <Callout tone="brand" icon={Plug} title="Todavía no conectaste ningún canal">
          Empezá por el simulador: conectalo a una sucursal y mandá un pedido de prueba de PedidosYa, Rappi o Uber Eats.
        </Callout>
      ) : (
        <>
          {list.length > 1 && (
            <div className="flex flex-wrap gap-2">
              {list.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setActiveId(c.id)}
                  className={
                    "rounded-lg border px-3 py-1.5 text-sm font-medium transition " +
                    (active?.id === c.id
                      ? "border-ninja-flameSoft bg-ninja-flame/10 text-foreground"
                      : "border-border bg-card text-muted-foreground hover:text-foreground")
                  }
                >
                  {c.label || CHANNEL_LABELS[c.provider]}
                </button>
              ))}
            </div>
          )}
          {active && <ConnectionPanel key={active.id} conn={active} />}
        </>
      )}

      <ConnectModal open={newOpen} onOpenChange={setNewOpen} onCreated={(id) => setActiveId(id)} />
    </div>
  );
}

function ConnectionPanel({ conn }: { conn: ChannelConnection }) {
  const [tab, setTab] = useState<"config" | "mapeo" | "simulador" | "actividad">(
    conn.provider === "simulador" ? "simulador" : "config",
  );
  const { data: stores } = useStores();
  const storeName = stores?.find((s) => s.id === conn.store_id)?.name ?? "Sucursal";

  return (
    <div className="space-y-4 rounded-lg border border-border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-bold text-foreground">{conn.label || CHANNEL_LABELS[conn.provider]}</h3>
            <Badge tone={STATUS_TONE[conn.status]}>{STATUS_LABEL[conn.status]}</Badge>
            <Badge tone="neutral">{CHANNEL_LABELS[conn.provider]}</Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {storeName} · local en la app {conn.external_store_id} · último pedido {fmtDate(conn.last_event_at)}
          </p>
        </div>
      </div>
      {conn.last_error && (
        <Callout tone="warning" title="Último error con la app">
          {conn.last_error} ({fmtDate(conn.last_error_at)})
        </Callout>
      )}

      <Segmented scrollOnMobile
        value={tab}
        onChange={setTab}
        aria-label="Sección del canal"
        options={[
          ...(conn.provider === "simulador" ? [{ value: "simulador" as const, label: "Simular" }] : []),
          { value: "config", label: "Configuración" },
          { value: "mapeo", label: "Productos" },
          { value: "actividad", label: "Actividad" },
        ]}
      />

      {tab === "config" && <ConnectionConfig conn={conn} />}
      {tab === "mapeo" && <ChannelMapping conn={conn} />}
      {tab === "simulador" && conn.provider === "simulador" && <SimulatorPanel conn={conn} />}
      {tab === "actividad" && <ConnectionActivity conn={conn} />}
    </div>
  );
}

function ConnectionConfig({ conn }: { conn: ChannelConnection }) {
  const { toast } = useToast();
  const { update, disconnect } = useChannelMutations();
  const { data: stores } = useStores();
  const [prep, setPrep] = useState(String(conn.default_prep_minutes));
  const [commission, setCommission] = useState(String(conn.commission_pct));
  const [extStore, setExtStore] = useState(conn.external_store_id);
  const [confirmOff, setConfirmOff] = useState(false);

  const save = (patch: Record<string, unknown>, ok = "Guardado") =>
    update.mutate(
      { id: conn.id, patch },
      {
        onSuccess: () => toast({ title: ok, variant: "success" }),
        onError: (e) => toast({ title: "No se pudo guardar", description: channelErrorMessage(e), variant: "error" }),
      },
    );

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Row label="Recibir pedidos" hint="Pausada: la app no debería mandar pedidos (pausá también el local en la app).">
          <Switch
            checked={conn.status === "activa"}
            onCheckedChange={(v) => save({ status: v ? "activa" : "pausada" }, v ? "Canal activo" : "Canal pausado")}
            label="Recibir pedidos"
          />
        </Row>
        <Row
          label="Aceptar solos"
          hint="El pedido va directo a cocina y se le confirma a la app con el tiempo de preparación por defecto."
        >
          <Switch
            checked={conn.auto_accept}
            disabled={conn.flow === "indirecto"}
            onCheckedChange={(v) => save({ auto_accept: v })}
            label="Aceptar solos"
          />
        </Row>
        <Select
          label="Sucursal"
          value={conn.store_id}
          options={(stores ?? []).map((s) => ({ value: s.id, label: s.name }))}
          onChange={(v) => save({ store_id: v })}
        />
        <Select
          label="Cómo se aceptan"
          value={conn.flow}
          options={[
            { value: "directo", label: "Desde NinjaSoft", description: "Aceptás, rechazás y avisás listo desde el tablero." },
            { value: "indirecto", label: "Desde la tablet de la app", description: "Llegan sólo pedidos ya aceptados." },
          ]}
          onChange={(v) => save({ flow: v })}
        />
        <Select
          label="Facturación"
          value={conn.billing_mode}
          options={[
            { value: "auto", label: "Automática", description: "Se factura sola al retirarse o entregarse, en tu turno." },
            { value: "manual", label: "Manual", description: "Queda a facturar y la cajera toca Facturar." },
          ]}
          onChange={(v) => save({ billing_mode: v })}
        />
        <div className="flex items-end gap-2">
          <Input
            label="Tiempo de preparación por defecto (min)"
            inputMode="numeric"
            value={prep}
            onChange={(e) => setPrep(e.target.value.replace(/\D/g, "").slice(0, 3))}
          />
          <Button
            variant="secondary"
            size="sm"
            className="mb-1"
            disabled={!prep || Number(prep) < 1 || Number(prep) > 180}
            onClick={() => save({ default_prep_minutes: Number(prep) })}
          >
            Guardar
          </Button>
        </div>
        <div className="flex items-end gap-2">
          <Input
            label="Comisión estimada de la app (%)"
            inputMode="decimal"
            hint="Para comparar con la liquidación. La real la informa la app."
            value={commission}
            onChange={(e) => setCommission(e.target.value.replace(/[^\d.,]/g, "").replace(",", ".").slice(0, 6))}
          />
          <Button
            variant="secondary"
            size="sm"
            className="mb-6"
            disabled={commission === "" || Number(commission) < 0 || Number(commission) > 100}
            onClick={() => save({ commission_pct: Number(commission) })}
          >
            Guardar
          </Button>
        </div>
        {conn.provider !== "simulador" && (
          <div className="flex items-end gap-2">
            <Input label="Id del local en la app" value={extStore} onChange={(e) => setExtStore(e.target.value.slice(0, 120))} />
            <Button
              variant="secondary"
              size="sm"
              className="mb-1"
              disabled={!extStore.trim() || extStore === conn.external_store_id}
              onClick={() => save({ external_store_id: extStore.trim() })}
            >
              Guardar
            </Button>
          </div>
        )}
      </div>

      <WebhookAndCredentials conn={conn} />

      <div className="flex justify-end">
        <Button variant="ghost" size="sm" onClick={() => setConfirmOff(true)}>
          <Trash2 size={15} /> Desconectar
        </Button>
      </div>
      <ConfirmDialog
        open={confirmOff}
        onOpenChange={setConfirmOff}
        title="Desconectar el canal"
        description="Los pedidos ya recibidos quedan en el tablero. La app deja de poder mandar pedidos a esta conexión y lo pendiente de enviar se descarta."
        confirmLabel="Desconectar"
        danger
        withReason
        reasonLabel="Motivo (opcional)"
        loading={disconnect.isPending}
        onConfirm={(reason) =>
          disconnect.mutate(
            { id: conn.id, reason: reason || null },
            {
              onSuccess: () => {
                setConfirmOff(false);
                toast({ title: "Canal desconectado", variant: "success" });
              },
              onError: (e) => toast({ title: "No se pudo desconectar", description: channelErrorMessage(e), variant: "error" }),
            },
          )
        }
      />
    </div>
  );
}

function WebhookAndCredentials({ conn }: { conn: ChannelConnection }) {
  const { toast } = useToast();
  const keys = useCredentialKeys(conn.id);
  const { setCredentials } = useChannelMutations();
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [whSecret, setWhSecret] = useState("");
  const url = webhookUrl(conn.id);
  const saved = new Set(keys.data?.keys ?? []);

  const copy = () => {
    void navigator.clipboard?.writeText(url).then(
      () => toast({ title: "URL copiada", variant: "success" }),
      () => undefined,
    );
  };

  return (
    <div className="space-y-3 rounded-lg border border-border p-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <Link2 size={16} /> Webhook y credenciales
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-3 py-2 font-mono text-xs text-foreground">{url}</code>
        <Button variant="secondary" size="sm" onClick={copy}>
          <Copy size={14} /> Copiar
        </Button>
      </div>
      {conn.provider === "simulador" ? (
        <p className="text-xs text-muted-foreground">
          El simulador firma cada pedido con un secreto que generó NinjaSoft y que nunca sale del servidor.
        </p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            Pasale esta URL a {CHANNEL_LABELS[conn.provider]} cuando te habiliten la integración. Las credenciales se guardan
            cifradas del lado del servidor y no se vuelven a mostrar.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <CredentialInput
              label="Client id / usuario"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              configured={saved.has("client_id")}
              optional
            />
            <CredentialInput
              label="Client secret / clave"
              secret
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              configured={saved.has("client_secret")}
              optional
            />
            <CredentialInput
              label="Secreto de firma del webhook"
              secret
              value={whSecret}
              onChange={(e) => setWhSecret(e.target.value)}
              configured={keys.data?.has_webhook_secret}
              optional
            />
          </div>
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="secondary"
              loading={setCredentials.isPending}
              disabled={!clientId && !clientSecret && !whSecret}
              onClick={() => {
                const creds: Record<string, unknown> = {};
                if (clientId) creds.client_id = clientId.trim();
                if (clientSecret) creds.client_secret = clientSecret.trim();
                if (whSecret) creds.webhook_secret = whSecret.trim();
                setCredentials.mutate(
                  { id: conn.id, credentials: creds },
                  {
                    onSuccess: () => {
                      setClientId("");
                      setClientSecret("");
                      setWhSecret("");
                      void keys.refetch();
                      toast({ title: "Credenciales guardadas", variant: "success" });
                    },
                    onError: (e) => toast({ title: "No se guardaron", description: channelErrorMessage(e), variant: "error" }),
                  },
                );
              }}
            >
              <KeyRound size={14} /> Guardar credenciales
            </Button>
          </div>
          <Callout tone="info" title="Adaptador en preparación">
            La conexión con {CHANNEL_LABELS[conn.provider]} queda lista del lado de NinjaSoft; los pedidos reales entran cuando la
            app apruebe la integración y termine la homologación. Mirá qué tramitar en la ayuda de Canales de delivery.
          </Callout>
        </>
      )}
    </div>
  );
}

const OUTBOX_ACTION: Record<string, string> = {
  accept: "Aceptar",
  reject: "Rechazar",
  mark_ready: "Listo",
  mark_picked_up: "Retirado",
  sync_menu: "Menú",
  toggle_store: "Pausar local",
};
const OUTBOX_TONE: Record<string, BadgeTone> = {
  ok: "success",
  pendiente: "warning",
  enviando: "info",
  error: "danger",
  descartado: "neutral",
};

function ConnectionActivity({ conn }: { conn: ChannelConnection }) {
  const { toast } = useToast();
  const outbox = useChannelOutbox(conn.id);
  const events = useChannelEvents(conn.id);
  const { retryOutbox, flush } = useChannelMutations();

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-foreground">Avisos a la app</h4>
        <Button
          variant="secondary"
          size="sm"
          loading={flush.isPending}
          onClick={() =>
            flush.mutate(undefined, {
              onError: (e) => toast({ title: "No se pudo enviar", description: channelErrorMessage(e), variant: "error" }),
            })
          }
        >
          <RefreshCw size={14} /> Enviar ahora
        </Button>
      </div>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {(outbox.data ?? []).map((o) => (
          <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
            <span className="flex items-center gap-2">
              <Badge tone={OUTBOX_TONE[o.status] ?? "neutral"}>{o.status}</Badge>
              <span className="font-medium">{OUTBOX_ACTION[o.action] ?? o.action}</span>
              <span className="text-xs text-muted-foreground">
                {fmtDate(o.created_at)} · intento {o.attempts}/{o.max_attempts}
              </span>
            </span>
            <span className="flex items-center gap-2">
              {o.last_error && <span className="max-w-[18rem] truncate text-xs text-danger">{o.last_error}</span>}
              {(o.status === "error" || o.status === "descartado") && (
                <Button variant="ghost" size="sm" onClick={() => retryOutbox.mutate(o.id)}>
                  Reintentar
                </Button>
              )}
            </span>
          </li>
        ))}
        {(outbox.data ?? []).length === 0 && <li className="px-3 py-4 text-center text-xs text-muted-foreground">Sin avisos todavía</li>}
      </ul>

      <h4 className="text-sm font-semibold text-foreground">Lo que mandó la app</h4>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {(events.data ?? []).map((e) => (
          <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
            <span className="flex items-center gap-2">
              <Badge tone={e.status === "procesado" ? "success" : e.status === "error" ? "danger" : "neutral"}>{e.status}</Badge>
              <span className="font-medium">{e.event_type}</span>
              <span className="text-xs text-muted-foreground">
                {e.external_order_id ?? ""} · {e.source} · {fmtDate(e.received_at)}
              </span>
            </span>
            {e.error && <span className="max-w-[18rem] truncate text-xs text-danger">{e.error}</span>}
          </li>
        ))}
        {(events.data ?? []).length === 0 && <li className="px-3 py-4 text-center text-xs text-muted-foreground">Sin eventos todavía</li>}
      </ul>
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{label}</p>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

function ConnectModal({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const { toast } = useToast();
  const providers = useChannelProviders();
  const { data: stores } = useStores();
  const { connect } = useChannelMutations();
  const [provider, setProvider] = useState<ChannelProvider>("simulador");
  const [storeId, setStoreId] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [extStore, setExtStore] = useState("");
  const [autoAccept, setAutoAccept] = useState(false);
  const [billing, setBilling] = useState<"auto" | "manual">("manual");
  const [prep, setPrep] = useState("20");

  const info = useMemo(() => (providers.data ?? []).find((p) => p.key === provider), [providers.data, provider]);
  const store = storeId ?? stores?.[0]?.id ?? null;
  const needsExt = provider !== "simulador";

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Conectar canal de delivery"
      description="Una conexión por app y sucursal."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            loading={connect.isPending}
            disabled={!store || (needsExt && !extStore.trim()) || !prep || Number(prep) < 1 || Number(prep) > 180}
            onClick={() =>
              connect.mutate(
                {
                  provider,
                  storeId: store!,
                  label: label.trim() || null,
                  externalStoreId: needsExt ? extStore.trim() : null,
                  settings: {
                    flow: info?.default_flow ?? "directo",
                    auto_accept: autoAccept,
                    billing_mode: billing,
                    default_prep_minutes: Number(prep),
                  },
                },
                {
                  onSuccess: (id) => {
                    onOpenChange(false);
                    onCreated(id);
                    toast({ title: "Canal conectado", variant: "success" });
                  },
                  onError: (e) => toast({ title: "No se pudo conectar", description: channelErrorMessage(e), variant: "error" }),
                },
              )
            }
          >
            Conectar
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <Select
          label="App"
          value={provider}
          options={(providers.data ?? []).map((p) => ({
            value: p.key,
            label: p.name,
            description: p.is_available ? "Disponible" : "Esperando el alta con la app",
          }))}
          onChange={(v) => setProvider(v)}
        />
        <Select
          label="Sucursal"
          value={store}
          options={(stores ?? []).map((s) => ({ value: s.id, label: s.name }))}
          onChange={(v) => setStoreId(v)}
        />
        <Input label="Nombre (opcional)" value={label} onChange={(e) => setLabel(e.target.value.slice(0, 80))} />
        {needsExt && (
          <Input
            label="Id del local en la app"
            hint="Te lo da la app al habilitar la integración (vendor o store id)."
            value={extStore}
            onChange={(e) => setExtStore(e.target.value.slice(0, 120))}
          />
        )}
        {info && !info.is_available && (
          <Callout tone="info" title="Adaptador en preparación">
            Podés dejar la conexión creada; los pedidos reales entran cuando {info.name} habilite la integración.
          </Callout>
        )}
        <Row label="Aceptar solos" hint="Sin tocar nada: comanda a cocina y aviso a la app.">
          <Switch checked={autoAccept} onCheckedChange={setAutoAccept} label="Aceptar solos" />
        </Row>
        <Select
          label="Facturación"
          value={billing}
          options={[
            { value: "manual", label: "Manual" },
            { value: "auto", label: "Automática al retirar o entregar" },
          ]}
          onChange={(v) => setBilling(v)}
        />
        <Input
          label="Tiempo de preparación por defecto (min)"
          inputMode="numeric"
          value={prep}
          onChange={(e) => setPrep(e.target.value.replace(/\D/g, "").slice(0, 3))}
        />
      </div>
    </Modal>
  );
}
