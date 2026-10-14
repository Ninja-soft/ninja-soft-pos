"use client";

import { useState } from "react";
import {
  AlertTriangle,
  Banknote,
  Clock,
  HandCoins,
  ListTodo,
  Receipt,
  RotateCcw,
  StickyNote,
  Ticket,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { TicketModal } from "@/components/sales/TicketModal";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import {
  KIND_LABEL,
  TIMELINE_KINDS,
  describeItem,
  mergePages,
  showsAmount,
  type ItemTone,
  type TimelineKind,
} from "@/lib/customers/c360";
import { useCustomer360Timeline, type TimelineFilters } from "@/modules/customers/c360";

const ICON: Record<TimelineKind, LucideIcon> = {
  sale: Receipt,
  return: RotateCcw,
  account: Wallet,
  collection: ListTodo,
  store_credit: Ticket,
  pending_charge: Clock,
  mp_refund: HandCoins,
  dispute: AlertTriangle,
  note: StickyNote,
};

const TONE: Record<ItemTone, string> = {
  success: "bg-success/15 text-success",
  warning: "bg-warning/15 text-warning",
  danger: "bg-danger/15 text-danger",
  info: "bg-info/15 text-info",
  brand: "bg-ninja-flame/15 text-ninja-flameSoft",
  neutral: "bg-muted text-muted-foreground",
};

const when = (iso: string) =>
  new Date(iso).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

type Filters = { kinds: TimelineKind[]; from: string; to: string };

// Línea de tiempo unificada con filtros por tipo y fecha (y la sucursal del
// encabezado), paginada por cursor ("Ver más").
export function C360Timeline({
  customerId,
  filters,
  onFilters,
  tlFilters,
  isManager,
}: {
  customerId: string;
  filters: Filters;
  onFilters: (f: Filters) => void;
  tlFilters: TimelineFilters;
  isManager: boolean;
}) {
  const q = useCustomer360Timeline(customerId, tlFilters);
  const items = mergePages(q.data?.pages ?? []);
  const [saleId, setSaleId] = useState<string | null>(null);
  const kinds = TIMELINE_KINDS.filter((k) => isManager || (k !== "dispute" && k !== "collection"));

  const toggle = (k: TimelineKind) =>
    onFilters({
      ...filters,
      kinds: filters.kinds.includes(k) ? filters.kinds.filter((x) => x !== k) : [...filters.kinds, k],
    });

  return (
    <section className="mt-6 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h2 className="text-sm font-semibold">Línea de tiempo</h2>
          <p className="text-xs text-muted-foreground">Todo lo que pasó con el cliente, de lo más nuevo a lo más viejo.</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-muted-foreground">
            Desde
            <input
              type="date"
              value={filters.from}
              onChange={(e) => onFilters({ ...filters, from: e.target.value })}
              className="mt-1 block h-9 rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
            />
          </label>
          <label className="text-xs text-muted-foreground">
            Hasta
            <input
              type="date"
              value={filters.to}
              onChange={(e) => onFilters({ ...filters, to: e.target.value })}
              className="mt-1 block h-9 rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
            />
          </label>
          {(filters.kinds.length > 0 || filters.from || filters.to) && (
            <Button variant="ghost" className="h-9 px-3" onClick={() => onFilters({ kinds: [], from: "", to: "" })}>
              Limpiar
            </Button>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {kinds.map((k) => {
          const on = filters.kinds.includes(k);
          const Icon = ICON[k];
          return (
            <button
              key={k}
              type="button"
              onClick={() => toggle(k)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border px-3 py-1 text-xs transition-colors",
                on ? "choice-on font-medium" : "border-border text-muted-foreground hover:bg-muted",
              )}
            >
              <Icon size={13} /> {KIND_LABEL[k]}
            </button>
          );
        })}
      </div>

      <div className="mt-4">
        {q.isLoading ? (
          <SpinnerBlock className="py-8" label="Cargando movimientos" />
        ) : q.isError ? (
          <p className="py-8 text-center text-sm text-danger">
            No se pudo cargar la línea de tiempo.{" "}
            <button className="underline" onClick={() => void q.refetch()}>
              Reintentar
            </button>
          </p>
        ) : items.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Sin movimientos con estos filtros.</p>
        ) : (
          <ol className="space-y-2">
            {items.map((it) => {
              const d = describeItem(it);
              const Icon = ICON[it.kind] ?? Banknote;
              const clickable = Boolean(it.sale_id);
              const Row = clickable ? "button" : "div";
              return (
                <li key={`${it.kind}:${it.id}`}>
                  <Row
                    {...(clickable ? { type: "button" as const, onClick: () => setSaleId(it.sale_id) } : {})}
                    className={cn(
                      "flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left",
                      clickable ? "transition hover:bg-muted/50" : "",
                    )}
                  >
                    <span className={cn("mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg", TONE[d.tone])}>
                      <Icon size={15} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">{d.title}</span>
                      {d.detail && (
                        <span className="block whitespace-pre-wrap break-words text-xs text-muted-foreground">{d.detail}</span>
                      )}
                      <span className="block text-xs text-muted-foreground">
                        {when(it.at)}
                        {it.store_name ? ` · ${it.store_name}` : ""}
                      </span>
                    </span>
                    {showsAmount(it) && (
                      <span
                        className={cn(
                          "shrink-0 text-sm font-semibold tabular-nums",
                          it.amount < 0 ? "text-muted-foreground" : "text-foreground",
                        )}
                      >
                        {formatCurrency(it.amount)}
                      </span>
                    )}
                  </Row>
                </li>
              );
            })}
          </ol>
        )}
        {q.hasNextPage && (
          <div className="mt-3 flex justify-center">
            <Button variant="secondary" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
              Ver más
            </Button>
          </div>
        )}
      </div>

      {saleId && <TicketModal open onOpenChange={(o) => !o && setSaleId(null)} saleId={saleId} />}
    </section>
  );
}
