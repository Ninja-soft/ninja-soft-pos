"use client";

import { useEffect, useState } from "react";
import { Pause, Play, Trash2, UserRound } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { money } from "@/components/pos/ui/posStyles";
import {
  pausedBadges,
  pausedTimeLabel,
  pausedTitle,
  type PausedPayment,
  type PausedSale,
} from "@/modules/paused-sales/logic";
import { DiscardPausedDialog } from "./PausedSaleDialogs";

// Lista completa de ventas pausadas (ADR-106): nombre editable, cliente,
// monto, hora, pagos guardados, Retomar y Descartar (con sus reglas).

const METHOD_LABEL: Record<string, string> = {
  cash: "Efectivo",
  debit: "Débito",
  credit: "Crédito",
  qr: "QR",
  transfer: "Transferencia",
  account: "Cuenta corriente",
  store_credit: "Saldo a favor",
};

const STATUS_LABEL: Partial<Record<PausedPayment["status"], string>> = {
  pending: "esperando el pago",
  approved: "cobrado",
  rejected: "rechazado",
  cancelled: "cancelado",
  expired: "vencido",
};

function paymentText(p: PausedPayment): string {
  const title = typeof p.line?.title === "string" ? (p.line.title as string) : (METHOD_LABEL[p.method] ?? p.method);
  const st = p.kind === "intent" ? STATUS_LABEL[p.status] : null;
  return `${title} ${money(p.amount)}${st ? ` (${st})` : ""}`;
}

function LabelField({ sale, onRename }: { sale: PausedSale; onRename: (s: PausedSale, label: string) => void }) {
  const [value, setValue] = useState(sale.label ?? "");
  useEffect(() => setValue(sale.label ?? ""), [sale.label]);
  return (
    <input
      value={value}
      maxLength={60}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onRename(sale, value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      placeholder={pausedTitle({ ...sale, label: null })}
      aria-label="Nombre de la venta pausada"
      className="h-11 w-full min-w-0 rounded-lg border border-border bg-background px-3 text-sm font-semibold text-foreground outline-none transition placeholder:font-normal placeholder:text-muted-foreground focus:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
    />
  );
}

export function PausedSalesPanel({
  list,
  busyId,
  role,
  currentUserId,
  onResume,
  onRename,
  onDiscard,
}: {
  list: PausedSale[];
  busyId: string | null;
  role: string | null;
  currentUserId: string | null;
  onResume: (s: PausedSale) => void;
  onRename: (s: PausedSale, label: string) => void;
  onDiscard: (s: PausedSale, reason: string | null, refundConfirmed: boolean) => Promise<boolean>;
}) {
  const [discarding, setDiscarding] = useState<PausedSale | null>(null);

  if (list.length === 0) {
    return (
      <EmptyState
        icon={Pause}
        title="No hay ventas pausadas"
        description="Pausá una venta con el botón Pausar (o Shift + F8) para atender a otro cliente y retomarla después."
      />
    );
  }

  return (
    <>
      <ul className="divide-y divide-border">
        {list.map((s) => {
          const badges = pausedBadges(s);
          const inUse = s.status === "resumed" && s.resumed_by !== currentUserId;
          return (
            <li key={s.id} className="space-y-2 py-3 first:pt-0">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <LabelField sale={s} onRename={onRename} />
                </div>
                <span className="shrink-0 font-price text-lg font-bold tabular-nums">{money(s.total)}</span>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span className="tabular-nums">Pausada {pausedTimeLabel(s.paused_at)}</span>
                <span className="flex items-center gap-1">
                  <UserRound size={12} aria-hidden /> {s.customer_name ?? "Consumidor final"}
                </span>
                <span className="tabular-nums">
                  {s.cart.lines.length} {s.cart.lines.length === 1 ? "producto" : "productos"}
                </span>
                {s.carry_over && <span>Pasa a la próxima apertura</span>}
                {badges.map((b) => (
                  <Badge key={b.text} tone={b.tone === "neutral" ? "neutral" : b.tone}>
                    {b.text}
                  </Badge>
                ))}
              </div>
              {s.payments.length > 0 && (
                <p className="text-xs text-muted-foreground">Pagos: {s.payments.map(paymentText).join(", ")}</p>
              )}
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="secondary"
                  onClick={() => setDiscarding(s)}
                  disabled={Boolean(busyId)}
                  aria-label={`Descartar ${pausedTitle(s)}`}
                >
                  <Trash2 size={16} aria-hidden /> Descartar
                </Button>
                <Button
                  onClick={() => onResume(s)}
                  loading={busyId === s.id}
                  disabled={Boolean(busyId) || (inUse && role !== "owner" && role !== "manager")}
                  title={inUse ? "La está cobrando otra persona" : undefined}
                >
                  <Play size={16} aria-hidden /> {inUse ? "Tomar" : "Retomar"}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      <DiscardPausedDialog
        sale={discarding}
        role={role}
        onClose={() => setDiscarding(null)}
        onResume={(s) => {
          setDiscarding(null);
          onResume(s);
        }}
        onConfirm={async (s, reason, refund) => {
          const ok = await onDiscard(s, reason, refund);
          if (ok) setDiscarding(null);
        }}
      />
    </>
  );
}
