"use client";

// Fila rica del listado de ventas (rediseño de /ventas). Mobile-first: en el
// celular es una tarjeta apilada; desde sm, miniaturas a la izquierda, datos
// al medio y total + cobros a la derecha. Toda la fila abre el detalle; las
// acciones tienen texto (o aria-label + title en el celular) y un menú "Más".
import { Ban, CreditCard, Eye, Lock, Mail, MoreHorizontal, Receipt, RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Skeleton } from "@/components/ui/Skeleton";
import { Dropdown, DropdownContent, DropdownItem, DropdownSeparator, DropdownTrigger } from "@/components/ui/Dropdown";
import { ProductThumb } from "@/components/products/ProductThumb";
import { BranchDot } from "@/components/branches/BranchSwitcher";
import { PaymentChipView } from "@/components/sales/SalePaymentLogo";
import type { SaleExtras } from "@/modules/sales/listExtras";
import type { SaleRow } from "@/modules/sales/api";
import type { SaleAlertBadge } from "@/lib/reports/paymentDisputes";
import {
  absoluteDateTime,
  CHANNEL_LABEL,
  fiscalBadge,
  groupPayments,
  relativeTime,
  returnState,
  saleStatusBadge,
  thumbsPreview,
  unitsCount,
} from "@/lib/sales/salesList";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

type Branch = Parameters<typeof BranchDot>[0]["branch"];

export interface SaleCardProps {
  sale: SaleRow;
  numberLabel: string;
  extras: SaleExtras | undefined;
  extrasLoading: boolean;
  providerOf: (ref: string | null) => string | null;
  branch: Branch;
  branchName: string | null;
  showBranch: boolean;
  alerts: SaleAlertBadge[];
  now: number;
  /** Motivo por el que no puede devolver (rol), o null. */
  returnDenied: string | null;
  returnLocked: boolean;
  /** Motivo por el que no puede anular (rol / día), o null. */
  voidDenied: string | null;
  onOpen: () => void;
  onTicket: () => void;
  onCobros: () => void;
  onReturn: () => void;
  onVoid: () => void;
}

