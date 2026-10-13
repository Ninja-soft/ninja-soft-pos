"use client";

// Resumen de /ventas: total cobrado, cantidad de ventas, ticket promedio y
// desglose por medio de pago (barra apilada en tonos del tema + leyenda con
// logos). Sale de sales_report (server-side, mismo alcance por sucursal que
// Reportes); cuenta sólo ventas completadas del período.
import { useSalesReport } from "@/modules/reports/hooks";
import { Skeleton } from "@/components/ui/Skeleton";
import { PaymentLogo } from "@/components/sales/SalePaymentLogo";
import { averageTicket, methodBreakdown, summaryPeriod } from "@/lib/sales/salesList";
import { formatCurrency, formatInt } from "@/lib/utils/format";

// Opacidades del primer plano para los tramos de la barra: sin degradados ni
// colores de marca, se distinguen por valor y por el orden de la leyenda.
const SHADES = ["bg-foreground/85", "bg-foreground/60", "bg-foreground/40", "bg-foreground/25", "bg-foreground/15"];

export function SalesSummary({
  range,
  storeId,
  method,
}: {
  range: { from?: Date; to?: Date } | undefined;
  storeId: string | null;
  method: string | null;
}) {
  const period = summaryPeriod(range);
  const { data, isLoading, isError } = useSalesReport(period.fromISO, period.toISO, { storeId, method });

  if (isError) return null;

  const total = Number(data?.total) || 0;
  const count = Number(data?.count) || 0;
  const shares = methodBreakdown(data?.by_method ?? []);
  const top = shares.slice(0, SHADES.length);

  return (
    <section
      aria-label="Resumen del período"
      aria-busy={isLoading || undefined}
      className="mt-5 rounded-lg border border-border bg-card p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {period.label}
          {method ? " · un medio" : ""}
        </h2>
        <span className="text-xs text-muted-foreground">Ventas completadas</span>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
        <div className="col-span-2 sm:col-span-1">
          <dt className="text-xs text-muted-foreground">Total vendido</dt>
          <dd className="mt-0.5 text-2xl font-bold tabular-nums tracking-tight sm:text-3xl">
            {isLoading ? <Skeleton className="h-8 w-40" /> : formatCurrency(total)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Ventas</dt>
          <dd className="mt-0.5 text-lg font-semibold tabular-nums">
            {isLoading ? <Skeleton className="h-6 w-12" /> : formatInt(count)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Ticket promedio</dt>
          <dd className="mt-0.5 text-lg font-semibold tabular-nums">
            {isLoading ? <Skeleton className="h-6 w-24" /> : formatCurrency(averageTicket(total, count))}
          </dd>
        </div>
      </dl>

      {isLoading ? (
        <Skeleton className="mt-4 h-2 w-full" />
      ) : top.length > 0 ? (
        <div className="mt-4">
          <div className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full" aria-hidden>
            {top.map((s, i) => (
              <span key={s.method} className={SHADES[i]} style={{ width: `${Math.max(s.pct, 1.5)}%` }} />
            ))}
          </div>
          <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-2" aria-label="Desglose por medio de pago">
            {shares.map((s, i) => (
              <li key={s.method} className="inline-flex items-center gap-2 text-sm">
                <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${SHADES[Math.min(i, SHADES.length - 1)]}`} />
                <PaymentLogo method={s.method} label={s.label} size={20} />
                <span className="font-medium">{s.label}</span>
                <span className="tabular-nums text-muted-foreground">
                  {formatCurrency(s.total)} · {s.pct.toLocaleString("es-AR")}%
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
