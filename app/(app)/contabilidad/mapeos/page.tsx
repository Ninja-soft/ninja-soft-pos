"use client";

import { Suspense, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, Plus, Trash2 } from "lucide-react";
import { PageContainer } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import {
  CONCEPTS,
  CONCEPT_GROUP_LABEL,
  qualifierLabel,
  type ConceptDef,
  type ConceptGroup,
} from "@/lib/accounting/mappings";
import { accErrorMessage } from "@/lib/accounting/sources";
import { AccountSelect, AccountingFrame, inputCls } from "@/components/accounting/shared";
import { SettlementSourceCard } from "@/components/accounting/SettlementSourceCard";
import { useAccAccounts, useAccMappings, useAccountingMutations } from "@/modules/accounting/hooks";
import type { AccAccount, Mapping } from "@/modules/accounting/api";
import { useStores } from "@/modules/stock/hooks";
import { useTreasuryAccounts } from "@/modules/treasury/hooks";
import { useSuppliers } from "@/modules/purchases/hooks";
import { useFeature } from "@/modules/saas/gating";

// Mapeos (ADR-066): a qué cuenta va cada evento, con excepciones por medio,
// adquirente, alícuota, proveedor, procesador o sucursal.
export default function MapeosPage() {
  return (
    <PageContainer size="xl">
      <AccountingFrame
        title="Mapeos"
        description="Elegí a qué cuenta va cada parte de los asientos automáticos. Lo más específico gana: medio y adquirente, después el medio, después la regla general; en cada nivel, la de la sucursal."
      >
        <Suspense fallback={null}>
          <MappingsEditor />
        </Suspense>
      </AccountingFrame>
    </PageContainer>
  );
}

const GROUPS = Object.keys(CONCEPT_GROUP_LABEL) as ConceptGroup[];

function MappingsEditor() {
  const { data: accounts = [] } = useAccAccounts();
  const { data: mappings = [], isLoading } = useAccMappings();
  const params = useSearchParams();
  const [group, setGroup] = useState<ConceptGroup>(() =>
    GROUPS.includes(params.get("grupo") as ConceptGroup) ? (params.get("grupo") as ConceptGroup) : "cobros",
  );

  return (
    <div className="mt-5 space-y-4">
      <nav aria-label="Grupos" className="flex gap-1 overflow-x-auto [scrollbar-width:none]">
        {GROUPS.map((g) => (
          <button
            key={g}
            type="button"
            onClick={() => setGroup(g)}
            className={cn(
              "shrink-0 rounded-md px-3 py-1.5 text-xs font-semibold transition",
              g === group ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:text-foreground",
            )}
          >
            {CONCEPT_GROUP_LABEL[g]}
          </button>
        ))}
      </nav>
      {group === "procesadores" && <SettlementSourceCard />}
      {!isLoading &&
        CONCEPTS.filter((c) => c.group === group).map((c) => (
          <ConceptCard key={c.key} concept={c} accounts={accounts} rows={mappings.filter((m) => m.concept === c.key)} />
        ))}
    </div>
  );
}

