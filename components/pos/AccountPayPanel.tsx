"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { Input } from "@/components/ui/Input";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import { dueDateFor, installmentSchedule, todayIso } from "@/lib/account/terms";
import { overrideErrorMessage } from "@/lib/account/pin";
import { accountErrorMessage } from "@/modules/customers/account";
import { useAccountMutations, useAccountPosInfo, useAccountSupervisors } from "@/modules/customers/hooks";

function fmt(iso: string) {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${(y ?? "").slice(2)}`;
}

export interface AccountPayState {
  // payments.reference para el trigger de cargo:
  // {"installments": N, "override_reason": "..."} (sesión de dueño/encargado) o
  // {"installments": N, "override_token": "..."} (PIN de supervisor).
  reference: string | undefined;
  // true = no se puede confirmar (bloqueado sin autorización, cargando).
  blocked: boolean;
}

interface PinAuth {
  token: string;
  amount: number;
  supervisorName: string;
  expiresAt: string;
}

// Panel de "Cuenta corriente" dentro del cobro del POS (Cuenta corriente v2):
// saldo, disponible, vencido, cuotas (si el negocio las habilita) y bloqueo por
// mora / límite con autorización inline: el dueño o encargado logueado escribe
// el motivo; un cajero pide el PIN de un supervisor (token de un solo uso,
// atado a este cliente, este cajero y este monto, vence a los 5 minutos). El
// server revalida todo (payment_account_charge); esto es UX.
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
  const { authorizeOverride } = useAccountMutations();
  const [n, setN] = useState(1);
  const [overrideReason, setOverrideReason] = useState("");
  const [supervisorId, setSupervisorId] = useState("");
  const [pin, setPin] = useState("");
  const [pinReason, setPinReason] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);
  const [auth, setAuth] = useState<PinAuth | null>(null);

  useEffect(() => {
    setN(1);
    setOverrideReason("");
    setSupervisorId("");
    setPin("");
    setPinReason("");
    setPinError(null);
    setAuth(null);
  }, [customerId]);

  const maxN = info?.installments?.enabled ? Math.max(1, info.installments.max) : 1;
  const exceedsLimit =
    info != null && Number(info.credit_limit) > 0 && Number(info.balance) + total > Number(info.credit_limit) + 0.001;
  const needsAuth = Boolean(info && (info.blocked || exceedsLimit));
  const overrideAllowed = Boolean(info?.override_allowed);
  const canSession = needsAuth && overrideAllowed && Boolean(info?.can_override);
  const canPin = needsAuth && overrideAllowed && !info?.can_override;
  const sessionOk = canSession && overrideReason.trim().length > 2;

  const { data: supervisors, isLoading: loadingSups } = useAccountSupervisors(canPin);

  // La autorización vale para un monto: si el total sube, hay que pedirla de nuevo.
  useEffect(() => {
    if (auth && total > auth.amount + 0.001) {
      setAuth(null);
      setPinError("El total cambió: pedí la autorización de nuevo.");
    }
  }, [auth, total]);

  // Vence a los 5 minutos (el server también lo controla).
  useEffect(() => {
    if (!auth) return;
    const ms = new Date(auth.expiresAt).getTime() - Date.now();
    const t = setTimeout(() => {
      setAuth(null);
      setPinError("La autorización venció: pedila de nuevo.");
    }, Math.max(0, ms));
    return () => clearTimeout(t);
  }, [auth]);

  const authorized = sessionOk || (canPin && auth != null);

  const schedule = useMemo(() => {
    if (!info || total <= 0) return [];
    const first = dueDateFor(todayIso(), info.terms);
    return installmentSchedule(total, Math.min(n, maxN), first, {
      mode: info.terms.mode,
      interval_days: info.installments.interval_days,
    });
  }, [info, total, n, maxN]);

  useEffect(() => {
    const blocked = isLoading || !info || (needsAuth && !authorized);
    const ref: Record<string, unknown> = {};
    if (n > 1) ref.installments = n;
    if (needsAuth && sessionOk) ref.override_reason = overrideReason.trim();
    else if (needsAuth && canPin && auth) ref.override_token = auth.token;
    onChange({ reference: Object.keys(ref).length ? JSON.stringify(ref) : undefined, blocked });
  }, [isLoading, info, needsAuth, authorized, sessionOk, canPin, auth, overrideReason, n, onChange]);

  async function requestAuth() {
    if (!customerId || !supervisorId) return;
    setPinError(null);
    try {
      const r = await authorizeOverride.mutateAsync({
        customerId,
        supervisorId,
        pin,
        amount: total,
        reason: pinReason.trim(),
      });
      if (r.ok) {
        const name = supervisors?.find((s) => s.user_id === supervisorId)?.name ?? "un supervisor";
        setAuth({ token: r.token, amount: total, supervisorName: name, expiresAt: r.expires_at });
      } else {
        setPinError(overrideErrorMessage(r.error, r));
      }
    } catch (e) {
      setPinError(accountErrorMessage(e));
    } finally {
      setPin("");
    }
  }

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

  const blockText =
    info.blocked === "account_blocked"
      ? "La cuenta del cliente está bloqueada."
      : info.blocked === "account_overdue_blocked"
        ? `El cliente tiene deuda vencida hace ${info.max_days_overdue} días y la cuenta está bloqueada.`
        : "Esta venta supera el límite de crédito del cliente.";

  return (
    <div className="space-y-3 rounded-lg bg-muted/40 p-3 text-sm">
      <div className="grid grid-cols-3 gap-2 [overflow-wrap:anywhere] [&>*]:min-w-0">
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

      {needsAuth && (
        <div className="space-y-2 rounded-md bg-red-400/10 px-3 py-2">
          <p className="flex items-start gap-2 text-danger">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <span>
              {blockText}
              {info.blocked && exceedsLimit ? " Además supera el límite de crédito." : ""}
            </span>
          </p>

          {!overrideAllowed ? (
            <p className="text-xs text-muted-foreground">El negocio no permite autorizar estas ventas.</p>
          ) : canSession ? (
            <Input
              label="Autorizar igual (motivo)"
              value={overrideReason}
              onChange={(e) => setOverrideReason(e.target.value)}
              placeholder="Ej: acordó pagar el viernes"
              maxLength={200}
              hint="Queda registrado en la auditoría."
            />
          ) : auth ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-success/15 px-3 py-2 text-success">
              <span className="flex items-center gap-2">
                <CheckCircle2 size={15} className="shrink-0" />
                Autorizado por {auth.supervisorName} para {formatCurrency(auth.amount)}.
              </span>
              <button
                type="button"
                className="text-xs font-medium underline-offset-2 hover:underline"
                onClick={() => setAuth(null)}
              >
                Cambiar
              </button>
            </div>
          ) : (
            <div className="space-y-2 rounded-md bg-background/60 p-3">
              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <KeyRound size={13} /> Pedí autorización a un supervisor
              </div>
              {loadingSups ? (
                <div className="flex justify-center py-2">
                  <Spinner size={16} />
                </div>
              ) : (supervisors ?? []).length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Ningún dueño o encargado cargó su PIN. Se carga en Configuración, sección Cuenta corriente.
                </p>
              ) : (
                <>
                  <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Supervisor">
                    {(supervisors ?? []).map((s) => (
                      <button
                        key={s.user_id}
                        type="button"
                        role="radio"
                        aria-checked={supervisorId === s.user_id}
                        disabled={s.locked}
                        onClick={() => setSupervisorId(s.user_id)}
                        className={cn(
                          "rounded-lg px-3 py-2 text-sm transition disabled:opacity-50",
                          supervisorId === s.user_id
                            ? "bg-ninja-flame/15 font-medium text-ninja-flameSoft"
                            : "bg-muted text-foreground hover:bg-muted/70",
                        )}
                      >
                        {s.name}
                        {s.locked ? " (bloqueado)" : ""}
                      </button>
                    ))}
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Input
                      label="PIN del supervisor"
                      type="password"
                      inputMode="numeric"
                      autoComplete="off"
                      maxLength={6}
                      value={pin}
                      onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    />
                    <Input
                      label="Motivo"
                      value={pinReason}
                      onChange={(e) => setPinReason(e.target.value)}
                      placeholder="Ej: acordó pagar el viernes"
                      maxLength={200}
                    />
                  </div>
                  <div className="flex justify-end">
                    <Button
                      type="button"
                      size="sm"
                      loading={authorizeOverride.isPending}
                      disabled={!supervisorId || pin.length < 4 || pinReason.trim().length < 3}
                      onClick={requestAuth}
                    >
                      Autorizar
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}
          {pinError && !auth && <p className="text-xs font-medium text-danger">{pinError}</p>}
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
