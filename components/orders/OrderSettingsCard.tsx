"use client";

// Configuración de pedidos de salón y expedición (F11 · H32, ADR-129):
// minutos de reserva, qué pasa al vencer, tipos de entrega habilitados y si
// cada uno puede hacerse en otra sucursal. Se guarda en
// pos_settings.order_config (sólo el dueño, RLS de pos_settings) y el
// servidor lo lee con pos_order_config (mismos defaults que orderConfig).
// ADR-130: también los pedidos desde el catálogo público (order_config.catalog).
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { SettingRow, SettingsCard } from "@/components/settings/Settings";
import { createClient } from "@/lib/supabase/client";
import { getCurrentTenantId } from "@/lib/supabase/currentUser";
import { useMyTenant } from "@/modules/tenants/hooks";
import { useFeature } from "@/modules/saas/gating";
import { useStores } from "@/modules/stock/hooks";
import { ORDER_CONFIG_KEY, useOrderConfig } from "@/modules/orders/hooks";
import {
  DELIVERY_TYPE_HINT,
  DELIVERY_TYPE_LABEL,
  ORDER_MINUTES_MAX,
  ORDER_MINUTES_MIN,
  orderConfig,
  type ExpiryAction,
  type OrderConfig,
} from "@/lib/orders/logic";

const field =
  "h-11 w-full rounded-lg border border-border bg-background/40 px-3 text-sm tabular-nums text-foreground outline-none focus:border-[color-mix(in_srgb,var(--foreground)_30%,transparent)]";

