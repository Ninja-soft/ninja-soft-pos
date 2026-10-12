"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Delete, Lock, ShieldCheck } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Avatar } from "@/components/ui/Avatar";
import { Callout } from "@/components/ui/Callout";
import { EmptyState } from "@/components/ui/EmptyState";
import { Spinner } from "@/components/ui/Spinner";
import { choiceClass } from "@/components/ui/ChoiceCard";
import { cn } from "@/lib/utils/cn";
import { capitalizeName, formatCurrency } from "@/lib/utils/format";
import { ACTION_INFO, authorizeErrorMessage } from "@/lib/security/pinPolicy";
import { securityApi } from "@/modules/security/api";
import { SupervisorCancelled, useSupervisorPrompt } from "@/modules/security/supervisor";
import { SOLID_CTA } from "@/components/security/styles";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "del"] as const;

// Diálogo global de PIN de supervisor (F17 · H116). Lo abre withSupervisor()
// desde cualquier flujo; devuelve un token de un solo uso al que pidió.
export function SupervisorPinHost() {
  const request = useSupervisorPrompt((s) => s.request);
  const open = Boolean(request);
  const info = request ? ACTION_INFO[request.action] : null;

  const supervisors = useQuery({
    queryKey: ["security", "supervisors"],
    queryFn: () => securityApi.supervisors(),
    enabled: open,
    staleTime: 30_000,
  });
  const usable = useMemo(() => (supervisors.data ?? []).filter((s) => s.has_pin && !s.expired), [supervisors.data]);

  const [supervisorId, setSupervisorId] = useState<string | null>(null);
  const [pin, setPin] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPin("");
    setReason("");
    setError(null);
    setBusy(false);
  }, [open, request]);
  useEffect(() => {
    if (!supervisorId && usable.length === 1) setSupervisorId(usable[0]!.user_id);
  }, [usable, supervisorId]);

  function cancel() {
    request?.reject(new SupervisorCancelled());
  }

  async function submit() {
    if (!request || !supervisorId) return;
    if (info?.reasonRequired && reason.trim().length < 3) {
      setError("Escribí el motivo (queda en la auditoría).");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await securityApi.authorize({
        action: request.action,
        supervisorId,
        pin,
        amount: request.amount,
        reason: reason.trim() || null,
      });
      if (r.ok) {
        request.resolve(r.token);
        return;
      }
      setError(authorizeErrorMessage(r.error, r));
      setPin("");
      if (r.error === "pin_locked") void supervisors.refetch();
    } catch {
      setError("No se pudo autorizar. Probá de nuevo.");
    } finally {
      setBusy(false);
    }
  }

  function press(k: (typeof KEYS)[number]) {
    if (k === "del") setPin((p) => p.slice(0, -1));
    else if (k) setPin((p) => (p.length < 6 ? p + k : p));
  }

  const selected = usable.find((s) => s.user_id === supervisorId) ?? null;
  const amountText =
    request?.amount == null || info?.unit === "none"
      ? null
      : info?.unit === "pct"
        ? `${request.amount.toLocaleString("es-AR", { maximumFractionDigits: 2 })} %`
        : formatCurrency(request.amount);

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && cancel()}
      title="Autorización de supervisor"
      description={info ? `${info.label}${amountText ? ` · ${amountText}` : ""}` : undefined}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={cancel}>
            Cancelar
          </Button>
          <Button
            type="button"
            className={SOLID_CTA}
            disabled={!supervisorId || pin.length < 4}
            loading={busy}
            onClick={submit}
          >
            <ShieldCheck size={16} /> Autorizar
          </Button>
        </>
      }
    >
      {request?.context && <p className="mb-4 text-sm text-muted-foreground">{request.context}</p>}

      {supervisors.isLoading ? (
        <div className="grid place-items-center py-8">
          <Spinner />
        </div>
      ) : usable.length === 0 ? (
        <EmptyState
          compact
          icon={Lock}
          title="Nadie tiene PIN de supervisor"
          description="Un dueño o encargado tiene que cargar su PIN en Configuración, Seguridad y auditoría."
        />
      ) : (
        <div className="space-y-5">
          <div>
            <span className="mb-2 block text-sm font-medium text-muted-foreground">¿Quién autoriza?</span>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {usable.map((s) => (
                <button
                  key={s.user_id}
                  type="button"
                  disabled={s.locked}
                  onClick={() => {
                    setSupervisorId(s.user_id);
                    setPin("");
                    setError(null);
                  }}
                  className={choiceClass(
                    supervisorId === s.user_id,
                    "flex min-h-[64px] items-center gap-2.5 rounded-lg p-2.5 text-left text-sm disabled:opacity-50",
                  )}
                >
                  <Avatar name={s.name} avatar={s.avatar} size={32} />
                  <span className="min-w-0">
                    <span className="block truncate font-semibold">{capitalizeName(s.name)}</span>
                    <span className="block text-xs text-muted-foreground">
                      {s.locked ? "Bloqueado" : s.role === "owner" ? "Dueño" : s.role === "manager" ? "Encargado" : "Supervisor"}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>

          {selected && (
            <div>
              <span className="mb-2 block text-sm font-medium text-muted-foreground">
                PIN de {capitalizeName(selected.name)}
              </span>
              <div className="mb-3 flex justify-center gap-2" aria-live="polite" aria-label={`${pin.length} dígitos`}>
                {Array.from({ length: 6 }).map((_, i) => (
                  <span
                    key={i}
                    className={cn(
                      "h-3 w-3 rounded-full",
                      i < pin.length ? "bg-foreground" : i < 4 ? "bg-foreground/20" : "bg-foreground/10",
                    )}
                  />
                ))}
              </div>
              <input
                type="password"
                inputMode="numeric"
                autoComplete="off"
                aria-label="PIN"
                value={pin}
                autoFocus
                onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                onKeyDown={(e) => e.key === "Enter" && pin.length >= 4 && void submit()}
                className="sr-only"
              />
              <div className="mx-auto grid max-w-[260px] grid-cols-3 gap-2">
                {KEYS.map((k, i) =>
                  k === "" ? (
                    <span key={i} />
                  ) : (
                    <button
                      key={i}
                      type="button"
                      onClick={() => press(k)}
                      aria-label={k === "del" ? "Borrar" : k}
                      className="grid h-12 place-items-center rounded-md bg-muted text-lg font-semibold tabular-nums transition hover:bg-fg-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {k === "del" ? <Delete size={18} aria-hidden /> : k}
                    </button>
                  ),
                )}
              </div>
            </div>
          )}

          {info?.reasonRequired && (
            <label className="block">
              <span className="mb-2 block text-sm font-medium text-muted-foreground">Motivo</span>
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Queda en la auditoría"
                className="h-11 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>
          )}

          {error && <Callout tone="danger">{error}</Callout>}
        </div>
      )}
    </Modal>
  );
}
SupervisorPinHost.displayName = "SupervisorPinHost";
