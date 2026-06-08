"use client";

import { useMemo, useState } from "react";
import { Printer, Search } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Eyebrow, Display } from "@/components/ui/Typography";
import { InfoHint } from "@/components/ui/InfoHint";
import { Card, CardContent } from "@/components/ui/Card";
import { Barcode } from "@/components/products/Barcode";
import { useProducts } from "@/modules/products/hooks";
import { buildLabels, clampCopies, type LabelSource } from "@/lib/labels";
import { formatCurrency } from "@/lib/utils/format";

type Sel = Record<string, LabelSource & { copies: number }>;

export default function EtiquetasPage() {
  const [search, setSearch] = useState("");
  const { data: products } = useProducts(search);
  const [sel, setSel] = useState<Sel>({});

  function toggle(p: LabelSource) {
    setSel((s) => {
      const next = { ...s };
      if (next[p.id]) delete next[p.id];
      else next[p.id] = { ...p, copies: 1 };
      return next;
    });
  }
  function setCopies(id: string, n: number) {
    setSel((s) => (s[id] ? { ...s, [id]: { ...s[id]!, copies: clampCopies(n) } } : s));
  }

  const labels = useMemo(
    () =>
      buildLabels(
        Object.values(sel).map((x) => ({ product: x, copies: x.copies })),
      ),
    [sel],
  );

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <div className="no-print">
        <Eyebrow>Catálogo</Eyebrow>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <Display className="flex items-center gap-2 text-3xl md:text-4xl">
            Etiquetas
            <InfoHint section="etiquetas" size={18} />
          </Display>
          <Button onClick={() => window.print()} disabled={labels.length === 0}>
            <Printer size={16} /> Imprimir ({labels.length})
          </Button>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          Elegí productos y la cantidad de etiquetas. Cada etiqueta lleva nombre,
          precio, PLU (si lo usás) y código de barras (barcode o SKU).
        </p>

        <div className="relative mt-5 max-w-md">
          <Search
            size={16}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nombre, PLU, SKU o código…"
            className="h-11 w-full rounded-lg border border-input bg-background pl-9 pr-4 text-sm text-foreground outline-none transition focus:border-ninja-flameSoft focus:ring-4 focus:ring-ninja-flameSoft/15"
          />
        </div>

        <Card className="mt-5">
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full min-w-[520px] text-sm">
              <thead className="bg-muted text-left text-xs uppercase tracking-[0.14em] text-muted-foreground">
                <tr>
                  <th className="w-10 px-4 py-3"></th>
                  <th className="whitespace-nowrap px-4 py-3">Producto</th>
                  <th className="whitespace-nowrap px-4 py-3">PLU</th>
                  <th className="whitespace-nowrap px-4 py-3">Código</th>
                  <th className="whitespace-nowrap px-4 py-3 text-right">Precio</th>
                  <th className="whitespace-nowrap px-4 py-3 text-right">Etiquetas</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {products?.map((p) => {
                  const checked = Boolean(sel[p.id]);
                  return (
                    <tr key={p.id} className="hover:bg-muted/40">
                      <td className="px-4 py-2">
                        <input
                          type="checkbox"
                          className="accent-ninja-flame"
                          checked={checked}
                          onChange={() =>
                            toggle({
                              id: p.id,
                              name: p.name,
                              price: p.price,
                              barcode: p.barcode,
                              sku: p.sku,
                              plu: p.plu,
                            })
                          }
                        />
                      </td>
                      <td className="px-4 py-2 font-medium">{p.name}</td>
                      <td className="px-4 py-2">
                        {p.plu ? (
                          <span className="inline-flex items-center rounded bg-ninja-flame/10 px-1.5 py-0.5 font-mono text-xs font-semibold text-ninja-flameSoft">
                            {p.plu}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2 font-mono text-xs text-muted-foreground">
                        {p.barcode || p.sku || "—"}
                      </td>
                      <td className="px-4 py-2 text-right">{formatCurrency(p.price)}</td>
                      <td className="px-4 py-2 text-right">
                        <input
                          type="number"
                          min={1}
                          disabled={!checked}
                          value={sel[p.id]?.copies ?? 1}
                          onChange={(e) => setCopies(p.id, Number(e.target.value))}
                          className="h-8 w-16 rounded-md border border-input bg-background px-2 text-right text-sm outline-none focus:border-ninja-flameSoft disabled:opacity-40"
                        />
                      </td>
                    </tr>
                  );
                })}
                {products?.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                      Sin productos. Cargá productos primero.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </CardContent>
        </Card>

        <h2 className="mt-8 font-display text-lg font-bold">
          Vista previa {labels.length > 0 && `(${labels.length})`}
        </h2>
        {labels.length === 0 && (
          <p className="mt-2 text-sm text-muted-foreground">
            Seleccioná productos para ver las etiquetas.
          </p>
        )}
      </div>

      {/* Hoja imprimible: solo esto se ve al imprimir (.ticket-print). La grilla
          y cada tarjeta usan .label-sheet / .label-card (estilos de impresión en
          globals.css) para salir negro sobre blanco y prolijas. */}
      {labels.length > 0 && (
        <div className="ticket-print label-sheet mt-4 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4">
          {labels.map((l, i) => {
            // El SKU se muestra como texto solo si aporta algo distinto del valor
            // que ya va en el código de barras (evita repetir el mismo dato).
            const showSku = l.sku && l.sku !== l.code;
            return (
              <div key={`${l.id}-${i}`} className="label-card border-border">
                {/* Nombre */}
                <div className="line-clamp-2 w-full text-[11px] font-semibold uppercase leading-tight tracking-wide">
                  {l.name}
                </div>

                {/* Precio (lo más grande de la etiqueta) */}
                <div className="font-price text-xl font-black leading-none tabular-nums">
                  {formatCurrency(l.price)}
                </div>

                {/* PLU: el código corto para tipear en el POS, destacado */}
                {l.plu && (
                  <div className="label-plu rounded bg-ninja-flame/10 px-2 py-0.5 font-mono text-xs font-bold tracking-[0.18em] text-ninja-flameSoft">
                    PLU {l.plu}
                  </div>
                )}

                {/* Código de barras + su valor / SKU legible */}
                {l.code ? (
                  <div className="flex w-full flex-col items-center gap-0.5">
                    <Barcode value={l.code} height={30} className="w-full max-w-[42mm]" />
                    <div className="font-mono text-[8px] tracking-[0.12em]">{l.code}</div>
                    {showSku && (
                      <div className="font-mono text-[8px] text-muted-foreground">
                        SKU {l.sku}
                      </div>
                    )}
                  </div>
                ) : showSku ? (
                  <div className="font-mono text-[9px] text-muted-foreground">
                    SKU {l.sku}
                  </div>
                ) : (
                  <div className="text-[8px] text-muted-foreground">sin código</div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
