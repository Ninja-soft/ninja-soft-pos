"use client";

import { useToast } from "@/components/ui/Toast";
import { useFeature } from "@/modules/saas/gating";
import {
  usePaymentTerms,
  usePriceAssignments,
  usePriceProLists,
  usePriceProMutations,
  usePriceSettings,
} from "@/modules/prices/proHooks";
import { friendlyPriceError } from "@/components/prices/shared";

const selectCls =
  "h-11 w-full rounded-lg border border-input bg-background px-4 text-sm text-foreground outline-none focus:border-foreground/40";

// Lista de precios y condición de pago del cliente (ADR-058). Se guardan al
// cambiar (no dependen del formulario). La lista exige listas_precios; la
// condición, listas_precios_pro.
export function CustomerPricingFields({
  customerId,
  termId,
}: {
  customerId: string;
  termId: string | null;
}) {
  const { toast } = useToast();
  const hasLists = useFeature("listas_precios") === true;
  const { data: settings } = usePriceSettings();
  const pro = Boolean(settings?.pro);
  const { data: lists } = usePriceProLists();
  const { data: assignments } = usePriceAssignments();
  const { data: terms } = usePaymentTerms(pro);
  const m = usePriceProMutations();
  if (!hasLists) return null;

  const current = (assignments ?? []).find((a) => a.scope === "customer" && a.scope_id === customerId);
  const onError = (e: unknown) => toast({ title: friendlyPriceError(e), variant: "error" });

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div>
        <label className="mb-2 block text-sm font-medium text-muted-foreground">Lista de precios</label>
        <select
          className={selectCls}
          value={current?.price_list_id ?? ""}
          onChange={(e) =>
            m.setAssignment.mutate({ scope: "customer", scopeId: customerId, listId: e.target.value || null }, { onError })
          }
        >
          <option value="">La del grupo o la sucursal</option>
          {(lists ?? []).map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </div>
      {pro && (terms ?? []).length > 0 && (
        <div>
          <label className="mb-2 block text-sm font-medium text-muted-foreground">Condición de pago</label>
          <select
            className={selectCls}
            defaultValue={termId ?? ""}
            onChange={(e) => m.setCustomerTerm.mutate({ customerId, termId: e.target.value || null }, { onError })}
          >
            <option value="">Contado</option>
            {(terms ?? [])
              .filter((t) => t.is_active)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({Number(t.surcharge_pct)}%)
                </option>
              ))}
          </select>
        </div>
      )}
    </div>
  );
}