export function OrderSettingsCard() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: me } = useMyTenant();
  const canEdit = me?.role === "owner";
  const { config, raw } = useOrderConfig();
  // ADR-130: pedidos desde el catálogo público (OPTIONAL; el servidor lo exige).
  const catalogFeature = useFeature("catalogo_pedidos");
  const { data: stores = [] } = useStores();
  const [c, setC] = useState<OrderConfig>(config);
  useEffect(() => setC(config), [config]);
  const dirty = JSON.stringify(c) !== JSON.stringify(config);

  const save = useMutation({
    mutationFn: async (next: OrderConfig) => {
      const tenantId = await getCurrentTenantId();
      if (!tenantId) throw new Error("no_tenant");
      const value = orderConfig({ ...(raw && typeof raw === "object" ? raw : {}), ...next });
      const { error } = await createClient()
        .from("pos_settings")
        .upsert({ tenant_id: tenantId, order_config: value } as never, { onConflict: "tenant_id" });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ORDER_CONFIG_KEY }),
  });

  async function onSave() {
    try {
      await save.mutateAsync(c);
      toast({ title: "Pedidos actualizados", variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo guardar", description: e instanceof Error ? e.message : undefined, variant: "error" });
    }
  }

  const setType = (t: "inmediato" | "retiro" | "envio", patch: Record<string, boolean>) =>
    setC({ ...c, delivery_types: { ...c.delivery_types, [t]: { ...c.delivery_types[t], ...patch } } });
  const setCatalog = (patch: Partial<OrderConfig["catalog"]>) => setC({ ...c, catalog: { ...c.catalog, ...patch } });
  const catalogTypes = c.delivery_types.retiro.enabled || c.delivery_types.envio.enabled;
  const liveStores = stores;

  return (
    <SettingsCard
      title="Pedidos de salón y expedición"
      description="El vendedor arma el pedido, la caja lo cobra y expedición lo entrega o lo despacha."
      actions={
        canEdit ? (
          <Button size="sm" onClick={onSave} loading={save.isPending} disabled={!dirty}>
            Guardar
          </Button>
        ) : undefined
      }
    >
      <SettingRow
        label="Reserva de stock"
        description={`Minutos que el pedido aparta el stock hasta que lo cobra la caja (de ${ORDER_MINUTES_MIN} a ${ORDER_MINUTES_MAX}).`}
        htmlFor="o-min"
      >
        <div className="flex max-w-[12rem] items-center gap-2">
          <input
            id="o-min"
            type="number"
            min={ORDER_MINUTES_MIN}
            max={ORDER_MINUTES_MAX}
            disabled={!canEdit}
            value={c.reservation_minutes}
            onChange={(e) =>
              setC({
                ...c,
                reservation_minutes: Math.max(ORDER_MINUTES_MIN, Math.min(ORDER_MINUTES_MAX, Number(e.target.value) || ORDER_MINUTES_MIN)),
              })
            }
            className={field}
          />
          <span className="text-sm text-muted-foreground">min</span>
        </div>
      </SettingRow>
      <SettingRow
        label="Al vencer la reserva"
        description={
          c.expiry_action === "release"
            ? "Se libera el stock y el pedido sigue en la lista: se cobra si todavía hay stock."
            : "El pedido se anula solo (si la caja ya lo estaba cobrando, se respeta)."
        }
        stacked
      >
        <Segmented<ExpiryAction>
          scrollOnMobile
          size="sm"
          aria-label="Al vencer la reserva"
          value={c.expiry_action}
          onChange={(v) => canEdit && setC({ ...c, expiry_action: v })}
          options={[
            { value: "release", label: "Liberar el stock" },
            { value: "cancel", label: "Anular el pedido" },
          ]}
        />
      </SettingRow>

      {(["inmediato", "retiro", "envio"] as const).map((t) => (
        <SettingRow key={t} label={DELIVERY_TYPE_LABEL[t]} description={DELIVERY_TYPE_HINT[t]} stacked>
          <div className="flex flex-col gap-2.5">
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>Habilitado</span>
              <Switch
                checked={c.delivery_types[t].enabled}
                disabled={!canEdit}
                onCheckedChange={(v) => setType(t, { enabled: v })}
                label={`${DELIVERY_TYPE_LABEL[t]} habilitado`}
              />
            </label>
            {t === "inmediato" && (
              <label className="flex items-center justify-between gap-3 text-sm">
                <span>Pasa por expedición (se entrega en el mostrador de entrega)</span>
                <Switch
                  checked={c.immediate_via_dispatch}
                  disabled={!canEdit || !c.delivery_types.inmediato.enabled}
                  onCheckedChange={(v) => setC({ ...c, immediate_via_dispatch: v })}
                  label="Se lo lleva ahora pasa por expedición"
                />
              </label>
            )}
            {t !== "inmediato" && (
              <label className="flex items-center justify-between gap-3 text-sm">
                <span>{t === "retiro" ? "Se puede retirar en otra sucursal" : "Se puede despachar desde otra sucursal"}</span>
                <Switch
                  checked={c.delivery_types[t].cross_branch}
                  disabled={!canEdit || !c.delivery_types[t].enabled}
                  onCheckedChange={(v) => setType(t, { cross_branch: v })}
                  label={`${DELIVERY_TYPE_LABEL[t]} en otra sucursal`}
                />
              </label>
            )}
            {t === "retiro" && (
              <label className="flex items-center justify-between gap-3 text-sm">
                <span>Pedir código de 6 dígitos al entregar (sin código, alcanza con el nombre)</span>
                <Switch
                  checked={c.delivery_types.retiro.pickup_code}
                  disabled={!canEdit || !c.delivery_types.retiro.enabled}
                  onCheckedChange={(v) => setType("retiro", { pickup_code: v })}
                  label="Código de retiro"
                />
              </label>
            )}
          </div>
        </SettingRow>
      ))}
      <SettingRow
        label="Pedidos desde el catálogo web"
        description={
          catalogFeature === false
            ? "Tu plan no incluye pedidos desde el catálogo. Están en el plan Pro."
            : "El cliente arma el carrito en tu catálogo público, elige retiro o envío y confirma. El pedido entra acá con el stock reservado y te llega un aviso."
        }
        stacked
      >
        <div className="flex flex-col gap-2.5">
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>Recibir pedidos desde el catálogo</span>
            <Switch
              checked={c.catalog.enabled && catalogFeature !== false}
              disabled={!canEdit || catalogFeature === false}
              onCheckedChange={(v) => setCatalog({ enabled: v })}
              label="Recibir pedidos desde el catálogo"
            />
          </label>
          {c.catalog.enabled && catalogFeature !== false && (
            <>
              {!catalogTypes && (
                <p className="text-xs text-warning">Prendé Retira después o Envío a domicilio: el catálogo sólo ofrece esos dos.</p>
              )}
              {liveStores.length > 1 && (
                <label className="flex flex-col gap-1 text-sm">
                  <span>Sucursal que reserva el stock y cobra</span>
                  <select
                    className={field}
                    disabled={!canEdit}
                    value={c.catalog.store_id ?? ""}
                    onChange={(e) => setCatalog({ store_id: e.target.value || null })}
                  >
                    <option value="">La principal</option>
                    {liveStores.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="flex items-center justify-between gap-3 text-sm">
                <span>Ofrecer pagar con link (Mercado Pago u otro proveedor conectado)</span>
                <Switch
                  checked={c.catalog.pay_link}
                  disabled={!canEdit}
                  onCheckedChange={(v) => setCatalog({ pay_link: v })}
                  label="Ofrecer pagar con link"
                />
              </label>
              <p className="text-xs text-muted-foreground">
                Retiro en otra sucursal y código de retiro siguen lo que elegiste arriba para Retira después.
              </p>
            </>
          )}
        </div>
      </SettingRow>
      {!canEdit && <p className="px-1 text-xs text-muted-foreground">Sólo el dueño cambia esta configuración.</p>}
    </SettingsCard>
  );
}