const ACTION =
  "inline-flex h-9 items-center justify-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function SaleCard(p: SaleCardProps) {
  const { sale, extras } = p;
  const items = extras?.items ?? [];
  const ret = returnState(items);
  const status = saleStatusBadge(sale.status, ret);
  const fiscal = fiscalBadge(extras?.fiscal ?? []);
  const chips = groupPayments(extras?.payments ?? [], p.providerOf);
  const { shown, extra } = thumbsPreview(items, 3);
  const units = unitsCount(items);
  const customer = sale.customers?.name?.trim() || null;
  const voided = sale.status === "voided";
  const canReturn = sale.status === "completed" && ret !== "full" && !p.returnDenied;
  const canVoid = sale.status === "completed";

  const meta = [
    extras ? CHANNEL_LABEL[extras.channel] : null,
    p.showBranch ? p.branchName : null,
    extras?.registerName ?? null,
    extras?.cashierName ?? null,
  ].filter(Boolean) as string[];

  return (
    <li className="group relative">
      <div
        role="button"
        tabIndex={0}
        onClick={p.onOpen}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            p.onOpen();
          }
        }}
        aria-label={`Venta ${p.numberLabel}, ${formatCurrency(sale.total)}, ${status.label}`}
        className={cn(
          "grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-3 px-4 pb-3 pt-4 transition hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none sm:grid-cols-[92px_minmax(0,1fr)_auto] sm:gap-x-4 sm:px-5 sm:pb-4",
          voided && "opacity-75",
        )}
      >
        {/* Miniaturas de los primeros productos */}
        {/* Miniaturas superpuestas (pila), la primera adelante. */}
        <div className="flex shrink-0 items-start" aria-hidden>
          {p.extrasLoading && !extras ? (
            <Skeleton className="h-11 w-11" />
          ) : (
            <>
              {shown.map((it, i) => (
                <ProductThumb
                  key={it.id}
                  src={it.image_url}
                  size={44}
                  className={cn("border-2 border-card", i > 0 && "-ml-5")}
                />
              ))}
              {extra > 0 && (
                <span className="-ml-5 grid h-11 w-11 place-items-center rounded-md border-2 border-card bg-muted text-xs font-semibold text-foreground">
                  +{extra}
                </span>
              )}
            </>
          )}
        </div>

        {/* Datos */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-mono text-sm font-semibold">{p.numberLabel}</span>
            <Badge tone={status.tone}>{status.label}</Badge>
            {fiscal && (
              <Badge tone={fiscal.tone} title={fiscal.title}>
                {fiscal.label}
              </Badge>
            )}
            {p.alerts.map((a) => (
              <Badge key={a.key} tone={a.tone} title={a.title}>
                {a.label}
              </Badge>
            ))}
            {sale.receipt_emailed_at && (
              <span title="Comprobante enviado por email" className="inline-flex text-muted-foreground">
                <Mail size={14} aria-label="Comprobante enviado por email" />
              </span>
            )}
          </div>
          <p className="mt-1 text-sm">
            <span className="font-medium text-foreground">{relativeTime(sale.created_at, p.now)}</span>
            <span className="text-muted-foreground"> · {absoluteDateTime(sale.created_at)}</span>
          </p>
          <p className="mt-1 line-clamp-2 text-sm text-muted-foreground sm:truncate">
            <span className={cn(customer ? "text-foreground" : "")}>{customer ?? "Consumidor final"}</span>
            {meta.length > 0 && (
              <>
                {" · "}
                {p.showBranch && p.branch && (
                  <BranchDot branch={p.branch} className="mr-1 inline-block h-2 w-2 align-middle" />
                )}
                {meta.join(" · ")}
              </>
            )}
          </p>
          {items.length > 0 && (
            <p className="mt-1 truncate text-sm text-muted-foreground">
              {items.length === 1 ? items[0]!.product_name : `${items[0]!.product_name} y ${items.length - 1} más`}
              <span className="tabular-nums"> · {units === 1 ? "1 unidad" : `${units} unidades`}</span>
            </p>
          )}
        </div>

        {/* Total + cobros */}
        <div className="col-span-2 flex flex-wrap items-center justify-between gap-2 sm:col-span-1 sm:w-[280px] sm:pb-11 sm:flex-col sm:flex-nowrap sm:items-end sm:justify-start">
          <span
            className={cn(
              "text-xl font-bold tabular-nums tracking-tight sm:text-right",
              voided && "text-muted-foreground line-through",
            )}
          >
            {formatCurrency(sale.total)}
          </span>
          <div className="flex flex-wrap gap-1.5 sm:justify-end">
            {p.extrasLoading && !extras ? (
              <Skeleton className="h-7 w-32" />
            ) : chips.length > 0 ? (
              chips.map((c) => <PaymentChipView key={c.key} chip={c} showAmount={chips.length > 1} />)
            ) : (
              <span className="text-xs text-muted-foreground">Sin cobros registrados</span>
            )}
          </div>
        </div>
      </div>

      {/* Acciones (fuera del área clickeable para no abrir el detalle) */}
      <div className="flex items-center justify-end gap-1 border-t border-border/60 px-3 py-1.5 sm:absolute sm:bottom-3 sm:right-3 sm:border-0 sm:p-0">
        <button type="button" onClick={p.onTicket} className={ACTION} title="Ver e imprimir el ticket">
          <Receipt size={16} aria-hidden />
          <span>Ticket</span>
        </button>
        {sale.status === "completed" && ret !== "full" && (
          <button
            type="button"
            onClick={canReturn ? p.onReturn : undefined}
            aria-disabled={!canReturn || undefined}
            title={
              p.returnDenied ??
              (p.returnLocked ? "Devoluciones: función no incluida en tu plan" : "Devolución o cambio")
            }
            className={cn(ACTION, !canReturn && "cursor-not-allowed opacity-50")}
          >
            {p.returnLocked || p.returnDenied ? <Lock size={14} aria-hidden /> : <RotateCcw size={16} aria-hidden />}
            <span>Devolver</span>
          </button>
        )}
        <Dropdown>
          <DropdownTrigger asChild>
            <button type="button" className={ACTION} aria-label="Más acciones" title="Más acciones">
              <MoreHorizontal size={16} aria-hidden />
              <span className="hidden sm:inline">Más</span>
            </button>
          </DropdownTrigger>
          <DropdownContent>
            <DropdownItem onSelect={p.onOpen}>
              <Eye size={15} /> Ver detalle
            </DropdownItem>
            <DropdownItem onSelect={p.onCobros}>
              <CreditCard size={15} /> Ver cobros
            </DropdownItem>
            {canVoid && (
              <>
                <DropdownSeparator />
                <DropdownItem
                  disabled={Boolean(p.voidDenied)}
                  onSelect={p.onVoid}
                  className="text-danger focus:text-danger"
                  title={p.voidDenied ?? undefined}
                >
                  <Ban size={15} /> Anular venta
                </DropdownItem>
                {p.voidDenied && (
                  <p className="px-3 pb-1.5 text-xs text-muted-foreground">{p.voidDenied}</p>
                )}
              </>
            )}
          </DropdownContent>
        </Dropdown>
      </div>
    </li>
  );
}

/** Esqueleto de una fila mientras carga la página. */
export function SaleCardSkeleton() {
  return (
    <li className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:gap-4 sm:px-5" aria-hidden>
      <div className="flex gap-1 sm:w-[92px]">
        <Skeleton className="h-11 w-11" />
      </div>
      <div className="flex-1 space-y-2">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-3.5 w-56" />
        <Skeleton className="h-3.5 w-48" />
      </div>
      <div className="space-y-2 sm:w-[280px]">
        <Skeleton className="h-6 w-32 sm:ml-auto" />
        <Skeleton className="h-7 w-40 sm:ml-auto" />
      </div>
    </li>
  );
}
