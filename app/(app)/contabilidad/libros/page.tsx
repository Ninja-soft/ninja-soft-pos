"use client";

import { useCallback, useMemo, useState } from "react";
import { BookText, FileDown, FileSpreadsheet } from "lucide-react";
import { PageContainer } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { EmptyState } from "@/components/ui/EmptyState";
import { Segmented } from "@/components/ui/Segmented";
import { Spinner } from "@/components/ui/Spinner";
import { TableWrap } from "@/components/ui/Table";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import { exportXlsx, type XlsxSheet } from "@/lib/utils/xlsx";
import {
  groupEntries,
  incomeStatement,
  ledgerRows,
  rollupTrialBalance,
  trialTotals,
  type JournalEntry,
} from "@/lib/accounting/journal";
import { round2 } from "@/lib/accounting/vat";
import { AccountSelect, AccountingFrame, RangeFields, currentMonthRange, fmtDate, money, selectCls } from "@/components/accounting/shared";
import { ExportModal } from "@/components/accounting/ExportModal";
import {
  useAccAccounts,
  useJournal,
  useTrialBalance,
  useVatPurchases,
  useVatSales,
} from "@/modules/accounting/hooks";
import { useStores } from "@/modules/stock/hooks";

type Book = "diario" | "mayor" | "sumas" | "resultados" | "iva_ventas" | "iva_compras";

// Libros (ADR-066): Diario, Mayor, sumas y saldos, estado de resultados e
// IVA ventas y compras, con XLSX y export al estudio.
export default function LibrosPage() {
  return (
    <PageContainer size="2xl">
      <AccountingFrame title="Libros" description="Diario, Mayor, sumas y saldos, resultados e IVA del período, para ver o mandar al estudio.">
        <Books />
      </AccountingFrame>
    </PageContainer>
  );
}

function Books() {
  const [book, setBook] = useState<Book>("diario");
  const [range, setRange] = useState(currentMonthRange());
  const [storeId, setStoreId] = useState("");
  const { data: stores = [] } = useStores();
  const storeName = useCallback((id: string | null) => stores.find((s) => s.id === id)?.name ?? "", [stores]);
  const valid = Boolean(range.from && range.to && range.from <= range.to);

  return (
    <div className="mt-5 space-y-4">
      <Segmented<Book>
        aria-label="Libro"
        size="sm"
        value={book}
        onChange={setBook}
        options={[
          { value: "diario", label: "Diario" },
          { value: "mayor", label: "Mayor" },
          { value: "sumas", label: "Sumas y saldos" },
          { value: "resultados", label: "Resultados" },
          { value: "iva_ventas", label: "IVA Ventas" },
          { value: "iva_compras", label: "IVA Compras" },
        ]}
      />
      <div className="flex flex-wrap items-center gap-2">
        <RangeFields from={range.from} to={range.to} onChange={setRange} />
        {book !== "iva_compras" && book !== "iva_ventas" && (
          <select aria-label="Sucursal" className={cn(selectCls, "h-10 w-auto")} value={storeId} onChange={(e) => setStoreId(e.target.value)}>
            <option value="" className="bg-popover text-popover-foreground">Todas las sucursales</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id} className="bg-popover text-popover-foreground">
                {s.name}
              </option>
            ))}
          </select>
        )}
      </div>
      {!valid && <p className="text-sm text-danger">Elegí un rango válido.</p>}
      {valid && book === "diario" && <Diario range={range} storeId={storeId || null} storeName={storeName} />}
      {valid && book === "mayor" && <Mayor range={range} storeId={storeId || null} />}
      {valid && book === "sumas" && <Sumas range={range} storeId={storeId || null} />}
      {valid && book === "resultados" && <Resultados range={range} storeId={storeId || null} />}
      {valid && book === "iva_ventas" && <IvaVentas range={range} storeName={storeName} />}
      {valid && book === "iva_compras" && <IvaCompras range={range} />}
    </div>
  );
}

type Range = { from: string; to: string };

function Loading() {
  return (
    <div className="flex justify-center py-10">
      <Spinner />
    </div>
  );
}

