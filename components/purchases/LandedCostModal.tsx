"use client";

// Hoja de costeo de importación sobre una recepción (F18 · H102, ADR-050).
// El cálculo es lógica pura (lib/purchases/landed.ts); el servidor guarda la
// hoja, el costo puesto en depósito por línea, el n° de despacho en el lote y
// ajusta el promedio ponderado y el último costo (purchase_apply_costing).

import { useEffect, useMemo, useState } from "react";
import { Download, Plus, Trash2, TriangleAlert } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { formatCurrency, formatQty } from "@/lib/utils/format";
import { exportXlsx } from "@/lib/utils/xlsx";
import {
  PRORATE_LABEL,
  computeLandedCost,
  emptyLandedSheet,
  isValidDispatchNumber,
  normalizeDispatchNumber,
  type LandedLineInput,
  type LandedSheet,
  type ProrateBy,
} from "@/lib/purchases/landed";
import { formatReceiptNumber, purchaseErrorMessage } from "@/lib/purchases/orders";
import { CURRENCIES } from "@/lib/purchases/suppliers";
import type { ReceiptDetail } from "@/modules/purchases/api";
import { usePurchaseMutations } from "@/modules/purchases/hooks";
import { formatMoney, inputCls, parseNum, selectCls } from "./shared";

interface LineState {
  id: string;
  fob_unit: string;
  weight_kg: string;
  volume_m3: string;
  duty_pct: string;
}

const s = (n: number | null | undefined) => (n == null ? "" : String(n).replace(".", ","));

const EXPENSE_CHIPS = ["Despachante", "Terminal", "Depósito fiscal", "Flete interno", "Gastos bancarios"];

const PRORATES = Object.keys(PRORATE_LABEL) as ProrateBy[];

function initial(r: ReceiptDetail): { sheet: LandedSheet; lines: LineState[] } {
  const saved = r.costing as { sheet?: LandedSheet; lines?: LandedLineInput[] } | null;
  const savedLines = new Map((saved?.lines ?? []).map((l) => [l.id, l]));
  const fx = r.fx_rate > 0 ? r.fx_rate : 1;
  const sheet: LandedSheet = saved?.sheet
    ? { ...emptyLandedSheet(), ...saved.sheet }
    : emptyLandedSheet(r.currency !== "ARS" ? r.currency : "USD", r.currency !== "ARS" ? r.fx_rate : 1);
  if (!sheet.dispatch_number && r.dispatch_number) sheet.dispatch_number = r.dispatch_number;
  const lines = r.items
    .filter((i) => i.qty > 0)
    .map((i) => {
      const sv = savedLines.get(i.id);
      const fob = sv ? sv.fob_unit : r.currency !== "ARS" ? i.unit_cost : i.unit_cost / fx;
      return {
        id: i.id,
        fob_unit: s(Math.round(fob * 10000) / 10000),
        weight_kg: s(sv?.weight_kg ?? i.weight_kg),
        volume_m3: s(sv?.volume_m3 ?? i.volume_m3),
        duty_pct: s(sv?.duty_pct ?? null),
      };
    });
  return { sheet, lines };
}

