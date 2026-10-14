"use client";

// Tabla de la corrida por tienda: estado con chip (Pendiente / En curso / OK /
// Error), progreso por tienda, ofertas nuevas, con cambios y faltantes
// alineados a la derecha, y el total destacado.
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { StoreLogo } from "@/components/catalog/StoreLogo";
import { cn } from "@/lib/utils/cn";
import { storeRowState, type StoreRowState, type SyncRun } from "@/modules/internal/catalogSync";
import { fmtNum, ProgressBar } from "./catalogUi";

const STATE: Record<StoreRowState, { label: string; tone: BadgeTone }> = {
  pending: { label: "Pendiente", tone: "neutral" },
  running: { label: "En curso", tone: "info" },
  ok: { label: "OK", tone: "success" },
  error: { label: "Error", tone: "danger" },
};

function Num({ n, strong }: { n: number; strong?: boolean }) {
  return (
    <span className={cn("tabular-nums", n === 0 && !strong ? "text-muted-foreground/60" : "text-foreground")}>
      {fmtNum(n)}
    </span>
  );
}

export function CatalogSyncStoresTable({ run }: { run: SyncRun }) {
  const rows = run.stores.map((s) => ({ s, ...storeRowState(run, s) }));
  const done = rows.filter((r) => r.state === "ok" || r.state === "error").length;

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="flex items-center justify-between gap-3 border-b border-border bg-muted/40 px-4 py-2.5">
        <p className="text-sm font-medium text-foreground">Por tienda</p>
        <p className="text-xs tabular-nums text-muted-foreground">
          {done} de {rows.length} cerradas
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="text-left text-xs font-medium text-muted-foreground">
              <th scope="col" className="px-4 py-2 font-medium">Tienda</th>
              <th scope="col" className="px-3 py-2 font-medium">Estado</th>
              <th scope="col" className="w-40 px-3 py-2 font-medium">Progreso</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Ofertas nuevas</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Con cambios</th>
              <th scope="col" className="px-4 py-2 text-right font-medium">Faltantes</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ s, state, pct }) => (
              <tr key={s.key} className="border-t border-border">
                <td className="px-4 py-2.5">
                  <span className="flex items-center gap-2.5 font-medium text-foreground">
                    <StoreLogo storeKey={s.key} name={s.label} size={28} />
                    <span className="truncate">{s.label}</span>
                  </span>
                </td>
                <td className="px-3 py-2.5" title={s.error ?? undefined}>
                  <Badge tone={STATE[state].tone}>{STATE[state].label}</Badge>
                </td>
                <td className="px-3 py-2.5">
                  <ProgressBar
                    pct={pct}
                    label={`Progreso de ${s.label}`}
                    tone={state === "ok" ? "success" : state === "error" ? "danger" : state === "pending" ? "muted" : "brand"}
                  />
                </td>
                <td className="px-3 py-2.5 text-right"><Num n={s.nuevos} /></td>
                <td className="px-3 py-2.5 text-right"><Num n={s.actualizados} /></td>
                <td className="px-4 py-2.5 text-right"><Num n={s.faltantes} /></td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-border bg-muted/40 font-semibold">
              <td className="px-4 py-3 text-foreground" colSpan={3}>Total</td>
              <td className="px-3 py-3 text-right"><Num n={run.ofertasNuevas} strong /></td>
              <td className="px-3 py-3 text-right"><Num n={run.ofertasActualizadas} strong /></td>
              <td className="px-4 py-3 text-right"><Num n={run.faltantes} strong /></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
