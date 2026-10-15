"use client";

import { Fragment, useMemo, useRef, useState } from "react";
import { CheckCheck, ChevronDown, CloudDownload, FileUp, Undo2 } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Checkbox } from "@/components/ui/Checkbox";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { TableStateRow, TableWrap } from "@/components/ui/Table";
import { useToast } from "@/components/ui/Toast";
import { nubceoErrorMessage, type NubceoConfig } from "@/modules/integrations/nubceo/api";
import { useNubceoLedger, useNubceoMutations } from "@/modules/integrations/nubceo/hooks";
import { parseLedgerCsv, type LedgerCsvResult } from "@/lib/integrations/nubceo/ledgerCsv";
import { LEDGER_CATEGORY_LABEL } from "@/supabase/functions/_shared/nubceo";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";
import { arDay, fmtDateTime } from "./shared";

type StatusFilter = "all" | "not_confirmed" | "confirmed";

const fmtDate = (d: string) => {
  const [y, m, day] = d.split("-");
  return `${day}/${m}/${y}`;
};

export function NubceoLedger({ config, canWrite }: { config: NubceoConfig; canWrite: boolean }) {
  const { toast } = useToast();
  const m = useNubceoMutations();
  const [from, setFrom] = useState(() => arDay(Date.now() - 30 * 86_400_000));
  const [to, setTo] = useState(() => arDay(Date.now()));
  const [status, setStatus] = useState<StatusFilter>("all");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [csv, setCsv] = useState<{ name: string; result: LedgerCsvResult } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const q = useNubceoLedger({ from, to, status });
  const rows = useMemo(() => q.data ?? [], [q.data]);
  const env = config.settings?.environment ?? "prod";
  const hasCreds = Boolean(config.credentials[env]);
  const s = config.settings;

  const selectable = rows.filter((r) => r.source === "api");
  const selectedIds = selectable.filter((r) => selected.has(r.id)).map((r) => r.nubceo_id);

  const pull = async () => {
    try {
      const r = await m.ledgerImportApi.mutateAsync(null);
      toast({ title: r.ok ? "Asientos actualizados." : "No se pudieron traer", description: r.message, variant: r.ok ? "success" : "error" });
    } catch (e) {
      toast({ title: "No se pudieron traer", description: nubceoErrorMessage(e), variant: "error" });
    }
  };

  const setLedgerStatus = async (st: "confirmed" | "not_confirmed") => {
    try {
      const r = await m.ledgerStatus.mutateAsync({ ids: selectedIds, status: st });
      if (!r.ok) throw new Error(r.error ?? "nubceo_error");
      setSelected(new Set());
      toast({ title: st === "confirmed" ? "Confirmados en NubCeo." : "Vuelven a sin confirmar.", variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo", description: nubceoErrorMessage(e), variant: "error" });
    }
  };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    const text = await f.text();
    setCsv({ name: f.name, result: parseLedgerCsv(text) });
    if (fileRef.current) fileRef.current.value = "";
  };

  const importCsv = async () => {
    if (!csv) return;
    try {
      const r = await m.ledgerImportCsv.mutateAsync(csv.result.headers);
      toast({ title: `${r.headers} asientos importados.`, variant: "success" });
      setCsv(null);
    } catch (e) {
      toast({ title: "No se importaron", description: nubceoErrorMessage(e), variant: "error" });
    }
  };

  const toggle = (set: Set<string>, id: string) => {
    const n = new Set(set);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  };

  return (
    <div className="space-y-5">
      <Callout tone="neutral" title="De dónde salen">
        NubCeo arma los asientos de cada liquidación conciliada y los publica en su API (Contabilidad, ledger headers). Traelos desde
        acá o importá la exportación en CSV. Cada asiento muestra sus renglones con la cuenta, el centro de costo y el importe
        (positivo al Debe, negativo al Haber).
        {s?.ledger_last_import_at && (
          <span className="mt-1 block text-[13px]">
            Última importación: {fmtDateTime(s.ledger_last_import_at)}
            {s.ledger_last_message ? ` · ${s.ledger_last_message}` : ""}
          </span>
        )}
      </Callout>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
        <div className="grid grid-cols-2 gap-2 sm:flex sm:items-end">
          <Input type="date" label="Desde" value={from} onChange={(e) => setFrom(e.target.value)} className="sm:w-[170px]" />
          <Input type="date" label="Hasta" value={to} onChange={(e) => setTo(e.target.value)} className="sm:w-[170px]" />
        </div>
        <Segmented
          size="sm"
          value={status}
          onChange={setStatus}
          aria-label="Estado"
          options={[
            { value: "all", label: "Todos" },
            { value: "not_confirmed", label: "Sin confirmar" },
            { value: "confirmed", label: "Confirmados" },
          ]}
        />
        <div className="flex flex-wrap gap-2 lg:ml-auto">
          <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()} disabled={!canWrite}>
            <FileUp size={15} /> Importar CSV
          </Button>
          <Button size="sm" onClick={pull} disabled={!canWrite || !hasCreds} loading={m.ledgerImportApi.isPending}>
            <CloudDownload size={15} /> Traer de NubCeo
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv,text/plain"
            className="hidden"
            onChange={(e) => onFile(e.target.files?.[0])}
          />
        </div>
      </div>

      {selectedIds.length > 0 && canWrite && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-muted/40 px-4 py-2.5 text-sm">
          <span className="font-medium">{selectedIds.length} seleccionados</span>
          <Button size="sm" onClick={() => setLedgerStatus("confirmed")} loading={m.ledgerStatus.isPending}>
            <CheckCheck size={15} /> Confirmar en NubCeo
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setLedgerStatus("not_confirmed")} disabled={m.ledgerStatus.isPending}>
            <Undo2 size={15} /> Desconfirmar
          </Button>
        </div>
      )}

      <TableWrap>
        <table className="w-full min-w-[760px] text-sm">
          <thead className="sticky top-0 z-10 bg-popover text-left text-xs uppercase tracking-[0.12em] text-muted-foreground">
            <tr className="bg-muted">
              <th className="w-10 px-3 py-2.5" aria-label="Seleccionar" />
              <th className="px-3 py-2.5">Fecha</th>
              <th className="px-3 py-2.5">Asiento</th>
              <th className="px-3 py-2.5">Categoría</th>
              <th className="px-3 py-2.5 text-right">Debe</th>
              <th className="px-3 py-2.5 text-right">Haber</th>
              <th className="px-3 py-2.5">Estado</th>
              <th className="w-10 px-3 py-2.5" aria-label="Ver renglones" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {q.isLoading ? (
              <TableStateRow colSpan={8} loading />
            ) : rows.length === 0 ? (
              <TableStateRow colSpan={8}>
                <p className="text-sm text-muted-foreground">No hay asientos en el período.</p>
              </TableStateRow>
            ) : (
              rows.map((h) => {
                const isOpen = open.has(h.id);
                const balanced = Math.round(h.total_debit * 100) === Math.round(h.total_credit * 100);
                return (
                  <Fragment key={h.id}>
                    <tr className={cn("hover:bg-muted/30", h.deleted_in_nubceo && "text-muted-foreground line-through")}>
                      <td className="px-3 py-2.5">
                        {h.source === "api" && (
                          <Checkbox
                            checked={selected.has(h.id)}
                            aria-label={`Seleccionar asiento ${h.number ?? ""}`}
                            disabled={!canWrite}
                            onCheckedChange={() => setSelected((x) => toggle(x, h.id))}
                          />
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 tabular-nums">{fmtDate(h.entry_date)}</td>
                      <td className="px-3 py-2.5">
                        <p className="font-medium">N° {h.number || "-"}</p>
                        <p className="text-xs text-muted-foreground">{h.source === "api" ? "API" : "CSV"}</p>
                      </td>
                      <td className="px-3 py-2.5">{h.category ? (LEDGER_CATEGORY_LABEL[h.category] ?? h.category) : "-"}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums">{formatCurrency(h.total_debit)}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums">
                        {formatCurrency(h.total_credit)}
                        {!balanced && <span className="ml-1 text-xs text-warning" title="Debe y Haber no cierran">≠</span>}
                      </td>
                      <td className="px-3 py-2.5">
                        <Badge tone={h.status === "confirmed" ? "success" : "neutral"}>
                          {h.status === "confirmed" ? "Confirmado" : "Sin confirmar"}
                        </Badge>
                      </td>
                      <td className="px-3 py-2.5">
                        <button
                          type="button"
                          aria-expanded={isOpen}
                          aria-label={isOpen ? "Ocultar renglones" : "Ver renglones"}
                          onClick={() => setOpen((x) => toggle(x, h.id))}
                          className="grid h-8 w-8 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                          <ChevronDown size={16} className={cn("transition-transform", isOpen && "rotate-180")} />
                        </button>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="bg-muted/20">
                        <td />
                        <td colSpan={7} className="px-3 pb-3 pt-1">
                          <table className="w-full text-[13px]">
                            <thead className="text-left text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                              <tr>
                                <th className="py-1.5 pr-3">Cuenta</th>
                                <th className="py-1.5 pr-3">Centro de costo</th>
                                <th className="py-1.5 pr-3 text-right">Debe</th>
                                <th className="py-1.5 text-right">Haber</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-border/60">
                              {(h.nubceo_ledger_entries ?? []).map((e) => (
                                <tr key={e.id}>
                                  <td className="py-1.5 pr-3">
                                    <span className="font-mono text-xs text-muted-foreground">{e.account_code}</span>{" "}
                                    {e.account_name}
                                    {e.subaccount_code || e.subaccount_name ? (
                                      <span className="text-muted-foreground"> · {e.subaccount_code} {e.subaccount_name}</span>
                                    ) : null}
                                  </td>
                                  <td className="py-1.5 pr-3 text-muted-foreground">{e.cost_center || "-"}</td>
                                  <td className="py-1.5 pr-3 text-right tabular-nums">{e.amount > 0 ? formatCurrency(e.amount) : ""}</td>
                                  <td className="py-1.5 text-right tabular-nums">{e.amount < 0 ? formatCurrency(-e.amount) : ""}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </TableWrap>

      <Modal
        open={Boolean(csv)}
        onOpenChange={(o) => !o && setCsv(null)}
        title="Importar asientos"
        description={csv?.name}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCsv(null)}>
              Cancelar
            </Button>
            <Button onClick={importCsv} disabled={!csv || csv.result.headers.length === 0} loading={m.ledgerImportCsv.isPending}>
              Importar {csv?.result.headers.length ?? 0} asientos
            </Button>
          </div>
        }
      >
        {csv && (
          <div className="space-y-3 text-sm">
            <p>
              {csv.result.rows} renglones en {csv.result.headers.length} asientos. Un asiento que ya estaba (mismo id o mismo número y
              fecha) se reemplaza.
            </p>
            {csv.result.unbalanced.length > 0 && (
              <Callout tone="warning" title="Asientos que no cierran">
                Debe y Haber no coinciden en: {csv.result.unbalanced.slice(0, 12).join(", ")}
                {csv.result.unbalanced.length > 12 ? "…" : ""}. Se importan igual.
              </Callout>
            )}
            {csv.result.errors.length > 0 && (
              <Callout tone="danger" title={`${csv.result.errors.length} problemas`}>
                <ul className="list-disc space-y-0.5 pl-4">
                  {csv.result.errors.slice(0, 8).map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
                {csv.result.errors.length > 8 && <p className="mt-1">Y {csv.result.errors.length - 8} más.</p>}
              </Callout>
            )}
            <p className="text-[13px] text-muted-foreground">
              Columnas que se reconocen: fecha, número (o id), categoría, estado, código y nombre de cuenta, subcuenta, centro de costo y
              Debe y Haber (o un importe con signo).
            </p>
          </div>
        )}
      </Modal>
    </div>
  );
}
NubceoLedger.displayName = "NubceoLedger";
