"use client";

// Movimientos (F23 · H155, ADR-158): cada entrada y salida de plata con el
// documento que la generó ("Ver origen") y su asiento ("Ver asiento"), más la
// conciliación manual contra el extracto. ?mov=<id> resalta un movimiento.

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowRightLeft, Ban, CheckCheck, ExternalLink, Paperclip } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Checkbox } from "@/components/ui/Checkbox";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Switch } from "@/components/ui/Switch";
import { TableStateRow, TableWrap } from "@/components/ui/Table";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import { ORIGIN_LABEL, movementOrigin, movementOriginHref, treasuryErrorMessage, type OriginKind } from "@/lib/treasury/accounts";
import { useMyTenant } from "@/modules/tenants/hooks";
import { useTreasuryAccess, useTreasuryAccounts, useTreasuryMovement, useTreasuryMovements, useTreasuryMutations } from "@/modules/treasury/hooks";
import { MOVEMENT_TYPE_LABEL, treasuryApi, type TreasuryMovement } from "@/modules/treasury/api";
import { ViewEntryButton } from "@/components/accounting/ViewEntryButton";
import { fmtDate, inputCls, selectCls } from "@/components/purchases/shared";
import { MovementFormModal } from "./TreasuryModals";
import { TreasuryFrame } from "./TreasuryFrame";

const MANUAL_TYPES = new Set(["deposit", "withdrawal", "adjustment", "other", "transfer_in", "transfer_out"]);

export function MovementsView() {
  const access = useTreasuryAccess();
  const { data: me } = useMyTenant();
  const canManage = Boolean(me?.canManage);
  const [movementOpen, setMovementOpen] = useState(false);
  return (
    <TreasuryFrame
      title="Movimientos"
      icon={ArrowRightLeft}
      description="Cada entrada y salida de plata, con el comprobante que la generó y su asiento. Tildá los que ya ves en el extracto para conciliarlos."
      actions={
        canManage ? (
          <Button onClick={() => setMovementOpen(true)}>
            <ArrowRightLeft size={16} /> Movimiento
          </Button>
        ) : undefined
      }
    >
      {access.enabled && <MovementsTable canManage={canManage} />}
      <MovementFormModal open={movementOpen} onOpenChange={setMovementOpen} accountId={null} />
    </TreasuryFrame>
  );
}

function MovementsTable({ canManage }: { canManage: boolean }) {
  const { toast } = useToast();
  const params = useSearchParams();
  const focusId = params.get("mov");
  const m = useTreasuryMutations();
  const { data: accounts = [] } = useTreasuryAccounts();
  const [accountId, setAccountId] = useState("");
  const [origin, setOrigin] = useState<OriginKind | "">("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [onlyPending, setOnlyPending] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [statementRef, setStatementRef] = useState("");
  const [voiding, setVoiding] = useState<string | null>(null);
  const focusRef = useRef<HTMLTableRowElement | null>(null);

  const { data: list = [], isLoading } = useTreasuryMovements({
    accountId: accountId || null,
    from: from || null,
    to: to || null,
    onlyUnreconciled: onlyPending,
  });
  const { data: focused } = useTreasuryMovement(focusId);
  const rows = useMemo(() => {
    const base = origin ? list.filter((r) => movementOrigin(r) === origin) : list;
    if (focused && !base.some((r) => r.id === focused.id)) return [focused, ...base];
    return base;
  }, [list, origin, focused]);

  useEffect(() => {
    if (focusId && focusRef.current) focusRef.current.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focusId, rows.length]);

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
      toast({ title: "No se pudo conciliar", description: treasuryErrorMessage(e), variant: "error" });
    }
  }

  async function doVoid(reason: string) {
    if (!voiding) return;
    try {
      await m.voidMovement.mutateAsync({ id: voiding, reason });
      toast({ title: "Movimiento anulado", variant: "success" });
      setVoiding(null);
    } catch (e) {
      toast({ title: "No se pudo anular", description: treasuryErrorMessage(e), variant: "error" });
    }
  }

  async function openProof(path: string) {
    try {
      const url = await treasuryApi.proofUrl(path);
      window.open(url, "_blank", "noopener");
    } catch (e) {
      toast({ title: "No se pudo abrir el comprobante", description: treasuryErrorMessage(e), variant: "error" });
    }
  }

  return (
    <div className="mt-4 space-y-4">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
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
        <select
          aria-label="Origen"
          className={cn(selectCls, "h-10")}
          value={origin}
          onChange={(e) => setOrigin(e.target.value as OriginKind | "")}
        >
          <option value="" className="bg-popover text-popover-foreground">
            Todos los orígenes
          </option>
          {(Object.keys(ORIGIN_LABEL) as OriginKind[]).map((k) => (
            <option key={k} value={k} className="bg-popover text-popover-foreground">
              {ORIGIN_LABEL[k]}
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
            className={cn(inputCls, "h-9 w-full sm:w-56")}
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
                <EmptyState
                  compact
                  icon={ArrowRightLeft}
                  title="Sin movimientos en esta vista"
                  description="Cuando cobres por transferencia o te acrediten una liquidación, aparece acá solo. También podés cargar ingresos, gastos y transferencias entre cuentas."
                />
              </TableStateRow>
            )}
            {rows.map((r) => (
              <MovementRow
                key={r.id}
                r={r}
                accountName={name(r.account_id)}
                canManage={canManage}
                focused={r.id === focusId}
                rowRef={r.id === focusId ? focusRef : undefined}
                selected={selected.has(r.id)}
                onToggle={() => toggle(r.id)}
                onVoid={() => setVoiding(r.id)}
                onProof={(p) => void openProof(p)}
              />
            ))}
          </tbody>
        </table>
      </TableWrap>

      <ConfirmDialog
        open={Boolean(voiding)}
        onOpenChange={(o) => !o && setVoiding(null)}
        title="¿Anular el movimiento?"
        description="Deja de contar en el saldo (una transferencia anula las dos cuentas) y su asiento se revierte. Queda registrado con el motivo."
        confirmLabel="Anular"
        danger
        withReason
        loading={m.voidMovement.isPending}
        onConfirm={(reason) => void doVoid(reason)}
      />
    </div>
  );
}

