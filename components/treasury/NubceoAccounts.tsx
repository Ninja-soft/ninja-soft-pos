"use client";

// Equivalencias de cuentas de NubCeo (F23 · H153, ADR-162): cada cuenta (y
// subcuenta) que usan los asientos de liquidación de NubCeo se apunta a una
// cuenta imputable de tu plan. Con NubCeo como fuente, un asiento entra al
// Diario recién cuando todas sus cuentas tienen equivalencia y balancea.

import { useState } from "react";
import Link from "next/link";
import { BookOpenCheck, CheckCircle2, RefreshCcw } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { EmptyState } from "@/components/ui/EmptyState";
import { TableStateRow, TableWrap } from "@/components/ui/Table";
import { useToast } from "@/components/ui/Toast";
import { AccountSelect } from "@/components/accounting/shared";
import { formatCurrency } from "@/lib/utils/format";
import { accErrorMessage } from "@/lib/accounting/sources";
import { useAccAccounts, useAccountingAccess } from "@/modules/accounting/hooks";
import type { AccAccount } from "@/modules/accounting/api";
import {
  useNubceoLedgerAccounts,
  useNubceoReconciliationCounts,
  useSettlementSourceInfo,
  useSettlementSourceMutations,
  type NubceoAccountRow,
} from "@/modules/accounting/settlementSource";

export function NubceoAccounts({ canWrite }: { canWrite: boolean }) {
  const acc = useAccountingAccess();
  const { data: info } = useSettlementSourceInfo(acc.enabled);
  const { data: rows = [], isLoading } = useNubceoLedgerAccounts(acc.enabled);
  const { data: accounts = [] } = useAccAccounts(acc.enabled);

  if (!acc.enabled) {
    return (
      <Callout tone="neutral" title="Hace falta la contabilidad">
        Las equivalencias traducen los asientos de NubCeo a tu plan de cuentas. Activá la Contabilidad para usarlas.
      </Callout>
    );
  }
  const missing = rows.filter((r) => !r.account_id).length;

  return (
    <div className="space-y-4">
      <Callout tone={info?.source === "nubceo" ? "info" : "neutral"} title="Para qué sirve">
        {info?.source === "nubceo"
          ? "NubCeo arma los asientos de tus liquidaciones. Cada cuenta de NubCeo tiene que apuntar a una cuenta de tu plan: los asientos entran al Diario cuando todas sus cuentas tienen equivalencia y el debe es igual al haber."
          : "Hoy NinjaPOS arma los asientos de liquidación. Si querés que los arme NubCeo, cargá acá las equivalencias y cambiá la fuente en Contabilidad, Mapeos, Procesadores."}{" "}
        <Link href={"/contabilidad/mapeos?grupo=procesadores" as never} className="text-ninja-flameSoft underline">
          Ver la fuente
        </Link>
      </Callout>
      {info && info.source === "nubceo" && (
        <p className="text-sm text-muted-foreground">
          {info.nubceo_in_journal} de {info.nubceo_headers} asientos de liquidación están en el Diario
          {info.nubceo_issues > 0 ? `; ${info.nubceo_issues} esperan equivalencias o no balancean (Contabilidad, Resumen)` : ""}.
        </p>
      )}
      {missing > 0 && <Callout tone="warning">Faltan {missing} equivalencias.</Callout>}
      <TableWrap>
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Cuenta de NubCeo</th>
              <th className="hidden px-4 py-3 text-right md:table-cell">Movido</th>
              <th className="px-4 py-3">Tu cuenta</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoading && <TableStateRow colSpan={3} loading />}
            {!isLoading && rows.length === 0 && (
              <TableStateRow colSpan={3}>
                <EmptyState
                  compact
                  icon={BookOpenCheck}
                  title="Todavía no hay asientos de liquidación de NubCeo"
                  description="Traelos en la pestaña Asientos que devolvió; las cuentas que usan aparecen acá."
                />
              </TableStateRow>
            )}
            {rows.map((r) => (
              <MapRow key={`${r.nubceo_code}|${r.nubceo_subcode}`} row={r} accounts={accounts} canWrite={canWrite} />
            ))}
          </tbody>
        </table>
      </TableWrap>
    </div>
  );
}

