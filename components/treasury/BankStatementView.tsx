"use client";

// Extracto del banco (F23 · H152, ADR-162): el dueño sube el extracto de su
// banco o billetera (CSV o Excel, con presets de los bancos más usados) y lo
// que coincide con Tesorería queda tildado solo. Lo que no, queda "Para
// revisar": se vincula con un movimiento, se crea el movimiento (comisión del
// banco, impuesto, transferencia que no estaba cargada) o se ignora con motivo.
// Feature conciliacion_bancaria; la barrera real es el servidor.

import { useMemo, useState } from "react";
import { FileUp, Landmark, Link2, Lock, RefreshCcw, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Modal } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { TableStateRow, TableWrap } from "@/components/ui/Table";
import { useToast } from "@/components/ui/Toast";
import { UpgradeModal } from "@/components/saas/UpgradeModal";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import { parseCsv } from "@/lib/reports/processorReconciliation";
import { readXlsxGrid } from "@/lib/utils/xlsxImport";
import {
  BANK_PRESETS,
  STATEMENT_FIELDS,
  STATEMENT_METHOD_LABEL,
  STATEMENT_STATUS_LABEL,
  bankPreset,
  findStatementHeader,
  guessStatementMapping,
  mappingReady,
  statementRowsToLines,
  statementTotals,
  type StatementField,
  type StatementMapping,
} from "@/lib/treasury/bankStatement";
import { KIND_LABEL, treasuryErrorMessage } from "@/lib/treasury/accounts";
import { useAccAccounts, useAccountingAccess } from "@/modules/accounting/hooks";
import {
  useBankStatementAccess,
  useStatementImports,
  useStatementLines,
  useTreasuryAccess,
  useTreasuryAccounts,
  useTreasuryMovements,
  useTreasuryMutations,
} from "@/modules/treasury/hooks";
import type { BankStatementLine } from "@/modules/treasury/api";
import { fmtDate } from "@/components/purchases/shared";

const SELECT =
  "h-9 w-full min-w-0 rounded-md border border-input bg-background px-2.5 text-sm text-foreground outline-none focus:border-ninja-flameSoft";

type Filter = "pending" | "matched" | "ignored" | "all";

function addDays(iso: string, n: number): string {
  const d = new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10) + n));
  return d.toISOString().slice(0, 10);
}

export function BankStatementView() {
  const treasury = useTreasuryAccess();
  const access = useBankStatementAccess();
  const [upgrade, setUpgrade] = useState(false);

  if (treasury.locked || access.locked) {
    return (
      <div className="mt-6 rounded-md bg-muted/40 p-8 text-center">
        <Lock className="mx-auto text-ninja-flameSoft" size={28} />
        <p className="mt-3 font-semibold">La conciliación bancaria no está incluida en tu plan</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
          Subí el extracto de tu banco o de Mercado Pago y se tilda solo contra lo que tenés en Tesorería. Lo que no
          coincide te queda a mano para revisar.
        </p>
        <Button className="mt-4" onClick={() => setUpgrade(true)}>
          Ver planes
        </Button>
        <UpgradeModal
          open={upgrade}
          onOpenChange={setUpgrade}
          featureKey={treasury.locked ? "tesoreria" : "conciliacion_bancaria"}
          featureLabel={treasury.locked ? "Tesorería" : "Conciliación bancaria"}
        />
      </div>
    );
  }
  if (!treasury.enabled || !access.enabled) return null;
  return <StatementBody />;
}

