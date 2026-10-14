"use client";

// Topes de bonificación por nivel (§22 #9): por operación y por mes por
// negocio. Los edita un super admin con motivo; el resto los ve.

import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { SectionHeader } from "@/components/ui/PageHeader";
import { useToast } from "@/components/ui/Toast";
import { ReasonDialog } from "@/components/internal/ReasonDialog";
import { BILLING_ROLE_LABELS, billingErrorMessage, formatCents, parsePesosToCents } from "@/lib/billing/ledger";
import { useBillingConfigMutations, type BillingAccess, type BillingCap } from "@/modules/billing/ledger";

const LEVEL_HELP: Record<string, string> = {
  cobranzas: "Staff de soporte con el permiso Cobranzas.",
  admin: "Admins (operan cobranzas por su nivel).",
  super_admin: "Super admins.",
};

const toText = (cents: number | null) =>
  cents == null ? "" : (cents / 100).toLocaleString("es-AR", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

function CapRow({ cap, editable, onSave }: { cap: BillingCap; editable: boolean; onSave: (op: number | null, month: number | null) => void }) {
  const [op, setOp] = useState(toText(cap.per_operation_cents));
  const [month, setMonth] = useState(toText(cap.per_month_cents));
  useEffect(() => {
    setOp(toText(cap.per_operation_cents));
    setMonth(toText(cap.per_month_cents));
  }, [cap.per_operation_cents, cap.per_month_cents]);
  const opCents = op.trim() === "" ? null : parsePesosToCents(op);
  const monthCents = month.trim() === "" ? null : parsePesosToCents(month);
  const invalid =
    (op.trim() !== "" && opCents === null) ||
    (month.trim() !== "" && monthCents === null) ||
    (opCents !== null && monthCents !== null && opCents > monthCents);
  const dirty = opCents !== cap.per_operation_cents || monthCents !== cap.per_month_cents;

  return (
    <li className="grid gap-3 px-4 py-4 md:grid-cols-[minmax(0,1fr)_minmax(0,180px)_minmax(0,180px)_auto] md:items-end">
      <div className="min-w-0">
        <p className="text-sm font-semibold">{BILLING_ROLE_LABELS[cap.level] ?? cap.level}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{LEVEL_HELP[cap.level]}</p>
      </div>
      {editable ? (
        <>
          <Input label="Por operación ($)" inputMode="decimal" value={op} onChange={(e) => setOp(e.target.value)} placeholder="Sin tope" />
          <Input label="Por mes y negocio ($)" inputMode="decimal" value={month} onChange={(e) => setMonth(e.target.value)} placeholder="Sin tope" />
          <Button variant="secondary" size="md" disabled={!dirty || invalid} onClick={() => onSave(opCents, monthCents)}>
            Guardar
          </Button>
        </>
      ) : (
        <>
          <div>
            <p className="text-xs text-muted-foreground">Por operación</p>
            <p className="mt-0.5 text-sm font-medium tabular-nums">{cap.per_operation_cents == null ? "Sin tope" : formatCents(cap.per_operation_cents)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Por mes y negocio</p>
            <p className="mt-0.5 text-sm font-medium tabular-nums">{cap.per_month_cents == null ? "Sin tope" : formatCents(cap.per_month_cents)}</p>
          </div>
          <span />
        </>
      )}
      {editable && invalid && (
        <p className="text-xs text-danger md:col-span-4">Revisá los importes: el tope mensual no puede ser menor al de una operación.</p>
      )}
    </li>
  );
}

export function BillingCapsCard({ access }: { access: BillingAccess | undefined }) {
  const { toast } = useToast();
  const { setCaps } = useBillingConfigMutations();
  const [pending, setPending] = useState<{ level: string; op: number | null; month: number | null } | null>(null);
  const editable = access?.can_configure ?? false;

  return (
    <section>
      <SectionHeader
        title="Topes de bonificación"
        icon={ShieldCheck}
        description="Cuánto puede resignar cada nivel sin pasar por un super admin: bonificaciones, anulaciones de cargos y ajustes a favor. Vacío = sin tope."
      />
      <ul className="mt-3 divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
        {(access?.caps ?? []).map((c) => (
          <CapRow key={c.level} cap={c} editable={editable} onSave={(op, month) => setPending({ level: c.level, op, month })} />
        ))}
      </ul>
      <ReasonDialog
        open={pending !== null}
        onOpenChange={(o) => !o && setPending(null)}
        title="Cambiar tope"
        description={
          pending
            ? `${BILLING_ROLE_LABELS[pending.level] ?? pending.level}: ${pending.op == null ? "sin tope" : formatCents(pending.op)} por operación y ${
                pending.month == null ? "sin tope" : formatCents(pending.month)
              } por mes y negocio.`
            : undefined
        }
        confirmLabel="Guardar tope"
        loading={setCaps.isPending}
        onConfirm={async (reason) => {
          if (!pending) return;
          try {
            await setCaps.mutateAsync({ level: pending.level, perOperationCents: pending.op, perMonthCents: pending.month, reason });
            toast({ title: "Tope guardado", variant: "success" });
            setPending(null);
          } catch (e) {
            toast({ title: "No se pudo guardar", description: billingErrorMessage(e), variant: "error" });
          }
        }}
      />
    </section>
  );
}
BillingCapsCard.displayName = "BillingCapsCard";
