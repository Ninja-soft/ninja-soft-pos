"use client";

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CreditCard, Pencil, Plug, Plus, QrCode, Star, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { SettingsCard } from "@/components/settings/Settings";
import { BranchDot } from "@/components/branches/BranchSwitcher";
import {
  TERMINAL_KIND_LABEL,
  kindForProvider,
  lastSeenLabel,
  terminalExternalIdError,
  type PaymentTerminal,
  type TerminalKind,
} from "@/lib/payments/terminals";
import { useBranchContext, useBranchScope } from "@/modules/branches/hooks";
import { branchLabel } from "@/modules/branches/logic";
import { terminalErrorMessage, type TerminalInput } from "@/modules/config/api";
import { usePaymentTerminals, useTerminalMutations } from "@/modules/config/hooks";
import { posApi } from "@/modules/pos/api";
import { useFeature } from "@/modules/saas/gating";
import {
  DEFAULT_INTEGRATION,
  INTEGRATED_PROVIDERS,
  isIntegratedKind,
  parseIntegration,
  withIntegration,
  type IntegrationConfig,
} from "@/lib/payments/terminal/config";
import { providerLabel } from "./ScopedConfig";
import { IntegratedTerminalFields } from "./IntegratedTerminalFields";
import { TerminalDeviceModal } from "./TerminalDeviceModal";

// =============================================================================
// Terminales de cobro por sucursal y caja (F17 · H93, ADR-049). BASE.
//
// Registro de los Point de Mercado Pago, Nave Point, Clover, cajas QR de
// Mercado Pago y posnets sin integrar: sucursal, caja (o flotante en la
// sucursal), id del proveedor, n° de comercio y default de la caja. El POS
// elige la de su caja sola; las Edges validan en el servidor que la terminal
// sea del negocio y de esa sucursal.
// =============================================================================

const PROVIDERS: { key: string; hint: string }[] = [
  { key: "mercadopago_point", hint: "Device id del lector (se ve en la app de Mercado Pago o con Detectar)." },
  { key: "nave_point", hint: "ID de punto de venta de la terminal en Nave." },
  { key: "fiserv_point", hint: "Número de serie de la terminal Clover." },
  { key: "mercadopago", hint: "Caja QR de Mercado Pago (external_pos_id). Mejor crearla con el botón de la caja." },
  { key: "payway", hint: "Posnet o pinpad Payway, sin integrar o integrado a la caja." },
  { key: "fiserv", hint: "Posnet o Clover sin integrar, o posnet integrado a la caja." },
  { key: "getnet", hint: "Posnet Getnet, sin integrar o integrado a la caja." },
];

const canIntegrate = (provider: string) => (INTEGRATED_PROVIDERS as readonly string[]).includes(provider);

type Draft = {
  id?: string;
  store_id: string;
  cash_register_id: string | null;
  provider_key: string;
  /** Tipo (sólo se elige en marcas que admiten terminal integrada, ADR-053). */
  kind: TerminalKind;
  integration: IntegrationConfig;
  meta: Record<string, unknown> | null;
  external_id: string;
  environment: "prod" | "test" | null;
  label: string;
  merchant_number: string;
  acquirer: string;
  is_default: boolean;
  active: boolean;
  notes: string;
};

