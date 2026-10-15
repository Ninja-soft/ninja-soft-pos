"use client";

// Cobranza 360 de un negocio en un panel (F20-11 · ADR-131): resumen de la
// fila de la cartera, la historia unificada y el acceso a la ficha.

import Link from "next/link";
import type { Route } from "next";
import { ExternalLink } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Badge } from "@/components/ui/Badge";
import { buttonVariants } from "@/components/ui/Button";
import { Tenant360Timeline } from "@/components/internal/billing/Tenant360Timeline";
import { BILLING_MODE_LABELS, formatCents, formatDay } from "@/lib/billing/ledger";
import { LADDER_LABELS, LADDER_TONES, ladderState, nextStepLabel, type PortfolioRow } from "@/lib/billing/collection360";

export function Tenant360Drawer({
  open,
  onOpenChange,
  tenantId,
  row,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  tenantId: string | null;
  /** Si viene de la cartera, muestra el resumen arriba. */
  row?: PortfolioRow | null;
}) {
  const ladder = row ? ladderState(row) : null;
  const next = row ? nextStepLabel(row.collection) : null;
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={row?.name ?? "Cobranza del negocio"}
      description={row ? BILLING_MODE_LABELS[row.billing_mode] ?? row.billing_mode : undefined}
      className="max-w-3xl"
      footer={
        tenantId ? (
          <Link href={`/internal/tenants/${tenantId}?tab=cuenta` as Route} className={buttonVariants({ variant: "secondary" })}>
            <ExternalLink size={15} aria-hidden />
            Ver ficha del negocio
          </Link>
        ) : null
      }
    >
      {row && (
        <dl className="mb-5 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div className="rounded-lg bg-muted/50 px-3 py-2">
            <dt className="text-xs text-muted-foreground">Saldo</dt>
            <dd className="font-semibold tabular-nums">{formatCents(row.balance_cents)}</dd>
          </div>
          <div className="rounded-lg bg-muted/50 px-3 py-2">
            <dt className="text-xs text-muted-foreground">Vencido</dt>
            <dd className={row.overdue_cents > 0 ? "font-semibold tabular-nums text-danger" : "font-semibold tabular-nums"}>
              {formatCents(row.overdue_cents)}
            </dd>
          </div>
          <div className="rounded-lg bg-muted/50 px-3 py-2">
            <dt className="text-xs text-muted-foreground">Mora</dt>
            <dd className="flex flex-wrap items-center gap-1.5">
              <span className="font-semibold tabular-nums">{row.days_overdue} d</span>
              {ladder && <Badge tone={LADDER_TONES[ladder]}>{LADDER_LABELS[ladder]}</Badge>}
            </dd>
          </div>
          <div className="rounded-lg bg-muted/50 px-3 py-2">
            <dt className="text-xs text-muted-foreground">Próximo paso</dt>
            <dd className="text-sm">{next ?? "Ninguno"}</dd>
          </div>
          {row.promise && (
            <div className="col-span-2 rounded-lg bg-info/10 px-3 py-2 sm:col-span-4">
              <dt className="text-xs text-muted-foreground">Promesa vigente</dt>
              <dd className="text-sm">
                {formatCents(row.promise.amount_cents)} para el {formatDay(row.promise.promised_date)}
                {row.promise.channel === "owner" ? " (la cargó el negocio)" : ""}
              </dd>
            </div>
          )}
        </dl>
      )}
      {tenantId && <Tenant360Timeline tenantId={tenantId} compact />}
    </Modal>
  );
}
Tenant360Drawer.displayName = "Tenant360Drawer";
