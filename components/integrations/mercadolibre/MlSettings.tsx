"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import type { Route } from "next";
import { ExternalLink, Link2, Lock, Plug, RefreshCw, ShoppingBag, Unplug } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button, buttonVariants } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { SettingRow, SettingsCard, SettingsNotice } from "@/components/settings/Settings";
import { UpgradeModal } from "@/components/saas/UpgradeModal";
import { selectCls } from "@/components/stock/transfers/shared";
import { useFeature } from "@/modules/saas/gating";
import { useMyTenant } from "@/modules/tenants/hooks";
import { useStores } from "@/modules/stock/hooks";
import { useWarehouses } from "@/modules/stock/warehouses";
import { usePriceLists } from "@/modules/prices/hooks";
import { useMlAccounts, useMlMutations, type MlAccount, type MlSettingsInput } from "@/modules/mercadolibre/hooks";
import {
  ACCOUNT_STATUS_LABELS,
  INVOICE_MODE_LABELS,
  LABEL_FORMAT_LABELS,
  LISTING_TYPE_LABELS,
  accountStatusTone,
  mlErrorMessage,
} from "@/lib/mercadolibre/labels";

// Configuración > Integraciones > Mercado Libre (H87 · ADR-104). Dueño o
// encargado: conectar una o varias cuentas de ML (OAuth con PKCE), reconectar
// la que venció, desconectar, y configurar por cuenta de dónde sale el stock
// publicado, el precio del canal, cuándo se factura y el formato de etiqueta.
// El servidor exige plan, rol y cuenta (ml_assert / ml_edge_guard).

const RESULT: Record<string, { title: string; variant: "success" | "error" }> = {
  ok: { title: "Cuenta de Mercado Libre conectada", variant: "success" },
  denied: { title: "Conexión cancelada en Mercado Libre", variant: "error" },
  taken: { title: "Esa cuenta de Mercado Libre ya está conectada a otro negocio", variant: "error" },
  not_configured: { title: "Falta configurar la app de Mercado Libre", variant: "error" },
  plan: { title: "Mercado Libre no está incluido en tu plan", variant: "error" },
  operator: { title: "Conectá con el usuario administrador de la cuenta, no con un colaborador", variant: "error" },
  expired: { title: "El pedido de conexión venció: probá de nuevo", variant: "error" },
  err: { title: "No se pudo conectar la cuenta de Mercado Libre", variant: "error" },
};

function when(iso: string | null): string {
  if (!iso) return "Nunca";
  return new Date(iso).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" });
}

/** Grupos de ajustes de la cuenta: se muestran y se guardan por separado. */
export type AccountConfigSection = "stock" | "price" | "listing" | "billing" | "labels";
const ALL_SECTIONS: AccountConfigSection[] = ["stock", "price", "listing", "billing", "labels"];