export function TerminalsManager() {
  const ctx = useBranchContext();
  const scope = useBranchScope();
  const { data: terminals, isLoading } = usePaymentTerminals();
  const mut = useTerminalMutations();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [archive, setArchive] = useState<PaymentTerminal | null>(null);
  const [qrFor, setQrFor] = useState<string | null>(null);
  const [connectFor, setConnectFor] = useState<PaymentTerminal | null>(null);
  const integratedAllowed = useFeature("terminal_integrada") !== false;
  const canManage = scope.data?.role === "owner" || scope.data?.role === "manager";

  const byStore = useMemo(() => {
    const m = new Map<string, PaymentTerminal[]>();
    for (const t of terminals ?? []) m.set(t.store_id, [...(m.get(t.store_id) ?? []), t]);
    return m;
  }, [terminals]);

  const newDraft = (storeId: string, registerId: string | null = null): Draft => ({
    store_id: storeId,
    cash_register_id: registerId,
    provider_key: "mercadopago_point",
    kind: "point",
    integration: DEFAULT_INTEGRATION,
    meta: null,
    external_id: "",
    environment: null,
    label: "",
    merchant_number: "",
    acquirer: "",
    is_default: Boolean(registerId),
    active: true,
    notes: "",
  });

  const save = () => {
    if (!draft) return;
    const kind: TerminalKind = canIntegrate(draft.provider_key) ? draft.kind : kindForProvider(draft.provider_key);
    const integrated = isIntegratedKind(kind);
    // El simulador no tiene n° de terminal real: se le pone uno propio.
    const externalId =
      integrated && !draft.external_id.trim() && draft.integration.adapter === "simulator"
        ? `SIM-${Math.random().toString(36).slice(2, 8).toUpperCase()}`
        : draft.external_id;
    if (integrated && !externalId.trim()) return toast({ title: "Cargá el n° de terminal", variant: "error" });
    const err = terminalExternalIdError(kind, externalId);
    if (err) return toast({ title: err, variant: "error" });
    if (!draft.label.trim()) return toast({ title: "Poné un nombre (ej. Point mostrador)", variant: "error" });
    const input: TerminalInput = {
      store_id: draft.store_id,
      cash_register_id: draft.cash_register_id,
      provider_key: draft.provider_key,
      kind,
      external_id: externalId.trim() || null,
      ...(integrated
        ? { external_meta: withIntegration(draft.meta, parseIntegration({ integration: draft.integration })) }
        : {}),
      environment: kind === "qr_caja" ? (draft.environment ?? "prod") : null,
      label: draft.label.trim(),
      merchant_number: draft.merchant_number.replace(/[^0-9a-z]/gi, "").slice(0, 20) || null,
      acquirer: draft.acquirer.trim() || null,
      is_default: draft.is_default && Boolean(draft.cash_register_id),
      active: draft.active,
      notes: draft.notes.trim() || null,
    };
    const done = {
      onSuccess: () => {
        toast({ title: "Terminal guardada", variant: "success" });
        setDraft(null);
      },
      onError: (e: unknown) => toast({ title: terminalErrorMessage(e), variant: "error" }),
    };
    if (draft.id) mut.update.mutate({ id: draft.id, patch: input }, done);
    else mut.create.mutate(input, done);
  };

  const branches = ctx.allowed;
  const storeOf = (id: string) => ctx.all.find((b) => b.id === id);
  const registersOf = (storeId: string) => (storeOf(storeId)?.registers ?? []).filter((r) => !r.deleted_at);

  // Caja QR de MP propia de una caja: usa la dirección de la sucursal.
  const createQrFor = async (registerId: string) => {
    const store = ctx.all.find((b) => b.registers.some((r) => r.id === registerId));
    const m = (store?.address ?? "").match(/^(.*?)\s+(\d+)\b/);
    if (!store || !m || !store.city || !store.province) {
      toast({
        title: "Completá la dirección de la sucursal",
        description: "Calle con número, ciudad y provincia en Sucursales y cajas: Mercado Pago las pide para la caja QR.",
        variant: "error",
      });
      return;
    }
    setQrFor(registerId);
    try {
      await posApi.mpQrSetup({
        name: store.name,
        street_name: m[1]!.trim(),
        street_number: m[2]!,
        city_name: store.city,
        state_name: store.province,
        cash_register_id: registerId,
      });
      toast({ title: "Caja QR creada para la caja", variant: "success" });
      await qc.invalidateQueries({ queryKey: ["payment-terminals"] });
    } catch (e) {
      toast({
        title: "No se pudo crear la caja QR",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    } finally {
      setQrFor(null);
    }
  };

  if (isLoading) return null;
  return (
    <div className="space-y-4">
      <Callout tone="info" icon={CreditCard}>
        El POS usa la terminal de su caja sin preguntar. Si una caja tiene varias, la marcada con la estrella es
        la que se elige primero; las terminales sin caja sirven para toda la sucursal.
      </Callout>
      {branches.map((b) => {
        const list = byStore.get(b.id) ?? [];
        return (
          <SettingsCard
            key={b.id}
            title={
              <span className="flex items-center gap-2">
                <BranchDot branch={b} /> {branchLabel(b)}
              </span>
            }
            description={list.length === 0 ? "Sin terminales registradas" : `${list.length} terminal${list.length > 1 ? "es" : ""}`}
            actions={
              canManage ? (
                <Button size="sm" variant="secondary" onClick={() => setDraft(newDraft(b.id))}>
                  <Plus size={14} /> Agregar terminal
                </Button>
              ) : undefined
            }
          >
            {[null, ...registersOf(b.id).map((r) => r.id)].map((regId) => {
              const rows = list.filter((t) => (t.cash_register_id ?? null) === regId);
              const reg = regId ? registersOf(b.id).find((r) => r.id === regId) : null;
              if (!regId && rows.length === 0) return null;
              return (
                <div key={regId ?? "store"} className="px-5 py-3">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {reg ? reg.name : "Toda la sucursal"}
                    </p>
                    {reg && canManage && (
                      <span className="flex gap-1">
                        <Button size="sm" variant="ghost" onClick={() => setDraft(newDraft(b.id, reg.id))}>
                          <Plus size={13} /> Terminal
                        </Button>
                        <Button size="sm" variant="ghost" disabled={qrFor === reg.id} onClick={() => createQrFor(reg.id)}>
                          <QrCode size={13} /> {qrFor === reg.id ? "Creando" : "Caja QR propia"}
                        </Button>
                      </span>
                    )}
                  </div>
                  {rows.length === 0 ? (
                    <p className="text-sm text-muted-foreground">Usa las terminales de la sucursal.</p>
                  ) : (
                    <ul className="space-y-2">
                      {rows.map((t) => (
                        <li key={t.id} className="flex flex-col gap-2 rounded-lg bg-muted/40 p-3 sm:flex-row sm:items-center sm:justify-between">
                          <div className="min-w-0">
                            <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                              {t.is_default && <Star size={13} className="fill-current text-warning" aria-label="Default de la caja" />}
                              {t.label}
                              {!t.active && <Badge tone="warning">Pausada</Badge>}
                              {t.environment === "test" && <Badge tone="info">Prueba</Badge>}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {providerLabel(t.provider_key)} · {TERMINAL_KIND_LABEL[t.kind]}
                              {t.external_id ? ` · ${t.external_id}` : ""}
                              {t.merchant_number ? ` · Comercio ${t.merchant_number}` : ""} · {lastSeenLabel(t.last_seen_at)}
                            </p>
                          </div>
                          {canManage && (
                            <span className="flex shrink-0 gap-1">
                              {isIntegratedKind(t.kind) && (
                                <Button size="sm" variant="ghost" onClick={() => setConnectFor(t)}>
                                  <Plug size={13} /> Conectar
                                </Button>
                              )}
                              {t.cash_register_id && !t.is_default && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => mut.update.mutate({ id: t.id, patch: { is_default: true } })}
                                >
                                  <Star size={13} /> Default
                                </Button>
                              )}
                              <Button
                                size="sm"
                                variant="ghost"
                                aria-label={`Editar ${t.label}`}
                                onClick={() =>
                                  setDraft({
                                    id: t.id,
                                    store_id: t.store_id,
                                    cash_register_id: t.cash_register_id,
                                    provider_key: t.provider_key,
                                    kind: t.kind,
                                    integration: parseIntegration(t.external_meta),
                                    meta: t.external_meta ?? null,
                                    external_id: t.external_id ?? "",
                                    environment: t.environment,
                                    label: t.label,
                                    merchant_number: t.merchant_number ?? "",
                                    acquirer: t.acquirer ?? "",
                                    is_default: t.is_default,
                                    active: t.active,
                                    notes: t.notes ?? "",
                                  })
                                }
                              >
                                <Pencil size={13} />
                              </Button>
                              <Button size="sm" variant="ghost" aria-label={`Archivar ${t.label}`} onClick={() => setArchive(t)}>
                                <Trash2 size={13} />
                              </Button>
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </SettingsCard>
        );
      })}

      <Modal
        open={Boolean(draft)}
        onOpenChange={(o) => !o && setDraft(null)}
        title={draft?.id ? "Editar terminal" : "Nueva terminal"}
        className="max-w-lg"
      >
        {draft && (
          <div className="space-y-3">
            <label className="block text-sm">
              <span className="mb-1 block font-medium">Medio</span>
              <select
                className="h-11 w-full rounded-lg border border-border bg-card px-3 text-sm"
                value={draft.provider_key}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    provider_key: e.target.value,
                    kind: kindForProvider(e.target.value),
                    integration: { ...DEFAULT_INTEGRATION },
                  })
                }
                disabled={Boolean(draft.id)}
              >
                {PROVIDERS.map((p) => (
                  <option key={p.key} value={p.key}>
                    {providerLabel(p.key)} ({TERMINAL_KIND_LABEL[kindForProvider(p.key)]})
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-xs text-muted-foreground">
                {PROVIDERS.find((p) => p.key === draft.provider_key)?.hint}
              </span>
            </label>
            {canIntegrate(draft.provider_key) && (
              <label className="block text-sm">
                <span className="mb-1 block font-medium">Tipo</span>
                <select
                  className="h-11 w-full rounded-lg border border-border bg-card px-3 text-sm"
                  value={draft.kind}
                  onChange={(e) => {
                    const kind = e.target.value as TerminalKind;
                    setDraft({
                      ...draft,
                      kind,
                      integration:
                        isIntegratedKind(kind) && draft.integration.adapter === "simulator" && !draft.id
                          ? { ...DEFAULT_INTEGRATION, adapter: "simulator" }
                          : draft.integration,
                    });
                  }}
                >
                  <option value="posnet_manual">{TERMINAL_KIND_LABEL.posnet_manual}</option>
                  <option value="posnet_integrado" disabled={!integratedAllowed && draft.kind !== "posnet_integrado"}>
                    {TERMINAL_KIND_LABEL.posnet_integrado} (cobra y completa el cupón)
                  </option>
                  <option value="pinpad" disabled={!integratedAllowed && draft.kind !== "pinpad"}>
                    {TERMINAL_KIND_LABEL.pinpad} conectado a la PC
                  </option>
                </select>
                {!integratedAllowed && (
                  <span className="mt-1 block text-xs text-muted-foreground">
                    La terminal integrada viene desde el plan Pro.
                  </span>
                )}
              </label>
            )}
            {canIntegrate(draft.provider_key) && isIntegratedKind(draft.kind) && (
              <IntegratedTerminalFields
                provider={draft.provider_key}
                value={draft.integration}
                onChange={(integration) => setDraft({ ...draft, integration })}
              />
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-sm">
                <span className="mb-1 block font-medium">Sucursal</span>
                <select
                  className="h-11 w-full rounded-lg border border-border bg-card px-3 text-sm"
                  value={draft.store_id}
                  onChange={(e) => setDraft({ ...draft, store_id: e.target.value, cash_register_id: null, is_default: false })}
                >
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm">
                <span className="mb-1 block font-medium">Caja</span>
                <select
                  className="h-11 w-full rounded-lg border border-border bg-card px-3 text-sm"
                  value={draft.cash_register_id ?? ""}
                  onChange={(e) => setDraft({ ...draft, cash_register_id: e.target.value || null })}
                >
                  <option value="">Toda la sucursal</option>
                  {registersOf(draft.store_id).map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <Input label="Nombre" value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder="Point mostrador" />
            <Input
              label={
                canIntegrate(draft.provider_key) && isIntegratedKind(draft.kind)
                  ? draft.integration.adapter === "simulator"
                    ? "N° de terminal (opcional en el simulador)"
                    : "N° de terminal"
                  : kindForProvider(draft.provider_key) === "posnet_manual"
                    ? "N° de terminal (opcional)"
                    : "Identificador"
              }
              value={draft.external_id}
              onChange={(e) => setDraft({ ...draft, external_id: e.target.value })}
            />
            {kindForProvider(draft.provider_key) === "qr_caja" && (
              <label className="block text-sm">
                <span className="mb-1 block font-medium">Ambiente</span>
                <select
                  className="h-11 w-full rounded-lg border border-border bg-card px-3 text-sm"
                  value={draft.environment ?? "prod"}
                  onChange={(e) => setDraft({ ...draft, environment: e.target.value as "prod" | "test" })}
                >
                  <option value="prod">Producción</option>
                  <option value="test">Prueba</option>
                </select>
              </label>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                label="N° de comercio (opcional)"
                value={draft.merchant_number}
                onChange={(e) => setDraft({ ...draft, merchant_number: e.target.value })}
                hint="Sale en el cupón para conciliar."
              />
              <Input
                label="Adquirente (opcional)"
                value={draft.acquirer}
                onChange={(e) => setDraft({ ...draft, acquirer: e.target.value })}
                placeholder="Prisma, Fiserv, Getnet"
              />
            </div>
            <Input label="Notas" value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
            <div className="flex flex-wrap gap-4 text-sm">
              {draft.cash_register_id && (
                <label className="flex items-center gap-2">
                  <Switch checked={draft.is_default} onCheckedChange={(v) => setDraft({ ...draft, is_default: v })} label="Default de la caja" />
                  Default de la caja
                </label>
              )}
              <label className="flex items-center gap-2">
                <Switch checked={draft.active} onCheckedChange={(v) => setDraft({ ...draft, active: v })} label="Activa" />
                Activa
              </label>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="secondary" onClick={() => setDraft(null)}>
                Cancelar
              </Button>
              <Button onClick={save} disabled={mut.create.isPending || mut.update.isPending}>
                Guardar
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {connectFor && <TerminalDeviceModal terminal={connectFor} onClose={() => setConnectFor(null)} />}

      <ConfirmDialog
        open={Boolean(archive)}
        onOpenChange={(o) => !o && setArchive(null)}
        title={`Archivar ${archive?.label ?? "terminal"}`}
        description="Deja de ofrecerse en el POS. Los cobros que ya pasaron por ella no cambian."
        confirmLabel="Archivar"
        danger
        loading={mut.archive.isPending}
        onConfirm={() =>
          archive &&
          mut.archive.mutate(archive.id, {
            onSuccess: () => setArchive(null),
            onError: (e) => toast({ title: terminalErrorMessage(e), variant: "error" }),
          })
        }
      />
    </div>
  );
}
