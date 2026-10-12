"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, Hourglass, Mail, MessageCircle, MessageSquareText, Copy, Share2 } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Segmented } from "@/components/ui/Segmented";
import { Spinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { ThemedLogo } from "@/components/ui/ThemedLogo";
import { BranchDot } from "@/components/branches/BranchSwitcher";
import { paymentIcon } from "@/lib/payments/logos";
import { formatCurrency, formatRelative } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";
import { useBranchContext } from "@/modules/branches/hooks";
import { usePendingCharges, usePendingChargesSync } from "@/modules/pending-charges/hooks";
import {
  effectiveStatus,
  expiresLabel,
  STATUS_LABEL,
  STATUS_TONE,
  type PendingCharge,
  type PendingChargeStatus,
  type ShareChannel,
} from "@/modules/pending-charges/logic";
import { PendingChargeDetail, PROVIDER_LABEL, TONE_BADGE } from "./PendingChargeDetail";

// Pestaña "Cobros en espera" (ADR-048): lista con filtros por estado y
// sucursal, resumen y detalle. La usan la pantalla del panel
// (/cobros-en-espera) y el POS (hoja desde la barra superior). Mientras está
// abierta sondea los cobros abiertos contra su proveedor.

type Filter = "open" | "completed" | "closed" | "all";

const FILTER_STATUSES: Record<Filter, PendingChargeStatus[] | undefined> = {
  open: ["waiting", "paid"],
  completed: ["completed"],
  closed: ["cancelled", "expired"],
  all: undefined,
};

const VIA_ICON: Partial<Record<ShareChannel, React.ElementType>> = {
  whatsapp: MessageCircle,
  email: Mail,
  sms: MessageSquareText,
  copy: Copy,
  native: Share2,
};

export function PendingChargesPanel({
  storeId,
  initialId = null,
  initialFilter = "open",
  onEditInPos,
  onPrint,
  canForce,
  compact = false,
}: {
  /** Sucursal a mostrar (null = todas las permitidas). */
  storeId: string | null;
  initialId?: string | null;
  initialFilter?: Filter;
  onEditInPos?: (c: PendingCharge) => void;
  onPrint?: (saleId: string) => void;
  canForce: boolean;
  compact?: boolean;
}) {
  const [filter, setFilter] = useState<Filter>(initialFilter);
  const [selected, setSelected] = useState<string | null>(initialId);
  const branch = useBranchContext();
  // Últimos 30 días para cobrados y cerrados; los abiertos, todos.
  const since = useMemo(
    () => (filter === "open" ? null : new Date(Date.now() - 30 * 86400_000).toISOString()),
    [filter],
  );
  const { data, isLoading } = usePendingCharges({ storeId, statuses: FILTER_STATUSES[filter], since });
  // Abiertos (para el resumen y el sondeo), siempre de la misma sucursal.
  const { data: openRows } = usePendingCharges({ storeId, statuses: ["waiting", "paid"] });
  usePendingChargesSync(openRows, true);

  const summary = useMemo(() => {
    let waiting = 0;
    let waitingAmount = 0;
    let paid = 0;
    let review = 0;
    for (const c of openRows ?? []) {
      const s = effectiveStatus(c);
      if (s === "waiting") {
        waiting++;
        waitingAmount += c.amount;
      } else if (s === "paid") paid++;
      if (c.needs_review) review++;
    }
    return { waiting, waitingAmount, paid, review };
  }, [openRows]);

  const showBranch = branch.isMulti && !storeId;

  return (
    <div className="space-y-4">
      <div className={cn("grid gap-2", compact ? "grid-cols-3" : "grid-cols-3 sm:max-w-xl")}>
        <Tile label="Esperando pago" value={String(summary.waiting)} hint={formatCurrency(summary.waitingAmount)} />
        <Tile label="Pagados sin venta" value={String(summary.paid)} tone={summary.paid > 0 ? "warning" : undefined} />
        <Tile label="Para revisar" value={String(summary.review)} tone={summary.review > 0 ? "danger" : undefined} />
      </div>

      <Segmented<Filter>
        aria-label="Filtrar por estado"
        value={filter}
        onChange={setFilter}
        size="sm"
        options={[
          { value: "open", label: "Abiertos" },
          { value: "completed", label: "Cobrados" },
          { value: "closed", label: "Cancelados y vencidos" },
          { value: "all", label: "Todos" },
        ]}
      />

      {isLoading ? (
        <div className="flex justify-center py-10">
          <Spinner size={24} />
        </div>
      ) : (data ?? []).length === 0 ? (
        <EmptyState
          icon={Hourglass}
          title={filter === "open" ? "No hay cobros esperando pago" : "Sin cobros en este filtro"}
          description="Desde el cobro con QR o link, tocá “Dejar en espera” para compartir el link y seguir vendiendo."
        />
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
          {(data ?? []).map((c) => {
            const s = effectiveStatus(c);
            const logo = paymentIcon(c.provider_key);
            const b = showBranch ? branch.all.find((x) => x.id === c.store_id) ?? null : null;
            return (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => setSelected(c.id)}
                  className="flex w-full items-center gap-3 px-3 py-3 text-left transition hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
                >
                  <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-fg-4">
                    {logo ? (
                      <ThemedLogo src={logo} alt={PROVIDER_LABEL[c.provider_key] ?? c.provider_key} className="h-6 w-auto" />
                    ) : (
                      <Hourglass size={18} aria-hidden />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{c.customer_name || "Sin cliente"}</span>
                      {c.needs_review && <AlertTriangle size={14} className="shrink-0 text-warning" aria-label="Para revisar" />}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                      {b && (
                        <span className="inline-flex items-center gap-1">
                          <BranchDot branch={b} /> {b.short_name || b.name}
                        </span>
                      )}
                      <span>{formatRelative(c.created_at)}</span>
                      {s === "waiting" && <span>{expiresLabel(c.expires_at)}</span>}
                      {s === "completed" && c.sale_number != null && <span>Venta #{c.sale_number}</span>}
                      {c.shared_via.map((v) => {
                        const Icon = VIA_ICON[v];
                        return Icon ? <Icon key={v} size={12} aria-label={v} /> : null;
                      })}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span className="font-semibold tabular-nums">{formatCurrency(c.amount)}</span>
                    <Badge tone={TONE_BADGE[STATUS_TONE[s]]}>{STATUS_LABEL[s]}</Badge>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <PendingChargeDetail
        chargeId={selected}
        open={selected !== null}
        onOpenChange={(o) => !o && setSelected(null)}
        onEditInPos={
          onEditInPos
            ? (c) => {
                setSelected(null);
                onEditInPos(c);
              }
            : undefined
        }
        onPrint={onPrint}
        canForce={canForce}
      />
    </div>
  );
}

function Tile({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "warning" | "danger" }) {
  return (
    <div className="rounded-xl bg-fg-4 px-3 py-2.5">
      <div className="text-[11px] font-semibold uppercase leading-tight tracking-[0.06em] text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-1 font-price text-xl font-black tabular-nums",
          tone === "warning" && "text-warning",
          tone === "danger" && "text-danger",
        )}
      >
        {value}
      </div>
      {hint && <div className="text-xs text-muted-foreground tabular-nums">{hint}</div>}
    </div>
  );
}
