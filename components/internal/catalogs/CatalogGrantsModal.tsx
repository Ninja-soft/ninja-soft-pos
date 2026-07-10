"use client";

import { useMemo, useState } from "react";
import { Gift, Search, Trash2, BadgeCheck } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { formatCurrency } from "@/lib/utils/format";
import { useInternalTenants } from "@/modules/internal/hooks";
import {
  useCatalogGrants,
  useGrantCatalog,
  useRevokeCatalog,
} from "@/modules/internal/catalogsHooks";
import type { Catalog } from "@/modules/internal/catalogs";

export function CatalogGrantsModal({
  open,
  onOpenChange,
  catalog,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  catalog: Catalog | null;
}) {
  const { toast } = useToast();
  const { data: tenants } = useInternalTenants();
  const { data: grants, isLoading } = useCatalogGrants(catalog?.id ?? null);
  const grant = useGrantCatalog();
  const revoke = useRevokeCatalog();
  const [query, setQuery] = useState("");

  const grantedIds = useMemo(
    () => new Set((grants ?? []).map((g) => g.tenantId)),
    [grants],
  );

  // Candidatos a bonificar: tenants que NO tienen el catálogo, filtrados por texto.
  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (tenants ?? [])
      .filter((t) => !grantedIds.has(t.id))
      .filter(
        (t) =>
          q === "" ||
          t.name.toLowerCase().includes(q) ||
          t.slug.toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [tenants, grantedIds, query]);

  async function doGrant(tenantId: string) {
    if (!catalog) return;
    try {
      await grant.mutateAsync({ tenantId, catalogId: catalog.id });
      toast({ title: "Acceso bonificado", variant: "success" });
      setQuery("");
    } catch (e) {
      toast({
        title: "No se pudo bonificar",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  async function doRevoke(tenantId: string) {
    if (!catalog) return;
    try {
      await revoke.mutateAsync({ tenantId, catalogId: catalog.id });
      toast({ title: "Bonificación quitada", variant: "success" });
    } catch (e) {
      toast({
        title: "No se pudo quitar",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={catalog ? `Accesos — ${catalog.name}` : "Accesos"}
      className="max-w-xl"
    >
      <div className="space-y-5">
        <p className="text-sm text-muted-foreground">
          Bonificá el catálogo a un negocio (acceso gratis, sin pasar por pago).
          Las compras pagadas también aparecen acá, pero no se pueden quitar
          desde este panel.
        </p>

        {/* Buscador + bonificar */}
        <div>
          <label className="mb-2 block text-sm font-medium text-muted-foreground">
            Bonificar a un negocio
          </label>
          <div className="relative">
            <Search
              size={15}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar negocio por nombre…"
              className="pl-9"
            />
          </div>
          {query.trim() !== "" && (
            <div className="mt-2 overflow-hidden rounded-lg border border-border">
              {candidates.length === 0 ? (
                <p className="px-3 py-3 text-sm text-muted-foreground">
                  Sin resultados (o ya tienen el catálogo).
                </p>
              ) : (
                candidates.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    disabled={grant.isPending}
                    onClick={() => doGrant(t.id)}
                    className="flex w-full items-center justify-between gap-3 border-b border-border px-3 py-2.5 text-left transition last:border-0 hover:bg-muted disabled:opacity-60"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-foreground">
                        {t.name}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {t.slug}
                      </span>
                    </span>
                    <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-ninja-flameSoft">
                      <Gift size={14} /> Bonificar
                    </span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>

        {/* Accesos actuales */}
        <div>
          <div className="mb-2 text-sm font-medium text-muted-foreground">
            Con acceso ({grants?.length ?? 0})
          </div>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Cargando…</p>
          ) : (grants?.length ?? 0) === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
              Todavía nadie compró ni recibió este catálogo.
            </p>
          ) : (
            <div className="space-y-2">
              {(grants ?? []).map((g) => (
                <div
                  key={g.tenantId}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {g.tenantName}
                    </span>
                    <span className="mt-0.5 inline-flex items-center gap-1.5 text-xs">
                      {g.source === "granted" ? (
                        <span className="inline-flex items-center gap-1 rounded bg-ninja-flame/15 px-1.5 py-0.5 font-medium text-ninja-flameSoft">
                          <Gift size={11} /> Bonificado
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 font-medium text-success">
                          <BadgeCheck size={11} /> Pagado
                          {g.pricePaid != null && ` · ${formatCurrency(g.pricePaid)}`}
                        </span>
                      )}
                      <span className="text-muted-foreground">
                        {new Date(g.purchasedAt).toLocaleDateString("es-AR")}
                      </span>
                    </span>
                  </div>
                  {g.source === "granted" && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      loading={revoke.isPending}
                      onClick={() => doRevoke(g.tenantId)}
                      className="text-destructive"
                    >
                      <Trash2 size={14} /> Quitar
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex justify-end">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cerrar
          </Button>
        </div>
      </div>
    </Modal>
  );
}