export function AccountConfig({
  account,
  canManage,
  sections = ALL_SECTIONS,
  saveLabel = "Guardar configuración",
}: {
  account: MlAccount;
  canManage: boolean;
  /** Qué grupos mostrar; se guardan sólo esos campos (el resto no se toca). */
  sections?: AccountConfigSection[];
  saveLabel?: string;
}) {
  const has = (k: AccountConfigSection) => sections.includes(k);
  const { toast } = useToast();
  const { saveSettings } = useMlMutations();
  const { data: stores = [] } = useStores();
  const { data: lists = [] } = usePriceLists();
  const initial = useMemo(
    () => ({
      store_id: account.location?.store_id ?? "",
      warehouse_id: account.location?.warehouse_id ?? "",
      reserve_qty: String(account.location?.reserve_qty ?? 0),
      reserve_pct: String(account.location?.reserve_pct ?? 0),
      max_qty: account.location?.max_qty != null ? String(account.location.max_qty) : "",
      stock_sync: account.stock_sync,
      price_sync: account.price_sync,
      price_list_id: account.price_list_id ?? "",
      price_markup_pct: String(account.price_markup_pct ?? 0),
      price_rounding: String(account.price_rounding ?? 0),
      default_listing_type: account.default_listing_type,
      label_format: account.label_format,
    }),
    [account],
  );
  const [f, setF] = useState(initial);
  useEffect(() => setF(initial), [initial]);
  const { data: warehouses = [] } = useWarehouses(f.store_id || null);

  const reserve = Number(f.reserve_qty);
  const reservePct = Number(f.reserve_pct || 0);
  const maxQty = f.max_qty.trim() === "" ? null : Number(f.max_qty);
  const markup = Number(f.price_markup_pct);
  const rounding = Number(f.price_rounding);
  const stockOk =
    Number.isFinite(reserve) && reserve >= 0 &&
    Number.isFinite(reservePct) && reservePct >= 0 && reservePct <= 95 &&
    (maxQty === null || (Number.isInteger(maxQty) && maxQty >= 0));
  const priceOk = Number.isFinite(markup) && markup >= -90 && markup <= 500 && Number.isFinite(rounding) && rounding >= 0;
  const valid = (!has("stock") || stockOk) && (!has("price") || priceOk);
  const dirty = JSON.stringify(f) !== JSON.stringify(initial);
  const disabled = !canManage || saveSettings.isPending;

  const save = () => {
    if (!valid) return;
    // Sólo los campos de los grupos visibles: el servidor deja el resto como está.
    const p: MlSettingsInput = {
      ...(has("stock")
        ? { store_id: f.store_id || null, warehouse_id: f.warehouse_id || null, reserve_qty: reserve, reserve_pct: reservePct, max_qty: maxQty, stock_sync: f.stock_sync }
        : {}),
      ...(has("price")
        ? { price_sync: f.price_sync, price_list_id: f.price_list_id || null, price_markup_pct: markup, price_rounding: rounding }
        : {}),
      ...(has("listing") ? { default_listing_type: f.default_listing_type } : {}),
      ...(has("labels") ? { label_format: f.label_format } : {}),
    };
    saveSettings.mutate(
      { accountId: account.id, p },
      {
        onSuccess: () => toast({ title: "Configuración guardada", description: "Las publicaciones vinculadas se reenvían solas.", variant: "success" }),
        onError: (e) => toast({ title: "No se pudo guardar", description: mlErrorMessage(e), variant: "error" }),
      },
    );
  };

  return (
    <div className="space-y-0 divide-y divide-border">
      {has("stock") && (
      <>
      <SettingRow label="Stock publicado desde" description="Sucursal (y depósito, opcional) cuyo stock se publica. Las ventas de esta cuenta descuentan de acá.">
        <div className="grid w-full gap-2 sm:w-80">
          <select
            className={selectCls}
            value={f.store_id}
            disabled={disabled}
            aria-label="Sucursal"
            onChange={(e) => setF({ ...f, store_id: e.target.value, warehouse_id: "" })}
          >
            <option value="">Sucursal principal</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          {warehouses.length > 0 && (
            <select
              className={selectCls}
              value={f.warehouse_id}
              disabled={disabled}
              aria-label="Depósito"
              onChange={(e) => setF({ ...f, warehouse_id: e.target.value })}
            >
              <option value="">Toda la sucursal</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          )}
        </div>
      </SettingRow>
      <SettingRow label="Reserva de seguridad" description="Unidades que nunca se publican (para no vender lo que se rompe o se vende en mostrador al mismo tiempo).">
        <Input
          className="w-28"
          type="number"
          inputMode="decimal"
          min={0}
          value={f.reserve_qty}
          disabled={disabled}
          aria-label="Reserva de seguridad"
          onChange={(e) => setF({ ...f, reserve_qty: e.target.value })}
        />
      </SettingRow>
      <SettingRow
        label="Stock publicable"
        description="Además de la reserva: un porcentaje que no se publica y un tope por publicación (vacío = sin tope). Ejemplo: 40 en stock, reserva 2, 10 % y tope 20 publica 20."
      >
        <div className="grid w-full grid-cols-2 gap-2 sm:w-80">
          <Input
            label="Guardar %"
            type="number"
            inputMode="decimal"
            min={0}
            max={95}
            value={f.reserve_pct}
            disabled={disabled}
            onChange={(e) => setF({ ...f, reserve_pct: e.target.value })}
          />
          <Input
            label="Tope por publicación"
            type="number"
            inputMode="numeric"
            min={0}
            placeholder="Sin tope"
            value={f.max_qty}
            disabled={disabled}
            onChange={(e) => setF({ ...f, max_qty: e.target.value })}
          />
        </div>
      </SettingRow>
      <SettingRow label="Sincronizar stock" description="Cada venta, compra o ajuste del POS actualiza la cantidad publicada.">
        <Switch checked={f.stock_sync} disabled={disabled} label="Sincronizar stock" onCheckedChange={(v) => setF({ ...f, stock_sync: v })} />
      </SettingRow>
      </>
      )}
      {has("price") && (
      <>
      <SettingRow label="Sincronizar precio" description="El precio publicado sale del POS. Si la publicación usa la automatización de precios de Mercado Libre, no se pisa.">
        <Switch checked={f.price_sync} disabled={disabled} label="Sincronizar precio" onCheckedChange={(v) => setF({ ...f, price_sync: v })} />
      </SettingRow>
      <SettingRow label="Precio del canal" description="Una lista de precios propia de Mercado Libre, o el precio del POS con un margen y redondeo.">
        <div className="grid w-full gap-2 sm:w-80">
          <select
            className={selectCls}
            value={f.price_list_id}
            disabled={disabled}
            aria-label="Lista de precios"
            onChange={(e) => setF({ ...f, price_list_id: e.target.value })}
          >
            <option value="">Precio del POS con margen</option>
            {lists.map((l) => (
              <option key={l.id} value={l.id}>
                Lista: {l.name}
              </option>
            ))}
          </select>
          {!f.price_list_id && (
            <div className="grid grid-cols-2 gap-2">
              <Input
                label="Margen %"
                type="number"
                inputMode="decimal"
                value={f.price_markup_pct}
                disabled={disabled}
                onChange={(e) => setF({ ...f, price_markup_pct: e.target.value })}
              />
              <Input
                label="Redondear a"
                type="number"
                inputMode="decimal"
                min={0}
                hint="0 = sin redondeo"
                value={f.price_rounding}
                disabled={disabled}
                onChange={(e) => setF({ ...f, price_rounding: e.target.value })}
              />
            </div>
          )}
        </div>
      </SettingRow>
      </>
      )}
      {has("billing") && (
      <>
      {/* ADR-141: cuándo facturar, subir la factura y las reglas se configuran en Mercado Libre › Configuración › Facturación. */}
      <SettingRow
        label="Facturación"
        description={`${INVOICE_MODE_LABELS[account.invoice_mode] ?? "No facturar"}${account.upload_invoice ? ", con la factura subida a la venta" : ""}. Cuándo facturar, qué factura sale y las percepciones se configuran en Mercado Libre › Configuración › Facturación.`}
      >
        <Link href={"/mercadolibre?tab=config&cfg=facturacion" as Route} className={buttonVariants({ variant: "secondary", size: "sm" })}>
          Configurar facturación
        </Link>
      </SettingRow>
      </>
      )}
      {has("listing") && (
      <SettingRow label="Tipo de publicación por defecto" description="El que se usa cuando un producto no tiene reglas de precio por tipo.">
        <select
          className={`${selectCls} sm:w-80`}
          value={f.default_listing_type}
          disabled={disabled}
          aria-label="Tipo de publicación"
          onChange={(e) => setF({ ...f, default_listing_type: e.target.value })}
        >
          {(["gold_special", "gold_pro"] as const).map((k) => (
            <option key={k} value={k}>
              {LISTING_TYPE_LABELS[k]}
            </option>
          ))}
        </select>
      </SettingRow>
      )}
      {has("labels") && (
      <SettingRow label="Etiquetas de envío" description="Formato de las etiquetas de Mercado Envíos que imprimís desde Envíos.">
        <select
          className={`${selectCls} sm:w-80`}
          value={f.label_format}
          disabled={disabled}
          aria-label="Formato de etiqueta"
          onChange={(e) => setF({ ...f, label_format: e.target.value as "pdf" | "zpl2" })}
        >
          {(["pdf", "zpl2"] as const).map((k) => (
            <option key={k} value={k}>
              {LABEL_FORMAT_LABELS[k]}
            </option>
          ))}
        </select>
      </SettingRow>
      )}
      {canManage && (
        <div className="flex flex-wrap items-center justify-end gap-3 px-5 py-4">
          {!valid && <span className="text-xs text-danger">Revisá los valores marcados: hay números fuera de rango.</span>}
          {valid && dirty && <span className="text-xs text-muted-foreground">Hay cambios sin guardar.</span>}
          <Button onClick={save} disabled={!valid || !dirty || disabled} loading={saveSettings.isPending}>
            {saveLabel}
          </Button>
        </div>
      )}
    </div>
  );
}