function ConceptCard({ concept, accounts, rows }: { concept: ConceptDef; accounts: AccAccount[]; rows: Mapping[] }) {
  const { toast } = useToast();
  const m = useAccountingMutations();
  const { data: stores = [] } = useStores();
  const tesoreria = useFeature("tesoreria");
  const { data: treasury = [] } = useTreasuryAccounts({}, concept.key === "tesoreria" && tesoreria === true);
  const compras = useFeature("compras");
  const bySupplier = concept.key === "compras" || concept.key === "proveedores";
  const { data: suppliers = [] } = useSuppliers({ includeArchived: true }, bySupplier && compras === true);
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState("");
  const [store, setStore] = useState("");
  const [acc, setAcc] = useState("");

  const options = useMemo(() => {
    const base = concept.qualifiers ?? [];
    if (bySupplier) return [...base, ...suppliers.map((sp) => ({ value: sp.id, label: sp.name }))];
    if (concept.key !== "tesoreria") return base;
    return [...base, ...treasury.map((t) => ({ value: `*:${t.id}`, label: `Cuenta ${t.name}` }))];
  }, [concept, treasury, suppliers, bySupplier]);

  const sorted = [...rows].sort((a, b) => {
    const ga = a.qualifier === "*" && !a.store_id ? 0 : 1;
    const gb = b.qualifier === "*" && !b.store_id ? 0 : 1;
    return ga - gb || a.qualifier.localeCompare(b.qualifier) || (a.store_id ?? "").localeCompare(b.store_id ?? "");
  });
  const hasDefault = rows.some((r) => r.qualifier === "*" && !r.store_id);

  async function set(qualifier: string, storeId: string | null, accountId: string | null) {
    try {
      await m.setMapping.mutateAsync({ concept: concept.key, qualifier, storeId, accountId });
      toast({ title: accountId ? "Mapeo guardado" : "Excepción quitada", variant: "success" });
      return true;
    } catch (e) {
      toast({ title: "No se pudo guardar", description: accErrorMessage(e), variant: "error" });
      return false;
    }
  }

  function label(qualifier: string) {
    if (qualifier.startsWith("*:") && concept.key === "tesoreria") {
      const t = treasury.find((x) => x.id === qualifier.slice(2));
      if (t) return `Cuenta ${t.name}`;
    }
    if (bySupplier) {
      const sp = suppliers.find((x) => x.id === qualifier);
      if (sp) return sp.name;
    }
    return qualifierLabel(concept.key, qualifier);
  }

  return (
    <section className="rounded-xl bg-card p-4 ring-1 ring-border">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold">{concept.label}</h3>
          <p className="max-w-3xl text-sm text-muted-foreground">{concept.help}</p>
        </div>
        <Button size="sm" variant="secondary" onClick={() => setAdding((a) => !a)}>
          <Plus size={14} /> Excepción
        </Button>
      </div>
      {!hasDefault && (
        <p className="mt-2 flex items-center gap-1.5 text-sm text-warning">
          <AlertTriangle size={14} /> Falta la regla general: los eventos sin excepción quedan pendientes.
        </p>
      )}
      <div className="mt-3 divide-y divide-border">
        {sorted.map((r) => (
          <div key={r.id} className="grid items-center gap-2 py-2 sm:grid-cols-[1fr_1fr_minmax(240px,1.4fr)_40px]">
            <div className="text-sm font-medium">{r.qualifier === "*" ? "Regla general" : label(r.qualifier)}</div>
            <div className="text-sm text-muted-foreground">
              {r.store_id ? stores.find((s) => s.id === r.store_id)?.name ?? "Sucursal" : "Todas las sucursales"}
            </div>
            <AccountSelect
              accounts={accounts}
              value={r.account_id}
              onChange={(v) => v && void set(r.qualifier, r.store_id, v)}
              aria-label={`Cuenta de ${concept.label}`}
            />
            {r.qualifier === "*" && !r.store_id ? (
              <span />
            ) : (
              <Button size="sm" variant="ghost" className="text-danger" aria-label="Quitar excepción" onClick={() => void set(r.qualifier, r.store_id, null)}>
                <Trash2 size={14} />
              </Button>
            )}
          </div>
        ))}
      </div>
      {adding && (
        <div className="mt-3 grid gap-2 rounded-lg bg-muted/30 p-3 sm:grid-cols-[1fr_1fr_minmax(240px,1.4fr)_auto]">
          <div>
            <input
              list={`q-${concept.key}`}
              aria-label={concept.qualifierLabel ?? "Detalle"}
              placeholder={concept.qualifierLabel ?? "Detalle (o * para todos)"}
              className={inputCls}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <datalist id={`q-${concept.key}`}>
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </datalist>
          </div>
          <select aria-label="Sucursal" className={inputCls} value={store} onChange={(e) => setStore(e.target.value)}>
            <option value="" className="bg-popover text-popover-foreground">Todas las sucursales</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id} className="bg-popover text-popover-foreground">
                {s.name}
              </option>
            ))}
          </select>
          <AccountSelect accounts={accounts} value={acc} onChange={setAcc} />
          <Button
            disabled={!acc || (!q.trim() && !store)}
            loading={m.setMapping.isPending}
            onClick={async () => {
              if (await set(q.trim() || "*", store || null, acc)) {
                setQ("");
                setStore("");
                setAcc("");
                setAdding(false);
              }
            }}
          >
            Agregar
          </Button>
        </div>
      )}
    </section>
  );
}
