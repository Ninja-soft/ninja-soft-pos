"use client";

import { selectCls } from "@/components/stock/transfers/shared";
import { LOGISTIC_RULE_LABELS } from "@/lib/mercadolibre/billing";
import type { LogisticRuleKey, LogisticStores } from "@/supabase/functions/_shared/mercadolibre/billingConfig";
import type { MlBillingSettings } from "@/modules/mercadolibre/billingHooks";

type Store = NonNullable<MlBillingSettings["stores"]>[number];

const ROWS: LogisticRuleKey[] = ["default", "me2", "full", "flex", "me1", "custom", "a_convenir"];

// Sucursal y depósito por tipo de envío (ADR-145): de qué sucursal sale la
// factura (con su punto de venta) y de qué depósito se descuenta el stock.
// Sin regla, la venta va como dice la cuenta (Configuración › Cuenta). Lo
// valida y lo aplica el servidor (ml_billing_settings_save, ml_ingest_pack,
// _ml_invoice_emit).
export function MlLogisticStores({
  value,
  onChange,
  stores,
  accountStore,
  disabled,
}: {
  value: LogisticStores;
  onChange: (v: LogisticStores) => void;
  stores: Store[];
  accountStore: { store_id: string | null; warehouse_id: string | null } | null;
  disabled: boolean;
}) {
  const accountName = stores.find((s) => s.id === accountStore?.store_id)?.name ?? "la sucursal principal";
  const set = (k: LogisticRuleKey, storeId: string, warehouseId: string | null) => {
    const next = { ...value };
    if (!storeId) delete next[k];
    else next[k] = { store_id: storeId, warehouse_id: k === "full" ? null : warehouseId };
    onChange(next);
  };

  if (stores.length === 0) {
    return <p className="text-sm text-muted-foreground">No hay sucursales activas para elegir.</p>;
  }

  return (
    <div className="w-full overflow-x-auto">
      <table className="w-full min-w-[520px] text-sm" aria-label="Sucursal y depósito por tipo de envío">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th className="py-2 pr-3 font-medium">Envío</th>
            <th className="py-2 pr-3 font-medium">Sucursal que factura</th>
            <th className="py-2 pr-3 font-medium">Depósito del stock</th>
            <th className="py-2 font-medium">PV</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {ROWS.map((k) => {
            const rule = value[k];
            const store = stores.find((s) => s.id === rule?.store_id) ?? null;
            const inherited = k === "default" ? `Como la cuenta (${accountName})` : value.default?.store_id ? "Como por defecto" : `Como la cuenta (${accountName})`;
            const info = LOGISTIC_RULE_LABELS[k]!;
            return (
              <tr key={k}>
                <td className="py-2 pr-3 align-top">
                  <span className="block font-medium">{info.label}</span>
                  <span className="block text-xs text-muted-foreground">{info.hint}</span>
                </td>
                <td className="py-2 pr-3 align-top">
                  <select
                    className={selectCls}
                    value={rule?.store_id ?? ""}
                    disabled={disabled}
                    aria-label={`Sucursal para ${info.label}`}
                    onChange={(e) => set(k, e.target.value, null)}
                  >
                    <option value="">{inherited}</option>
                    {stores.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="py-2 pr-3 align-top">
                  {k === "full" ? (
                    <span className="block py-2 text-xs text-muted-foreground">Depósito virtual Full</span>
                  ) : (
                    <select
                      className={selectCls}
                      value={rule?.warehouse_id ?? ""}
                      disabled={disabled || !store}
                      aria-label={`Depósito para ${info.label}`}
                      onChange={(e) => set(k, rule!.store_id, e.target.value || null)}
                    >
                      <option value="">{store ? "El salón de la sucursal" : "-"}</option>
                      {(store?.warehouses ?? []).map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                    </select>
                  )}
                </td>
                <td className="py-2 align-top tabular-nums text-muted-foreground">
                  <span className="block py-2">{store?.pto_vta ? String(store.pto_vta).padStart(5, "0") : "-"}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
