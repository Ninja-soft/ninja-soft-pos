"use client";

import { useMemo, useState } from "react";
import { Lock, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Select, type SelectOption } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { TableWrap } from "@/components/ui/Table";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { useFeature } from "@/modules/saas/gating";
import { useRolePermissions } from "@/lib/permissions/useRole";
import { formatCurrency } from "@/lib/utils/format";
import { PAYMENT_METHOD_LABELS } from "@/lib/utils/paymentMethods";
import {
  FEE_METHODS,
  describeFeeRule,
  feeTotals,
  validateFeeRule,
  type FeeRule,
  type FeeRuleDraft,
} from "@/lib/payments/feeEstimate";
import {
  feeErrorMessage,
  usePaymentFeeRules,
  usePaymentFeesReport,
  usePaymentProvidersList,
  useRemoveFeeRule,
  useSaveFeeRule,
} from "@/modules/payments/fees";

// Reporte de medios de pago con comisiones estimadas (F8 · ADR-099). Bruto,
// comisión estimada, IVA sobre la comisión y neto por medio, procesador y
// cuotas, más las propinas por medio. Las comisiones las carga el dueño o un
// encargado (lo que le cobra cada procesador); no hace falta conectar nada.

const ALL = "__all__";

function methodLabel(m: string) {
  return PAYMENT_METHOD_LABELS[m] ?? m;
}

