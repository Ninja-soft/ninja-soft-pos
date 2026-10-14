"use client";

// Pestaña Catálogos del panel interno: KPIs arriba y cuatro secciones
// (Sincronización, Catálogos vendibles, Tiendas de origen, Catálogo maestro).
// La sección elegida se recuerda por navegador (comodidad, no estado crítico).
import { useEffect, useState } from "react";
import { Boxes, Layers, RefreshCw, Store, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { useCatalogStores } from "@/modules/internal/catalogsHooks";
import type { Catalog } from "@/modules/internal/catalogs";
import { CatalogEditorModal } from "./CatalogEditorModal";
import { CatalogGrantsModal } from "./CatalogGrantsModal";
import { CatalogKpis } from "./CatalogKpis";
import { CatalogSyncCard } from "./CatalogSyncCard";
import { CatalogSyncScheduleCard } from "./CatalogSyncScheduleCard";
import { CatalogSyncHistory } from "./CatalogSyncHistory";
import { CatalogExcelImport } from "./CatalogExcelImport";
import { CatalogListSection } from "./CatalogListSection";
import { CatalogStoresSection } from "./CatalogStoresSection";
import { CatalogMasterCard } from "./CatalogMasterCard";
import { SectionHeader } from "./catalogUi";

type Tab = "sync" | "catalogos" | "tiendas" | "maestro";

const TABS: { value: Tab; label: string; icon: LucideIcon }[] = [
  { value: "sync", label: "Sincronización", icon: RefreshCw },
  { value: "catalogos", label: "Catálogos vendibles", icon: Boxes },
  { value: "tiendas", label: "Tiendas de origen", icon: Store },
  { value: "maestro", label: "Catálogo maestro", icon: Layers },
];

const TAB_KEY = "ninja-internal-catalogs-tab";

export function CatalogsManager() {
  const { data: stores } = useCatalogStores();
  const [tab, setTab] = useState<Tab>("sync");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Catalog | null>(null);
  const [grantsOpen, setGrantsOpen] = useState(false);
  const [grantsCatalog, setGrantsCatalog] = useState<Catalog | null>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(TAB_KEY) as Tab | null;
      if (saved && TABS.some((t) => t.value === saved)) setTab(saved);
    } catch {
      /* sin storage: queda la primera */
    }
  }, []);

  function choose(t: Tab) {
    setTab(t);
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {
      /* sin storage */
    }
  }

  return (
    <div className="space-y-6">
      <CatalogKpis />

      <div
        role="tablist"
        aria-label="Secciones de catálogos"
        className="grid grid-cols-2 gap-1 rounded-lg border border-border bg-muted/40 p-1 md:grid-cols-4"
      >
        {TABS.map((t) => {
          const active = tab === t.value;
          return (
            <button
              key={t.value}
              type="button"
              role="tab"
              aria-selected={active}
              data-shot-tab={t.value}
              onClick={() => choose(t.value)}
              className={cn(
                "inline-flex min-w-0 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active ? "bg-card text-foreground ring-1 ring-border" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <t.icon size={15} aria-hidden />
              {t.label}
            </button>
          );
        })}
      </div>

      <div role="tabpanel">
        {tab === "sync" && (
          <section data-shot="sincronizacion" className="space-y-4">
            <SectionHeader
              icon={RefreshCw}
              title="Sincronización con el catálogo"
              description="Trae el catálogo maestro del scraper: productos, ofertas por tienda y vendedor, y tiendas nuevas."
            />
            <CatalogSyncCard />
            <div className="grid gap-4 xl:grid-cols-5">
              <div className="min-w-0 xl:col-span-2">
                <CatalogSyncScheduleCard />
              </div>
              <div className="min-w-0 xl:col-span-3">
                <CatalogSyncHistory />
              </div>
            </div>
            <CatalogExcelImport />
          </section>
        )}
        {tab === "catalogos" && (
          <CatalogListSection
            onCreate={() => {
              setEditing(null);
              setEditorOpen(true);
            }}
            onEdit={(c) => {
              setEditing(c);
              setEditorOpen(true);
            }}
            onGrants={(c) => {
              setGrantsCatalog(c);
              setGrantsOpen(true);
            }}
          />
        )}
        {tab === "tiendas" && <CatalogStoresSection />}
        {tab === "maestro" && <CatalogMasterCard />}
      </div>

      <CatalogEditorModal open={editorOpen} onOpenChange={setEditorOpen} catalog={editing} stores={stores ?? []} />
      <CatalogGrantsModal open={grantsOpen} onOpenChange={setGrantsOpen} catalog={grantsCatalog} />
    </div>
  );
}
