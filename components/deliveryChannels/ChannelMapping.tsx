"use client";

import { useMemo, useState } from "react";
import { Sparkles, Unlink } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { SearchField } from "@/components/ui/SearchField";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { formatCurrency } from "@/lib/utils/format";
import { normalizeName, simulatorExternalId, suggestMappings, type MapSuggestion } from "@/lib/deliveryChannels/mapping";
import { channelErrorMessage, type ChannelConnection, type MapInput } from "@/modules/deliveryChannels/api";
import { useChannelMapping, useChannelMutations } from "@/modules/deliveryChannels/hooks";

// Mapeo de productos POS <-> ítems de la app (ADR-102). Cada fila: producto y
// su id en la app. "Sugerir" cruza por SKU y nombre con lo que la app ya
// mandó (y, en el simulador, con su catálogo SIM-). Lo que llega sin mapear se
// cocina igual y queda marcado para revisar.
export function ChannelMapping({ conn }: { conn: ChannelConnection }) {
  const { toast } = useToast();
  const { rows, external, products } = useChannelMapping(conn.id);
  const { mapSet } = useChannelMutations();
  const [q, setQ] = useState("");
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [suggestions, setSuggestions] = useState<MapSuggestion[] | null>(null);

  const byProduct = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows.data ?? []) if (r.kind === "product" && r.product_id) m.set(r.product_id, r.external_id);
    return m;
  }, [rows.data]);
  const mappedExternal = useMemo(() => new Set((rows.data ?? []).map((r) => r.external_id)), [rows.data]);
  const unmapped = useMemo(
    () => (external.data ?? []).filter((x) => x.kind === "product" && !mappedExternal.has(x.external_id)),
    [external.data, mappedExternal],
  );

  if (rows.isLoading || products.isLoading) return <SpinnerBlock className="py-10" />;

  const list = (products.data ?? []).filter((p) => !q || normalizeName(p.name).includes(normalizeName(q)) || (p.sku ?? "").toLowerCase().includes(q.toLowerCase()));

  const save = (input: MapInput[], ok: string) =>
    mapSet.mutate(
      { connectionId: conn.id, rows: input },
      {
        onSuccess: () => {
          setDraft({});
          setSuggestions(null);
          toast({ title: ok, variant: "success" });
        },
        onError: (e) => toast({ title: "No se pudo guardar el mapeo", description: channelErrorMessage(e), variant: "error" }),
      },
    );

  const suggest = () => {
    const externals = unmapped.map((x) => ({ external_id: x.external_id, name: x.name, sku: x.sku, kind: x.kind }));
    const found = suggestMappings(
      (products.data ?? []).filter((p) => !byProduct.has(p.id)),
      externals,
      mappedExternal,
    );
    // En el simulador, el catálogo de la app son los mismos productos con id SIM-.
    if (conn.provider === "simulador") {
      const used = new Set(found.map((f) => f.product_id));
      for (const p of products.data ?? []) {
        if (byProduct.has(p.id) || used.has(p.id) || p.has_variants) continue;
        const ext = simulatorExternalId(p);
        if (mappedExternal.has(ext)) continue;
        found.push({ external_id: ext, external_name: p.name, product_id: p.id, product_name: p.name, reason: "sku", score: 1 });
      }
    }
    setSuggestions(found);
    if (found.length === 0) toast({ title: "No hay sugerencias nuevas", variant: "info" });
  };

  const dirty = Object.entries(draft).filter(([pid, v]) => (byProduct.get(pid) ?? "") !== v.trim());

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <SearchField value={q} onValueChange={setQ} placeholder="Buscar producto o SKU" className="sm:max-w-xs" />
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={suggest}>
            <Sparkles size={14} /> Sugerir por nombre y SKU
          </Button>
          <Button
            size="sm"
            disabled={dirty.length === 0}
            loading={mapSet.isPending}
            onClick={() =>
              save(
                dirty.map(([pid, v]) => ({
                  kind: "product" as const,
                  external_id: v.trim() || (byProduct.get(pid) ?? ""),
                  product_id: v.trim() ? pid : null,
                })),
                "Mapeo guardado",
              )
            }
          >
            Guardar cambios
          </Button>
        </div>
      </div>

      {suggestions && suggestions.length > 0 && (
        <div className="space-y-2 rounded-lg border border-border p-3">
          <p className="text-sm font-semibold text-foreground">{suggestions.length} sugerencias</p>
          <ul className="max-h-60 space-y-1 overflow-y-auto text-sm">
            {suggestions.map((s) => (
              <li key={s.external_id} className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate">
                  {s.external_name} <span className="text-muted-foreground">({s.external_id})</span> {"->"} {s.product_name}
                </span>
                <Badge tone={s.reason === "parecido" ? "warning" : "success"}>{s.reason}</Badge>
              </li>
            ))}
          </ul>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setSuggestions(null)}>
              Descartar
            </Button>
            <Button
              size="sm"
              loading={mapSet.isPending}
              onClick={() =>
                save(
                  suggestions.map((s) => ({
                    kind: "product" as const,
                    external_id: s.external_id,
                    external_name: s.external_name,
                    product_id: s.product_id,
                  })),
                  "Sugerencias aplicadas",
                )
              }
            >
              Aplicar sugerencias
            </Button>
          </div>
        </div>
      )}

      {unmapped.length > 0 && (
        <Callout tone="warning" title={`${unmapped.length} ítems de la app sin mapear`}>
          {unmapped
            .slice(0, 6)
            .map((x) => `${x.name} (${x.external_id})`)
            .join(", ")}
          {unmapped.length > 6 ? "..." : ""}. Llegan igual a cocina, pero no descuentan stock del producto. Escribí su id al lado
          del producto o usá Sugerir.
        </Callout>
      )}

      <div className="overflow-hidden rounded-lg border border-border">
        <ul className="max-h-[28rem] divide-y divide-border overflow-y-auto">
          {list.map((p) => {
            const current = byProduct.get(p.id) ?? "";
            const value = draft[p.id] ?? current;
            return (
              <li key={p.id} className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{p.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {p.sku ? `SKU ${p.sku} · ` : ""}
                    {formatCurrency(Number(p.price))}
                    {p.has_variants ? " · con variantes (no se mapea)" : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    aria-label={`Id en la app de ${p.name}`}
                    disabled={p.has_variants}
                    value={value}
                    placeholder="Id en la app"
                    onChange={(e) => setDraft((d) => ({ ...d, [p.id]: e.target.value.slice(0, 120) }))}
                    className="h-9 w-48 rounded-lg border border-input bg-background px-3 font-mono text-xs text-foreground outline-none focus:border-ninja-flameSoft disabled:opacity-50"
                  />
                  {current && (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label="Quitar mapeo"
                      onClick={() => save([{ kind: "product", external_id: current, product_id: null }], "Mapeo quitado")}
                    >
                      <Unlink size={14} />
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
          {list.length === 0 && <li className="px-3 py-6 text-center text-xs text-muted-foreground">Sin productos</li>}
        </ul>
      </div>
      <p className="text-xs text-muted-foreground">
        Los modificadores que manda la app y no están mapeados viajan como nota de la línea para la cocina. Precio: se cobra el
        que informa la app.
      </p>
    </div>
  );
}