export function PaymentFeesSection({
  fromISO,
  toISO,
  storeId,
}: {
  fromISO: string;
  toISO: string;
  storeId: string | null;
}) {
  const enabled = useFeature("comisiones_estimadas");
  const { role } = useRolePermissions();
  const isManager = role === "owner" || role === "manager";
  const ready = enabled === true && isManager;
  const report = usePaymentFeesReport(fromISO, toISO, storeId, ready);
  const providers = usePaymentProvidersList(ready);
  const [editing, setEditing] = useState(false);

  const providerName = useMemo(() => {
    const m = new Map((providers.data ?? []).map((p) => [p.key, p.name]));
    return (k: string | null) => (k ? (m.get(k) ?? k) : null);
  }, [providers.data]);

  if (role && !isManager) return null;

  if (enabled === false) {
    return (
      <section className="rounded-lg border border-border bg-card p-4 sm:p-5 lg:col-span-2">
        <h3 className="text-base font-semibold">Comisiones estimadas por medio de pago</h3>
        <p className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
          <Lock size={14} aria-hidden /> Disponible desde el plan Pro: cuánto te cobra cada procesador y cuánto te queda.
        </p>
      </section>
    );
  }

  const rows = report.data?.rows ?? [];
  const tips = report.data?.tips ?? [];
  const totals = feeTotals(rows);

  return (
    <section className="rounded-lg border border-border bg-card p-4 sm:p-5 lg:col-span-2" aria-labelledby="fees-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id="fees-title" className="text-base font-semibold">
            Comisiones estimadas por medio de pago
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {rows.length === 0
              ? "Sin cobros en el período."
              : `Cobraste ${formatCurrency(totals.gross)}. Comisión estimada ${formatCurrency(
                  totals.fee + totals.vat,
                )}${totals.effectivePct > 0 ? ` (${String(totals.effectivePct).replace(".", ",")} % de lo cobrado con comisión)` : ""}. Te queda ${formatCurrency(totals.net)}.`}
          </p>
          {totals.withoutRule > 0 && (
            <p className="mt-1 text-xs text-warning">
              {totals.withoutRule === 1 ? "Un medio cobrado no tiene" : `${totals.withoutRule} medios cobrados no tienen`} comisión
              cargada: se cuentan sin comisión.
            </p>
          )}
        </div>
        <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
          <Pencil size={14} /> Comisiones
        </Button>
      </div>

      {report.isLoading ? (
        <div className="grid place-items-center py-8">
          <Spinner size={20} />
        </div>
      ) : report.error ? (
        <p className="mt-4 text-sm text-muted-foreground">{feeErrorMessage(report.error)}</p>
      ) : rows.length > 0 ? (
        <TableWrap className="mt-4">
          <table className="w-full min-w-[640px] text-sm tabular-nums">
            <thead className="text-left text-xs text-muted-foreground">
              <tr className="border-b border-border">
                <th className="px-3 py-2 font-medium">Medio</th>
                <th className="px-3 py-2 text-right font-medium">Cobros</th>
                <th className="px-3 py-2 text-right font-medium">Cobrado</th>
                <th className="px-3 py-2 font-medium">Comisión</th>
                <th className="px-3 py-2 text-right font-medium">Comisión + IVA</th>
                <th className="px-3 py-2 text-right font-medium">Neto</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const sub = [providerName(r.provider_key), r.installments ? `${r.installments} cuota${r.installments > 1 ? "s" : ""}` : null]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <tr key={`${r.method}|${r.provider_key ?? ""}|${r.installments ?? ""}`} className="border-b border-border last:border-0">
                    <td className="px-3 py-2">
                      <div className="font-medium">{methodLabel(r.method)}</div>
                      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
                    </td>
                    <td className="px-3 py-2 text-right">{r.count}</td>
                    <td className="px-3 py-2 text-right">{formatCurrency(r.gross)}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {r.rule_id ? describeFeeRule(r) : "Sin cargar"}
                    </td>
                    <td className="px-3 py-2 text-right">{formatCurrency(r.fee + r.vat)}</td>
                    <td className="px-3 py-2 text-right font-medium">{formatCurrency(r.net)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableWrap>
      ) : null}

      {tips.length > 0 && (
        <div className="mt-4">
          <h4 className="text-sm font-semibold">Propinas por medio</h4>
          <ul className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {tips.map((t) => (
              <li key={t.method} className="flex items-center justify-between rounded-md bg-muted/40 px-3 py-2 text-sm">
                <span>
                  {methodLabel(t.method)} <span className="text-xs text-muted-foreground">· {t.count}</span>
                </span>
                <span className="font-medium tabular-nums">{formatCurrency(t.amount)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="mt-3 text-xs text-muted-foreground">
        Es una estimación con las comisiones que cargaste. Lo que te liquidó cada procesador está en Conciliación.
      </p>

      <FeeRulesModal open={editing} onOpenChange={setEditing} providerName={providerName} providers={providers.data ?? []} />
    </section>
  );
}

const EMPTY: FeeRuleDraft = {
  method: "credit",
  provider_key: null,
  installments: null,
  fee_pct: 0,
  fixed_fee: 0,
  vat_on_fee: true,
  note: null,
};

function FeeRulesModal({
  open,
  onOpenChange,
  providerName,
  providers,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  providerName: (k: string | null) => string | null;
  providers: { key: string; name: string }[];
}) {
  const { toast } = useToast();
  const rules = usePaymentFeeRules(open);
  const save = useSaveFeeRule();
  const remove = useRemoveFeeRule();
  const [draft, setDraft] = useState<(FeeRuleDraft & { id?: string }) | null>(null);
  const [pct, setPct] = useState("");
  const [fixed, setFixed] = useState("");
  const [cuotas, setCuotas] = useState("");

  function edit(r: FeeRule | null) {
    const d = r
      ? {
          id: r.id,
          method: r.method,
          provider_key: r.provider_key,
          installments: r.installments,
          fee_pct: r.fee_pct,
          fixed_fee: r.fixed_fee,
          vat_on_fee: r.vat_on_fee,
          note: r.note ?? null,
        }
      : { ...EMPTY };
    setDraft(d);
    setPct(d.fee_pct ? String(d.fee_pct).replace(".", ",") : "");
    setFixed(d.fixed_fee ? String(d.fixed_fee).replace(".", ",") : "");
    setCuotas(d.installments ? String(d.installments) : "");
  }

  const parse = (s: string) => (s.trim() === "" ? 0 : Number(s.replace(",", ".")));

  async function submit() {
    if (!draft) return;
    const next: FeeRuleDraft & { id?: string } = {
      ...draft,
      fee_pct: parse(pct),
      fixed_fee: parse(fixed),
      installments: cuotas.trim() === "" ? null : Number(cuotas),
      note: draft.note?.trim() ? draft.note.trim() : null,
    };
    const err = validateFeeRule(next);
    if (err) {
      toast({ title: err, variant: "error" });
      return;
    }
    try {
      await save.mutateAsync(next);
      toast({ title: "Comisión guardada", variant: "success" });
      setDraft(null);
    } catch (e) {
      toast({ title: feeErrorMessage(e), variant: "error" });
    }
  }

  async function drop(id: string) {
    try {
      await remove.mutateAsync(id);
      toast({ title: "Comisión quitada", variant: "success" });
    } catch (e) {
      toast({ title: feeErrorMessage(e), variant: "error" });
    }
  }

  const methodOptions: SelectOption<string>[] = FEE_METHODS.map((m) => ({ value: m, label: methodLabel(m) }));
  const providerOptions: SelectOption<string>[] = [
    { value: ALL, label: "Cualquier procesador" },
    ...providers.map((p) => ({ value: p.key, label: p.name })),
  ];

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o) setDraft(null);
        onOpenChange(o);
      }}
      title="Comisiones por medio de pago"
      description="Lo que te cobra cada procesador. La más específica gana: procesador y cuotas, después procesador, después cuotas, después la general del medio."
      footer={
        draft ? (
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDraft(null)}>
              Volver
            </Button>
            <Button onClick={submit} disabled={save.isPending}>
              {save.isPending ? <Spinner size={14} /> : null} Guardar
            </Button>
          </div>
        ) : (
          <div className="flex justify-end">
            <Button onClick={() => edit(null)}>
              <Plus size={14} /> Agregar comisión
            </Button>
          </div>
        )
      }
    >
      {draft ? (
        <div className="space-y-4">
          <Select
            label="Medio"
            value={draft.method}
            options={methodOptions}
            onChange={(v) => setDraft({ ...draft, method: v })}
          />
          <Select
            label="Procesador"
            value={draft.provider_key ?? ALL}
            options={providerOptions}
            onChange={(v) => setDraft({ ...draft, provider_key: v === ALL ? null : v })}
          />
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Comisión %"
              inputMode="decimal"
              value={pct}
              onChange={(e) => setPct(e.target.value)}
              placeholder="0"
            />
            <Input
              label="Fijo por cobro $"
              inputMode="decimal"
              value={fixed}
              onChange={(e) => setFixed(e.target.value)}
              placeholder="0"
            />
          </div>
          <Input
            label="Cuotas (vacío = todas)"
            inputMode="numeric"
            value={cuotas}
            onChange={(e) => setCuotas(e.target.value.replace(/\D/g, "").slice(0, 2))}
            placeholder="Todas"
            hint="Sólo para débito y crédito, según el cupón."
          />
          <Switch
            checked={draft.vat_on_fee}
            onCheckedChange={(v) => setDraft({ ...draft, vat_on_fee: v })}
            label="Sumar IVA (21 %) sobre la comisión"
          />
          <Input
            label="Nota (opcional)"
            maxLength={120}
            value={draft.note ?? ""}
            onChange={(e) => setDraft({ ...draft, note: e.target.value })}
          />
        </div>
      ) : rules.isLoading ? (
        <div className="grid place-items-center py-8">
          <Spinner size={20} />
        </div>
      ) : (rules.data ?? []).length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Todavía no cargaste comisiones. Agregá la de cada medio (por ejemplo, crédito 3,5 % + IVA) y el reporte calcula
          cuánto te queda.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {(rules.data ?? []).map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0 text-sm">
                <div className="font-medium">
                  {methodLabel(r.method)}
                  {r.provider_key ? ` · ${providerName(r.provider_key)}` : ""}
                  {r.installments ? ` · ${r.installments} cuota${r.installments > 1 ? "s" : ""}` : ""}
                </div>
                <div className="text-xs text-muted-foreground">
                  {describeFeeRule(r)}
                  {r.note ? ` · ${r.note}` : ""}
                </div>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button variant="ghost" size="sm" aria-label="Editar" onClick={() => edit(r)}>
                  <Pencil size={14} />
                </Button>
                <Button variant="ghost" size="sm" aria-label="Quitar" onClick={() => drop(r.id)} disabled={remove.isPending}>
                  <Trash2 size={14} />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
PaymentFeesSection.displayName = "PaymentFeesSection";
