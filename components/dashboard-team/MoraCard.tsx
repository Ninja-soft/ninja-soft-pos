"use client";

// =============================================================================
// "Mi suscripción > Mora" (F20-9 · ADR-128, spec docs/40 §10.5, §14.5 y §22
// #10). Lo que el dueño o el encargado tienen que saber cuando hay deuda
// vencida: días de atraso, punitorios, qué pasa y cuándo si no paga
// (restricción parcial, suspensión), y la promesa de pago. El dueño puede
// cargar "Voy a pagar el día…" con los límites de la plataforma (el servidor
// los valida). Sin deuda ni promesas no muestra nada.
// =============================================================================

import { useState } from "react";
import { CalendarCheck, Hand, Lock, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { SectionHeader } from "@/components/ui/PageHeader";
import { useToast } from "@/components/ui/Toast";
import { formatCents, formatDay, parsePesosToCents } from "@/lib/billing/ledger";
import {
  PROMISE_REJECT_MESSAGES,
  PROMISE_STATUS_LABELS,
  RESTRICT_AREAS,
  validatePromise,
  type RestrictArea,
} from "@/lib/billing/mora";
import { moraErrorMessage, useMyMora, useOwnerPromise, type MyMora } from "@/modules/billing/mora";

function PromiseDialog({ open, onOpenChange, mora }: { open: boolean; onOpenChange: (o: boolean) => void; mora: MyMora }) {
  const { toast } = useToast();
  const create = useOwnerPromise();
  const rules = mora.promise_rules;
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(rules.min_date);
  const [note, setNote] = useState("");
  const [lastOpen, setLastOpen] = useState(false);
  if (open && !lastOpen) {
    setLastOpen(true);
    setAmount(String(mora.overdue_cents / 100).replace(".", ","));
    setDate(rules.min_date);
    setNote("");
  } else if (!open && lastOpen) {
    setLastOpen(false);
  }
  const cents = parsePesosToCents(amount) ?? 0;
  const err = validatePromise({ today: mora.as_of, date, amountCents: cents, balanceCents: mora.balance_cents, maxDays: rules.max_days });

  async function submit() {
    if (err) return;
    try {
      await create.mutateAsync({ amountCents: cents, date, note: note.trim() || null });
      toast({ title: "Listo, anotamos tu promesa", description: `Te esperamos el ${formatDay(date)}.`, variant: "success" });
      onOpenChange(false);
    } catch (e) {
      toast({ title: "No se pudo cargar", description: moraErrorMessage(e), variant: "error" });
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Voy a pagar el día…"
      description={`Elegí la fecha (hasta ${rules.max_days} días) y el monto. Mientras esté vigente no limitamos ni suspendemos tu cuenta.`}
      className="max-w-md"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={Boolean(err)} loading={create.isPending}>
            Confirmar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Monto ($)"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            error={amount && err === "invalid_amount" ? `Hasta ${formatCents(mora.balance_cents)}` : undefined}
          />
          <Input
            label="Fecha"
            type="date"
            min={rules.min_date}
            max={rules.max_date}
            value={date}
            onChange={(e) => setDate(e.target.value)}
            error={err === "invalid_promise_date" ? `Entre ${formatDay(rules.min_date)} y ${formatDay(rules.max_date)}` : undefined}
          />
        </div>
        <Input label="Comentario (opcional)" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Ej.: cobro a mis clientes el viernes" />
        <p className="text-xs text-muted-foreground">
          Si ese día no registramos el pago, la cuenta sigue el curso normal y no vas a poder cargar otra promesa para esta deuda.
        </p>
      </div>
    </Modal>
  );
}

export function MoraCard() {
  const { data: mo, error } = useMyMora();
  const [open, setOpen] = useState(false);
  if (error || !mo) return null;
  const hasDebt = mo.overdue_cents > 0;
  if (!hasDebt && !mo.promise && !mo.soft_restricted) return null;

  const areas = mo.restrict_areas
    .map((a) => RESTRICT_AREAS[a as RestrictArea]?.label.toLowerCase())
    .filter(Boolean)
    .join(" y ");
  const next = mo.next_step;
  const nextText =
    next?.action === "suspend"
      ? `El ${formatDay(next.date)} tu cuenta pasa a sólo lectura.`
      : next?.action === "soft_restrict"
        ? `El ${formatDay(next.date)} se limitan ${areas || "algunas secciones"} (podés seguir vendiendo).`
        : next?.action === "past_due"
          ? `El ${formatDay(next.date)} tu cuenta pasa a pago pendiente.`
          : null;

  return (
    <section>
      <SectionHeader
        title="Pagos atrasados"
        icon={TriangleAlert}
        description="Tu deuda vencida con NinjaSoft, los punitorios y qué pasa si no se regulariza."
        actions={
          mo.promise ? <Badge tone="info">Con promesa</Badge> : hasDebt ? <Badge tone="warning">{mo.days_overdue} días de atraso</Badge> : undefined
        }
      />
      <div className="mt-3 space-y-3">
        {hasDebt && (
          <div className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-card p-4 text-sm sm:grid-cols-3">
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">Vencido</p>
              <p className="mt-0.5 text-lg font-semibold tabular-nums">{formatCents(mo.overdue_cents)}</p>
              {mo.oldest_due && <p className="text-xs text-muted-foreground">Desde el {formatDay(mo.effective_due ?? mo.oldest_due)}</p>}
            </div>
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">Punitorios</p>
              <p className="mt-0.5 text-lg font-semibold tabular-nums">{formatCents(mo.interest_open_cents)}</p>
              <p className="text-xs text-muted-foreground">{mo.interest_enabled ? "Incluidos en el vencido" : "Tu cuenta no tiene punitorios"}</p>
            </div>
            <div className="col-span-2 min-w-0 sm:col-span-1">
              <p className="text-xs text-muted-foreground">Saldo total</p>
              <p className="mt-0.5 text-lg font-semibold tabular-nums">{formatCents(mo.balance_cents)}</p>
            </div>
          </div>
        )}

        {mo.soft_restricted && (
          <Callout tone="warning" icon={Lock} title="Tu cuenta tiene una restricción parcial">
            Podés seguir vendiendo y cobrando. {areas ? `${areas.charAt(0).toUpperCase()}${areas.slice(1)} quedan limitados` : "Algunas secciones quedan limitadas"} hasta que
            regularices el pago.
          </Callout>
        )}

        {mo.promise ? (
          <Callout tone="info" icon={CalendarCheck} title={`Prometiste pagar ${formatCents(mo.promise.amount_cents)} el ${formatDay(mo.promise.promised_date)}`}>
            Mientras tanto no limitamos ni suspendemos tu cuenta. Los avisos siguen llegando.
          </Callout>
        ) : (
          nextText && (
            <Callout tone="danger" icon={TriangleAlert} title="Si no se regulariza">
              {nextText} Pagá desde Cómo pagar, más abajo.
            </Callout>
          )
        )}

        {!mo.promise && hasDebt && mo.is_owner && (
          <div className="flex flex-wrap items-center gap-3">
            {mo.promise_rules.can_create ? (
              <Button variant="secondary" onClick={() => setOpen(true)}>
                <Hand size={16} aria-hidden /> Voy a pagar el día…
              </Button>
            ) : (
              mo.promise_rules.reason &&
              mo.promise_rules.reason !== "nothing_due" && (
                <p className="text-sm text-muted-foreground">{PROMISE_REJECT_MESSAGES[mo.promise_rules.reason] ?? "No podés cargar una promesa ahora."}</p>
              )
            )}
          </div>
        )}

        {mo.promises.filter((p) => p.status !== "open").length > 0 && (
          <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
            {mo.promises
              .filter((p) => p.status !== "open")
              .map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                  <span className="min-w-0">
                    <span className="tabular-nums">{formatCents(p.amount_cents)}</span> para el {formatDay(p.promised_date)}
                  </span>
                  <Badge tone={p.status === "kept" ? "success" : p.status === "broken" ? "danger" : "neutral"}>{PROMISE_STATUS_LABELS[p.status]}</Badge>
                </li>
              ))}
          </ul>
        )}
      </div>
      <PromiseDialog open={open} onOpenChange={setOpen} mora={mo} />
    </section>
  );
}
MoraCard.displayName = "MoraCard";