export function LandedCostModal({
  receipt,
  open,
  onOpenChange,
}: {
  receipt: ReceiptDetail;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { toast } = useToast();
  const { applyCosting } = usePurchaseMutations();
  const [sheet, setSheet] = useState<LandedSheet>(() => initial(receipt).sheet);
  const [lines, setLines] = useState<LineState[]>(() => initial(receipt).lines);
  const [fxText, setFxText] = useState("");
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    if (!open) return;
    const i = initial(receipt);
    setSheet(i.sheet);
    setLines(i.lines);
    setFxText(s(i.sheet.fx_rate));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, receipt.id]);

  const items = useMemo(() => new Map(receipt.items.map((i) => [i.id, i])), [receipt.items]);

  const inputs: LandedLineInput[] = useMemo(
    () =>
      lines.map((l) => ({
        id: l.id,
        qty: items.get(l.id)?.qty ?? 0,
        fob_unit: parseNum(l.fob_unit),
        weight_kg: l.weight_kg.trim() ? parseNum(l.weight_kg) : null,
        volume_m3: l.volume_m3.trim() ? parseNum(l.volume_m3) : null,
        duty_pct: l.duty_pct.trim() ? parseNum(l.duty_pct) : null,
      })),
    [lines, items],
  );

  const result = useMemo(() => computeLandedCost(sheet, inputs), [sheet, inputs]);

  const dispatch = normalizeDispatchNumber(sheet.dispatch_number);
  const dispatchShapeOk = !dispatch || /^[0-9A-Z]{16}$/.test(dispatch);
  const dispatchStrictOk = !dispatch || isValidDispatchNumber(dispatch);

  const patchSheet = (p: Partial<LandedSheet>) => setSheet((prev) => ({ ...prev, ...p }));
  const patchLine = (id: string, p: Partial<LineState>) =>
    setLines((prev) => prev.map((l) => (l.id === id ? { ...l, ...p } : l)));

  const canApply = result.lines.length > 0 && sheet.fx_rate > 0 && dispatchShapeOk;

  async function apply() {
    try {
      await applyCosting.mutateAsync({
        receiptId: receipt.id,
        costing: { sheet: { ...sheet, dispatch_number: dispatch || null }, lines: inputs, result: result.totals },
        items: result.lines.map((l) => ({ item_id: l.id, landed_unit_cost: l.landed_unit })),
        dispatchNumber: dispatch || null,
      });
      toast({ title: "Costeo aplicado", description: "Se actualizaron los costos de los productos.", variant: "success" });
      setConfirm(false);
      onOpenChange(false);
    } catch (e) {
      toast({ title: "No se pudo aplicar el costeo", description: purchaseErrorMessage(e), variant: "error" });
    }
  }

  function exportSheet() {
    const cur = sheet.currency;
    void exportXlsx(`costeo-${formatReceiptNumber(receipt.number)}`, [
      {
        name: "Costeo",
        title: `Costeo de importación ${formatReceiptNumber(receipt.number)}${dispatch ? ` · Despacho ${dispatch}` : ""}`,
        columns: [
          { header: "Producto", key: "producto", width: 30 },
          { header: "Cantidad", key: "qty", type: "number" },
          { header: `FOB (${cur})`, key: "fob", type: "number" },
          { header: `Flete (${cur})`, key: "freight", type: "number" },
          { header: `Seguro (${cur})`, key: "insurance", type: "number" },
          { header: `CIF (${cur})`, key: "cif", type: "number" },
          { header: "CIF $", key: "cif_ars", type: "money" },
          { header: "Derechos $", key: "duty", type: "money" },
          { header: "Tasa de estadística $", key: "statistics", type: "money" },
          { header: "Otros tributos $", key: "other", type: "money" },
          { header: "Gastos $", key: "expenses", type: "money" },
          { header: "Total puesto en depósito $", key: "landed", type: "money" },
          { header: "Unitario $", key: "unit", type: "money" },
        ],
        rows: result.lines.map((l) => {
          const it = items.get(l.id);
          return {
            producto: it ? (it.variant_label ? `${it.product_name} (${it.variant_label})` : it.product_name) : "",
            qty: l.qty,
            fob: l.fob,
            freight: l.freight,
            insurance: l.insurance,
            cif: l.cif,
            cif_ars: l.cif_ars,
            duty: l.duty,
            statistics: l.statistics,
            other: l.other_taxes,
            expenses: l.expenses,
            landed: l.landed_total,
            unit: l.landed_unit,
          };
        }),
        totals: {
          fob: result.totals.fob,
          freight: result.totals.freight,
          insurance: result.totals.insurance,
          cif: result.totals.cif,
          cif_ars: result.totals.cif_ars,
          duty: result.totals.duty,
          statistics: result.totals.statistics,
          other: result.totals.other_taxes,
          expenses: result.totals.expenses,
          landed: result.totals.landed,
        },
      },
      {
        name: "Crédito fiscal",
        title: "Crédito fiscal y pagos a cuenta (no se suman al costo)",
        columns: [
          { header: "Concepto", key: "c", width: 30 },
          { header: "%", key: "pct", type: "number" },
          { header: "Importe $", key: "amount", type: "money" },
        ],
        rows: result.totals.credit_taxes.map((c) => ({ c: c.description, pct: c.pct, amount: c.amount })),
        totals: { amount: result.totals.credit_total },
      },
    ]);
  }

  const numInput = (value: string, onChange: (v: string) => void, label: string, className?: string) => (
    <input
      aria-label={label}
      inputMode="decimal"
      className={cn(inputCls, "h-9 text-right tabular-nums", className)}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`Costeo de importación · ${formatReceiptNumber(receipt.number)}`}
      description="Del FOB al costo unitario puesto en depósito. El crédito fiscal no se suma al costo."
      className="sm:max-w-6xl"
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm">
            Puesto en depósito: <b className="tabular-nums">{formatCurrency(result.totals.landed)}</b>
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={exportSheet} disabled={result.lines.length === 0}>
              <Download size={15} /> XLSX
            </Button>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button onClick={() => setConfirm(true)} disabled={!canApply}>
              Aplicar costeo
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-5">
        {/* Valores en origen y tipo de cambio */}
        <section className="grid gap-3 sm:grid-cols-4">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Moneda de origen</span>
            <select
              className={cn(selectCls, "h-10")}
              value={sheet.currency}
              onChange={(e) => patchSheet({ currency: e.target.value })}
            >
              {CURRENCIES.filter((c) => c !== "ARS").map((c) => (
                <option key={c} value={c} className="bg-popover text-popover-foreground">
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Tipo de cambio del despacho</span>
            <input
              inputMode="decimal"
              className={inputCls}
              value={fxText}
              onChange={(e) => {
                setFxText(e.target.value);
                patchSheet({ fx_rate: parseNum(e.target.value) });
              }}
            />
          </label>
          <label className="block sm:col-span-2">
            <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
              N° de despacho (AAaaaTTTTnnnnnnX)
            </span>
            <input
              className={cn(inputCls, "font-mono uppercase")}
              value={sheet.dispatch_number ?? ""}
              maxLength={24}
              placeholder="24001IC04123456K"
              onChange={(e) => patchSheet({ dispatch_number: e.target.value })}
            />
            {!dispatchShapeOk && (
              <span className="mt-1 block text-xs text-danger">Tiene que tener 16 letras o números.</span>
            )}
            {dispatchShapeOk && !dispatchStrictOk && (
              <span className="mt-1 block text-xs text-warning">
                No tiene la forma habitual (año, aduana, tipo, número y letra). Revisalo.
              </span>
            )}
          </label>
        </section>

        <section className="grid gap-3 lg:grid-cols-2">
          <ConceptRow
            label={`Flete internacional (${sheet.currency})`}
            amount={sheet.freight.amount}
            prorate={sheet.freight.prorate}
            onChange={(v) => patchSheet({ freight: v })}
          />
          <ConceptRow
            label={`Seguro (${sheet.currency})`}
            amount={sheet.insurance.amount}
            prorate={sheet.insurance.prorate}
            onChange={(v) => patchSheet({ insurance: v })}
          />
        </section>

        <section className="grid gap-3 sm:grid-cols-3">
          <PctField
            label="Derechos de importación % (por defecto)"
            value={sheet.duty_pct}
            onChange={(v) => patchSheet({ duty_pct: v })}
          />
          <PctField
            label="Tasa de estadística %"
            value={sheet.statistics_pct}
            onChange={(v) => patchSheet({ statistics_pct: v })}
          />
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Tope de la tasa en $ (opcional)</span>
            <input
              inputMode="decimal"
              className={inputCls}
              defaultValue={s(sheet.statistics_cap_ars)}
              key={`cap-${receipt.id}-${open}`}
              onChange={(e) =>
                patchSheet({ statistics_cap_ars: e.target.value.trim() ? parseNum(e.target.value) : null })
              }
            />
          </label>
        </section>

        <PctList
          title="Otros tributos que son costo (% sobre CIF)"
          items={sheet.other_cost_taxes}
          onChange={(v) => patchSheet({ other_cost_taxes: v })}
          addLabel="Agregar tributo"
        />

        {/* Gastos de nacionalización */}
        <section className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Gastos de nacionalización en pesos (netos de IVA)
            </h4>
            <div className="flex flex-wrap gap-1.5">
              {EXPENSE_CHIPS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className="rounded-md bg-muted px-2.5 py-1 text-xs transition hover:bg-muted/70"
                  onClick={() =>
                    patchSheet({
                      expenses: [
                        ...sheet.expenses,
                        { description: c, amount_ars: 0, prorate: c === "Flete interno" ? "weight" : "value" },
                      ],
                    })
                  }
                >
                  <Plus size={11} className="mr-0.5 inline" /> {c}
                </button>
              ))}
            </div>
          </div>
          {sheet.expenses.length === 0 && (
            <p className="text-xs text-muted-foreground">Sin gastos cargados.</p>
          )}
          {sheet.expenses.map((e, idx) => (
            <div key={`${idx}-${sheet.expenses.length}`} className="grid grid-cols-[1fr_8rem_9rem_auto] gap-2">
              <input
                aria-label="Concepto"
                className={cn(inputCls, "h-9")}
                value={e.description}
                onChange={(ev) => {
                  const next = [...sheet.expenses];
                  next[idx] = { ...e, description: ev.target.value };
                  patchSheet({ expenses: next });
                }}
              />
              <input
                aria-label="Importe"
                inputMode="decimal"
                className={cn(inputCls, "h-9 text-right")}
                defaultValue={s(e.amount_ars || null)}
                onChange={(ev) => {
                  const next = [...sheet.expenses];
                  next[idx] = { ...e, amount_ars: parseNum(ev.target.value) };
                  patchSheet({ expenses: next });
                }}
              />
              <ProrateSelect
                value={e.prorate}
                onChange={(p) => {
                  const next = [...sheet.expenses];
                  next[idx] = { ...e, prorate: p };
                  patchSheet({ expenses: next });
                }}
              />
              <Button
                size="sm"
                variant="ghost"
                aria-label="Quitar"
                onClick={() => patchSheet({ expenses: sheet.expenses.filter((_, i) => i !== idx) })}
              >
                <Trash2 size={14} />
              </Button>
            </div>
          ))}
        </section>

        {/* Líneas */}
        <section className="space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Líneas</h4>
          <div className="overflow-x-auto rounded-xl ring-1 ring-border">
            <table className="w-full text-xs">
              <thead className="bg-muted/60 text-muted-foreground">
                <tr>
                  <th className="px-2 py-2 text-left">Producto</th>
                  <th className="px-2 py-2 text-right">Cant.</th>
                  <th className="px-2 py-2 text-right">FOB unit. ({sheet.currency})</th>
                  <th className="px-2 py-2 text-right">Peso kg</th>
                  <th className="px-2 py-2 text-right">Vol. m³</th>
                  <th className="px-2 py-2 text-right">Derechos %</th>
                  <th className="px-2 py-2 text-right">CIF</th>
                  <th className="px-2 py-2 text-right">CIF $</th>
                  <th className="px-2 py-2 text-right">Derechos</th>
                  <th className="px-2 py-2 text-right">Tasa</th>
                  <th className="px-2 py-2 text-right">Otros</th>
                  <th className="px-2 py-2 text-right">Gastos</th>
                  <th className="px-2 py-2 text-right">Total $</th>
                  <th className="px-2 py-2 text-right">Unitario $</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {lines.map((l) => {
                  const it = items.get(l.id);
                  const r = result.lines.find((x) => x.id === l.id);
                  const prev = it?.valued_unit_cost ?? 0;
                  const variation = r && prev > 0 ? ((r.landed_unit - prev) / prev) * 100 : null;
                  return (
                    <tr key={l.id}>
                      <td className="px-2 py-1.5">
                        <div className="max-w-[12rem] truncate font-medium">
                          {it?.product_name}
                          {it?.variant_label ? ` (${it.variant_label})` : ""}
                        </div>
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{formatQty(it?.qty ?? 0)}</td>
                      <td className="px-2 py-1.5">
                        {numInput(l.fob_unit, (v) => patchLine(l.id, { fob_unit: v }), "FOB unitario", "w-24")}
                      </td>
                      <td className="px-2 py-1.5">
                        {numInput(l.weight_kg, (v) => patchLine(l.id, { weight_kg: v }), "Peso", "w-20")}
                      </td>
                      <td className="px-2 py-1.5">
                        {numInput(l.volume_m3, (v) => patchLine(l.id, { volume_m3: v }), "Volumen", "w-20")}
                      </td>
                      <td className="px-2 py-1.5">
                        {numInput(l.duty_pct, (v) => patchLine(l.id, { duty_pct: v }), "Derechos", "w-16")}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{r ? formatMoney(r.cif, sheet.currency) : ""}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{r ? formatCurrency(r.cif_ars) : ""}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{r ? formatCurrency(r.duty) : ""}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{r ? formatCurrency(r.statistics) : ""}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{r ? formatCurrency(r.other_taxes) : ""}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{r ? formatCurrency(r.expenses) : ""}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{r ? formatCurrency(r.landed_total) : ""}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        {r && (
                          <>
                            <div className="font-semibold">{formatCurrency(r.landed_unit)}</div>
                            <div className="text-[11px] text-muted-foreground">
                              antes {formatCurrency(prev)}
                              {variation != null && (
                                <span className={cn("ml-1", variation > 0 ? "text-warning" : "text-success")}>
                                  {variation > 0 ? "+" : ""}
                                  {variation.toFixed(1).replace(".", ",")} %
                                </span>
                              )}
                            </div>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="bg-muted/40 font-semibold">
                <tr>
                  <td className="px-2 py-2" colSpan={6}>
                    Total
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">{formatMoney(result.totals.cif, sheet.currency)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{formatCurrency(result.totals.cif_ars)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{formatCurrency(result.totals.duty)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{formatCurrency(result.totals.statistics)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{formatCurrency(result.totals.other_taxes)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{formatCurrency(result.totals.expenses)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{formatCurrency(result.totals.landed)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">
            FOB {formatMoney(result.totals.fob, sheet.currency)} + flete{" "}
            {formatMoney(result.totals.freight, sheet.currency)} + seguro{" "}
            {formatMoney(result.totals.insurance, sheet.currency)} = CIF{" "}
            {formatMoney(result.totals.cif, sheet.currency)}. Peso y volumen son totales de la línea.
          </p>
        </section>

        {result.warnings.length > 0 && (
          <Callout tone="warning" icon={TriangleAlert} title="Revisá">
            <ul className="list-disc pl-4">
              {result.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </Callout>
        )}

        {/* Crédito fiscal informativo */}
        <section className="space-y-2 rounded-xl bg-muted p-3.5">
          <h4 className="text-sm font-semibold">Crédito fiscal y pagos a cuenta: no se suma al costo</h4>
          <p className="text-xs text-muted-foreground">
            Informativo, sobre CIF + derechos + tasa ({formatCurrency(result.totals.vat_base)}). Lo computable se
            recupera en las declaraciones juradas.
          </p>
          <PctList
            title=""
            items={sheet.credit_taxes}
            onChange={(v) => patchSheet({ credit_taxes: v })}
            addLabel="Agregar concepto"
            amounts={result.totals.credit_taxes.map((c) => c.amount)}
          />
          <div className="text-right text-sm">
            Total crédito fiscal: <b className="tabular-nums">{formatCurrency(result.totals.credit_total)}</b>
          </div>
        </section>
      </div>

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="¿Aplicar el costeo?"
        description="Cada línea pasa a valer su costo puesto en depósito: se ajusta el costo promedio ponderado con la diferencia sobre el stock actual y, si es la última compra del producto, también el último costo. El n° de despacho queda en el lote. Podés volver a aplicarlo si cambian los gastos."
        confirmLabel="Aplicar costeo"
        loading={applyCosting.isPending}
        onConfirm={() => void apply()}
      />
    </Modal>
  );
}

function ProrateSelect({ value, onChange }: { value: ProrateBy; onChange: (p: ProrateBy) => void }) {
  return (
    <select
      aria-label="Base de prorrateo"
      className={cn(selectCls, "h-9 px-2")}
      value={value}
      onChange={(e) => onChange(e.target.value as ProrateBy)}
    >
      {PRORATES.map((p) => (
        <option key={p} value={p} className="bg-popover text-popover-foreground">
          {PRORATE_LABEL[p]}
        </option>
      ))}
    </select>
  );
}

function ConceptRow({
  label,
  amount,
  prorate,
  onChange,
}: {
  label: string;
  amount: number;
  prorate: ProrateBy;
  onChange: (v: { amount: number; prorate: ProrateBy }) => void;
}) {
  const [text, setText] = useState(s(amount || null));
  useEffect(() => {
    if (parseNum(text) !== amount) setText(s(amount || null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount]);
  return (
    <div>
      <span className="mb-1.5 block text-xs font-medium text-muted-foreground">{label}</span>
      <div className="grid grid-cols-[1fr_9rem] gap-2">
        <input
          inputMode="decimal"
          aria-label={label}
          className={inputCls}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            onChange({ amount: parseNum(e.target.value), prorate });
          }}
        />
        <ProrateSelect value={prorate} onChange={(p) => onChange({ amount, prorate: p })} />
      </div>
    </div>
  );
}

function PctField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  const [text, setText] = useState(s(value));
  useEffect(() => {
    if (parseNum(text) !== value) setText(s(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-muted-foreground">{label}</span>
      <input
        inputMode="decimal"
        className={inputCls}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange(parseNum(e.target.value));
        }}
      />
    </label>
  );
}

function PctList({
  title,
  items,
  onChange,
  addLabel,
  amounts,
}: {
  title: string;
  items: Array<{ description: string; pct: number }>;
  onChange: (v: Array<{ description: string; pct: number }>) => void;
  addLabel: string;
  amounts?: number[];
}) {
  return (
    <section className="space-y-2">
      {title && (
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h4>
      )}
      {items.map((t, idx) => (
        <div key={`${idx}-${items.length}`} className="grid grid-cols-[1fr_6rem_auto] items-center gap-2 sm:grid-cols-[1fr_6rem_9rem_auto]">
          <input
            aria-label="Concepto"
            className={cn(inputCls, "h-9")}
            value={t.description}
            onChange={(e) => {
              const next = [...items];
              next[idx] = { ...t, description: e.target.value };
              onChange(next);
            }}
          />
          <input
            aria-label="Porcentaje"
            inputMode="decimal"
            className={cn(inputCls, "h-9 text-right")}
            defaultValue={s(t.pct)}
            onChange={(e) => {
              const next = [...items];
              next[idx] = { ...t, pct: parseNum(e.target.value) };
              onChange(next);
            }}
          />
          {amounts && (
            <span className="hidden text-right text-sm tabular-nums sm:block">{formatCurrency(amounts[idx] ?? 0)}</span>
          )}
          <Button
            size="sm"
            variant="ghost"
            aria-label="Quitar"
            onClick={() => onChange(items.filter((_, i) => i !== idx))}
          >
            <Trash2 size={14} />
          </Button>
        </div>
      ))}
      <Button size="sm" variant="secondary" onClick={() => onChange([...items, { description: "", pct: 0 }])}>
        <Plus size={14} /> {addLabel}
      </Button>
    </section>
  );
}
