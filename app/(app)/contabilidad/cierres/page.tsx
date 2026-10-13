"use client";

import { useEffect, useState } from "react";
import { Lock, LockOpen } from "lucide-react";
import { PageContainer } from "@/components/ui/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Switch } from "@/components/ui/Switch";
import { TableStateRow, TableWrap } from "@/components/ui/Table";
import { useToast } from "@/components/ui/Toast";
import { formatCurrency } from "@/lib/utils/format";
import { closeBlock, reopenBlock, type PeriodState } from "@/lib/accounting/periods";
import { accErrorMessage } from "@/lib/accounting/sources";
import { AccountingFrame, fmtDate, inputCls, monthName, today } from "@/components/accounting/shared";
import {
  useAccIssues,
  useAccPeriods,
  useAccSettings,
  useAccountingAccess,
  useAccountingMutations,
} from "@/modules/accounting/hooks";
import type { AccSettings, PeriodRow } from "@/modules/accounting/api";

// Cierres (ADR-066): cierre mensual con numeración del Diario, reapertura del
// dueño con motivo y configuración de la contabilidad.
export default function CierresPage() {
  return (
    <PageContainer size="xl">
      <AccountingFrame
        title="Cierres"
        description="Cerrá cada mes cuando el estudio lo revisó: los asientos quedan numerados y nada con fecha de ese mes se puede cambiar."
      >
        <Periods />
        <SettingsForm />
      </AccountingFrame>
    </PageContainer>
  );
}

const BLOCK_TEXT: Record<string, string> = {
  not_ended: "El mes no terminó",
  already_closed: "Ya está cerrado",
  previous_open: "Primero cerrá los meses anteriores",
  later_closed: "Primero reabrí los posteriores",
  not_closed: "",
};

