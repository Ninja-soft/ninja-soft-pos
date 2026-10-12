"use client";

import { useState } from "react";
import { KeyRound, Lock, ShieldCheck } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { useMyTenant } from "@/modules/tenants/hooks";
import { accountErrorMessage } from "@/modules/customers/account";
import {
  useAccountMutations,
  useAccountSupervisors,
  useSupervisorPinStatus,
} from "@/modules/customers/hooks";
import { pinProblem } from "@/lib/account/pin";
import { cn } from "@/lib/utils/cn";

function hhmm(iso: string): string {
  return new Date(iso).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
}

// PIN de supervisor (Configuración → Cuenta corriente). Con el PIN, un dueño o
// encargado autoriza desde la caja de un cajero una venta a cuenta bloqueada
// por mora o por límite. El server guarda sólo el hash (bcrypt).
export function SupervisorPinCard() {
  const { toast } = useToast();
  const { data: me } = useMyTenant();
  const { data: status, isLoading } = useSupervisorPinStatus();
  const isOwner = me?.role === "owner";
  const { data: supervisors } = useAccountSupervisors(isOwner);
  const { setPin, clearPin } = useAccountMutations();
  const [pin, setPinValue] = useState("");
  const [repeat, setRepeat] = useState("");
  const [touched, setTouched] = useState(false);
  const [confirmClear, setConfirmClear] = useState<string | null>(null);

  const problem = pinProblem(pin);
  const mismatch = repeat.length > 0 && repeat !== pin;
  const canSave = !problem && repeat === pin;

  async function save() {
    setTouched(true);
    if (!canSave) return;
    try {
      await setPin.mutateAsync(pin);
      setPinValue("");
      setRepeat("");
      setTouched(false);
      toast({ title: status?.has_pin ? "PIN actualizado" : "PIN guardado", variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo guardar el PIN", description: accountErrorMessage(e), variant: "error" });
    }
  }

  async function clear(userId: string | null) {
    try {
      await clearPin.mutateAsync(userId);
      setConfirmClear(null);
      toast({ title: "PIN quitado", variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo quitar el PIN", description: accountErrorMessage(e), variant: "error" });
    }
  }

  const digitsOnly = (v: string) => v.replace(/\D/g, "").slice(0, 6);

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div>
          <div className="flex items-center gap-2 font-semibold">
            <KeyRound size={16} className="text-ninja-flameSoft" /> PIN de supervisor
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Con tu PIN autorizás, desde la caja de un cajero, una venta a cuenta bloqueada por mora o por límite de
            crédito. Se guarda cifrado: nadie puede verlo. Cada autorización queda en la auditoría.
          </p>
        </div>

        {isLoading || !status ? (
          <SpinnerBlock />
        ) : !status.can_have_pin ? (
          <p className="rounded-lg bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
            Sólo el dueño y los encargados pueden tener PIN de supervisor.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
                  status.has_pin ? "bg-success/15 text-success" : "bg-muted text-muted-foreground",
                )}
              >
                <ShieldCheck size={13} /> {status.has_pin ? "Tenés un PIN activo" : "Todavía no tenés PIN"}
              </span>
              {status.locked_until && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-red-400/15 px-2.5 py-1 text-xs font-medium text-danger">
                  <Lock size={13} /> Bloqueado hasta las {hhmm(status.locked_until)} por intentos fallidos
                </span>
              )}
            </div>

            <form
              className="grid gap-3 sm:grid-cols-2"
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <Input
                label={status.has_pin ? "PIN nuevo" : "PIN"}
                type="password"
                inputMode="numeric"
                autoComplete="new-password"
                maxLength={6}
                value={pin}
                onChange={(e) => setPinValue(digitsOnly(e.target.value))}
                hint="De 4 a 6 números."
                error={touched && problem ? problem : undefined}
              />
              <Input
                label="Repetí el PIN"
                type="password"
                inputMode="numeric"
                autoComplete="new-password"
                maxLength={6}
                value={repeat}
                onChange={(e) => setRepeat(digitsOnly(e.target.value))}
                error={mismatch ? "Los PIN no coinciden" : undefined}
              />
              <div className="flex flex-wrap items-center justify-end gap-2 sm:col-span-2">
                {status.has_pin && confirmClear !== "self" && (
                  <Button type="button" variant="ghost" onClick={() => setConfirmClear("self")}>
                    Quitar mi PIN
                  </Button>
                )}
                <Button type="submit" loading={setPin.isPending} disabled={!canSave}>
                  {status.has_pin ? "Cambiar PIN" : "Guardar PIN"}
                </Button>
              </div>
            </form>

            {confirmClear === "self" && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-red-400/10 px-3 py-2 text-sm">
                <span>¿Quitar tu PIN? No vas a poder autorizar desde la caja de otro.</span>
                <div className="flex gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setConfirmClear(null)}>
                    Cancelar
                  </Button>
                  <Button size="sm" variant="destructive" loading={clearPin.isPending} onClick={() => clear(null)}>
                    Quitar
                  </Button>
                </div>
              </div>
            )}

            {isOwner && (supervisors ?? []).length > 0 && (
              <div className="rounded-lg bg-muted/30 p-3">
                <div className="mb-1 text-sm font-medium">Supervisores con PIN</div>
                <ul className="divide-y divide-border">
                  {(supervisors ?? []).map((s) => (
                    <li key={s.user_id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                      <span className="min-w-0">
                        <span className="font-medium">{s.name}</span>{" "}
                        <span className="text-xs text-muted-foreground">
                          {s.role === "owner" ? "Dueño" : "Encargado"}
                          {s.locked ? " · bloqueado por intentos" : ""}
                        </span>
                      </span>
                      {confirmClear === s.user_id ? (
                        <span className="flex gap-2">
                          <Button size="sm" variant="ghost" onClick={() => setConfirmClear(null)}>
                            Cancelar
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            loading={clearPin.isPending}
                            onClick={() => clear(s.user_id)}
                          >
                            Quitar PIN
                          </Button>
                        </span>
                      ) : (
                        <Button size="sm" variant="ghost" onClick={() => setConfirmClear(s.user_id)}>
                          Quitar
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
