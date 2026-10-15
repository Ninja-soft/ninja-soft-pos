"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, ArrowRightLeft, Ban, CheckCheck, Landmark, Lock, Pencil, Plus, Wallet } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { Checkbox } from "@/components/ui/Checkbox";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import { TableStateRow, TableWrap } from "@/components/ui/Table";
import { UpgradeModal } from "@/components/saas/UpgradeModal";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import { agingBySupplier } from "@/lib/purchases/aging";
import { purchaseErrorMessage } from "@/lib/purchases/orders";
import {
  CHEQUE_KIND_LABEL,
  CHEQUE_STATUS_LABEL,
  CHEQUE_STATUS_TONE,
  actionLabel,
  daysToPayment,
  manualActions,
  type ChequeKind,
  type ChequeStatus,
} from "@/lib/treasury/cheques";
import { buildCashFlow, firstShortfall, type CashFlowGranularity } from "@/lib/treasury/cashflow";
import { treasuryTotals } from "@/lib/treasury/totals";
import { useMyTenant } from "@/modules/tenants/hooks";
import { usePaymentAllocations, useSupplierEntries, useSuppliers } from "@/modules/purchases/hooks";
import {
  useCheques,
  useReceivables,
  useTreasuryAccess,
  useTreasuryAccounts,
  useTreasuryBalances,
  useTreasuryMovements,
  useTreasuryMutations,
} from "@/modules/treasury/hooks";
import { MOVEMENT_TYPE_LABEL, type Cheque, type TreasuryAccount } from "@/modules/treasury/api";
import { fmtDate, inputCls, selectCls, supplierName, today } from "@/components/purchases/shared";
import {
  AccountFormModal,
  ChequeActionModal,
  ChequeFormModal,
  MovementFormModal,
} from "@/components/treasury/TreasuryModals";

type Tab = "cuentas" | "movimientos" | "cheques" | "flujo";

const MANUAL_TYPES = new Set(["deposit", "withdrawal", "adjustment", "other", "transfer_in", "transfer_out"]);

function addDays(iso: string, n: number): string {
  const d = new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10) + n));
  return d.toISOString().slice(0, 10);
}