export function MlSettings() {
  const { toast } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  const enabled = useFeature("mercadolibre");
  const { data: me, isLoading: meLoading } = useMyTenant();
  const canManage = Boolean(me?.canManage);
  const q = useMlAccounts(canManage);
  const { connect, disconnect, syncAccount } = useMlMutations();
  const [upgrade, setUpgrade] = useState(false);
  const [toDisconnect, setToDisconnect] = useState<MlAccount | null>(null);
  const [configFor, setConfigFor] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  // Resultado del redirect del OAuth (?ml=ok|denied|taken|not_configured|err).
  useEffect(() => {
    const ml = searchParams.get("ml");
    if (!ml) return;
    const r = RESULT[ml] ?? RESULT.err!;
    toast({ title: r.title, variant: r.variant });
    void q.refetch();
    router.replace("/configuracion?seccion=mercadolibre");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const accounts = useMemo(() => q.data ?? [], [q.data]);
  useEffect(() => {
    if (!configFor && accounts.length > 0) setConfigFor(accounts[0]!.id);
  }, [accounts, configFor]);

  const start = (reconnectId: string | null) => {
    if (enabled === false) {
      setUpgrade(true);
      return;
    }
    setConnectError(null);
    connect.mutate(reconnectId, {
      onSuccess: (r) => {
        if (r?.url) window.location.assign(r.url);
      },
      onError: (e) => {
        const msg = mlErrorMessage(e);
        setConnectError(msg);
        toast({ title: "No se pudo iniciar la conexión", description: msg, variant: "error" });
      },
    });
  };

  if (meLoading || (canManage && q.isLoading)) return <SpinnerBlock className="py-16" />;
  if (!canManage) {
    return (
      <Callout tone="info" icon={Lock} title="Sólo dueño o encargado">
        Conectar cuentas de Mercado Libre y cambiar cómo se sincronizan las publicaciones lo hace el dueño o un encargado.
      </Callout>
    );
  }

  const current = accounts.find((a) => a.id === configFor) ?? null;

  return (
    <div className="space-y-6">
      <SettingsCard
        title="Cuentas conectadas"
        description="Podés conectar más de una cuenta (por ejemplo, tienda oficial y outlet). Cada cuenta de Mercado Libre se conecta a un solo negocio."
        icon={ShoppingBag}
        actions={
          <>
            {accounts.length > 0 && (
              <Link href="/mercadolibre" className={buttonVariants({ variant: "secondary", size: "sm" })}>
                <ExternalLink size={15} /> Ir a Mercado Libre
              </Link>
            )}
            <Button size="sm" onClick={() => start(null)} loading={connect.isPending}>
              <Plug size={15} /> Conectar cuenta
            </Button>
          </>
        }
      >
        {connectError && (
          <SettingsNotice>
            <Callout tone="warning" title="No se pudo conectar">
              {connectError}
            </Callout>
          </SettingsNotice>
        )}
        {accounts.length === 0 ? (
          <EmptyState
            compact
            icon={Link2}
            title="Todavía no conectaste ninguna cuenta"
            description="Conectá con el usuario administrador de tu cuenta de Mercado Libre. Vas a autorizar a NinjaSoft en la página de Mercado Libre y volver acá."
          />
        ) : (
          accounts.map((a) => (
            <div key={a.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{a.nickname || `Usuario ${a.ml_user_id}`}</span>
                  <Badge tone={accountStatusTone(a.status)}>{ACCOUNT_STATUS_LABELS[a.status] ?? a.status}</Badge>
                  {a.user_product_seller && <Badge tone="neutral">User Products</Badge>}
                </div>
                <p className="text-xs text-muted-foreground">
                  Conectada {when(a.connected_at)} · última sincronización {when(a.last_sync_at)}
                </p>
                {a.status === "reauth_required" && (
                  <p className="text-xs text-warning">{a.status_reason ?? "La conexión venció: reconectá la cuenta."}</p>
                )}
                {a.last_error && a.status === "active" && <p className="text-xs text-danger">{a.last_error}</p>}
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                {a.status === "reauth_required" && (
                  <Button size="sm" onClick={() => start(a.id)} loading={connect.isPending}>
                    <RefreshCw size={15} /> Reconectar
                  </Button>
                )}
                {a.status === "active" && (
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={syncAccount.isPending && syncAccount.variables === a.id}
                    onClick={() =>
                      syncAccount.mutate(a.id, {
                        onSuccess: (r) => toast({ title: "Sincronización pedida", description: `${r?.orders ?? 0} órdenes revisadas`, variant: "success" }),
                        onError: (e) => toast({ title: "No se pudo sincronizar", description: mlErrorMessage(e), variant: "error" }),
                      })
                    }
                  >
                    <RefreshCw size={15} /> Sincronizar ahora
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={() => setToDisconnect(a)}>
                  <Unplug size={15} /> Desconectar
                </Button>
              </div>
            </div>
          ))
        )}
      </SettingsCard>

      {current && (
        <SettingsCard
          title="Configuración de la cuenta"
          description="Cómo se publica el stock y el precio, y cuándo se facturan las ventas."
          actions={
            accounts.length > 1 ? (
              <select
                className={`${selectCls} h-9 w-56`}
                value={current.id}
                aria-label="Cuenta"
                onChange={(e) => setConfigFor(e.target.value)}
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.nickname || a.ml_user_id}
                  </option>
                ))}
              </select>
            ) : undefined
          }
        >
          <AccountConfig account={current} canManage={canManage} />
        </SettingsCard>
      )}

      <ConfirmDialog
        open={toDisconnect !== null}
        onOpenChange={(o) => !o && setToDisconnect(null)}
        title={`Desconectar ${toDisconnect?.nickname ?? "la cuenta"}`}
        description="Dejan de entrar órdenes y de sincronizarse stock y precio. Las ventas ya registradas quedan. Para quitar el acceso también en Mercado Libre, revocalo desde tu cuenta de Mercado Libre."
        confirmLabel="Desconectar"
        danger
        withReason
        reasonLabel="Motivo"
        loading={disconnect.isPending}
        onConfirm={(reason) => {
          if (!toDisconnect) return;
          disconnect.mutate(
            { accountId: toDisconnect.id, reason },
            {
              onSuccess: () => {
                toast({ title: "Cuenta desconectada", variant: "success" });
                setToDisconnect(null);
                setConfigFor(null);
              },
              onError: (e) => toast({ title: "No se pudo desconectar", description: mlErrorMessage(e), variant: "error" }),
            },
          );
        }}
      />
      <UpgradeModal open={upgrade} onOpenChange={setUpgrade} featureKey="mercadolibre" featureLabel="Mercado Libre" />
    </div>
  );
}
