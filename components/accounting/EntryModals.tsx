"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ExternalLink, Plus, Trash2, Undo2 } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Modal } from "@/components/ui/Modal";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import { entryTotals } from "@/lib/accounting/journal";
import { round2 } from "@/lib/accounting/vat";
import { ENTRY_KIND_LABEL, accErrorMessage, eventLabel, sourceHref, sourceLabel } from "@/lib/accounting/sources";
import { useAccAccounts, useAccountingMutations, useCostCenters, useEntryLines } from "@/modules/accounting/hooks";
import type { AccEntry } from "@/modules/accounting/api";
import { useStores } from "@/modules/stock/hooks";
import { AccountSelect, fmtDate, inputCls, money, parseNum, today } from "./shared";

/** Detalle de un asiento: renglones, origen y reversión (manuales). */
export function EntryDetailModal({ entry, onOpenChange }: { entry: AccEntry | null; onOpenChange: (o: boolean) => void }) {
  const { toast } = useToast();
  const m = useAccountingMutations();
  const { data: lines = [], isLoading } = useEntryLines(entry?.id ?? null);
  const { data: stores = [] } = useStores();
  const [reversing, setReversing] = useState(false);
  const t = entryTotals(lines);
  const href = sourceHref(entry?.source_type, entry?.source_id);
  const canReverse = entry && (entry.kind === "manual" || entry.kind === "opening") && !entry.reversed_by;

  async function reverse(reason: string) {
    if (!entry) return;
    try {
      await m.reverse.mutateAsync({ id: entry.id, reason });
      toast({ title: "Asiento revertido", variant: "success" });
      setReversing(false);
      onOpenChange(false);
    } catch (e) {
      toast({ title: "No se pudo revertir", description: accErrorMessage(e), variant: "error" });
    }
  }

  return (
    <Modal
      open={Boolean(entry)}
      onOpenChange={onOpenChange}
      title={entry ? `Asiento N° ${entry.official_number ?? entry.number}` : "Asiento"}
      className="sm:max-w-3xl"
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          {href ? (
            <Link href={href as never} className="inline-flex items-center gap-1 text-sm text-ninja-flameSoft hover:underline">
              Ver {sourceLabel(entry?.source_type).toLowerCase()} <ExternalLink size={13} />
            </Link>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            {canReverse && (
              <Button variant="secondary" onClick={() => setReversing(true)}>
                <Undo2 size={15} /> Revertir
              </Button>
            )}
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cerrar
            </Button>
          </div>
        </div>
      }
    >
      {entry && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-semibold">{fmtDate(entry.entry_date)}</span>
            <Badge tone={entry.kind === "auto" ? "info" : entry.kind === "reversal" ? "warning" : "brand"}>
              {ENTRY_KIND_LABEL[entry.kind] ?? entry.kind}
            </Badge>
            {entry.source_type && (
              <Badge tone="neutral">
                {sourceLabel(entry.source_type)} · {eventLabel(entry.source_event)}
              </Badge>
            )}
            {entry.reversed_by && <Badge tone="warning">Revertido</Badge>}
            {entry.store_id && (
              <span className="text-muted-foreground">{stores.find((s) => s.id === entry.store_id)?.name ?? ""}</span>
            )}
          </div>
          <p className="text-sm">{entry.description}</p>
          {entry.official_number && (
            <p className="text-xs text-muted-foreground">N° interno {entry.number} · N° del Diario {entry.official_number}</p>
          )}
          <div className="overflow-x-auto rounded-lg ring-1 ring-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Cuenta</th>
                  <th className="hidden px-3 py-2 sm:table-cell">C. costo</th>
                  <th className="px-3 py-2 text-right">Debe</th>
                  <th className="px-3 py-2 text-right">Haber</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {isLoading && (
                  <tr>
                    <td colSpan={4} className="px-3 py-6 text-center">
                      <Spinner />
                    </td>
                  </tr>
                )}
                {lines.map((l) => (
                  <tr key={l.line_no}>
                    <td className={cn("px-3 py-2", l.credit > 0 && "pl-8")}>
                      <div className="font-medium">
                        <span className="tabular-nums text-muted-foreground">{l.account_code}</span> {l.account_name}
                      </div>
                      {l.description && <div className="text-xs text-muted-foreground">{l.description}</div>}
                    </td>
                    <td className="hidden px-3 py-2 text-muted-foreground sm:table-cell">{l.cost_center_code ?? ""}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{money(l.debit)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{money(l.credit)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-muted/40 font-semibold">
                <tr>
                  <td className="px-3 py-2">Totales</td>
                  <td className="hidden sm:table-cell" />
                  <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(t.debit)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(t.credit)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={reversing}
        onOpenChange={setReversing}
        title="¿Revertir el asiento?"
        description="Se carga un contra-asiento con fecha de hoy. El original no se modifica."
        confirmLabel="Revertir"
        withReason
        loading={m.reverse.isPending}
        onConfirm={(r) => void reverse(r)}
      />
    </Modal>
  );
}

interface DraftLine {
  key: number;
  account_id: string;
  cost_center_id: string;
  debit: string;
  credit: string;
  description: string;
}

const emptyLine = (key: number): DraftLine => ({ key, account_id: "", cost_center_id: "", debit: "", credit: "", description: "" });

/** Asiento manual o de apertura con renglones libres. */
export function ManualEntryModal({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { toast } = useToast();
  const m = useAccountingMutations();
  const { data: accounts = [] } = useAccAccounts(open);
  const { data: centers = [] } = useCostCenters(open);
  const { data: stores = [] } = useStores();
  const [date, setDate] = useState(today());
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<"manual" | "opening">("manual");
  const [storeId, setStoreId] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([emptyLine(1), emptyLine(2)]);

  const totals = useMemo(() => {
    const debit = round2(lines.reduce((t, l) => t + parseNum(l.debit), 0));
    const credit = round2(lines.reduce((t, l) => t + parseNum(l.credit), 0));
    return { debit, credit, diff: round2(debit - credit) };
  }, [lines]);
  const valid =
    description.trim().length > 0 &&
    totals.debit > 0 &&
    totals.diff === 0 &&
    lines.filter((l) => l.account_id && (parseNum(l.debit) || parseNum(l.credit))).length >= 2 &&
    lines.every((l) => !(parseNum(l.debit) && parseNum(l.credit)));

  function update(key: number, patch: Partial<DraftLine>) {
    setLines((p) => p.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function reset() {
    setDate(today());
    setDescription("");
    setKind("manual");
    setStoreId("");
    setLines([emptyLine(1), emptyLine(2)]);
  }

  async function save() {
    try {
      await m.saveManual.mutateAsync({
        date,
        description: description.trim(),
        kind,
        store_id: storeId || null,
        lines: lines
          .filter((l) => l.account_id && (parseNum(l.debit) || parseNum(l.credit)))
          .map((l) => ({
            account_id: l.account_id,
            cost_center_id: l.cost_center_id || null,
            debit: parseNum(l.debit),
            credit: parseNum(l.credit),
            description: l.description.trim() || null,
          })),
      });
      toast({ title: "Asiento guardado", variant: "success" });
      reset();
      onOpenChange(false);
    } catch (e) {
      toast({ title: "No se pudo guardar", description: accErrorMessage(e), variant: "error" });
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Nuevo asiento"
      description="Se guarda inmutable: para corregirlo, se revierte y se carga de nuevo."
      className="sm:max-w-4xl"
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          <div className={cn("text-sm tabular-nums", totals.diff === 0 ? "text-muted-foreground" : "text-danger")}>
            Debe {formatCurrency(totals.debit)} · Haber {formatCurrency(totals.credit)}
            {totals.diff !== 0 && ` · Diferencia ${formatCurrency(totals.diff)}`}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button onClick={() => void save()} disabled={!valid} loading={m.saveManual.isPending}>
              Guardar asiento
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-[160px_1fr_180px_180px]">
          <input type="date" aria-label="Fecha" className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} />
          <input aria-label="Leyenda" placeholder="Leyenda del asiento" className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} />
          <select aria-label="Tipo" className={inputCls} value={kind} onChange={(e) => setKind(e.target.value as "manual" | "opening")}>
            <option value="manual" className="bg-popover text-popover-foreground">Manual</option>
            <option value="opening" className="bg-popover text-popover-foreground">Apertura</option>
          </select>
          <select aria-label="Sucursal" className={inputCls} value={storeId} onChange={(e) => setStoreId(e.target.value)}>
            <option value="" className="bg-popover text-popover-foreground">Sin sucursal</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id} className="bg-popover text-popover-foreground">
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          {lines.map((l) => (
            <div key={l.key} className="grid gap-2 rounded-lg bg-muted/30 p-2 sm:grid-cols-[1fr_120px_120px_120px_36px]">
              <AccountSelect accounts={accounts} value={l.account_id} onChange={(v) => update(l.key, { account_id: v })} />
              <select aria-label="Centro de costo" className={inputCls} value={l.cost_center_id} onChange={(e) => update(l.key, { cost_center_id: e.target.value })}>
                <option value="" className="bg-popover text-popover-foreground">C. costo</option>
                {centers.map((c) => (
                  <option key={c.id} value={c.id} className="bg-popover text-popover-foreground">
                    {c.code} · {c.name}
                  </option>
                ))}
              </select>
              <input aria-label="Debe" inputMode="decimal" placeholder="Debe" className={cn(inputCls, "text-right")} value={l.debit} onChange={(e) => update(l.key, { debit: e.target.value, credit: e.target.value ? "" : l.credit })} />
              <input aria-label="Haber" inputMode="decimal" placeholder="Haber" className={cn(inputCls, "text-right")} value={l.credit} onChange={(e) => update(l.key, { credit: e.target.value, debit: e.target.value ? "" : l.debit })} />
              <Button size="sm" variant="ghost" aria-label="Quitar renglón" disabled={lines.length <= 2} onClick={() => setLines((p) => p.filter((x) => x.key !== l.key))}>
                <Trash2 size={14} />
              </Button>
              <input aria-label="Leyenda del renglón" placeholder="Leyenda del renglón (opcional)" className={cn(inputCls, "sm:col-span-5")} value={l.description} onChange={(e) => update(l.key, { description: e.target.value })} />
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => setLines((p) => [...p, emptyLine(Math.max(...p.map((x) => x.key)) + 1)])}>
            <Plus size={14} /> Renglón
          </Button>
          {totals.diff !== 0 && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                setLines((p) => [
                  ...p,
                  {
                    ...emptyLine(Math.max(...p.map((x) => x.key)) + 1),
                    debit: totals.diff < 0 ? String(-totals.diff) : "",
                    credit: totals.diff > 0 ? String(totals.diff) : "",
                  },
                ])
              }
            >
              Agregar renglón por la diferencia
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
