"use client";

// Posición (F23 · H150 + H155, ADR-158): toda la plata en un lugar. Cajas del
// POS, caja general, bancos, billeteras y lo que falta acreditar, con el total
// en pesos y lo que está en otra moneda aparte.

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRightLeft, Info, Landmark, Link2, Pencil, Plus, Wallet } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { EmptyState } from "@/components/ui/EmptyState";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import { treasuryTotals } from "@/lib/treasury/totals";
import { groupPositions, isSystemKind, providerLabel } from "@/lib/treasury/accounts";
import { useMyTenant } from "@/modules/tenants/hooks";
import { useTreasuryAccess, useTreasuryAccounts, useTreasuryAccountsSync, useTreasuryPosition } from "@/modules/treasury/hooks";
import type { TreasuryAccount, TreasuryPosition } from "@/modules/treasury/api";
import { fmtDate } from "@/components/purchases/shared";
import { AccountFormModal, ChequeFormModal, MovementFormModal } from "./TreasuryModals";
import { TreasuryFrame, TreasuryStat } from "./TreasuryFrame";

export function PositionView() {
  const access = useTreasuryAccess();
  const { data: me } = useMyTenant();
  const canManage = Boolean(me?.canManage);
  useTreasuryAccountsSync(access.enabled && canManage);
  const { data: rows = [], isLoading } = useTreasuryPosition(access.enabled);
  const { data: accounts = [] } = useTreasuryAccounts({}, access.enabled);
  const [accountModal, setAccountModal] = useState<{ open: boolean; account: TreasuryAccount | null; position: TreasuryPosition | null }>({
    open: false,
    account: null,
    position: null,
  });
  const [movementFor, setMovementFor] = useState<{ open: boolean; accountId: string | null }>({ open: false, accountId: null });
  const [chequeOpen, setChequeOpen] = useState(false);

  const totals = treasuryTotals(rows);
  const groups = useMemo(() => groupPositions(rows), [rows]);
  const others = Object.entries(totals.otherCurrencies);
  const ownAccounts = rows.filter((r) => !isSystemKind(r.kind));
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  const actions = canManage ? (
    <>
      <Button onClick={() => setAccountModal({ open: true, account: null, position: null })}>
        <Plus size={16} /> Agregar cuenta
      </Button>
      <Button variant="secondary" onClick={() => setMovementFor({ open: true, accountId: null })}>
        <ArrowRightLeft size={16} /> Movimiento
      </Button>
      <Button variant="secondary" onClick={() => setChequeOpen(true)}>
        <Plus size={16} /> Cheque de terceros
      </Button>
    </>
  ) : undefined;

  return (
    <TreasuryFrame
      title="Posición"
      icon={Landmark}
      description="Toda tu plata en un lugar: lo que está en las cajas, en el banco, en Mercado Pago y lo que todavía te tienen que acreditar."
      actions={actions}
    >
      <div className="mt-4 space-y-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <TreasuryStat label="Disponible en pesos" value={formatCurrency(totals.total)} tone={totals.total < 0 ? "danger" : undefined} />
          <TreasuryStat label="En bancos y billeteras" value={formatCurrency(totals.banks + totals.wallets)} />
          <TreasuryStat
            label="A acreditar (estimado)"
            value={formatCurrency(totals.receivable)}
            hint="Todavía no es plata disponible."
          />
        </div>
        {others.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Además, en otras monedas:{" "}
            {others.map(([cur, amount]) => `${cur} ${amount.toLocaleString("es-AR", { minimumFractionDigits: 2 })}`).join(" · ")}
          </p>
        )}

        {isLoading ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : (
          <>
            {ownAccounts.length === 0 && (
              <EmptyState
                icon={Wallet}
                title="Todavía no cargaste cuentas"
                description="Sumá tu banco y tu billetera para ver tu plata junta. Si vinculás la cuenta donde te transfieren, cada cobro por transferencia entra solo."
                action={
                  canManage ? (
                    <Button onClick={() => setAccountModal({ open: true, account: null, position: null })}>
                      <Plus size={16} /> Agregar cuenta
                    </Button>
                  ) : undefined
                }
              />
            )}
            {groups
              .filter((g) => g.rows.length > 0)
              .map((g) => (
                <section key={g.kind} className="space-y-2">
                  <div className="flex flex-wrap items-end justify-between gap-2">
                    <div className="min-w-0">
                      <h2 className="font-display text-base font-bold">{g.title}</h2>
                      <p className="text-xs text-muted-foreground">{g.hint}</p>
                    </div>
                    <span className="font-semibold tabular-nums">{formatCurrency(g.totalArs)}</span>
                  </div>
                  <ul className="divide-y divide-border rounded-md border border-border bg-card">
                    {g.rows.map((r) => (
                      <PositionRow
                        key={r.account_id}
                        row={r}
                        canManage={canManage}
                        onMove={() => setMovementFor({ open: true, accountId: r.account_id })}
                        onEdit={() =>
                          setAccountModal({ open: true, account: accountById.get(r.account_id) ?? null, position: r })
                        }
                      />
                    ))}
                  </ul>
                  {g.kind === "receivable" && (
                    <Link href="/tesoreria/a-acreditar" className="inline-block text-sm text-ninja-flameSoft hover:underline">
                      Ver el detalle de lo que falta acreditar
                    </Link>
                  )}
                </section>
              ))}
          </>
        )}

        <Callout tone="neutral" icon={Info} title="Cómo se relaciona">
          <ul className="list-disc space-y-1 pl-4">
            <li>Un cobro por transferencia entra solo en el banco o billetera que tiene vinculada esa cuenta de cobro.</li>
            <li>
              Lo que cobrás con tarjeta o QR queda en <b>A acreditar</b> hasta que el procesador te liquida; eso se
              controla en Conciliación.
            </li>
            <li>El efectivo vive en las cajas del POS hasta que lo pasás a la caja general o lo depositás en el banco.</li>
            <li>Cada movimiento tiene su asiento contable: lo ves con &quot;Ver asiento&quot; en Movimientos.</li>
          </ul>
        </Callout>
      </div>

      <AccountFormModal
        open={accountModal.open}
        onOpenChange={(o) => setAccountModal((s) => ({ ...s, open: o }))}
        account={accountModal.account}
        position={accountModal.position}
      />
      <MovementFormModal
        open={movementFor.open}
        onOpenChange={(o) => setMovementFor((s) => ({ ...s, open: o }))}
        accountId={movementFor.accountId}
      />
      <ChequeFormModal open={chequeOpen} onOpenChange={setChequeOpen} />
    </TreasuryFrame>
  );
}