function MapRow({
  row,
  accounts,
  canWrite,
}: {
  row: NubceoAccountRow;
  accounts: AccAccount[];
  canWrite: boolean;
}) {
  const { toast } = useToast();
  const m = useSettlementSourceMutations();
  const [busy, setBusy] = useState(false);

  async function set(accountId: string | null) {
    setBusy(true);
    try {
      const r = await m.mapNubceoAccount.mutateAsync({
        code: row.nubceo_code,
        subcode: row.nubceo_subcode,
        accountId,
        name: row.nubceo_name,
      });
      toast({
        title: accountId ? "Equivalencia guardada" : "Equivalencia quitada",
        description: r.retried > 0 ? `Entraron ${r.retried} asientos de NubCeo al Diario.` : undefined,
        variant: "success",
      });
    } catch (e) {
      toast({ title: "No se pudo guardar", description: accErrorMessage(e), variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr>
      <td className="px-4 py-3">
        <div className="font-medium">
          <span className="font-mono text-xs">{row.nubceo_code}</span>
          {row.nubceo_subcode ? <span className="font-mono text-xs"> / {row.nubceo_subcode}</span> : null}{" "}
          {row.nubceo_name ?? ""}
        </div>
        <div className="mt-0.5">
          {row.account_id ? (
            <Badge tone="success">
              <CheckCircle2 size={12} /> Con equivalencia
            </Badge>
          ) : (
            <Badge tone="warning">Sin equivalencia</Badge>
          )}
        </div>
      </td>
      <td className="hidden px-4 py-3 text-right tabular-nums md:table-cell">
        {formatCurrency(row.amount)}
        <span className="block text-xs text-muted-foreground">
          {row.entries} {row.entries === 1 ? "renglón" : "renglones"}
        </span>
      </td>
      <td className="px-4 py-3">
        {canWrite ? (
          <AccountSelect
            accounts={accounts}
            value={row.account_id}
            onChange={(v) => void set(v || null)}
            aria-label={`Cuenta para ${row.nubceo_code}`}
          />
        ) : (
          <span>{row.account_id ? `${row.account_code} ${row.account_name}` : "Sin equivalencia"}</span>
        )}
        {busy && <span className="text-xs text-muted-foreground">Guardando…</span>}
      </td>
    </tr>
  );
}

/** Resumen del estado de conciliación que devuelve NubCeo, con "Traer ahora". */
export function NubceoReconciliationSummary({ canWrite }: { canWrite: boolean }) {
  const { toast } = useToast();
  const { data } = useNubceoReconciliationCounts();
  const m = useSettlementSourceMutations();
  if (!data) return null;
  const total = data.reconciled + data.pending + data.difference;

  async function pull() {
    try {
      const r = await m.pullReconciliation.mutateAsync();
      toast({ title: r.ok ? "Estado traído de NubCeo" : "NubCeo no respondió", description: r.message, variant: r.ok ? "success" : "error" });
    } catch (e) {
      toast({ title: "No se pudo traer", description: e instanceof Error ? e.message : undefined, variant: "error" });
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-md bg-muted/40 p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <span className="font-semibold">Lo que NubCeo concilió</span>
        <span className="block text-muted-foreground">
          {total === 0
            ? "Todavía no hay estado de conciliación: se trae solo una vez por día."
            : `${data.reconciled} conciliadas, ${data.pending} pendientes, ${data.difference} con diferencia${
                data.unknown > 0 ? `, ${data.unknown} sin estado` : ""
              }.`}
          {data.last_pull ? ` Última lectura: ${new Date(data.last_pull).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" })}.` : ""}
        </span>
      </div>
      {canWrite && (
        <Button size="sm" variant="secondary" loading={m.pullReconciliation.isPending} onClick={() => void pull()}>
          <RefreshCcw size={14} /> Traer ahora
        </Button>
      )}
    </div>
  );
}
