"use client";

// Piezas comunes de Contabilidad (ADR-066).

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpenCheck, Lock, ShieldAlert } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/ui/PageHeader";
import { Spinner } from "@/components/ui/Spinner";
import { UpgradeModal } from "@/components/saas/UpgradeModal";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import { ACCOUNT_KIND_LABEL, type AccountKind } from "@/lib/accounting/journal";
import { useAccSettings, useAccountingAccess } from "@/modules/accounting/hooks";
import type { AccAccount } from "@/modules/accounting/api";
import { SetupCard } from "./SetupCard";

export { fmtDate, inputCls, selectCls, today, parseNum } from "@/components/purchases/shared";

const TABS: Array<{ href: string; label: string }> = [
  { href: "/contabilidad", label: "Resumen" },
  { href: "/contabilidad/asientos", label: "Asientos" },
  { href: "/contabilidad/libros", label: "Libros" },
  { href: "/contabilidad/plan-de-cuentas", label: "Plan de cuentas" },
  { href: "/contabilidad/mapeos", label: "Mapeos" },
  { href: "/contabilidad/cierres", label: "Cierres" },
];

export function AccountingTabs() {
  const pathname = usePathname();
  return (
    <nav aria-label="Contabilidad" className="mt-4 flex gap-1 overflow-x-auto [scrollbar-width:none]">
      {TABS.map((t) => {
        const on = pathname === t.href;
        return (
          <Link
            key={t.href}
            href={t.href as never}
            className={cn(
              "shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold transition",
              on ? "bg-ninja-flame/[0.12] text-ninja-flameSoft" : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * Encabezado + pestañas + estado de acceso. Renderiza `children` sólo con la
 * feature, el rol y la contabilidad ya activada (si no, muestra el alta).
 */
export function AccountingFrame({
  title,
  description,
  actions,
  children,
  requireSetup = true,
}: {
  title: string;
  description: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  requireSetup?: boolean;
}) {
  const access = useAccountingAccess();
  const settings = useAccSettings(access.enabled);
  const [upgrade, setUpgrade] = useState(false);
  const ready = access.ready && (!access.enabled || !settings.isLoading);
  const configured = Boolean(settings.data);

  return (
    <>
      <PageHeader
        eyebrow="Contabilidad"
        title={title}
        icon={BookOpenCheck}
        description={description}
        actions={access.enabled && configured ? actions : undefined}
      />
      <AccountingTabs />
      {!ready && (
        <div className="mt-10 flex justify-center">
          <Spinner />
        </div>
      )}
      {ready && access.locked && (
        <div className="mt-8 rounded-xl bg-muted/40 p-8 text-center">
          <Lock className="mx-auto text-ninja-flameSoft" size={28} />
          <p className="mt-3 font-semibold">Contabilidad no está incluida en tu plan</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Asientos automáticos desde ventas, cobros, compras, pagos, caja y procesadores, plan de cuentas, cierre
            mensual, libros y export para el sistema de tu estudio contable.
          </p>
          <Button className="mt-4" onClick={() => setUpgrade(true)}>
            Ver planes
          </Button>
          <UpgradeModal open={upgrade} onOpenChange={setUpgrade} featureKey="contabilidad" featureLabel="Contabilidad" />
        </div>
      )}
      {ready && !access.locked && access.forbidden && (
        <div className="mt-8 rounded-xl bg-muted/40 p-8 text-center">
          <ShieldAlert className="mx-auto text-warning" size={28} />
          <p className="mt-3 font-semibold">Sólo el dueño o un encargado ven la contabilidad</p>
        </div>
      )}
      {ready && access.enabled && !configured && requireSetup && <SetupCard />}
      {ready && access.enabled && (configured || !requireSetup) && children}
    </>
  );
}

export const KIND_TONE: Record<AccountKind, BadgeTone> = {
  activo: "info",
  pasivo: "warning",
  patrimonio: "gold",
  ingreso: "success",
  egreso: "danger",
};

export function KindBadge({ kind }: { kind: AccountKind }) {
  return <Badge tone={KIND_TONE[kind]}>{ACCOUNT_KIND_LABEL[kind]}</Badge>;
}

/** Importe del libro: vacío si es cero. */
export function money(n: number | null | undefined): string {
  return n ? formatCurrency(n) : "";
}

/** Selector de cuenta imputable agrupado por tipo. */
export function AccountSelect({
  accounts,
  value,
  onChange,
  className,
  placeholder = "Elegí una cuenta",
  includeNonImputable = false,
  "aria-label": ariaLabel,
}: {
  accounts: AccAccount[];
  value: string | null;
  onChange: (id: string) => void;
  className?: string;
  placeholder?: string;
  includeNonImputable?: boolean;
  "aria-label"?: string;
}) {
  const kinds: AccountKind[] = ["activo", "pasivo", "patrimonio", "ingreso", "egreso"];
  const usable = accounts.filter((a) => (includeNonImputable || a.imputable) && a.is_active);
  return (
    <select
      aria-label={ariaLabel ?? placeholder}
      className={cn(
        "h-10 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none transition focus:border-ninja-flameSoft focus:ring-4 focus:ring-ninja-flameSoft/15",
        className,
      )}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="" className="bg-popover text-popover-foreground">
        {placeholder}
      </option>
      {kinds.map((k) => (
        <optgroup key={k} label={ACCOUNT_KIND_LABEL[k]}>
          {usable
            .filter((a) => a.kind === k)
            .map((a) => (
              <option key={a.id} value={a.id} className="bg-popover text-popover-foreground">
                {a.code} · {a.name}
              </option>
            ))}
        </optgroup>
      ))}
    </select>
  );
}

/** Rango de fechas simple con atajos por mes. */
export function RangeFields({
  from,
  to,
  onChange,
}: {
  from: string;
  to: string;
  onChange: (v: { from: string; to: string }) => void;
}) {
  const months = lastMonths(12);
  const cls =
    "h-10 rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none transition focus:border-ninja-flameSoft focus:ring-4 focus:ring-ninja-flameSoft/15";
  const current = months.find((m) => m.from === from && m.to === to)?.from ?? "";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        aria-label="Mes"
        className={cls}
        value={current}
        onChange={(e) => {
          const m = months.find((x) => x.from === e.target.value);
          if (m) onChange({ from: m.from, to: m.to });
        }}
      >
        <option value="" className="bg-popover text-popover-foreground">
          Rango a medida
        </option>
        {months.map((m) => (
          <option key={m.from} value={m.from} className="bg-popover text-popover-foreground">
            {m.label}
          </option>
        ))}
      </select>
      <input type="date" aria-label="Desde" className={cls} value={from} onChange={(e) => onChange({ from: e.target.value, to })} />
      <input type="date" aria-label="Hasta" className={cls} value={to} onChange={(e) => onChange({ from, to: e.target.value })} />
    </div>
  );
}

const MONTH_NAMES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

export function monthName(period: string): string {
  return `${MONTH_NAMES[Number(period.slice(5, 7)) - 1] ?? ""} ${period.slice(0, 4)}`;
}

export function lastMonths(n: number): Array<{ from: string; to: string; label: string }> {
  const now = new Date();
  const out: Array<{ from: string; to: string; label: string }> = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    const p = (x: number) => String(x).padStart(2, "0");
    const from = `${d.getFullYear()}-${p(d.getMonth() + 1)}-01`;
    const to = `${last.getFullYear()}-${p(last.getMonth() + 1)}-${p(last.getDate())}`;
    out.push({ from, to, label: monthName(from) });
  }
  return out;
}

/** Mes en curso (del 1 a hoy). */
export function currentMonthRange(): { from: string; to: string } {
  const m = lastMonths(1)[0]!;
  return { from: m.from, to: m.to };
}
