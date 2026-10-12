"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { Input } from "@/components/ui/Input";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import { dueDateFor, installmentSchedule, todayIso } from "@/lib/account/terms";
import { accountErrorMessage } from "@/modules/customers/account";
import { useAccountPosInfo } from "@/modules/customers/hooks";

function fmt(iso: string) {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${(y ?? "").slice(2)}`;
}

export interface AccountPayState {
  // payments.reference para el trigger de cargo: {"installments": N, "override_reason": "..."}.
  reference: string | undefined;
  // true = no se puede confirmar (bloqueado sin override, supera límite, cargando).
  blocked: boolean;
}

// Panel de "Cuenta corriente" dentro del cobro del POS (Cuenta corriente v2):
// saldo, disponible, vencido, cuotas (si el negocio las habilita) y bloqueo por
// mora con autorización inline de encargado. El server revalida todo
// (payment_account_charge); esto es UX.
export function AccountPayPanel({
  customerId,
  total,
  onChange,
}: {
  customerId: string | null | undefined;
  total: number;
  onChange: (s: AccountPayState) => void;
}) {
  const { data: info, isLoading, error } = useAccountPosInfo(customerId);
  const [n, setN] = useState(1);
  const [overrideReason, setOverrideReason] = useState("");

  useEffect(() => {
    setN(1);
    setOverrideReason("");
  }, [customerId]);

  const maxN = info?.installments?.enabled ? Math.max(1, info.installments.max) : 1;
  const exceedsLimit =
    info != null && Number(info.credit_limit) > 0 && Number(info.balance) + total > Number(info.credit_limit) + 0.001;
  const canOverride = Boolean(info?.blocked && info.override_allowed && info.can_override);
  const overrideOk = canOverride && overrideReason.trim().length > 2;

  const schedule = useMemo(() => {
    if (!info || total <= 0) return [];
    const first = dueDateFor(todayIso(), info.terms);
    return installmentSchedule(total, Math.min(n, maxN), first, {
      mode: info.terms.mode,
      interval_days: info.installments.interval_days,
    });
  }, [info, total, n, maxN]);

  useEffect(() => {
    const blocked = isLoading || !info || exceedsLimit || (Boolean(info.blocked) && !overrideOk);
    const ref: Record<string, unknown> = {};
    if (n > 1) ref.installments = n;
    if (info?.blocked && overrideOk) ref.override_reason = overrideReason.trim();
    onChange({ reference: Object.keys(ref).length ? JSON.stringify(ref) : undefined, blocked });
  }, [isLoading, info, exceedsLimit, overrideOk, overrideReason, n, onChange]);

  if (!customerId) return null;
  if (isLoading) {
    return (
      <div className="flex items-center justify-center rounded-lg bg-muted/40 p-4">
        <Spinner size={18} />
      </div>
    );
  }
  if (error || !info) {
    return (
      <p className="rounded-lg bg-red-400/10 px-3 py-2 text-sm text-danger">
        {accountErrorMessage(error) || "No se pudo leer la cuenta del cliente"}
      </p>
    );
  }

  return (
    <div className="space-y-3 rounded-lg bg-muted/40 p-3 text-sm">
      <div className="grid grid-cols-3 gap-2">
        <div>
          <div className="text-xs text-muted-foreground">Saldo</div>
          <div className="font-semibold tabular-nums">{formatCurrency(info.balance)}</div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">Disponible</div>
          <div className={cn("font-semibold tabular-nums", exceedsLimit && "text-danger")}>
            {info.available != null ? formatCurrency(info.available) : "Sin límite"}
          </div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">Vencido</div>
          <div className={cn("font-semibold tabular-nums", info.overdue > 0 && "text-danger")}>
            {formatCurrency(info.overdue)}
          </div>
        </div>
      </div>

      {exceedsLimit && (
        <p className="flex items-start gap-2 rounded-md bg-red-400/10 px-3 py-2 text-danger">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          Esta venta supera el límite de crédito del cliente.
        </p>
      )}

      {info.blocked && (
        <div className="space-y-2 rounded-md bg-red-400/10 px-3 py-2">
          <p className="flex items-start gap-2 text-danger">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            {info.blocked === "account_blocked"
              ? "La cuenta del cliente está bloqueada."
              : `El cliente tiene deuda vencida hace ${info.max_days_overdue} días y la cuenta está bloqueada.`}
          </p>
          {canOverride ? (
            <Input
              label="Autorizar igual (motivo)"
              value={overrideReason}
              onChange={(e) => setOverrideReason(e.target.value)}
              placeholder="Ej: acordó pagar el viernes"
              maxLength={200}
              hint="Queda registrado en la auditoría."
            />
          ) : (
            <p className="text-xs text-muted-foreground">
              {info.override_allowed
                ? "Sólo un encargado o el dueño puede autorizar la venta."
                : "El negocio no permite autorizar ventas con mora."}
            </p>
          )}
        </div>
      )}

      {maxN > 1 && (
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">Cuotas</span>
          <select
            value={n}
            onChange={(e) => setN(Number(e.target.value))}
            className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
          >
            {Array.from({ length: maxN }, (_, i) => i + 1).map((k) => (
              <option key={k} value={k}>
                {k === 1 ? "1 pago" : `${k} cuotas de ${formatCurrency(total / k)}`}
              </option>
            ))}
          </select>
        </label>
      )}

      {schedule.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {schedule.length === 1
            ? `Vence el ${fmt(schedule[0]!.due_date)}.`
            : `Vencen: ${schedule.map((s) => fmt(s.due_date)).join(", ")}.`}
        </p>
      )}
    </div>
  );
}
