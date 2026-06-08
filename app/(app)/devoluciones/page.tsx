"use client";

import { useState } from "react";
import { Receipt, RotateCcw, Search, Tags, Ticket } from "lucide-react";
import { Eyebrow, Display } from "@/components/ui/Typography";
import { InfoHint } from "@/components/ui/InfoHint";
import { Button } from "@/components/ui/Button";
import { ReturnModal } from "@/components/sales/ReturnModal";
import { ReturnReasonsModal } from "@/components/sales/ReturnReasonsModal";
import {
  useSales,
  useSaleNumberFormat,
  useReturnsList,
  useSalesByNumber,
} from "@/modules/sales/hooks";
import { formatCurrency } from "@/lib/utils/format";
import { formatSaleNumber, saleMatchesQuery } from "@/lib/utils/saleNumber";

// Sección dedicada de devoluciones (H29): buscás la venta por ticket / N° de
// comprobante y arrancás la devolución desde acá.
export default function DevolucionesPage() {
  const { data: sales, isLoading } = useSales();
  const { data: numFmt } = useSaleNumberFormat();
  const { data: returns } = useReturnsList();
  const [search, setSearch] = useState("");
  const [returnId, setReturnId] = useState<string | null>(null);
  const [returnOpen, setReturnOpen] = useState(false);
  const [reasonsOpen, setReasonsOpen] = useState(false);

  const completed = (sales ?? []).filter((s) => s.status === "completed");
  // Búsqueda por N° exacto en el server (encuentra tickets fuera de las últimas 100).
  const digits = search.replace(/\D/g, "");
  const searchNum = search.trim() && digits ? Number(digits) : null;
  const { data: byNumber } = useSalesByNumber(searchNum);
  const results = search.trim()
    ? Array.from(
        new Map(
          [
            ...completed.filter((s) => saleMatchesQuery(s.number, numFmt, search)),
            ...((byNumber ?? []).filter((s) => s.status === "completed")),
          ].map((s) => [s.id, s]),
        ).values(),
      )
    : completed.slice(0, 8);

  function openReturn(id: string) {
    setReturnId(id);
    setReturnOpen(true);
  }

  return (
    <>
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="flex items-start justify-between gap-3">
          <div>
            <Eyebrow>Operación</Eyebrow>
            <Display className="mt-3 flex items-center gap-2 text-3xl md:text-4xl">
              Devoluciones
              <InfoHint section="devoluciones" size={18} />
            </Display>
          </div>
          <Button variant="secondary" className="mt-2 shrink-0" onClick={() => setReasonsOpen(true)}>
            <Tags size={16} /> Motivos
          </Button>
        </div>
        <p className="mt-2 text-muted-foreground">
          Buscá la venta por su <strong>N° de comprobante o ticket</strong> y registrá
          la devolución o el cambio.
        </p>

        <div className="relative mt-6">
          <Search
            size={18}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="N° de comprobante o ticket…"
            className="h-12 w-full rounded-xl border border-input bg-background pl-10 pr-4 text-sm outline-none focus:border-ninja-flameSoft focus:ring-2 focus:ring-ninja-flameSoft/20"
          />
        </div>

        <div className="mt-3 text-xs uppercase tracking-wide text-muted-foreground">
          {search.trim() ? "Resultados" : "Ventas recientes"}
        </div>

        <div className="mt-2 space-y-2">
          {isLoading && (
            <p className="py-8 text-center text-sm text-muted-foreground">Cargando…</p>
          )}
          {!isLoading && results.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {search.trim()
                ? "Sin ventas para esa búsqueda."
                : "No hay ventas completadas."}
            </p>
          )}
          {results.map((s) => (
            <button
              key={s.id}
              onClick={() => openReturn(s.id)}
              className="group flex w-full items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3 text-left transition hover:border-ninja-flameSoft/40 hover:bg-muted"
            >
              <span className="flex min-w-0 items-center gap-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground transition group-hover:bg-ninja-flame/10 group-hover:text-ninja-flameSoft">
                  <Receipt size={17} />
                </span>
                <span className="min-w-0">
                  <span className="block font-mono font-semibold">
                    {formatSaleNumber(s.number, numFmt)}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {new Date(s.created_at).toLocaleString("es-AR")}
                  </span>
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-3">
                <span className="font-price font-semibold tabular-nums">{formatCurrency(s.total)}</span>
                <span className="inline-flex items-center gap-1 text-sm font-medium text-ninja-flameSoft">
                  <RotateCcw size={15} /> Devolver
                </span>
              </span>
            </button>
          ))}
        </div>
        {(returns ?? []).length > 0 && (
          <div className="mt-8">
            <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
              Últimas devoluciones
            </div>
            <div className="space-y-1.5">
              {(returns ?? []).map((r) => {
                const isVoucher = r.refund_method === "store_credit";
                return (
                  <div
                    key={r.id}
                    className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-2.5 text-sm"
                  >
                    <span className="shrink-0 font-mono font-semibold">Dev #{r.number}</span>
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                      {r.reason || "—"}
                    </span>
                    <span
                      className={
                        "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium " +
                        (isVoucher
                          ? "bg-ninja-flame/10 text-ninja-flameSoft"
                          : "bg-muted text-muted-foreground")
                      }
                    >
                      {isVoucher && <Ticket size={12} />}
                      {isVoucher ? "Vale" : "Efectivo"}
                    </span>
                    <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">
                      {new Date(r.created_at).toLocaleDateString("es-AR")}
                    </span>
                    <span className="shrink-0 font-price font-semibold tabular-nums">
                      {formatCurrency(r.total)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <ReturnModal open={returnOpen} onOpenChange={setReturnOpen} saleId={returnId} />
      <ReturnReasonsModal open={reasonsOpen} onOpenChange={setReasonsOpen} />
    </>
  );
}