// Tesorería (F18 · H111, ADR-059): cuentas, movimientos y conciliación,
// cheques y flujo de fondos proyectado.
export default function TesoreriaPage() {
  const access = useTreasuryAccess();
  const { data: me } = useMyTenant();
  const canManage = Boolean(me?.canManage);
  const [tab, setTab] = useState<Tab>("cuentas");
  const [accountModal, setAccountModal] = useState<{ open: boolean; account: TreasuryAccount | null }>({
    open: false,
    account: null,
  });
  const [movementFor, setMovementFor] = useState<{ open: boolean; accountId: string | null }>({ open: false, accountId: null });
  const [chequeOpen, setChequeOpen] = useState(false);
  const [upgrade, setUpgrade] = useState(false);

  const header = (
    <PageHeader
      eyebrow="Finanzas"
      title="Tesorería"
      icon={Landmark}
      description="Caja general y bancos, conciliación contra el extracto, cheques en cartera y lo que va a entrar y salir en las próximas semanas."
      actions={
        access.enabled && canManage ? (
          <>
            <Button onClick={() => setMovementFor({ open: true, accountId: null })}>
              <ArrowRightLeft size={16} /> Movimiento
            </Button>
            <Button variant="secondary" onClick={() => setChequeOpen(true)}>
              <Plus size={16} /> Cheque de terceros
            </Button>
            <Button variant="secondary" onClick={() => setAccountModal({ open: true, account: null })}>
              <Plus size={16} /> Cuenta
            </Button>
          </>
        ) : undefined
      }
    />
  );

  if (access.locked) {
    return (
      <PageContainer>
        {header}
        <div className="mt-8 rounded-md bg-muted/40 p-8 text-center">
          <Lock className="mx-auto text-ninja-flameSoft" size={28} />
          <p className="mt-3 font-semibold">Tesorería no está incluida en tu plan</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Llevá la caja general y los bancos con su saldo, conciliá contra el extracto, controlá los cheques en
            cartera y mirá el flujo de fondos con lo que vence de proveedores y lo que entra de clientes.
          </p>
          <Button className="mt-4" onClick={() => setUpgrade(true)}>
            Ver planes
          </Button>
          <UpgradeModal open={upgrade} onOpenChange={setUpgrade} featureKey="tesoreria" featureLabel="Tesorería" />
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      {header}
      <div className="mt-4">
        <Segmented<Tab> scrollOnMobile
          aria-label="Vista"
          value={tab}
          onChange={setTab}
          size="sm"
          options={[
            { value: "cuentas", label: "Cuentas" },
            { value: "movimientos", label: "Movimientos y conciliación" },
            { value: "cheques", label: "Cheques" },
            { value: "flujo", label: "Flujo de fondos" },
          ]}
        />
      </div>

      {access.enabled && tab === "cuentas" && (
        <AccountsTab
          canManage={canManage}
          onEdit={(a) => setAccountModal({ open: true, account: a })}
          onMove={(id) => setMovementFor({ open: true, accountId: id })}
        />
      )}
      {access.enabled && tab === "movimientos" && <MovementsTab canManage={canManage} />}
      {access.enabled && tab === "cheques" && <ChequesTab canManage={canManage} />}
      {access.enabled && tab === "flujo" && <CashFlowTab />}

      <AccountFormModal
        open={accountModal.open}
        onOpenChange={(o) => setAccountModal((s) => ({ ...s, open: o }))}
        account={accountModal.account}
      />
      <MovementFormModal
        open={movementFor.open}
        onOpenChange={(o) => setMovementFor((s) => ({ ...s, open: o }))}
        accountId={movementFor.accountId}
      />
      <ChequeFormModal open={chequeOpen} onOpenChange={setChequeOpen} />
    </PageContainer>
  );
}

// ── Cuentas ────────────────────────────────────────────────────────────────

function AccountsTab({
  canManage,
  onEdit,
  onMove,
}: {
  canManage: boolean;
  onEdit: (a: TreasuryAccount) => void;
  onMove: (id: string) => void;
}) {
  const { data: accounts = [], isLoading } = useTreasuryAccounts();
  const { data: balances = [] } = useTreasuryBalances();
  const byId = new Map(balances.map((b) => [b.account_id, b]));
  const totals = treasuryTotals(balances);
  const others = Object.entries(totals.otherCurrencies);

  return (
    <div className="mt-4 space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Disponible total en pesos" value={formatCurrency(totals.total)} />
        <Stat label="En bancos" value={formatCurrency(totals.banks)} />
        <Stat label="En caja general" value={formatCurrency(totals.cash)} />
      </div>
      {others.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Además, en otras monedas:{" "}
          {others
            .map(([cur, amount]) => `${cur} ${amount.toLocaleString("es-AR", { minimumFractionDigits: 2 })}`)
            .join(" · ")}
        </p>
      )}
      <TableWrap>
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Cuenta</th>
              <th className="px-4 py-3 text-right">Saldo</th>
              <th className="hidden px-4 py-3 text-right md:table-cell">Conciliado</th>
              <th className="hidden px-4 py-3 text-right md:table-cell">Sin conciliar</th>
              <th className="px-2 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoading && <TableStateRow colSpan={5} loading />}
            {!isLoading && accounts.length === 0 && (
              <TableStateRow colSpan={5}>
                <EmptyState
                  compact
                  icon={Wallet}
                  title="Sin cuentas"
                  description="Creá la caja general y tus cuentas bancarias con su saldo inicial."
                />
              </TableStateRow>
            )}
            {accounts.map((a) => {
              const b = byId.get(a.id);
              return (
                <tr key={a.id} className={cn(!a.is_active && "opacity-60")}>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2 font-medium">
                      {a.kind === "bank" ? <Landmark size={14} /> : <Wallet size={14} />}
                      {a.name}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {a.kind === "bank" ? [a.bank_name, a.alias, a.cbu].filter(Boolean).join(" · ") : "Caja general"}
                    </div>
                  </td>
                  <td className={cn("px-4 py-3 text-right font-semibold tabular-nums", (b?.balance ?? 0) < 0 && "text-danger")}>
                    {formatCurrency(b?.balance ?? a.opening_balance)}
                  </td>
                  <td className="hidden px-4 py-3 text-right tabular-nums md:table-cell">
                    {formatCurrency(b?.reconciled_balance ?? a.opening_balance)}
                  </td>
                  <td className="hidden px-4 py-3 text-right tabular-nums text-muted-foreground md:table-cell">
                    {b?.unreconciled_count ?? 0}
                  </td>
                  <td className="px-2 py-3 text-right">
                    {canManage && (
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="ghost" aria-label="Movimiento" onClick={() => onMove(a.id)}>
                          <ArrowRightLeft size={14} />
                        </Button>
                        <Button size="sm" variant="ghost" aria-label="Editar" onClick={() => onEdit(a)}>
                          <Pencil size={14} />
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableWrap>
      <p className="text-xs text-muted-foreground">
        Las órdenes de pago con transferencia o cheque mueven estas cuentas. El efectivo de las cajas del POS sigue en
        sus turnos: pasalo a la caja general con un ingreso.
      </p>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "danger" | "success" }) {
  return (
    <div className="rounded-md border border-border bg-card p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-1 font-price text-xl font-black tabular-nums",
          tone === "danger" && "text-danger",
          tone === "success" && "text-success",
        )}
      >
        {value}
      </div>
    </div>
  );
}

// ── Movimientos y conciliación ─────────────────────────────────────────────

function MovementsTab({ canManage }: { canManage: boolean }) {
  const { toast } = useToast();
  const m = useTreasuryMutations();
  const { data: accounts = [] } = useTreasuryAccounts();
  const [accountId, setAccountId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [onlyPending, setOnlyPending] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [statementRef, setStatementRef] = useState("");
  const [voiding, setVoiding] = useState<string | null>(null);

  const { data: rows = [], isLoading } = useTreasuryMovements({
    accountId: accountId || null,
    from: from || null,
    to: to || null,
    onlyUnreconciled: onlyPending,
  });
  const name = (id: string) => accounts.find((a) => a.id === id)?.name ?? "Cuenta";
  const selectedRows = rows.filter((r) => selected.has(r.id));
  const selectedTotal = selectedRows.reduce((t, r) => t + r.amount, 0);

  function toggle(id: string) {
    setSelected((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  async function reconcile(value: boolean) {
    try {
      await m.reconcile.mutateAsync({ ids: [...selected], reconciled: value, statementRef: statementRef.trim() || null });
      toast({ title: value ? "Movimientos conciliados" : "Conciliación quitada", variant: "success" });
      setSelected(new Set());
      setStatementRef("");
    } catch (e) {
      toast({ title: "No se pudo conciliar", description: purchaseErrorMessage(e), variant: "error" });
    }
  }

  async function doVoid(reason: string) {
    if (!voiding) return;
    try {
      await m.voidMovement.mutateAsync({ id: voiding, reason });
      toast({ title: "Movimiento anulado", variant: "success" });
      setVoiding(null);
    } catch (e) {
      toast({ title: "No se pudo anular", description: purchaseErrorMessage(e), variant: "error" });
    }
  }

  return (
    <div className="mt-4 space-y-4">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <select aria-label="Cuenta" className={cn(selectCls, "h-10")} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          <option value="" className="bg-popover text-popover-foreground">
            Todas las cuentas
          </option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id} className="bg-popover text-popover-foreground">
              {a.name}
            </option>
          ))}
        </select>
        <input type="date" aria-label="Desde" className={inputCls} value={from} onChange={(e) => setFrom(e.target.value)} />
        <input type="date" aria-label="Hasta" className={inputCls} value={to} onChange={(e) => setTo(e.target.value)} />
        <label className="flex h-10 items-center gap-2 text-sm">
          <Switch checked={onlyPending} onCheckedChange={setOnlyPending} label="Sólo sin conciliar" />
          Sólo sin conciliar
        </label>
      </div>

      {canManage && selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted px-3 py-2.5 text-sm">
          <span>
            {selected.size} seleccionados · <b className="tabular-nums">{formatCurrency(selectedTotal)}</b>
          </span>
          <input
            aria-label="Referencia del extracto"
            placeholder="Referencia del extracto (opcional)"
            className={cn(inputCls, "h-9 w-56")}
            value={statementRef}
            onChange={(e) => setStatementRef(e.target.value)}
          />
          <Button size="sm" onClick={() => void reconcile(true)} loading={m.reconcile.isPending}>
            <CheckCheck size={14} /> Conciliar
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void reconcile(false)}>
            Quitar conciliación
          </Button>
        </div>
      )}

      <TableWrap>
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              {canManage && <th className="w-10 px-3 py-3" />}
              <th className="px-4 py-3">Fecha</th>
              <th className="px-4 py-3">Movimiento</th>
              <th className="hidden px-4 py-3 md:table-cell">Cuenta</th>
              <th className="px-4 py-3 text-right">Importe</th>
              <th className="px-2 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoading && <TableStateRow colSpan={6} loading />}
            {!isLoading && rows.length === 0 && (
              <TableStateRow colSpan={6}>
                <EmptyState compact icon={ArrowRightLeft} title="Sin movimientos en esta vista" description="Registrá ingresos, egresos y transferencias, o pagá con una orden de pago." />
              </TableStateRow>
            )}
            {rows.map((r) => (
              <tr key={r.id}>
                {canManage && (
                  <td className="px-3 py-3">
                    <Checkbox
                      checked={selected.has(r.id)}
                      onCheckedChange={() => toggle(r.id)}
                      aria-label="Seleccionar movimiento"
                    />
                  </td>
                )}
                <td className="px-4 py-3 whitespace-nowrap">{fmtDate(r.movement_date)}</td>
                <td className="px-4 py-3">
                  <div className="font-medium">{MOVEMENT_TYPE_LABEL[r.type]}</div>
                  {r.description && <div className="text-xs text-muted-foreground">{r.description}</div>}
                  <div className="mt-1">
                    {r.reconciled_at ? (
                      <Badge tone="success">Conciliado{r.statement_ref ? ` · ${r.statement_ref}` : ""}</Badge>
                    ) : (
                      <Badge tone="neutral">Sin conciliar</Badge>
                    )}
                  </div>
                </td>
                <td className="hidden px-4 py-3 md:table-cell">{name(r.account_id)}</td>
                <td className={cn("px-4 py-3 text-right font-semibold tabular-nums", r.amount < 0 ? "text-danger" : "text-success")}>
                  {formatCurrency(r.amount)}
                </td>
                <td className="px-2 py-3 text-right">
                  {canManage && !r.reconciled_at && MANUAL_TYPES.has(r.type) && (
                    <Button size="sm" variant="ghost" className="text-danger" aria-label="Anular movimiento" onClick={() => setVoiding(r.id)}>
                      <Ban size={14} />
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>

      <ConfirmDialog
        open={Boolean(voiding)}
        onOpenChange={(o) => !o && setVoiding(null)}
        title="¿Anular el movimiento?"
        description="Deja de contar en el saldo (una transferencia anula las dos cuentas). Queda registrado con el motivo."
        confirmLabel="Anular"
        danger
        withReason
        loading={m.voidMovement.isPending}
        onConfirm={(reason) => void doVoid(reason)}
      />
    </div>
  );
}

// ── Cheques ────────────────────────────────────────────────────────────────

function ChequesTab({ canManage }: { canManage: boolean }) {
  const [kind, setKind] = useState<ChequeKind | "all">("third_party");
  const [status, setStatus] = useState<"open" | "all">("open");
  const { data: cheques = [], isLoading } = useCheques({
    kind: kind === "all" ? null : kind,
    statuses: status === "open" ? ["en_cartera", "entregado"] : null,
  });
  const { data: suppliers = [] } = useSuppliers({ includeArchived: true });
  const [action, setAction] = useState<{ cheque: Cheque; to: ChequeStatus } | null>(null);
  const now = today();
  const inWallet = cheques.filter((c) => c.kind === "third_party" && c.status === "en_cartera");
  const ownPending = cheques.filter((c) => c.kind === "own" && c.status === "entregado");

  return (
    <div className="mt-4 space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Stat label={`En cartera (${inWallet.length})`} value={formatCurrency(inWallet.reduce((t, c) => t + c.amount, 0))} />
        <Stat
          label={`Propios a debitar (${ownPending.length})`}
          value={formatCurrency(ownPending.reduce((t, c) => t + c.amount, 0))}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Segmented<ChequeKind | "all">
          aria-label="Tipo"
          value={kind}
          onChange={setKind}
          size="sm"
          options={[
            { value: "third_party", label: "De terceros" },
            { value: "own", label: "Propios" },
            { value: "all", label: "Todos" },
          ]}
        />
        <Segmented<"open" | "all">
          aria-label="Estado"
          value={status}
          onChange={setStatus}
          size="sm"
          options={[
            { value: "open", label: "Pendientes" },
            { value: "all", label: "Historial" },
          ]}
        />
      </div>
      <TableWrap>
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Cheque</th>
              <th className="px-4 py-3">Fecha de pago</th>
              <th className="hidden px-4 py-3 md:table-cell">De / para</th>
              <th className="px-4 py-3 text-right">Importe</th>
              <th className="px-2 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoading && <TableStateRow colSpan={5} loading />}
            {!isLoading && cheques.length === 0 && (
              <TableStateRow colSpan={5}>
                <EmptyState compact icon={Landmark} title="Sin cheques en esta vista" description="Registrá los cheques de terceros que recibís; los propios nacen en las órdenes de pago." />
              </TableStateRow>
            )}
            {cheques.map((c) => {
              const days = daysToPayment(c.payment_date, now);
              return (
                <tr key={c.id}>
                  <td className="px-4 py-3">
                    <div className="font-medium">
                      {c.is_echeq ? "E-cheq" : "Cheque"} N° {c.number}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {CHEQUE_KIND_LABEL[c.kind]}
                      {c.bank_name ? ` · ${c.bank_name}` : ""}
                    </div>
                    <div className="mt-1">
                      <Badge tone={CHEQUE_STATUS_TONE[c.status]}>{CHEQUE_STATUS_LABEL[c.status]}</Badge>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div>{fmtDate(c.payment_date)}</div>
                    {(c.status === "en_cartera" || c.status === "entregado") && (
                      <div className={cn("text-xs", days <= 0 ? "text-warning" : "text-muted-foreground")}>
                        {days <= 0 ? "Ya se puede cobrar" : `En ${days} días`}
                      </div>
                    )}
                  </td>
                  <td className="hidden px-4 py-3 md:table-cell">
                    {c.kind === "third_party" ? (
                      <>
                        <div>{c.drawer_name ?? c.received_from ?? ""}</div>
                        {c.delivered_to_supplier_id && (
                          <div className="text-xs text-muted-foreground">
                            Entregado a {supplierName(suppliers, c.delivered_to_supplier_id)}
                          </div>
                        )}
                      </>
                    ) : (
                      <div>{c.delivered_to_supplier_id ? supplierName(suppliers, c.delivered_to_supplier_id) : ""}</div>
                    )}
                    {c.reject_reason && <div className="text-xs text-danger">{c.reject_reason}</div>}
                  </td>
                  <td className="px-4 py-3 text-right font-semibold tabular-nums">{formatCurrency(c.amount)}</td>
                  <td className="px-2 py-3 text-right">
                    {canManage && (
                      <div className="flex justify-end gap-1">
                        {manualActions(c.kind, c.status).map((to) => (
                          <Button
                            key={to}
                            size="sm"
                            variant={to === "rechazado" ? "ghost" : "secondary"}
                            className={cn(to === "rechazado" && "text-danger")}
                            onClick={() => setAction({ cheque: c, to })}
                          >
                            {actionLabel(c.kind, to)}
                          </Button>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableWrap>
      <ChequeActionModal cheque={action?.cheque ?? null} to={action?.to ?? null} onOpenChange={(o) => !o && setAction(null)} />
    </div>
  );
}

// ── Flujo de fondos ────────────────────────────────────────────────────────

function CashFlowTab() {
  const [days, setDays] = useState<"30" | "60" | "90">("30");
  const [granularity, setGranularity] = useState<CashFlowGranularity>("week");
  const now = today();
  const to = addDays(now, Number(days));
  const { data: balances = [] } = useTreasuryBalances();
  const { data: receivables = [] } = useReceivables(to);
  const { data: entries = [] } = useSupplierEntries(null);
  const { data: allocations = [] } = usePaymentAllocations();
  const { data: cheques = [] } = useCheques({ statuses: ["en_cartera", "entregado"] });

  const start = treasuryTotals(balances).total;
  const payables = useMemo(() => {
    const out: Array<{ date: string; amount: number }> = [];
    for (const aging of agingBySupplier(entries, now, allocations).values()) {
      for (const d of aging.open) out.push({ date: d.due_date, amount: d.open });
    }
    return out;
  }, [entries, allocations, now]);

  const rows = buildCashFlow({
    startBalance: start,
    from: now,
    to,
    granularity,
    receivables: receivables.map((r) => ({ date: r.due_date, amount: r.amount })),
    chequesIn: cheques
      .filter((c) => c.kind === "third_party" && c.status === "en_cartera")
      .map((c) => ({ date: c.payment_date, amount: c.amount })),
    payables,
    chequesOut: cheques
      .filter((c) => c.kind === "own" && c.status === "entregado")
      .map((c) => ({ date: c.payment_date, amount: c.amount })),
  });
  const shortfall = firstShortfall(rows);

  return (
    <div className="mt-4 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented<"30" | "60" | "90">
          aria-label="Horizonte"
          value={days}
          onChange={setDays}
          size="sm"
          options={[
            { value: "30", label: "30 días" },
            { value: "60", label: "60 días" },
            { value: "90", label: "90 días" },
          ]}
        />
        <Segmented<CashFlowGranularity>
          aria-label="Agrupar"
          value={granularity}
          onChange={setGranularity}
          size="sm"
          options={[
            { value: "day", label: "Por día" },
            { value: "week", label: "Por semana" },
            { value: "month", label: "Por mes" },
          ]}
        />
        <span className="ml-auto text-sm text-muted-foreground">
          Saldo de hoy en tesorería <b className="tabular-nums text-foreground">{formatCurrency(start)}</b>
        </span>
      </div>
      {shortfall && (
        <Callout tone="danger" icon={AlertTriangle} title="Faltan fondos">
          Con lo que vence, el saldo queda en {formatCurrency(shortfall.balance)} en {shortfall.label.toLowerCase()}.
        </Callout>
      )}
      <TableWrap>
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Período</th>
              <th className="px-4 py-3 text-right">Cobros de clientes</th>
              <th className="hidden px-4 py-3 text-right md:table-cell">Cheques a cobrar</th>
              <th className="px-4 py-3 text-right">Pagos a proveedores</th>
              <th className="hidden px-4 py-3 text-right md:table-cell">Cheques propios</th>
              <th className="px-4 py-3 text-right">Saldo proyectado</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => (
              <tr key={r.key}>
                <td className="px-4 py-3">{r.label}</td>
                <td className="px-4 py-3 text-right tabular-nums text-success">{r.receivables ? formatCurrency(r.receivables) : ""}</td>
                <td className="hidden px-4 py-3 text-right tabular-nums text-success md:table-cell">
                  {r.chequesIn ? formatCurrency(r.chequesIn) : ""}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-danger">{r.payables ? formatCurrency(r.payables) : ""}</td>
                <td className="hidden px-4 py-3 text-right tabular-nums text-danger md:table-cell">
                  {r.chequesOut ? formatCurrency(r.chequesOut) : ""}
                </td>
                <td className={cn("px-4 py-3 text-right font-semibold tabular-nums", r.balance < 0 && "text-danger")}>
                  {formatCurrency(r.balance)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
      <p className="text-xs text-muted-foreground">
        Lo vencido y sin pagar (o sin cobrar) se proyecta en el primer período. Los comprobantes de proveedor salen de
        la cuenta corriente con la imputación de las órdenes de pago; los cobros, de la cuenta corriente de clientes.
      </p>
    </div>
  );
}
