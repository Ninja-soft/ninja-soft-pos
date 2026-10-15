"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, PackageSearch, Send, Warehouse } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { EmptyState } from "@/components/ui/EmptyState";
import { SearchField } from "@/components/ui/SearchField";
import { formatInt } from "@/lib/utils/format";
import {
  COVERAGE_LABELS,
  FULL_CONDITIONS,
  FULL_NA_REASONS,
  coverage,
  soldInWindow,
  type CoverageResult,
  type FullNaReason,
} from "@/lib/mercadolibre/full";
import type { MlFullOverview, MlFullRow } from "@/modules/mercadolibre/fullHooks";

export interface FullStockLine {
  row: MlFullRow;
  cov: CoverageResult;
  sold: number;
  soldSource: "ops" | "orders" | "none";
}

/** Filas con su cobertura, ordenadas por urgencia. */
export function stockLines(overview: MlFullOverview): FullStockLine[] {
  const order = { out: 0, critical: 1, low: 2, ok: 3, no_sales: 4 } as const;
  return overview.rows
    .map((row) => {
      const s = soldInWindow(row);
      const cov = coverage({
        available: row.available,
        inTransit: row.in_transit,
        sold: s.sold,
        leadDays: overview.settings.lead_days,
        targetDays: overview.settings.target_days,
      });
      return { row, cov, sold: s.sold, soldSource: s.source };
    })
    .sort((a, b) => order[a.cov.level] - order[b.cov.level] || a.row.title.localeCompare(b.row.title));
}

const NA_KEYS: FullNaReason[] = ["damaged", "lost", "withdrawal", "internal_process", "transfer", "no_fiscal_coverage", "not_supported", "other"];

function Stat({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="rounded-xl bg-card p-3.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-2xl font-bold tabular-nums">{formatInt(value)}</p>
      <p className="text-[11px] text-muted-foreground">{hint}</p>
    </div>
  );
}

