"use client";

// =============================================================================
// PaymentHistory — "Registro de pagos" del panel del dueño.
//
// Presentacional puro: recibe la lista de pagos ya cargada (billing_records que
// el dueño puede ver vía my_subscription) y la renderiza como tabla prolija
// (fecha, concepto/período, medio, monto). Estado vacío cuidado cuando no hay
// cobros todavía (típico de un tenant en trial sin pago).
//
// Es presentacional a propósito: billing_records tiene RLS solo-staff, así que
// la fuente de los pagos la decide quien lo monta (hoy, el último pago expuesto
// por my_subscription). Si en el futuro se expone el historial completo, basta
// con pasarle más filas: la tabla ya soporta N pagos.
// =============================================================================

import { Receipt } from "lucide-react";

export interface PaymentRecord {
  id?: string;
  amount: number;
  currency?: string | null;
  medium: string;
  period_start?: string | null;
  period_end?: string | null;
  receipt_ref?: string | null;
  notes?: string | null;
  created_at: string;
}

// Medios de pago legibles (billing_records.medium guarda la key cruda).
const MEDIUM_LABELS: Record<string, string> = {
  mercado_pago: "Mercado Pago",
  mercadopago: "Mercado Pago",
  mp: "Mercado Pago",
  transferencia: "Transferencia",
  efectivo: "Efectivo",
  tarjeta: "Tarjeta",
  card: "Tarjeta",
  manual: "Registro manual",
};

function mediumLabel(m: string): string {
  return MEDIUM_LABELS[m] ?? (m ? m.charAt(0).toUpperCase() + m.slice(1) : "—");
}

function fmtMoney(n: number | null | undefined, currency?: string | null): string {
  const cur = (currency ?? "ARS").toUpperCase();
  const symbol = cur === "ARS" ? "$" : `${cur} `;
  return `${symbol}${Number(n ?? 0).toLocaleString("es-AR")}`;
}

function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("es-AR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

// Concepto legible del cobro: el período facturado si existe, si no las notas.
function conceptLabel(p: PaymentRecord): string {
  if (p.period_start || p.period_end) {
    const a = p.period_start ? fmtDate(p.period_start) : null;
    const b = p.period_end ? fmtDate(p.period_end) : null;
    if (a && b) return `Período ${a} – ${b}`;
    return `Período hasta ${b ?? a}`;
  }
  if (p.notes && p.notes.trim()) return p.notes.trim();
  return "Suscripción";
}

export function PaymentHistory({
  payments,
  className,
}: {
  payments: PaymentRecord[];
  className?: string;
}) {
  if (payments.length === 0) {
    return (
      <div
        className={`rounded-xl border border-dashed border-border bg-muted/20 p-6 text-center ${className ?? ""}`}
      >
        <span className="mx-auto grid h-10 w-10 place-items-center rounded-full bg-muted text-muted-foreground">
          <Receipt size={18} />
        </span>
        <p className="mt-3 text-sm font-medium text-foreground">
          Todavía no hay pagos registrados
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Cuando se procese tu primer cobro, vas a ver acá el detalle de cada
          pago (fecha, período, medio y monto).
        </p>
      </div>
    );
  }

  return (
    <div className={`overflow-hidden rounded-xl border border-border ${className ?? ""}`}>
      {/* Encabezado (desktop) */}
      <div className="hidden grid-cols-[1fr_1.4fr_1fr_auto] gap-3 border-b border-border bg-muted/30 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground sm:grid">
        <span>Fecha</span>
        <span>Concepto</span>
        <span>Medio</span>
        <span className="text-right">Monto</span>
      </div>
      <ul className="divide-y divide-border">
        {payments.map((p, i) => (
          <li
            key={p.id ?? `${p.created_at}-${i}`}
            className="grid grid-cols-2 gap-x-3 gap-y-1 px-4 py-3 text-sm sm:grid-cols-[1fr_1.4fr_1fr_auto] sm:items-center"
          >
            {/* Fecha */}
            <span className="font-medium text-foreground">
              {fmtDate(p.created_at)}
            </span>
            {/* Concepto */}
            <span className="order-3 col-span-2 text-xs text-muted-foreground sm:order-none sm:col-span-1 sm:text-sm">
              {conceptLabel(p)}
            </span>
            {/* Medio */}
            <span className="text-xs text-muted-foreground sm:text-sm">
              {mediumLabel(p.medium)}
            </span>
            {/* Monto */}
            <span className="text-right font-semibold text-foreground">
              {fmtMoney(p.amount, p.currency)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