function StatementBody() {
  const { toast } = useToast();
  const m = useTreasuryMutations();
  const { data: accounts = [], isLoading: loadingAccounts } = useTreasuryAccounts();
  const usable = useMemo(
    () => accounts.filter((a) => a.is_active && (a.kind === "bank" || a.kind === "wallet" || a.kind === "cash")),
    [accounts],
  );
  const [accountId, setAccountId] = useState<string | null>(null);
  const account = usable.find((a) => a.id === accountId) ?? usable.find((a) => a.kind === "bank") ?? usable[0] ?? null;
  const [filter, setFilter] = useState<Filter>("pending");
  const lines = useStatementLines({ accountId: account?.id ?? null });
  const imports = useStatementImports(account?.id ?? null);
  const [importOpen, setImportOpen] = useState(false);
  const [linking, setLinking] = useState<BankStatementLine | null>(null);
  const [creating, setCreating] = useState<BankStatementLine | null>(null);
  const [ignoring, setIgnoring] = useState<BankStatementLine | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const all = useMemo(() => lines.data ?? [], [lines.data]);
  const counts = useMemo(() => {
    const c = { pending: 0, matched: 0, ignored: 0, pendingAmount: 0 };
    for (const l of all) {
      c[l.match_status] += 1;
      if (l.match_status === "pending") c.pendingAmount = Math.round((c.pendingAmount + l.amount) * 100) / 100;
    }
    return c;
  }, [all]);
  const visible = filter === "all" ? all : all.filter((l) => l.match_status === filter);

  async function act(l: BankStatementLine, action: "unlink" | "unignore") {
    try {
      await m.resolveStatementLine.mutateAsync({ lineId: l.id, action });
      toast({ title: action === "unlink" ? "Renglón desvinculado" : "Vuelve a revisar", variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo", description: treasuryErrorMessage(e), variant: "error" });
    }
  }

  async function rematch() {
    if (!account) return;
    try {
      const n = await m.rematchStatement.mutateAsync(account.id);
      toast({
        title: n > 0 ? `Se tildaron ${n} renglones` : "No hubo coincidencias nuevas",
        description: n > 0 ? undefined : "Cargá en Tesorería lo que falte y volvé a cruzar, o vinculalo a mano.",
        variant: n > 0 ? "success" : "info",
      });
    } catch (e) {
      toast({ title: "No se pudo cruzar", description: treasuryErrorMessage(e), variant: "error" });
    }
  }

  if (loadingAccounts) return null;
  if (usable.length === 0) {
    return (
      <div className="mt-5">
        <EmptyState
          icon={Landmark}
          title="Primero cargá tu banco en Tesorería"
          description="El extracto se concilia contra los movimientos de una cuenta de Tesorería. Sumala en Tesorería, Posición."
        />
      </div>
    );
  }

  return (
    <div className="mt-5 space-y-4">
      <p className="text-sm text-muted-foreground">
        Subí el extracto de tu banco o billetera y se tilda solo lo que coincide con Tesorería (mismo importe, el mismo
        día o hasta 4 días de diferencia). Lo que no coincide queda para revisar: vinculalo, crealo o ignoralo.
      </p>
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
        <label className="flex min-w-0 flex-col gap-1 sm:w-72">
          <span className="text-xs text-muted-foreground">Cuenta</span>
          <select className={SELECT} value={account?.id ?? ""} onChange={(e) => setAccountId(e.target.value)}>
            {usable.map((a) => (
              <option key={a.id} value={a.id} className="bg-popover text-popover-foreground">
                {KIND_LABEL[a.kind]} · {a.name}
                {a.currency !== "ARS" ? ` (${a.currency})` : ""}
              </option>
            ))}
          </select>
        </label>
        <div className="flex flex-wrap gap-2 sm:ml-auto">
          <Button variant="secondary" onClick={() => void rematch()} loading={m.rematchStatement.isPending}>
            <RefreshCcw size={16} /> Volver a cruzar
          </Button>
          <Button onClick={() => setImportOpen(true)}>
            <FileUp size={16} /> Subir extracto
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-md border border-border bg-card p-4">
          <div className="text-xs text-muted-foreground">Para revisar</div>
          <div className={cn("mt-1 font-price text-xl font-black tabular-nums", counts.pending > 0 && "text-warning")}>
            {counts.pending}
          </div>
          <div className="text-xs text-muted-foreground">Neto {formatCurrency(counts.pendingAmount)}</div>
        </div>
        <div className="rounded-md border border-border bg-card p-4">
          <div className="text-xs text-muted-foreground">Conciliados</div>
          <div className="mt-1 font-price text-xl font-black tabular-nums text-success">{counts.matched}</div>
          <div className="text-xs text-muted-foreground">Tildados en Tesorería</div>
        </div>
        <div className="rounded-md border border-border bg-card p-4">
          <div className="text-xs text-muted-foreground">Ignorados</div>
          <div className="mt-1 font-price text-xl font-black tabular-nums">{counts.ignored}</div>
          <div className="text-xs text-muted-foreground">Con su motivo</div>
        </div>
      </div>

      <Segmented<Filter>
        scrollOnMobile
        aria-label="Estado"
        size="sm"
        value={filter}
        onChange={setFilter}
        options={[
          { value: "pending", label: `Para revisar (${counts.pending})` },
          { value: "matched", label: "Conciliados" },
          { value: "ignored", label: "Ignorados" },
          { value: "all", label: "Todos" },
        ]}
      />

      <TableWrap>
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Fecha</th>
              <th className="px-4 py-3">Detalle</th>
              <th className="px-4 py-3 text-right">Importe</th>
              <th className="hidden px-4 py-3 md:table-cell">Estado</th>
              <th className="px-4 py-3 text-right">Acción</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {lines.isLoading && <TableStateRow colSpan={5} loading />}
            {!lines.isLoading && visible.length === 0 && (
              <TableStateRow colSpan={5}>
                <EmptyState
                  compact
                  icon={Landmark}
                  title={all.length === 0 ? "Todavía no subiste extractos de esta cuenta" : "Nada en esta vista"}
                  description={
                    all.length === 0
                      ? "Descargá los movimientos del home banking en Excel o CSV y subilos con \"Subir extracto\"."
                      : filter === "pending"
                        ? "Todo lo del extracto coincide con Tesorería."
                        : "Probá con otro filtro."
                  }
                />
              </TableStateRow>
            )}
            {visible.map((l) => {
              const st = STATEMENT_STATUS_LABEL[l.match_status];
              return (
                <tr key={l.id}>
                  <td className="whitespace-nowrap px-4 py-3">{fmtDate(l.line_date)}</td>
                  <td className="px-4 py-3">
                    <div className="min-w-0 truncate font-medium">{l.description ?? "Sin detalle"}</div>
                    <div className="text-xs text-muted-foreground">
                      {[l.reference, l.match_method ? STATEMENT_METHOD_LABEL[l.match_method] : null, l.review_note]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                    <div className="md:hidden">
                      <Badge tone={st.tone}>{st.label}</Badge>
                    </div>
                  </td>
                  <td className={cn("px-4 py-3 text-right font-semibold tabular-nums", l.amount < 0 ? "text-danger" : "text-success")}>
                    {formatCurrency(l.amount)}
                  </td>
                  <td className="hidden px-4 py-3 md:table-cell">
                    <Badge tone={st.tone}>{st.label}</Badge>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex flex-wrap justify-end gap-1">
                      {l.match_status === "pending" && (
                        <>
                          <Button size="sm" variant="secondary" onClick={() => setLinking(l)}>
                            <Link2 size={14} /> Vincular
                          </Button>
                          <Button size="sm" variant="secondary" onClick={() => setCreating(l)}>
                            Crear
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setIgnoring(l)}>
                            Ignorar
                          </Button>
                        </>
                      )}
                      {l.match_status === "matched" && (
                        <Button size="sm" variant="ghost" onClick={() => void act(l, "unlink")}>
                          Desvincular
                        </Button>
                      )}
                      {l.match_status === "ignored" && (
                        <Button size="sm" variant="ghost" onClick={() => void act(l, "unignore")}>
                          Volver a revisar
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableWrap>

      {(imports.data ?? []).length > 0 && (
        <div className="rounded-md bg-muted/40 p-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Extractos subidos</p>
          <ul className="space-y-1 text-sm">
            {(imports.data ?? []).map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0">
                  <span className="font-medium">{i.file_name ?? "Extracto"}</span>
                  <span className="block text-xs text-muted-foreground">
                    {i.period_from && i.period_to ? `${fmtDate(i.period_from)} al ${fmtDate(i.period_to)} · ` : ""}
                    {i.inserted_count} renglones nuevos, {i.matched_count} tildados solos
                  </span>
                </span>
                <Button size="sm" variant="ghost" onClick={() => setDeleting(i.id)} aria-label="Borrar extracto">
                  <Trash2 size={14} />
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {account && (
        <ImportStatementModal
          open={importOpen}
          onOpenChange={setImportOpen}
          accountId={account.id}
          accountName={account.name}
        />
      )}
      {linking && account && <LinkStatementModal line={linking} accountId={account.id} onClose={() => setLinking(null)} />}
      {creating && <CreateFromStatementModal line={creating} onClose={() => setCreating(null)} />}
      <ConfirmDialog
        open={ignoring !== null}
        onOpenChange={(o) => !o && setIgnoring(null)}
        title="Ignorar este renglón"
        description="Queda fuera de lo que tenés que revisar. Escribí por qué (por ejemplo: movimiento entre tus propias cuentas que ya cargaste de otra forma)."
        withReason
        reasonLabel="Motivo"
        confirmLabel="Ignorar"
        loading={m.resolveStatementLine.isPending}
        onConfirm={async (reason) => {
          if (!ignoring) return;
          try {
            await m.resolveStatementLine.mutateAsync({ lineId: ignoring.id, action: "ignore", note: reason });
            setIgnoring(null);
          } catch (e) {
            toast({ title: "No se pudo", description: treasuryErrorMessage(e), variant: "error" });
          }
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Borrar este extracto"
        description="Sus renglones dejan de contar y los movimientos que había tildado vuelven a quedar sin conciliar. Podés subirlo de nuevo cuando quieras."
        withReason
        danger
        confirmLabel="Borrar"
        loading={m.deleteStatement.isPending}
        onConfirm={async (reason) => {
          if (!deleting) return;
          try {
            await m.deleteStatement.mutateAsync({ importId: deleting, reason });
            setDeleting(null);
            toast({ title: "Extracto borrado", variant: "success" });
          } catch (e) {
            toast({ title: "No se pudo borrar", description: treasuryErrorMessage(e), variant: "error" });
          }
        }}
      />
    </div>
  );
}

// ── Subir extracto ────────────────────────────────────────────────────────────

function ImportStatementModal({
  open,
  onOpenChange,
  accountId,
  accountName,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  accountId: string;
  accountName: string;
}) {
  const { toast } = useToast();
  const m = useTreasuryMutations();
  const [preset, setPreset] = useState("otro");
  const [fileName, setFileName] = useState<string | null>(null);
  const [grid, setGrid] = useState<string[][]>([]);
  const [headerRow, setHeaderRow] = useState(0);
  const [map, setMap] = useState<StatementMapping>({});
  const [error, setError] = useState<string | null>(null);

  const header = grid[headerRow] ?? [];
  const body = useMemo(() => grid.slice(headerRow + 1), [grid, headerRow]);
  const results = useMemo(() => (mappingReady(map) ? statementRowsToLines(body, map, headerRow + 2) : []), [body, map, headerRow]);
  const ok = results.filter((r) => r.line).map((r) => r.line!);
  const skipped = results.length - ok.length;
  const totals = statementTotals(ok);

  function reset() {
    setFileName(null);
    setGrid([]);
    setMap({});
    setError(null);
    setHeaderRow(0);
  }

  async function onFile(f: File | undefined) {
    if (!f) return;
    setError(null);
    let g: string[][] = [];
    if (/\.csv$|\.txt$/i.test(f.name)) g = parseCsv(await f.text());
    else {
      const res = await readXlsxGrid(await f.arrayBuffer());
      if (res.fatalError) {
        setError(res.fatalError);
        return;
      }
      g = res.grid;
    }
    if (g.length < 2) {
      setError("El archivo no tiene movimientos para subir.");
      return;
    }
    const hr = findStatementHeader(g, preset);
    setFileName(f.name);
    setGrid(g);
    setHeaderRow(hr);
    setMap(guessStatementMapping(g[hr] ?? [], preset));
  }

  function changePreset(p: string) {
    setPreset(p);
    if (grid.length > 0) {
      const hr = findStatementHeader(grid, p);
      setHeaderRow(hr);
      setMap(guessStatementMapping(grid[hr] ?? [], p));
    }
  }

  async function submit() {
    try {
      const r = await m.importStatement.mutateAsync({ accountId, fileName: fileName ?? "extracto", preset, lines: ok });
      toast({
        title: `Extracto subido: ${r.matched} tildados solos`,
        description:
          r.pending > 0
            ? `${r.pending} quedaron para revisar${r.duplicates > 0 ? ` y ${r.duplicates} ya estaban subidos` : ""}.`
            : r.duplicates > 0
              ? `${r.duplicates} renglones ya estaban subidos.`
              : "Todo coincide con Tesorería.",
        variant: "success",
      });
      reset();
      onOpenChange(false);
    } catch (e) {
      toast({ title: "No se pudo subir", description: treasuryErrorMessage(e), variant: "error" });
    }
  }

  const setField = (f: StatementField, v: string) =>
    setMap((cur) => {
      const next = { ...cur };
      if (v === "") delete next[f];
      else next[f] = Number(v);
      return next;
    });

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
      title={`Subir extracto de ${accountName}`}
      description="Elegí tu banco para que reconozcamos las columnas, subí el archivo y revisá la vista previa."
      className="sm:max-w-2xl"
      footer={
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={() => void submit()} disabled={ok.length === 0 || m.importStatement.isPending}>
            {m.importStatement.isPending ? "Subiendo..." : `Subir ${ok.length} ${ok.length === 1 ? "renglón" : "renglones"}`}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-xs text-muted-foreground">Banco o billetera</span>
          <select className={SELECT} value={preset} onChange={(e) => changePreset(e.target.value)}>
            {BANK_PRESETS.map((p) => (
              <option key={p.key} value={p.key} className="bg-popover text-popover-foreground">
                {p.label}
              </option>
            ))}
          </select>
          <span className="text-xs text-muted-foreground">{bankPreset(preset).hint}</span>
        </label>
        {!fileName ? (
          <label className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed border-border px-4 py-10 text-center hover:bg-muted/40">
            <FileUp size={22} className="text-ninja-flameSoft" aria-hidden />
            <span className="text-sm font-medium">Elegí el archivo del extracto</span>
            <span className="text-xs text-muted-foreground">.xlsx o .csv, hasta 5.000 renglones</span>
            <input
              type="file"
              accept=".xlsx,.csv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
              className="sr-only"
              onChange={(e) => void onFile(e.target.files?.[0])}
            />
          </label>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="min-w-0 truncate font-medium">{fileName}</span>
              <button type="button" className="text-xs text-muted-foreground underline" onClick={reset}>
                Elegir otro archivo
              </button>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {STATEMENT_FIELDS.map((f) => (
                <label key={f.key} className="flex min-w-0 flex-col gap-1">
                  <span className="text-xs text-muted-foreground">{f.label}</span>
                  <select className={SELECT} value={map[f.key] ?? ""} onChange={(e) => setField(f.key, e.target.value)}>
                    <option value="">No está en el archivo</option>
                    {header.map((h, i) => (
                      <option key={i} value={i}>
                        {h || `Columna ${i + 1}`}
                      </option>
                    ))}
                  </select>
                  {f.hint && <span className="text-xs text-muted-foreground">{f.hint}</span>}
                </label>
              ))}
            </div>
            {!mappingReady(map) ? (
              <Callout tone="warning">Elegí al menos la fecha y el importe (o los débitos y créditos).</Callout>
            ) : (
              <div className="rounded-lg border border-border">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2 text-sm">
                  <span>
                    {totals.count} renglones · entra <span className="tabular-nums text-success">{formatCurrency(totals.in)}</span> ·
                    sale <span className="tabular-nums text-danger">{formatCurrency(totals.out)}</span>
                  </span>
                  {skipped > 0 && <span className="text-xs text-muted-foreground">{skipped} filas de saldo o vacías se omiten</span>}
                </div>
                <div className="slim-scrollbar max-h-56 overflow-auto">
                  <table className="w-full min-w-[480px] text-xs">
                    <thead className="sticky top-0 bg-popover text-left text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 font-medium">Fecha</th>
                        <th className="px-3 py-2 font-medium">Detalle</th>
                        <th className="px-3 py-2 text-right font-medium">Importe</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {ok.slice(0, 50).map((l, i) => (
                        <tr key={i}>
                          <td className="whitespace-nowrap px-3 py-1.5">{fmtDate(l.date)}</td>
                          <td className="px-3 py-1.5">{[l.description, l.reference].filter(Boolean).join(" · ")}</td>
                          <td className={cn("px-3 py-1.5 text-right tabular-nums", l.amount < 0 ? "text-danger" : "text-success")}>
                            {formatCurrency(l.amount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
        {error && <Callout tone="danger">{error}</Callout>}
      </div>
    </Modal>
  );
}

// ── Vincular con un movimiento ────────────────────────────────────────────────

function LinkStatementModal({ line, accountId, onClose }: { line: BankStatementLine; accountId: string; onClose: () => void }) {
  const { toast } = useToast();
  const m = useTreasuryMutations();
  const { data: movements = [], isLoading } = useTreasuryMovements({
    accountId,
    from: addDays(line.line_date, -15),
    to: addDays(line.line_date, 15),
  });
  const candidates = movements.filter((mv) => Math.abs(mv.amount - line.amount) < 0.005);
  const [picked, setPicked] = useState<string | null>(null);

  async function save() {
    if (!picked) return;
    try {
      await m.resolveStatementLine.mutateAsync({ lineId: line.id, action: "link", movementId: picked });
      toast({ title: "Renglón conciliado", variant: "success" });
      onClose();
    } catch (e) {
      toast({ title: "No se pudo vincular", description: treasuryErrorMessage(e), variant: "error" });
    }
  }

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Vincular con un movimiento"
      description="Movimientos de la cuenta con el mismo importe, 15 días antes o después."
      className="sm:max-w-lg"
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void save()} disabled={!picked || m.resolveStatementLine.isPending}>
            Vincular
          </Button>
        </div>
      }
    >
      <div className="rounded-lg bg-muted/50 px-3 py-2.5 text-sm">
        {fmtDate(line.line_date)} · {line.description ?? "Sin detalle"} ·{" "}
        <b className="tabular-nums">{formatCurrency(line.amount)}</b>
      </div>
      <div className="mt-3 space-y-1">
        {isLoading && <p className="text-sm text-muted-foreground">Buscando…</p>}
        {!isLoading && candidates.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No hay movimientos con ese importe. Si falta cargarlo, usá &quot;Crear&quot; desde el renglón.
          </p>
        )}
        {candidates.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setPicked(c.id)}
            className={cn(
              "flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left text-sm transition",
              picked === c.id ? "border-ninja-flame bg-ninja-flame/10" : "border-border hover:bg-muted/50",
            )}
          >
            <span className="min-w-0">
              <span className="block truncate">{c.description ?? "Movimiento"}</span>
              <span className="block text-xs text-muted-foreground">
                {fmtDate(c.movement_date)}
                {c.reconciled_at ? " · ya tildado" : ""}
              </span>
            </span>
            <span className="tabular-nums">{formatCurrency(c.amount)}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

// ── Crear el movimiento desde el extracto ─────────────────────────────────────

function CreateFromStatementModal({ line, onClose }: { line: BankStatementLine; onClose: () => void }) {
  const { toast } = useToast();
  const m = useTreasuryMutations();
  const acc = useAccountingAccess();
  const { data: accAccounts = [] } = useAccAccounts(acc.enabled);
  const expenseAccounts = accAccounts.filter((a) => a.kind === "egreso" && a.imputable && a.is_active);
  const [expense, setExpense] = useState("");
  const [description, setDescription] = useState(line.description ?? "");
  const out = line.amount < 0;

  async function save() {
    try {
      await m.resolveStatementLine.mutateAsync({
        lineId: line.id,
        action: "create",
        expenseAccountId: out ? expense || null : null,
        description: description.trim() || null,
        note: "Creado desde el extracto",
      });
      toast({ title: "Movimiento creado y conciliado", variant: "success" });
      onClose();
    } catch (e) {
      toast({ title: "No se pudo crear", description: treasuryErrorMessage(e), variant: "error" });
    }
  }

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={out ? "Cargar el gasto o retiro" : "Cargar el ingreso"}
      description="Se crea el movimiento en Tesorería con la fecha y el importe del extracto, y queda tildado."
      className="sm:max-w-md"
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void save()} disabled={m.resolveStatementLine.isPending}>
            Crear y conciliar
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="rounded-lg bg-muted/50 px-3 py-2.5 text-sm">
          {fmtDate(line.line_date)} · <b className={cn("tabular-nums", out ? "text-danger" : "text-success")}>{formatCurrency(line.amount)}</b>
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Detalle</span>
          <input
            className={SELECT}
            maxLength={300}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        {out && expenseAccounts.length > 0 && (
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">¿Qué gasto es? (opcional)</span>
            <select className={SELECT} value={expense} onChange={(e) => setExpense(e.target.value)}>
              <option value="">Sin categoría (retiro)</option>
              {expenseAccounts.map((a) => (
                <option key={a.id} value={a.id} className="bg-popover text-popover-foreground">
                  {a.code} {a.name}
                </option>
              ))}
            </select>
            <span className="text-xs text-muted-foreground">
              Para comisiones o mantenimiento de cuenta elegí &quot;Comisiones y gastos bancarios&quot;: el asiento va ahí.
            </span>
          </label>
        )}
      </div>
    </Modal>
  );
}