function fileBase(prefix: string, r: Range) {
  return `${prefix}-${r.from}-a-${r.to}`;
}

// ── Diario ─────────────────────────────────────────────────────────────────

function Diario({ range, storeId, storeName }: { range: Range; storeId: string | null; storeName: (id: string | null) => string }) {
  const { data: lines = [], isLoading } = useJournal({ ...range, storeId });
  const entries = useMemo(() => groupEntries(lines), [lines]);
  const [limit, setLimit] = useState(200);
  const [exportOpen, setExportOpen] = useState(false);
  const totals = useMemo(
    () => ({ debit: round2(entries.reduce((t, e) => t + e.debit, 0)), credit: round2(entries.reduce((t, e) => t + e.credit, 0)) }),
    [entries],
  );

  function xlsx() {
    const rows = lines.map((l) => ({
      numero: l.official_number ?? l.number,
      fecha: l.entry_date,
      leyenda: l.entry_description,
      cuenta: l.account_code,
      nombre: l.account_name,
      externo: l.account_external_code ?? "",
      cc: l.cost_center_code ?? "",
      debe: l.debit,
      haber: l.credit,
      detalle: l.description ?? "",
    }));
    void exportXlsx(fileBase("libro-diario", range), [
      {
        name: "Diario",
        title: `Libro Diario del ${fmtDate(range.from)} al ${fmtDate(range.to)}`,
        columns: [
          { header: "N°", key: "numero", type: "number", width: 8 },
          { header: "Fecha", key: "fecha", type: "date", width: 12 },
          { header: "Leyenda", key: "leyenda", width: 40 },
          { header: "Cuenta", key: "cuenta", width: 14 },
          { header: "Nombre", key: "nombre", width: 34 },
          { header: "Código externo", key: "externo", width: 14 },
          { header: "C. costo", key: "cc", width: 10 },
          { header: "Debe", key: "debe", type: "money", width: 14 },
          { header: "Haber", key: "haber", type: "money", width: 14 },
          { header: "Detalle", key: "detalle", width: 28 },
        ],
        rows,
        totals: { debe: totals.debit, haber: totals.credit },
      },
    ]);
  }

  if (isLoading) return <Loading />;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm text-muted-foreground">
          {entries.length} asientos · Debe {formatCurrency(totals.debit)} · Haber {formatCurrency(totals.credit)}
        </span>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={xlsx} disabled={!lines.length}>
            <FileSpreadsheet size={14} /> XLSX
          </Button>
          <Button size="sm" onClick={() => setExportOpen(true)} disabled={!lines.length}>
            <FileDown size={14} /> Exportar para el estudio
          </Button>
        </div>
      </div>
      {entries.length === 0 && <EmptyState icon={BookText} title="Sin asientos en el rango" />}
      <div className="space-y-3">
        {entries.slice(0, limit).map((e) => (
          <DiaryEntry key={e.entry_id} e={e} />
        ))}
      </div>
      {entries.length > limit && (
        <div className="text-center">
          <Button variant="secondary" size="sm" onClick={() => setLimit((l) => l + 200)}>
            Ver más ({entries.length - limit} restantes)
          </Button>
        </div>
      )}
      <ExportModal open={exportOpen} onOpenChange={setExportOpen} lines={lines} baseName={fileBase("asientos", range)} storeName={storeName} />
    </div>
  );
}

