"use client";

import { useState } from "react";
import { RotateCcw, Search } from "lucide-react";
import { Eyebrow, Display } from "@/components/ui/Typography";
import { ReturnModal } from "@/components/sales/ReturnModal";
import { useSales, useSaleNumberFormat } from "@/modules/sales/hooks";
import { formatCurrency } from "@/lib/utils/format";
import { formatSaleNumber, saleMatchesQuery } from "@/lib/utils/saleNumber";

// Sección dedicada de devoluciones (H29): buscás la venta por ticket / N° de
// comprobante y arrancás la devolución desde acá.
export default function DevolucionesPage() {
  const { data: sales, isLoading } = useSales();
  const { data: numFmt } = useSaleNumberFormat();
  const [search, setSearch] = useState("");
  const [returnId, setReturnId] = useState<string | null>(null);
  const [returnOpen, setReturnOpen] = useState(false);

  const completed = (sales ?? []).filter((s) => s.status === "completed");
  const results = search.trim()
    ? completed.filter((s) => saleMatchesQuery(s.number, numFmt, search))
    : completed.slice(0, 8);

  function openReturn(id: string) {
    setReturnId(id);
    setReturnOpen(true);
  }

  return (
    <>
      <div className="mx-auto max-w-3xl px-6 py-8">
        <Eyebrow>Operación</Eyebrow>
        <Display className="mt-3 text-3xl md:text-4xl">Devoluciones</Display>
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
            className="h-12 w-full rounded-lg border border-input bg-background pl-10 pr-4 text-sm outline-none focus:border-ninja-flameSoft focus:ring-2 focus:ring-ninja-flameSoft/20"
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
              className="flex w-full items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3 text-left transition hover:border-ninja-flameSoft/40 hover:bg-muted"
            >
              <span className="min-w-0">
                <span className="block font-mono font-semibold">
                  {formatSaleNumber(s.number, numFmt)}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {new Date(s.created_at).toLocaleString("es-AR")}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-3">
                <span className="font-semibold">{formatCurrency(s.total)}</span>
                <span className="inline-flex items-center gap-1 text-sm font-medium text-ninja-flameSoft">
                  <RotateCcw size={15} /> Devolver
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>

      <ReturnModal open={returnOpen} onOpenChange={setReturnOpen} saleId={returnId} />
    </>
  );
}
