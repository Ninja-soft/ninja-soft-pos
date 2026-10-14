"use client";

// Presupuestos (ADR-122): listar, filtrar por estado, cliente, número y tipo
// de servicio, crear, ver, duplicar, editar mientras no esté aceptado y
// convertir en venta. OPTIONAL `presupuestos` (Pro+): la base lo exige en
// cada RPC; acá sólo se muestra el bloqueo.
import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { FileSignature, Lock, Plus } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { SearchField } from "@/components/ui/SearchField";
import { EmptyState } from "@/components/ui/EmptyState";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { UpgradeModal } from "@/components/saas/UpgradeModal";
import { QuoteFormModal } from "@/components/quotes/QuoteFormModal";
import { QuoteDetailModal } from "@/components/quotes/QuoteDetailModal";
import { useFeature } from "@/modules/saas/gating";
import { useMyTenant } from "@/modules/tenants/hooks";
import { useQuotes } from "@/modules/quotes/hooks";
import { useServiceTypes } from "@/modules/services/types";
import { fmtDate } from "@/lib/invoices/legal";
import {
  QUOTE_STATUS_LABEL,
  QUOTE_STATUS_TONE,
  effectiveQuoteStatus,
  quoteNumberLabel,
  todayArIso,
  type QuoteStatus,
} from "@/lib/quotes/logic";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

type Filter = "all" | QuoteStatus;
const FILTERS: Filter[] = ["all", "draft", "sent", "accepted", "expired", "rejected", "converted"];

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

function PresupuestosInner() {
  const enabled = useFeature("presupuestos");
  const params = useSearchParams();
  const { data: me } = useMyTenant();
  const canOperate = Boolean(me && me.role !== "viewer");
  const { data: list = [], isLoading } = useQuotes(enabled === true);
  const { data: types = [] } = useServiceTypes(enabled === true);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [type, setType] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [upgradeOpen, setUpgradeOpen] = useState(false);

  // Link directo: /presupuestos?id=<uuid> (desde el POS al guardar).
  useEffect(() => {
    const id = params.get("id");
    if (id) setOpenId(id);
  }, [params]);

  const today = todayArIso();
  const rows = useMemo(() => {
    const term = norm(q.trim());
    return list
      .map((r) => ({ ...r, eff: effectiveQuoteStatus(r.status, r.valid_until, today) }))
      .filter((r) => filter === "all" || r.eff === filter)
      .filter((r) => !type || r.service_types.includes(type))
      .filter(
        (r) =>
          !term ||
          norm(`${r.customer_name ?? ""} ${r.customer_doc ?? ""} ${quoteNumberLabel(r.pto_vta, r.number)} ${r.number}`).includes(term),
      );
  }, [list, filter, type, q, today]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: list.length };
    for (const r of list) {
      const e = effectiveQuoteStatus(r.status, r.valid_until, today);
      c[e] = (c[e] ?? 0) + 1;
    }
    return c;
  }, [list, today]);

  const header = (
    <PageHeader
      eyebrow="Operación"
      title="Presupuestos"
      icon={FileSignature}
      description="Cotizá productos y servicios con validez y condiciones, mandalos por WhatsApp o con un link para aceptar y convertilos en venta con un click."
      actions={
        enabled && canOperate ? (
          <Button onClick={() => setFormOpen(true)}>
            <Plus size={16} /> Nuevo presupuesto
          </Button>
        ) : undefined
      }
    />
  );

  if (enabled === false) {
    return (
      <PageContainer>
        {header}
        <div className="mt-8 rounded-lg bg-muted/40 p-8 text-center">
          <Lock className="mx-auto text-ninja-flameSoft" size={28} aria-hidden />
          <p className="mt-3 font-semibold">Los presupuestos no están incluidos en tu plan</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Armá presupuestos con tu marca, mandalos con un link de aceptación y convertilos en venta sin volver a cargar nada.
          </p>
          <Button className="mt-4" onClick={() => setUpgradeOpen(true)}>
            Ver planes
          </Button>
          <UpgradeModal open={upgradeOpen} onOpenChange={setUpgradeOpen} featureKey="presupuestos" featureLabel="Presupuestos" />
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      {header}

      <div className="mt-6 space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <SearchField
            value={q}
            onValueChange={setQ}
            placeholder="Buscar por cliente, CUIT o número"
            aria-label="Buscar presupuestos"
            className="sm:max-w-sm"
          />
          {types.length > 0 && (
            <select
              aria-label="Tipo de servicio"
              value={type}
              onChange={(e) => setType(e.target.value)}
              className="h-11 rounded-lg border border-border bg-background/40 px-3 text-sm text-foreground outline-none sm:w-56"
            >
              <option value="" className="bg-popover text-popover-foreground">
                Todos los tipos de servicio
              </option>
              {types.map((t) => (
                <option key={t.id} value={t.name} className="bg-popover text-popover-foreground">
                  {t.name}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="-mx-4 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0" role="tablist" aria-label="Estado">
          <div className="flex w-max gap-1.5">
            {FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                role="tab"
                aria-selected={filter === f}
                onClick={() => setFilter(f)}
                className={cn(
                  "flex h-9 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium transition-colors",
                  filter === f ? "choice-on" : "bg-fg-4 text-muted-foreground hover:bg-fg-6 hover:text-foreground",
                )}
              >
                {f === "all" ? "Todos" : QUOTE_STATUS_LABEL[f]}
                <span className="tabular-nums text-xs opacity-70">{counts[f] ?? 0}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <section className="mt-5">
        {isLoading || enabled === undefined ? (
          <SpinnerBlock />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={FileSignature}
            title={list.length === 0 ? "Todavía no hay presupuestos" : "No hay presupuestos con ese filtro"}
            description={
              list.length === 0
                ? "Creá uno desde acá o desde el POS con el botón Presupuesto, junto a Cobrar."
                : "Probá con otro estado, tipo de servicio o búsqueda."
            }
            action={
              list.length === 0 && canOperate ? (
                <Button onClick={() => setFormOpen(true)}>
                  <Plus size={16} /> Nuevo presupuesto
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
            {rows.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => setOpenId(r.id)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-fg-4"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-mono text-[13px] font-semibold tabular-nums">{quoteNumberLabel(r.pto_vta, r.number)}</span>
                      <Badge tone={QUOTE_STATUS_TONE[r.eff]}>
                        {QUOTE_STATUS_LABEL[r.eff]}
                      </Badge>
                      {r.version > 1 && <span className="text-xs text-muted-foreground">rev. {r.version}</span>}
                    </div>
                    <p className="mt-0.5 truncate text-sm font-medium">{r.customer_name || "Consumidor final"}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {fmtDate(r.issue_date)} · vence {fmtDate(r.valid_until)} · {r.item_count} {r.item_count === 1 ? "renglón" : "renglones"}
                      {r.service_types.length ? ` · ${r.service_types.join(", ")}` : ""}
                    </p>
                  </div>
                  <span className="shrink-0 font-price text-base font-semibold tabular-nums">{formatCurrency(r.total)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <QuoteFormModal open={formOpen} onOpenChange={setFormOpen} onSaved={(r) => setOpenId(r.id)} />
      <QuoteDetailModal
        quoteId={openId}
        onOpenChange={(o) => !o && setOpenId(null)}
        onOpenQuote={setOpenId}
        canManage={Boolean(me?.canManage) || canOperate}
      />
    </PageContainer>
  );
}

export default function PresupuestosPage() {
  return (
    <Suspense fallback={<SpinnerBlock />}>
      <PresupuestosInner />
    </Suspense>
  );
}