function MovementRow({
  r,
  accountName,
  canManage,
  focused,
  rowRef,
  selected,
  onToggle,
  onVoid,
  onProof,
}: {
  r: TreasuryMovement;
  accountName: string;
  canManage: boolean;
  focused: boolean;
  rowRef?: React.Ref<HTMLTableRowElement>;
  selected: boolean;
  onToggle: () => void;
  onVoid: () => void;
  onProof: (path: string) => void;
}) {
  const origin = movementOrigin(r);
  const href = movementOriginHref(r);
  return (
    <tr ref={rowRef} className={cn(focused && "bg-ninja-flame/10", r.voided_at && "opacity-60")}>
      {canManage && (
        <td className="px-3 py-3 align-top">
          <Checkbox checked={selected} onCheckedChange={onToggle} aria-label="Seleccionar movimiento" />
        </td>
      )}
      <td className="whitespace-nowrap px-4 py-3 align-top">{fmtDate(r.movement_date)}</td>
      <td className="px-4 py-3 align-top">
        <div className="font-medium">{MOVEMENT_TYPE_LABEL[r.type] ?? r.type}</div>
        {r.description && <div className="text-xs text-muted-foreground">{r.description}</div>}
        {r.receipt_number && <div className="text-xs text-muted-foreground">Comprobante {r.receipt_number}</div>}
        <div className="mt-1 text-xs text-muted-foreground md:hidden">{accountName}</div>
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <Badge tone={origin === "manual" ? "neutral" : "info"}>{ORIGIN_LABEL[origin]}</Badge>
          {r.voided_at ? (
            <Badge tone="danger">Anulado</Badge>
          ) : r.reconciled_at ? (
            <Badge tone="success">Conciliado{r.statement_ref ? ` · ${r.statement_ref}` : ""}</Badge>
          ) : (
            <Badge tone="neutral">Sin conciliar</Badge>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-1">
          {href && (
            <Link href={href as never} className="inline-flex h-9 items-center gap-1 px-1 text-xs text-ninja-flameSoft hover:underline">
              Ver origen <ExternalLink size={12} />
            </Link>
          )}
          {r.proof_path && (
            <Button size="sm" variant="ghost" onClick={() => onProof(r.proof_path!)}>
              <Paperclip size={14} /> Comprobante
            </Button>
          )}
          <ViewEntryButton sourceType="treasury_movement" sourceId={r.id} />
        </div>
      </td>
      <td className="hidden px-4 py-3 align-top md:table-cell">{accountName}</td>
      <td className={cn("px-4 py-3 text-right align-top font-semibold tabular-nums", r.amount < 0 ? "text-danger" : "text-success")}>
        {formatCurrency(r.amount)}
      </td>
      <td className="px-2 py-3 text-right align-top">
        {canManage && !r.reconciled_at && !r.voided_at && MANUAL_TYPES.has(r.type) && (
          <Button size="sm" variant="ghost" className="text-danger" aria-label="Anular movimiento" onClick={onVoid}>
            <Ban size={14} />
          </Button>
        )}
      </td>
    </tr>
  );
}
