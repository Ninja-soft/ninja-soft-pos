"use client";

import { useEffect, useMemo, useState } from "react";
import { Calculator, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { selectCls } from "@/components/stock/transfers/shared";
import { formatCurrency } from "@/lib/utils/format";
import { LISTING_TYPE_LABELS, mlErrorMessage } from "@/lib/mercadolibre/labels";
import { DEFAULT_RULES, listingPrice, suggestedMarkup, type ListingRule } from "@/lib/mercadolibre/pricing";
import { usePriceLists } from "@/modules/prices/hooks";
import { mlPublishApi, useMlListingRules, useMlMutations, type MlAccount, type MlListingFee } from "@/modules/mercadolibre/hooks";

// Reglas de precio por tipo de publicación (H141 · ADR-132): cada tipo con su
// recargo sobre el precio base de la cuenta o una lista propia, redondeo,
// mínimo y si se tilda solo al publicar. La vista previa usa el mismo
// cálculo que el servidor (lib/mercadolibre/pricing.ts).

const KNOWN = ["gold_special", "gold_pro"] as const;

type Draft = Omit<ListingRule, "markup_pct" | "rounding" | "min_price"> & { markup_pct: string; rounding: string; min_price: string };

const toDraft = (r: ListingRule): Draft => ({
  ...r,
  markup_pct: String(r.markup_pct ?? 0),
  rounding: String(r.rounding ?? 0),
  min_price: String(r.min_price ?? 0),
});

export function MlListingRulesEditor({
  account,
  canManage,
  sampleCategoryId,
}: {
  account: MlAccount;
  canManage: boolean;
  /** Una categoría de la cuenta para leer la comisión de ML por tipo. */
  sampleCategoryId: string | null;
}) {
  const { toast } = useToast();
  const { data: rules, isLoading } = useMlListingRules(account.id);
  const { data: lists = [] } = usePriceLists();
  const { saveRules } = useMlMutations();
  const [rows, setRows] = useState<Draft[]>([]);
  const [example, setExample] = useState("10000");
  const [fees, setFees] = useState<MlListingFee[] | null>(null);
  const [feesBusy, setFeesBusy] = useState(false);

  useEffect(() => {
    if (!rules) return;
    setRows((rules.length ? rules : DEFAULT_RULES).map(toDraft));
  }, [rules]);

  const parsed = useMemo(
    () =>
      rows.map((r) => ({
        ...r,
        markup_pct: Number(r.markup_pct || 0),
        rounding: Number(r.rounding || 0),
        min_price: Number(r.min_price || 0),
      })),
    [rows],
  );
  const invalid = parsed.some(
    (r) =>
      !Number.isFinite(r.markup_pct) ||
      r.markup_pct < -90 ||
      r.markup_pct > 500 ||
      !(r.rounding >= 0) ||
      !(r.min_price >= 0) ||
      (r.mode === "price_list" && !r.price_list_id),
  );
  const base = Number(example) > 0 ? Number(example) : 0;
  const disabled = !canManage || saveRules.isPending;
  const unused = KNOWN.filter((k) => !rows.some((r) => r.listing_type_id === k));

  const set = (i: number, patch: Partial<Draft>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const loadFees = async () => {
    if (!sampleCategoryId || !(base > 0)) return;
    setFeesBusy(true);
    try {
      const r = await mlPublishApi.listingFees(sampleCategoryId, base);
      setFees(r.fees ?? []);
    } catch (e) {
      toast({ title: "No se pudo leer la comisión de Mercado Libre", description: mlErrorMessage(e), variant: "error" });
    } finally {
      setFeesBusy(false);
    }
  };
  const feeOf = (t: string) => fees?.find((f) => f.listing_type_id === t) ?? null;
  const classic = feeOf("gold_special");

  const save = () =>
    saveRules.mutate(
      { accountId: account.id, rules: parsed },
      {
        onSuccess: () => toast({ title: "Precios por tipo guardados", description: "Las publicaciones vinculadas se actualizan solas.", variant: "success" }),
        onError: (e) => toast({ title: "No se pudo guardar", description: mlErrorMessage(e), variant: "error" }),
      },
    );

  if (isLoading) return <SpinnerBlock className="py-8" />;

  return (
    <div className="space-y-4 px-5 py-4">
      <p className="text-sm text-muted-foreground">
        El precio base es el de la cuenta ({account.price_list_id ? "lista de precios de Mercado Libre" : `precio del POS${account.price_markup_pct ? ` + ${account.price_markup_pct} %` : ""}`}). Cada tipo
        puede sumarle un recargo o usar otra lista. En cada producto podés cambiarlo desde su ficha.
      </p>

      <div className="space-y-3">
        {rows.map((r, i) => {
          const p = parsed[i]!;
          const preview = listingPrice({
            basePrice: base,
            listPrice: () => null,
            accountRounding: Number(account.price_rounding || 0),
            rule: p,
            override: null,
          });
          const fee = feeOf(r.listing_type_id);
          const suggestion = classic && fee && r.listing_type_id !== "gold_special" ? suggestedMarkup(base, classic, fee) : null;
          return (
            <div key={r.listing_type_id} className="space-y-3 rounded-lg bg-muted p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-3">
                  <Switch
                    checked={r.enabled}
                    disabled={disabled}
                    label={`Usar ${LISTING_TYPE_LABELS[r.listing_type_id] ?? r.listing_type_id}`}
                    onCheckedChange={(v) => set(i, { enabled: v })}
                  />
                  <span className="text-sm font-semibold">{LISTING_TYPE_LABELS[r.listing_type_id] ?? r.listing_type_id}</span>
                </div>
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-2 text-xs">
                    <Checkbox checked={r.default_on} disabled={disabled} onCheckedChange={(v) => set(i, { default_on: Boolean(v) })} />
                    Tildado al publicar
                  </label>
                  {!KNOWN.includes(r.listing_type_id as (typeof KNOWN)[number]) || rows.length > 1 ? (
                    <button
                      type="button"
                      className="rounded-md p-1 text-muted-foreground hover:bg-secondary/60"
                      aria-label={`Quitar ${LISTING_TYPE_LABELS[r.listing_type_id] ?? r.listing_type_id}`}
                      disabled={disabled}
                      onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                    >
                      <Trash2 size={15} />
                    </button>
                  ) : null}
                </div>
              </div>
              {r.enabled && (
                <div className="grid gap-2 sm:grid-cols-4">
                  <label className="block space-y-1 text-sm">
                    <span className="font-medium">Precio</span>
                    <select
                      className={selectCls}
                      value={r.mode === "price_list" ? `list:${r.price_list_id ?? ""}` : "markup"}
                      disabled={disabled}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === "markup") set(i, { mode: "markup", price_list_id: null });
                        else set(i, { mode: "price_list", price_list_id: v.slice(5) || null });
                      }}
                    >
                      <option value="markup">Base de la cuenta + recargo</option>
                      {lists.map((l) => (
                        <option key={l.id} value={`list:${l.id}`}>
                          Lista: {l.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Input
                    label="Recargo %"
                    type="number"
                    inputMode="decimal"
                    value={r.markup_pct}
                    disabled={disabled}
                    hint={suggestion != null ? `Para dejar lo mismo que Clásica: ${suggestion} %` : undefined}
                    onChange={(e) => set(i, { markup_pct: e.target.value })}
                  />
                  <Input
                    label="Redondear a"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    hint="0 = el de la cuenta"
                    value={r.rounding}
                    disabled={disabled}
                    onChange={(e) => set(i, { rounding: e.target.value })}
                  />
                  <Input
                    label="Precio mínimo"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    value={r.min_price}
                    disabled={disabled}
                    onChange={(e) => set(i, { min_price: e.target.value })}
                  />
                </div>
              )}
              {r.enabled && base > 0 && (
                <p className="text-xs text-muted-foreground">
                  Con base {formatCurrency(base)}: {r.mode === "price_list" ? "precio de la lista" : ""}
                  {r.mode === "price_list" && p.markup_pct ? ` + ${p.markup_pct} %` : ""}
                  {r.mode !== "price_list" && preview != null ? <span className="font-medium tabular-nums text-foreground">{formatCurrency(preview)}</span> : null}
                  {fee ? ` · comisión de Mercado Libre ${fee.percentage_fee.toLocaleString("es-AR", { maximumFractionDigits: 2 })} % + ${formatCurrency(fee.fixed_fee)}` : ""}
                </p>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-end gap-2">
        {unused.map((k) => (
          <Button
            key={k}
            variant="secondary"
            size="sm"
            disabled={disabled}
            onClick={() => setRows((rs) => [...rs, toDraft({ ...DEFAULT_RULES.find((d) => d.listing_type_id === k)!, default_on: false })])}
          >
            <Plus size={15} /> {LISTING_TYPE_LABELS[k]}
          </Button>
        ))}
        <div className="w-36">
          <Input label="Precio de ejemplo" type="number" inputMode="decimal" min={0} value={example} onChange={(e) => setExample(e.target.value)} />
        </div>
        {sampleCategoryId && (
          <Button variant="ghost" size="sm" onClick={loadFees} loading={feesBusy} disabled={!(base > 0)}>
            <Calculator size={15} /> Ver comisión por tipo
          </Button>
        )}
      </div>

      {canManage && (
        <div className="flex justify-end">
          <Button onClick={save} disabled={invalid || disabled} loading={saveRules.isPending}>
            Guardar precios por tipo
          </Button>
        </div>
      )}
    </div>
  );
}