function subtitle(r: TreasuryPosition): string {
  const d = r.detail ?? {};
  switch (r.kind) {
    case "pos_cash":
      if (d.shift_open) return `Turno abierto${d.opened_at ? ` desde ${fmtDate(d.opened_at.slice(0, 10))}` : ""} · esperado`;
      if (d.closed_at) return `Contado al cerrar el ${fmtDate(d.closed_at.slice(0, 10))}`;
      return "Sin turnos todavía";
    case "receivable":
      return d.pending_count
        ? `${d.pending_count} cobro${d.pending_count === 1 ? "" : "s"} sin acreditar${d.oldest_date ? ` · desde ${fmtDate(d.oldest_date)}` : ""}`
        : "Nada pendiente";
    case "wallet":
      return providerLabel(r.provider_key);
    case "bank":
      return r.unreconciled_count > 0 ? `${r.unreconciled_count} movimientos sin conciliar` : "Todo conciliado";
    default:
      return "Caja general";
  }
}

function PositionRow({
  row: r,
  canManage,
  onMove,
  onEdit,
}: {
  row: TreasuryPosition;
  canManage: boolean;
  onMove: () => void;
  onEdit: () => void;
}) {
  const system = r.is_system || isSystemKind(r.kind);
  return (
    <li className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3", !r.is_active && "opacity-60")}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 font-medium">
          <span className="break-words">{r.name}</span>
          {r.currency !== "ARS" && <Badge tone="info">{r.currency}</Badge>}
          {!r.is_active && <Badge tone="neutral">Inactiva</Badge>}
        </div>
        <div className="text-xs text-muted-foreground">{subtitle(r)}</div>
        {r.transfer_accounts.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {r.transfer_accounts.map((t) => (
              <Badge key={t.id} tone="neutral">
                <Link2 size={11} /> {t.alias || t.bank_name || "Cuenta de cobro"}
              </Badge>
            ))}
          </div>
        )}
      </div>
      <div className={cn("ml-auto text-right font-semibold tabular-nums", r.balance < 0 && "text-danger")}>
        {formatCurrency(r.balance)}
      </div>
      {canManage && !system && (
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" aria-label={`Movimiento en ${r.name}`} onClick={onMove}>
            <ArrowRightLeft size={14} />
          </Button>
          <Button size="sm" variant="ghost" aria-label={`Editar ${r.name}`} onClick={onEdit}>
            <Pencil size={14} />
          </Button>
        </div>
      )}
    </li>
  );
}
