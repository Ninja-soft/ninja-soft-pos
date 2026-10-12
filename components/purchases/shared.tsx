"use client";

// Piezas comunes de Compras (F18 · H101, ADR-050).

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Lock, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { UpgradeModal } from "@/components/saas/UpgradeModal";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import {
  ORDER_STATUS_LABEL,
  ORDER_STATUS_TONE,
  type OrderStatus,
} from "@/lib/purchases/orders";
import type { PurchaseEvent, Supplier } from "@/modules/purchases/api";

export { fmtDate, fmtDateTime, selectCls, storeName } from "@/components/stock/transfers/shared";

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  return <Badge tone={ORDER_STATUS_TONE[status]}>{ORDER_STATUS_LABEL[status]}</Badge>;
}

export function supplierName(suppliers: Pick<Supplier, "id" | "name">[], id: string | null | undefined): string {
  if (!id) return "Sin proveedor";
  return suppliers.find((s) => s.id === id)?.name ?? "Proveedor";
}

const fmtCache = new Map<string, Intl.NumberFormat>();

/** Importe con su moneda (pesos con el formato de siempre). */
export function formatMoney(value: number | null | undefined, currency = "ARS"): string {
  if (!currency || currency === "ARS") return formatCurrency(value);
  let f = fmtCache.get(currency);
  if (!f) {
    try {
      f = new Intl.NumberFormat("es-AR", { style: "currency", currency, minimumFractionDigits: 2 });
    } catch {
      f = new Intl.NumberFormat("es-AR", { minimumFractionDigits: 2 });
    }
    fmtCache.set(currency, f);
  }
  return f.format(value ?? 0);
}

/** Fecha local YYYY-MM-DD. */
export function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Número tolerante a coma decimal ("1.234,5" → 1234.5; "12,5" → 12.5). */
export function parseNum(v: string | number | null | undefined): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = String(v ?? "").trim();
  if (!s) return 0;
  const normalized = s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : 0;
}

export const inputCls =
  "h-10 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none transition focus:border-ninja-flameSoft focus:ring-4 focus:ring-ninja-flameSoft/15";

export const textareaCls =
  "min-h-[72px] w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none transition focus:border-ninja-flameSoft focus:ring-4 focus:ring-ninja-flameSoft/15";

const TABS: Array<{ href: string; label: string }> = [
  { href: "/compras/ordenes", label: "Órdenes" },
  { href: "/compras/recepciones", label: "Recepciones" },
  { href: "/compras/devoluciones", label: "Devoluciones" },
  { href: "/compras/facturas", label: "Facturas y pagos" },
  { href: "/compras/lotes", label: "Lotes" },
  { href: "/compras/proveedores", label: "Proveedores" },
];

/** Navegación entre las pantallas de Compras. */
export function ComprasTabs() {
  const pathname = usePathname();
  return (
    <nav aria-label="Compras" className="mt-4 flex gap-1 overflow-x-auto [scrollbar-width:none]">
      {TABS.map((t) => {
        const on = pathname === t.href;
        return (
          <Link
            key={t.href}
            href={t.href as never}
            className={cn(
              "shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold transition",
              on
                ? "bg-ninja-flame/[0.12] text-ninja-flameSoft"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Pantalla de Compras sin la feature en el plan. */
export function ComprasLocked({ featureKey = "compras", label = "Compras" }: { featureKey?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-8 rounded-xl bg-muted/40 p-8 text-center">
      <Lock className="mx-auto text-ninja-flameSoft" size={28} />
      <p className="mt-3 font-semibold">{label} no está incluido en tu plan</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
        Cargá proveedores, armá órdenes de compra, recibí la mercadería por sucursal con control de
        diferencias, registrá facturas y pagos y mantené al día el costo de cada producto.
      </p>
      <Button className="mt-4" onClick={() => setOpen(true)}>
        Ver planes
      </Button>
      <UpgradeModal open={open} onOpenChange={setOpen} featureKey={featureKey} featureLabel={label} />
    </div>
  );
}

export function Kpi({
  label,
  value,
  tone,
  onClick,
  icon: Icon,
}: {
  label: string;
  value: string | number;
  tone?: "warning" | "brand" | "danger" | "success";
  onClick?: () => void;
  icon?: LucideIcon;
}) {
  const Comp = onClick ? "button" : "div";
  return (
    <Comp
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className="rounded-xl bg-card p-4 text-left shadow-sm ring-1 ring-border transition hover:ring-ninja-flameSoft/40"
    >
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {Icon && <Icon size={13} />} {label}
      </div>
      <div
        className={cn(
          "mt-1 font-price text-xl font-black tabular-nums sm:text-2xl",
          tone === "warning" && "text-warning",
          tone === "brand" && "text-ninja-flameSoft",
          tone === "danger" && "text-danger",
          tone === "success" && "text-success",
        )}
      >
        {value}
      </div>
    </Comp>
  );
}

export const PURCHASE_EVENT_LABEL: Record<string, string> = {
  created: "Creado",
  updated: "Editado",
  sent: "Enviada al proveedor",
  reopened: "Vuelta a borrador",
  partially_received: "Recibida en parte",
  received: "Recibida",
  closed: "Cerrada con faltante",
  cancelled: "Cancelada",
  costing_applied: "Costeo de importación aplicado",
  voided: "Anulado",
  returned: "Devolución al proveedor",
  receipt_voided: "Recepción anulada",
  credit_linked: "Nota de crédito vinculada",
  credit_unlinked: "Nota de crédito desvinculada",
};

export function Timeline({ events }: { events: PurchaseEvent[] }) {
  if (events.length === 0) return null;
  return (
    <div>
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Historial</h4>
      <ol className="space-y-2 border-l border-border pl-4 text-sm">
        {events.map((e) => (
          <li key={e.id} className="relative">
            <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-ninja-flameSoft" />
            <div className="font-medium">{PURCHASE_EVENT_LABEL[e.kind] ?? e.kind}</div>
            <div className="text-xs text-muted-foreground">
              {new Date(e.created_at).toLocaleString("es-AR", {
                day: "2-digit",
                month: "2-digit",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
              {e.actor_name ? ` · ${e.actor_name}` : ""}
            </div>
            {e.notes && <div className="text-xs text-muted-foreground">{e.notes}</div>}
          </li>
        ))}
      </ol>
    </div>
  );
}

export function Info({ label, value, wide }: { label: string; value: React.ReactNode; wide?: boolean }) {
  return (
    <div className={cn(wide && "col-span-2 sm:col-span-4")}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

/** Campo con etiqueta (formularios de compras y tesorería). */
export function FormField({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-1.5 block text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

/** Lista de errores de validación (bloquean el guardado). */
export function ErrorList({ errors }: { errors: string[] }) {
  if (errors.length === 0) return null;
  return (
    <ul className="list-disc pl-4 text-xs text-danger">
      {errors.map((x) => (
        <li key={x}>{x}</li>
      ))}
    </ul>
  );
}

/** Encabezado de sección dentro de un formulario. */
export function SectionTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{children}</h4>
      {action}
    </div>
  );
}