function DiaryEntry({ e }: { e: JournalEntry }) {
  return (
    <div className="overflow-hidden rounded-xl bg-card ring-1 ring-border">
      <div className="flex flex-wrap items-baseline justify-between gap-2 bg-muted/40 px-4 py-2 text-sm">
        <div>
          <span className="font-semibold tabular-nums">N° {e.official_number ?? e.number}</span>
          <span className="ml-3 text-muted-foreground">{fmtDate(e.entry_date)}</span>
          <span className="ml-3">{e.description}</span>
        </div>
      </div>
      <table className="w-full text-sm">
        <tbody className="divide-y divide-border">
          {e.lines.map((l) => (
            <tr key={l.line_no}>
              <td className={cn("px-4 py-1.5", l.credit > 0 && "pl-12")}>
                <span className="tabular-nums text-muted-foreground">{l.account_code}</span> {l.account_name}
                {l.cost_center_code && <span className="ml-2 text-xs text-muted-foreground">{l.cost_center_code}</span>}
              </td>
              <td className="w-36 px-4 py-1.5 text-right tabular-nums">{money(l.debit)}</td>
              <td className="w-36 px-4 py-1.5 text-right tabular-nums">{money(l.credit)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Mayor ──────────────────────────────────────────────────────────────────

function Mayor({ range, storeId }: { range: Range; storeId: string | null }) {
  const { data: accounts = [] } = useAccAccounts();
  const [accountId, setAccountId] = useState("");
  const trial = useTrialBalance({ ...range, storeId }, Boolean(accountId));
  const journal = useJournal({ ...range, storeId, accountId }, Boolean(accountId));
  const opening = trial.data?.find((r) => r.account_id === accountId)?.opening ?? 0;
  const rows = useMemo(() => ledgerRows(journal.data ?? [], opening), [journal.data, opening]);
  const account = accounts.find((a) => a.id === accountId);

  function xlsx() {
    if (!account) return;
    void exportXlsx(fileBase(`mayor-${account.code}`, range), [
      {
        name: "Mayor",
        title: `Mayor ${account.code} ${account.name} · saldo anterior ${formatCurrency(opening)}`,
        columns: [
          { header: "Fecha", key: "fecha", type: "date", width: 12 },
          { header: "N°", key: "numero", type: "number", width: 8 },
          { header: "Leyenda", key: "leyenda", width: 44 },
          { header: "Debe", key: "debe", type: "money", width: 14 },
          { header: "Haber", key: "haber", type: "money", width: 14 },
          { header: "Saldo", key: "saldo", type: "money", width: 14 },
        ],
        rows: rows.map((r) => ({
          fecha: r.entry_date,
          numero: r.official_number ?? r.number,
          leyenda: r.detail ? `${r.description} · ${r.detail}` : r.description,
          debe: r.debit,
          haber: r.credit,
          saldo: r.balance,
        })),
      },
    ]);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-[260px] flex-1">
          <AccountSelect accounts={accounts} value={accountId} onChange={setAccountId} placeholder="Elegí la cuenta" />
        </div>
        <Button size="sm" variant="secondary" onClick={xlsx} disabled={!rows.length}>
          <FileSpreadsheet size={14} /> XLSX
        </Button>
      </div>
      {!accountId && <EmptyState icon={BookText} title="Elegí una cuenta para ver su Mayor" />}
      {accountId && (trial.isLoading || journal.isLoading) && <Loading />}
      {accountId && !journal.isLoading && (
        <TableWrap>
          <table className="w-full text-sm">
            <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Fecha</th>
                <th className="px-4 py-3">Leyenda</th>
                <th className="px-4 py-3 text-right">Debe</th>
                <th className="px-4 py-3 text-right">Haber</th>
                <th className="px-4 py-3 text-right">Saldo</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              <tr className="bg-muted/30">
                <td className="px-4 py-2" />
                <td className="px-4 py-2 font-medium">Saldo anterior</td>
                <td />
                <td />
                <td className="px-4 py-2 text-right font-semibold tabular-nums">{formatCurrency(opening)}</td>
              </tr>
              {rows.map((r, i) => (
                <tr key={`${r.entry_id}-${i}`}>
                  <td className="whitespace-nowrap px-4 py-2">{fmtDate(r.entry_date)}</td>
                  <td className="px-4 py-2">
                    <span className="mr-2 tabular-nums text-muted-foreground">{r.official_number ?? r.number}</span>
                    {r.description}
                    {r.detail && <span className="text-muted-foreground"> · {r.detail}</span>}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{money(r.debit)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{money(r.credit)}</td>
                  <td className={cn("px-4 py-2 text-right tabular-nums", r.balance < 0 && "text-danger")}>{formatCurrency(r.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </div>
  );
}

// ── Sumas y saldos ─────────────────────────────────────────────────────────

function Sumas({ range, storeId }: { range: Range; storeId: string | null }) {
  const { data = [], isLoading } = useTrialBalance({ ...range, storeId });
  const [hideEmpty, setHideEmpty] = useState(true);
  const [onlyImputable, setOnlyImputable] = useState(false);
  const nodes = useMemo(() => rollupTrialBalance(data, { hideEmpty }), [data, hideEmpty]);
  const shown = onlyImputable ? nodes.filter((n) => n.imputable) : nodes;
  const t = trialTotals(data);

  function xlsx() {
    void exportXlsx(fileBase("sumas-y-saldos", range), [
      {
        name: "Sumas y saldos",
        title: `Balance de sumas y saldos del ${fmtDate(range.from)} al ${fmtDate(range.to)}`,
        columns: [
          { header: "Cuenta", key: "cuenta", width: 14 },
          { header: "Nombre", key: "nombre", width: 40 },
          { header: "Saldo anterior", key: "anterior", type: "money", width: 16 },
          { header: "Debe", key: "debe", type: "money", width: 16 },
          { header: "Haber", key: "haber", type: "money", width: 16 },
          { header: "Saldo deudor", key: "deudor", type: "money", width: 16 },
          { header: "Saldo acreedor", key: "acreedor", type: "money", width: 16 },
        ],
        rows: shown.map((n) => ({
          cuenta: n.code,
          nombre: `${"  ".repeat(n.depth)}${n.name}`,
          anterior: n.opening,
          debe: n.debit,
          haber: n.credit,
          deudor: n.closing > 0 ? n.closing : 0,
          acreedor: n.closing < 0 ? -n.closing : 0,
        })),
        totals: { debe: t.debit, haber: t.credit, deudor: t.debtor, acreedor: t.creditor },
      },
    ] satisfies XlsxSheet[]);
  }

  if (isLoading) return <Loading />;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-2">
          <Checkbox checked={hideEmpty} onCheckedChange={(v) => setHideEmpty(Boolean(v))} aria-label="Ocultar sin movimientos" />
          Ocultar cuentas sin saldo ni movimientos
        </label>
        <label className="flex items-center gap-2">
          <Checkbox checked={onlyImputable} onCheckedChange={(v) => setOnlyImputable(Boolean(v))} aria-label="Sólo imputables" />
          Sólo imputables
        </label>
        <span className={cn("ml-auto font-medium", t.balanced ? "text-success" : "text-danger")}>
          {t.balanced ? "Cuadra" : "No cuadra"}
        </span>
        <Button size="sm" variant="secondary" onClick={xlsx}>
          <FileSpreadsheet size={14} /> XLSX
        </Button>
      </div>
      <TableWrap>
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Cuenta</th>
              <th className="hidden px-4 py-3 text-right md:table-cell">Saldo anterior</th>
              <th className="px-4 py-3 text-right">Debe</th>
              <th className="px-4 py-3 text-right">Haber</th>
              <th className="px-4 py-3 text-right">Saldo</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {shown.map((n) => (
              <tr key={n.account_id} className={cn(!n.imputable && "bg-muted/20 font-semibold")}>
                <td className="px-4 py-2" style={{ paddingLeft: `${16 + n.depth * 16}px` }}>
                  <span className="tabular-nums text-muted-foreground">{n.code}</span> {n.name}
                </td>
                <td className="hidden px-4 py-2 text-right tabular-nums md:table-cell">{money(n.opening)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{money(n.debit)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{money(n.credit)}</td>
                <td className={cn("px-4 py-2 text-right tabular-nums", n.closing < 0 && "text-muted-foreground")}>
                  {n.closing ? `${formatCurrency(Math.abs(n.closing))} ${n.closing > 0 ? "D" : "A"}` : ""}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="bg-muted/40 font-semibold">
            <tr>
              <td className="px-4 py-2">Totales</td>
              <td className="hidden md:table-cell" />
              <td className="px-4 py-2 text-right tabular-nums">{formatCurrency(t.debit)}</td>
              <td className="px-4 py-2 text-right tabular-nums">{formatCurrency(t.credit)}</td>
              <td className="px-4 py-2 text-right text-xs tabular-nums">
                D {formatCurrency(t.debtor)} · A {formatCurrency(t.creditor)}
              </td>
            </tr>
          </tfoot>
        </table>
      </TableWrap>
    </div>
  );
}

// ── Estado de resultados ───────────────────────────────────────────────────

function Resultados({ range, storeId }: { range: Range; storeId: string | null }) {
  const { data = [], isLoading } = useTrialBalance({ ...range, storeId });
  const r = useMemo(() => incomeStatement(data), [data]);

  function xlsx() {
    void exportXlsx(fileBase("estado-de-resultados", range), [
      {
        name: "Resultados",
        title: `Estado de resultados del ${fmtDate(range.from)} al ${fmtDate(range.to)}`,
        columns: [
          { header: "Cuenta", key: "cuenta", width: 14 },
          { header: "Concepto", key: "nombre", width: 44 },
          { header: "Importe", key: "importe", type: "money", width: 18 },
        ],
        rows: [
          ...r.ingresos.map((l) => ({ cuenta: l.code, nombre: l.name, importe: l.amount })),
          { cuenta: "", nombre: "Total ingresos", importe: r.totalIngresos },
          ...r.egresos.map((l) => ({ cuenta: l.code, nombre: l.name, importe: -l.amount })),
          { cuenta: "", nombre: "Total egresos", importe: -r.totalEgresos },
        ],
        totals: { importe: r.resultado },
      },
    ]);
  }

  if (isLoading) return <Loading />;
  const Section = ({ title, lines, total, sign }: { title: string; lines: typeof r.ingresos; total: number; sign: 1 | -1 }) => (
    <div className="overflow-hidden rounded-xl bg-card ring-1 ring-border">
      <div className="bg-muted/40 px-4 py-2 text-sm font-semibold">{title}</div>
      <table className="w-full text-sm">
        <tbody className="divide-y divide-border">
          {lines.length === 0 && (
            <tr>
              <td className="px-4 py-2 text-muted-foreground">Sin movimientos</td>
            </tr>
          )}
          {lines.map((l) => (
            <tr key={l.account_id}>
              <td className="px-4 py-2">
                <span className="tabular-nums text-muted-foreground">{l.code}</span> {l.name}
              </td>
              <td className="w-44 px-4 py-2 text-right tabular-nums">{formatCurrency(sign * l.amount)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="font-semibold">
          <tr>
            <td className="px-4 py-2">Total</td>
            <td className="px-4 py-2 text-right tabular-nums">{formatCurrency(sign * total)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" variant="secondary" onClick={xlsx}>
          <FileSpreadsheet size={14} /> XLSX
        </Button>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Ingresos" lines={r.ingresos} total={r.totalIngresos} sign={1} />
        <Section title="Egresos" lines={r.egresos} total={r.totalEgresos} sign={-1} />
      </div>
      <div className="flex items-center justify-between rounded-xl bg-card px-5 py-4 ring-1 ring-border">
        <span className="font-semibold">{r.resultado >= 0 ? "Ganancia del período" : "Pérdida del período"}</span>
        <span className={cn("font-price text-2xl font-black tabular-nums", r.resultado >= 0 ? "text-success" : "text-danger")}>
          {formatCurrency(r.resultado)}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        Estado simple con los movimientos del rango. Sin CMV por venta, el costo de lo vendido sale del inventario que
        calcula el estudio al cierre.
      </p>
    </div>
  );
}

// ── IVA Ventas ─────────────────────────────────────────────────────────────

const KIND_LABEL: Record<string, string> = { venta: "Ventas", anulacion: "Anulaciones", devolucion: "Devoluciones" };

function IvaVentas({ range, storeName }: { range: Range; storeName: (id: string | null) => string }) {
  const { toast } = useToast();
  const { data = [], isLoading, error } = useVatSales(range);
  const byRate = useMemo(() => {
    const m = new Map<number, { net: number; vat: number; gross: number }>();
    for (const r of data) {
      const a = m.get(r.rate) ?? { net: 0, vat: 0, gross: 0 };
      a.net = round2(a.net + r.net);
      a.vat = round2(a.vat + r.vat);
      a.gross = round2(a.gross + r.gross);
      m.set(r.rate, a);
    }
    return [...m.entries()].sort((a, b) => b[0] - a[0]);
  }, [data]);

  function xlsx() {
    void exportXlsx(fileBase("iva-ventas", range), [
      {
        name: "Resumen",
        title: `IVA Ventas del ${fmtDate(range.from)} al ${fmtDate(range.to)}`,
        columns: [
          { header: "Alícuota", key: "rate", type: "number", width: 10 },
          { header: "Neto", key: "net", type: "money", width: 16 },
          { header: "IVA", key: "vat", type: "money", width: 16 },
          { header: "Total", key: "gross", type: "money", width: 16 },
        ],
        rows: byRate.map(([rate, a]) => ({ rate, ...a })),
      },
      {
        name: "Por día",
        columns: [
          { header: "Fecha", key: "day", type: "date", width: 12 },
          { header: "Sucursal", key: "store", width: 18 },
          { header: "Tipo", key: "kind", width: 14 },
          { header: "Alícuota", key: "rate", type: "number", width: 10 },
          { header: "Comprobantes", key: "docs", type: "number", width: 12 },
          { header: "Neto", key: "net", type: "money", width: 16 },
          { header: "IVA", key: "vat", type: "money", width: 16 },
          { header: "Total", key: "gross", type: "money", width: 16 },
        ],
        rows: data.map((r) => ({ ...r, store: storeName(r.store_id), kind: KIND_LABEL[r.kind] ?? r.kind })),
      },
    ]).catch(() => toast({ title: "No se pudo exportar", variant: "error" }));
  }

  if (isLoading) return <Loading />;
  if (error) return <p className="text-sm text-danger">No se pudo leer el IVA Ventas.</p>;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-xs text-muted-foreground">
          Resumen con IVA incluido en el precio a la alícuota de cada producto (sin comprobantes con CAE todavía). Las
          anulaciones y devoluciones restan.
        </p>
        <Button size="sm" variant="secondary" onClick={xlsx} disabled={!data.length}>
          <FileSpreadsheet size={14} /> XLSX
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {byRate.map(([rate, a]) => (
          <div key={rate} className="rounded-xl bg-card p-4 ring-1 ring-border">
            <div className="text-xs text-muted-foreground">Alícuota {String(rate).replace(".", ",")} %</div>
            <div className="mt-1 font-price text-xl font-black tabular-nums">{formatCurrency(a.vat)}</div>
            <div className="text-xs text-muted-foreground">Neto {formatCurrency(a.net)} · Total {formatCurrency(a.gross)}</div>
          </div>
        ))}
        {byRate.length === 0 && <EmptyState icon={BookText} title="Sin ventas en el rango" />}
      </div>
      {data.length > 0 && (
        <TableWrap>
          <table className="w-full text-sm">
            <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Fecha</th>
                <th className="hidden px-4 py-3 md:table-cell">Sucursal</th>
                <th className="px-4 py-3">Tipo</th>
                <th className="px-4 py-3 text-right">Alícuota</th>
                <th className="px-4 py-3 text-right">Neto</th>
                <th className="px-4 py-3 text-right">IVA</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.map((r, i) => (
                <tr key={i}>
                  <td className="px-4 py-2">{fmtDate(r.day)}</td>
                  <td className="hidden px-4 py-2 md:table-cell">{storeName(r.store_id)}</td>
                  <td className="px-4 py-2">{KIND_LABEL[r.kind] ?? r.kind} ({r.docs})</td>
                  <td className="px-4 py-2 text-right tabular-nums">{String(r.rate).replace(".", ",")} %</td>
                  <td className="px-4 py-2 text-right tabular-nums">{formatCurrency(r.net)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{formatCurrency(r.vat)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </div>
  );
}

// ── IVA Compras ────────────────────────────────────────────────────────────

const INV_KIND: Record<string, string> = { invoice: "FC", debit_note: "ND", credit_note: "NC" };

function IvaCompras({ range }: { range: Range }) {
  const { data = [], isLoading, error } = useVatPurchases(range);
  const totals = useMemo(() => {
    const keys = ["net_total", "vat_total", "exempt", "non_taxed", "perc_iva", "perc_iibb", "perc_ganancias", "internos", "otros", "total"] as const;
    const t: Record<string, number> = {};
    for (const k of keys) t[k] = round2(data.reduce((s, r) => s + r[k], 0));
    return t;
  }, [data]);

  function xlsx() {
    void exportXlsx(fileBase("iva-compras", range), [
      {
        name: "IVA Compras",
        title: `IVA Compras del ${fmtDate(range.from)} al ${fmtDate(range.to)}`,
        columns: [
          { header: "Fecha", key: "issue_date", type: "date", width: 12 },
          { header: "Comprobante", key: "doc", width: 22 },
          { header: "Proveedor", key: "supplier_name", width: 30 },
          { header: "CUIT", key: "supplier_cuit", width: 14 },
          { header: "Neto gravado", key: "net_total", type: "money", width: 14 },
          { header: "IVA", key: "vat_total", type: "money", width: 14 },
          { header: "Exento", key: "exempt", type: "money", width: 12 },
          { header: "No gravado", key: "non_taxed", type: "money", width: 12 },
          { header: "Perc. IVA", key: "perc_iva", type: "money", width: 12 },
          { header: "Perc. IIBB", key: "perc_iibb", type: "money", width: 12 },
          { header: "Perc. Ganancias", key: "perc_ganancias", type: "money", width: 14 },
          { header: "Internos", key: "internos", type: "money", width: 12 },
          { header: "Otros", key: "otros", type: "money", width: 12 },
          { header: "Total", key: "total", type: "money", width: 14 },
        ],
        rows: data.map((r) => ({
          ...r,
          doc: `${INV_KIND[r.kind] ?? r.kind} ${r.letter} ${String(r.point_of_sale).padStart(5, "0")}-${String(r.number).padStart(8, "0")}`,
        })),
        totals,
      },
    ]);
  }

  if (isLoading) return <Loading />;
  if (error) return <p className="text-sm text-danger">No se pudo leer el IVA Compras.</p>;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm text-muted-foreground">
          {data.length} comprobantes · IVA crédito fiscal {formatCurrency(totals.vat_total)} · Percepciones{" "}
          {formatCurrency((totals.perc_iva ?? 0) + (totals.perc_iibb ?? 0) + (totals.perc_ganancias ?? 0))}
        </span>
        <Button size="sm" variant="secondary" onClick={xlsx} disabled={!data.length}>
          <FileSpreadsheet size={14} /> XLSX
        </Button>
      </div>
      {data.length === 0 ? (
        <EmptyState icon={BookText} title="Sin comprobantes de proveedor en el rango" />
      ) : (
        <TableWrap>
          <table className="w-full text-sm">
            <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Fecha</th>
                <th className="px-4 py-3">Comprobante</th>
                <th className="hidden px-4 py-3 md:table-cell">Proveedor</th>
                <th className="px-4 py-3 text-right">Neto</th>
                <th className="px-4 py-3 text-right">IVA</th>
                <th className="hidden px-4 py-3 text-right lg:table-cell">Percepciones</th>
                <th className="px-4 py-3 text-right">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.map((r) => (
                <tr key={r.invoice_id}>
                  <td className="px-4 py-2">{fmtDate(r.issue_date)}</td>
                  <td className="whitespace-nowrap px-4 py-2 tabular-nums">
                    {INV_KIND[r.kind] ?? r.kind} {r.letter} {String(r.point_of_sale).padStart(5, "0")}-{String(r.number).padStart(8, "0")}
                  </td>
                  <td className="hidden px-4 py-2 md:table-cell">
                    {r.supplier_name}
                    {r.supplier_cuit && <span className="ml-1 text-xs text-muted-foreground">{r.supplier_cuit}</span>}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{formatCurrency(r.net_total)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{formatCurrency(r.vat_total)}</td>
                  <td className="hidden px-4 py-2 text-right tabular-nums lg:table-cell">
                    {money(round2(r.perc_iva + r.perc_iibb + r.perc_ganancias))}
                  </td>
                  <td className="px-4 py-2 text-right font-semibold tabular-nums">{formatCurrency(r.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </div>
  );
}