function Periods() {
  const { toast } = useToast();
  const access = useAccountingAccess();
  const m = useAccountingMutations();
  const { data: periods = [], isLoading } = useAccPeriods();
  const { data: issues = [] } = useAccIssues();
  const [closing, setClosing] = useState<PeriodRow | null>(null);
  const [reopening, setReopening] = useState<PeriodRow | null>(null);
  const states: PeriodState[] = periods.map((p) => ({ period: p.period, status: p.status, entries: p.entries }));
  const now = today();

  async function close() {
    if (!closing) return;
    try {
      const r = await m.closePeriod.mutateAsync({ period: closing.period });
      toast({ title: `${monthName(closing.period)} cerrado`, description: `${r.entries} asientos numerados.`, variant: "success" });
      setClosing(null);
    } catch (e) {
      toast({ title: "No se pudo cerrar", description: accErrorMessage(e), variant: "error" });
    }
  }

  async function reopen(reason: string) {
    if (!reopening) return;
    try {
      await m.reopenPeriod.mutateAsync({ period: reopening.period, reason });
      toast({ title: `${monthName(reopening.period)} reabierto`, variant: "success" });
      setReopening(null);
    } catch (e) {
      toast({ title: "No se pudo reabrir", description: accErrorMessage(e), variant: "error" });
    }
  }

  return (
    <div className="mt-5 space-y-3">
      <TableWrap>
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Mes</th>
              <th className="px-4 py-3">Estado</th>
              <th className="px-4 py-3 text-right">Asientos</th>
              <th className="hidden px-4 py-3 text-right md:table-cell">Movido</th>
              <th className="px-2 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoading && <TableStateRow colSpan={5} loading />}
            {periods.map((p) => {
              const cb = closeBlock(states, p.period, now);
              const rb = reopenBlock(states, p.period);
              return (
                <tr key={p.period}>
                  <td className="px-4 py-3 font-medium">{monthName(p.period)}</td>
                  <td className="px-4 py-3">
                    {p.status === "closed" ? (
                      <Badge tone="success">Cerrado{p.closed_at ? ` el ${fmtDate(p.closed_at)}` : ""}</Badge>
                    ) : (
                      <Badge tone="neutral">Abierto</Badge>
                    )}
                    {p.reopen_reason && p.status === "open" && (
                      <div className="mt-1 text-xs text-muted-foreground">Reabierto: {p.reopen_reason}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{p.entries}</td>
                  <td className="hidden px-4 py-3 text-right tabular-nums md:table-cell">{p.total ? formatCurrency(p.total) : ""}</td>
                  <td className="px-2 py-3 text-right">
                    {p.status === "open" ? (
                      <Button size="sm" variant="secondary" disabled={Boolean(cb)} title={cb ? BLOCK_TEXT[cb] : undefined} onClick={() => setClosing(p)}>
                        <Lock size={14} /> Cerrar
                      </Button>
                    ) : (
                      access.isOwner && (
                        <Button size="sm" variant="ghost" disabled={Boolean(rb)} title={rb ? BLOCK_TEXT[rb] : undefined} onClick={() => setReopening(p)}>
                          <LockOpen size={14} /> Reabrir
                        </Button>
                      )
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableWrap>
      <p className="text-xs text-muted-foreground">
        Al cerrar, los asientos del mes reciben el número correlativo del Diario por ejercicio. Lo que llegue después
        con fecha de un mes cerrado (una factura atrasada, una anulación) se contabiliza el primer día del mes abierto
        siguiente. Sólo el dueño reabre, con motivo, y queda en la auditoría.
      </p>
      <ConfirmDialog
        open={Boolean(closing)}
        onOpenChange={(o) => !o && setClosing(null)}
        title={closing ? `¿Cerrar ${monthName(closing.period)}?` : "¿Cerrar el mes?"}
        description={
          issues.length
            ? `Hay ${issues.length} eventos sin contabilizar (Resumen). Si son de este mes, después van a ir al mes siguiente.`
            : "Se numeran los asientos y el mes queda bloqueado."
        }
        confirmLabel="Cerrar mes"
        loading={m.closePeriod.isPending}
        onConfirm={() => void close()}
      />
      <ConfirmDialog
        open={Boolean(reopening)}
        onOpenChange={(o) => !o && setReopening(null)}
        title={reopening ? `¿Reabrir ${monthName(reopening.period)}?` : "¿Reabrir el mes?"}
        description="Se vuelven a poder cargar y regenerar asientos con fecha de ese mes. Al cerrarlo de nuevo se renumera."
        confirmLabel="Reabrir"
        danger
        withReason
        reasonPlaceholder="Por ejemplo: ajuste pedido por el estudio"
        loading={m.reopenPeriod.isPending}
        onConfirm={(r) => void reopen(r)}
      />
    </div>
  );
}

function SettingsForm() {
  const { toast } = useToast();
  const m = useAccountingMutations();
  const { data: settings } = useAccSettings();
  const [v, setV] = useState<Partial<AccSettings>>({});

  useEffect(() => {
    if (settings) setV(settings);
  }, [settings]);

  if (!settings) return null;

  async function save() {
    try {
      await m.saveSettings.mutateAsync({
        enabled: v.enabled,
        start_date: v.start_date,
        vat_mode: v.vat_mode,
        default_vat_rate: Number(v.default_vat_rate),
        cmv_mode: v.cmv_mode,
        fiscal_year_start_month: Number(v.fiscal_year_start_month),
      });
      toast({ title: "Configuración guardada", description: "Aplica a los asientos nuevos; para lo ya generado, rehacé el período.", variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo guardar", description: accErrorMessage(e), variant: "error" });
    }
  }

  return (
    <section className="mt-8 rounded-xl bg-card p-5 ring-1 ring-border">
      <h2 className="font-semibold">Configuración</h2>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="flex items-center gap-3 text-sm sm:col-span-2">
          <Switch checked={Boolean(v.enabled)} onCheckedChange={(c) => setV((s) => ({ ...s, enabled: c }))} label="Generar asientos" />
          Generar asientos automáticos al registrar cada operación
        </label>
        <label className="block text-sm">
          <span className="font-medium">Contabilizar desde</span>
          <input type="date" className={`mt-1 ${inputCls}`} value={v.start_date ?? ""} onChange={(e) => setV((s) => ({ ...s, start_date: e.target.value }))} />
        </label>
        <label className="block text-sm">
          <span className="font-medium">Inicio del ejercicio</span>
          <select className={`mt-1 ${inputCls}`} value={v.fiscal_year_start_month ?? 1} onChange={(e) => setV((s) => ({ ...s, fiscal_year_start_month: Number(e.target.value) }))}>
            {Array.from({ length: 12 }, (_, i) => (
              <option key={i} value={i + 1} className="bg-popover text-popover-foreground">
                {monthName(`2000-${String(i + 1).padStart(2, "0")}-01`).replace(" 2000", "")}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="font-medium">IVA de las ventas</span>
          <select className={`mt-1 ${inputCls}`} value={v.vat_mode ?? "included_rate"} onChange={(e) => setV((s) => ({ ...s, vat_mode: e.target.value as AccSettings["vat_mode"] }))}>
            <option value="included_rate" className="bg-popover text-popover-foreground">Incluido en el precio, por alícuota del producto</option>
            <option value="none" className="bg-popover text-popover-foreground">Sin IVA (monotributo o exento)</option>
          </select>
        </label>
        <label className="block text-sm">
          <span className="font-medium">Alícuota si el ítem no tiene producto</span>
          <input inputMode="decimal" className={`mt-1 ${inputCls}`} value={v.default_vat_rate ?? 21} onChange={(e) => setV((s) => ({ ...s, default_vat_rate: Number(e.target.value.replace(",", ".")) || 0 }))} />
        </label>
        <label className="block text-sm sm:col-span-2">
          <span className="font-medium">Costo de lo vendido</span>
          <select className={`mt-1 ${inputCls}`} value={v.cmv_mode ?? "none"} onChange={(e) => setV((s) => ({ ...s, cmv_mode: e.target.value as AccSettings["cmv_mode"] }))}>
            <option value="none" className="bg-popover text-popover-foreground">Por diferencia de inventario (lo calcula el estudio)</option>
            <option value="perpetual" className="bg-popover text-popover-foreground">En cada venta y devolución, al costo vigente del producto</option>
          </select>
        </label>
      </div>
      <div className="mt-4 flex justify-end">
        <Button onClick={() => void save()} loading={m.saveSettings.isPending}>
          Guardar configuración
        </Button>
      </div>
    </section>
  );
}