// Stock en Full vs propio, cobertura y alertas de quiebre (ADR-142).
export function MlFullStock({
  overview,
  onSend,
}: {
  overview: MlFullOverview;
  onSend?: (lines: Array<{ product_id: string; variant_id: string | null; qty: number }>) => void;
}) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const lines = useMemo(() => stockLines(overview), [overview]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return lines;
    return lines.filter(({ row }) =>
      [row.title, row.inventory_id, row.sku, row.product_name, row.ml_item_id].some((v) => v && v.toLowerCase().includes(q)),
    );
  }, [lines, search]);

  const totals = useMemo(
    () =>
      overview.rows.reduce(
        (t, r) => ({
          available: t.available + r.available,
          notAvailable: t.notAvailable + r.not_available,
          inTransit: t.inTransit + r.in_transit,
          own: t.own + Math.max(0, r.own_qty ?? 0),
        }),
        { available: 0, notAvailable: 0, inTransit: 0, own: 0 },
      ),
    [overview.rows],
  );
  const alerts = lines.filter((l) => l.cov.level === "out" || l.cov.level === "critical");
  const toSend = lines.filter((l) => l.cov.suggestQty > 0 && l.row.product_id);

  if (overview.rows.length === 0) {
    return (
      <EmptyState
        icon={Warehouse}
        title="Todavía no hay stock en Full"
        description="Cuando una publicación vinculada esté en Full, tocá Sincronizar: aparece acá con su código de inventario y su stock."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Stat label="Disponible en Full" value={totals.available} hint="Lo que ML puede vender ya" />
        <Stat label="No disponible en Full" value={totals.notAvailable} hint="Dañado, perdido, retiro, control" />
        <Stat label="En camino a Full" value={totals.inTransit} hint="Despachado, sin recibir" />
        <Stat label="Stock propio vinculado" value={totals.own} hint="En tu sucursal de Mercado Libre" />
      </div>

      {alerts.length > 0 && (
        <Callout
          tone="danger"
          icon={AlertTriangle}
          title={alerts.length === 1 ? "1 producto se queda sin stock en Full" : `${alerts.length} productos se quedan sin stock en Full`}
          actions={
            onSend && toSend.length > 0 ? (
              <Button
                size="sm"
                onClick={() =>
                  onSend(toSend.map((l) => ({ product_id: l.row.product_id!, variant_id: l.row.variant_id, qty: l.cov.suggestQty })))
                }
              >
                <Send size={15} /> Armar envío con lo sugerido
              </Button>
            ) : undefined
          }
        >
          Con las ventas de 30 días, lo disponible no alcanza para los {overview.settings.lead_days} días que tarda un envío en
          estar disponible: {alerts.slice(0, 3).map((a) => a.row.title).join(", ")}
          {alerts.length > 3 ? " y otros" : ""}.
        </Callout>
      )}

      <SearchField value={search} onValueChange={setSearch} aria-label="Buscar en Full" placeholder="Buscar por título, código de inventario o SKU" />

      <ul className="space-y-2" aria-label="Stock en Full">
        {filtered.map(({ row, cov, sold, soldSource }) => {
          const meta = COVERAGE_LABELS[cov.level];
          const expanded = open === row.id;
          return (
            <li key={row.id} className="rounded-xl bg-card p-3.5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <p className="text-sm font-semibold">{row.title}</p>
                    {row.variation_label && <Badge tone="neutral">{row.variation_label}</Badge>}
                    <Badge tone={meta.tone}>{meta.label}</Badge>
                    {!row.product_id && <Badge tone="warning">Sin vincular</Badge>}
                  </div>
                  <p className="font-mono text-xs text-muted-foreground">
                    {row.inventory_id}
                    {row.ml_item_id ? ` · ${row.ml_item_id}` : ""}
                    {row.sku ? ` · SKU ${row.sku}` : ""}
                  </p>
                  {row.last_error && <p className="text-xs text-warning">No se pudo leer en la última sincronización: {row.last_error}</p>}
                </div>
                <dl className="grid grid-cols-4 gap-2 text-center sm:w-[22rem]">
                  <div>
                    <dt className="text-[11px] text-muted-foreground">Disponible</dt>
                    <dd className="text-base font-bold tabular-nums">{formatInt(row.available)}</dd>
                  </div>
                  <div>
                    <dt className="text-[11px] text-muted-foreground">No disp.</dt>
                    <dd className="text-base font-bold tabular-nums">{formatInt(row.not_available)}</dd>
                  </div>
                  <div>
                    <dt className="text-[11px] text-muted-foreground">En camino</dt>
                    <dd className="text-base font-bold tabular-nums">{formatInt(row.in_transit)}</dd>
                  </div>
                  <div>
                    <dt className="text-[11px] text-muted-foreground">Propio</dt>
                    <dd className="text-base font-bold tabular-nums">{row.own_qty === null ? "-" : formatInt(row.own_qty)}</dd>
                  </div>
                </dl>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>
                  Vendidas en 30 días: <strong className="text-foreground">{formatInt(sold)}</strong>
                  {soldSource === "orders" ? " (según tus ventas)" : ""}
                </span>
                {cov.daysCover !== null && (
                  <span>
                    Alcanza para <strong className="text-foreground">{cov.daysCover} días</strong>
                    {row.in_transit > 0 ? ` (${cov.daysCoverWithTransit} con lo que está en camino)` : ""}
                  </span>
                )}
                {cov.suggestQty > 0 && (
                  <span>
                    Conviene mandar <strong className="text-foreground">{formatInt(cov.suggestQty)}</strong>
                  </span>
                )}
                {row.pending_sales > 0 && <span>{formatInt(row.pending_sales)} vendidas desde la última lectura</span>}
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {row.not_available > 0 && (
                  <Button variant="ghost" size="sm" onClick={() => setOpen(expanded ? null : row.id)} aria-expanded={expanded}>
                    <PackageSearch size={15} /> {expanded ? "Ocultar motivos" : "Ver por qué no está disponible"}
                  </Button>
                )}
                {onSend && row.product_id && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => onSend([{ product_id: row.product_id!, variant_id: row.variant_id, qty: Math.max(1, cov.suggestQty) }])}
                  >
                    <Send size={15} /> Mandar a Full
                  </Button>
                )}
              </div>
              {expanded && (
                <div className="mt-2 space-y-1 rounded-lg bg-muted p-3 text-sm">
                  {NA_KEYS.filter((k) => Number(row[k]) > 0).map((k) => (
                    <div key={k} className="flex justify-between gap-2">
                      <span title={FULL_NA_REASONS[k].help}>{FULL_NA_REASONS[k].label}</span>
                      <span className="font-semibold tabular-nums">{formatInt(Number(row[k]))}</span>
                    </div>
                  ))}
                  {(row.conditions ?? []).length > 0 && (
                    <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                      {row.conditions.map((c, i) => (
                        <li key={i}>
                          {FULL_CONDITIONS[c.condition] ?? c.condition}: {formatInt(c.quantity)}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
