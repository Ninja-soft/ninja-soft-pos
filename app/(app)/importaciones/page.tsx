"use client";

import { useMemo, useState } from "react";
import { Download, FileSpreadsheet, Lock, Upload } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { useToast } from "@/components/ui/Toast";
import { GatedButton } from "@/components/saas/GatedAction";
import { ImportWizard } from "@/components/import/ImportWizard";
import { downloadImportTemplate } from "@/lib/import/download";
import type { ImportContext, ImportDefinition, ImportEntityKey } from "@/lib/import/types";
import { IMPORT_DEFINITIONS } from "@/modules/imports/registry";
import { exportFullBase } from "@/modules/imports/exportAll";
import { useFeature } from "@/modules/saas/gating";
import { useMyTenant } from "@/modules/tenants/hooks";
import { useBranches } from "@/modules/branches/hooks";
import { usePriceLists } from "@/modules/prices/hooks";
import { useRequiredCustomerFields } from "@/modules/customers/hooks";

// Importar y exportar (TX-4, ADR-078): un lugar para bajar las plantillas,
// importar cada entidad con el asistente de 3 pasos y exportar la base
// completa en un solo Excel. Sólo dueño o encargado (el servidor lo exige).

type AnyDef = ImportDefinition<Record<string, unknown>>;

function EntityRow({
  def,
  context,
  onImport,
}: {
  def: AnyDef;
  context: ImportContext;
  onImport: (entity: ImportEntityKey) => void;
}) {
  const { toast } = useToast();
  const canImport = useFeature("importacion_excel");
  const canEntity = useFeature(def.feature ?? "");
  // Si el plan no incluye la importación o la función de la entidad, el botón
  // abre el aviso de plan en lugar del asistente (el servidor igual rechaza).
  const lockedBy = canImport === false ? "importacion_excel" : def.feature && canEntity === false ? def.feature : null;

  return (
    <li className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 font-semibold">
          {def.title}
          {lockedBy && <Lock size={13} className="text-ninja-flameSoft" aria-label="No incluido en tu plan" />}
        </p>
        <p className="mt-0.5 text-sm text-muted-foreground">{def.intro}</p>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            downloadImportTemplate(def, context).catch(() =>
              toast({ title: "No se pudo generar la plantilla", variant: "error" }),
            )
          }
        >
          <FileSpreadsheet size={15} /> Plantilla
        </Button>
        <GatedButton
          feature={lockedBy ?? "importacion_excel"}
          featureLabel={lockedBy === "importacion_excel" || !lockedBy ? "Importación Excel" : def.title}
          size="sm"
          onClick={() => onImport(def.entity)}
        >
          <Upload size={15} /> Importar
        </GatedButton>
      </div>
    </li>
  );
}

export default function ImportacionesPage() {
  const { toast } = useToast();
  const { data: me, isLoading } = useMyTenant();
  const canManage = Boolean(me?.canManage);
  const { data: branches } = useBranches();
  const { data: lists } = usePriceLists();
  const { data: required } = useRequiredCustomerFields();
  const [active, setActive] = useState<ImportEntityKey | null>(null);
  const [exporting, setExporting] = useState(false);

  const context = useMemo<ImportContext>(
    () => ({
      requireCustomerDoc: required?.requireDoc ?? false,
      stores: (branches ?? []).filter((b) => !b.deleted_at).map((b) => b.code || b.name),
      priceLists: (lists ?? []).map((l) => l.name),
    }),
    [branches, lists, required],
  );

  const activeDef = IMPORT_DEFINITIONS.find((d) => d.entity === active) as AnyDef | undefined;

  async function onExportAll() {
    setExporting(true);
    try {
      await exportFullBase(me?.name ?? null);
    } catch (e) {
      toast({
        title: "No se pudo exportar la base",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    } finally {
      setExporting(false);
    }
  }

  return (
    <PageContainer size="lg">
      <PageHeader
        eyebrow="Gestión"
        title="Importar y exportar"
        icon={FileSpreadsheet}
        description="Cargá tus datos desde Excel con una plantilla. Antes de guardar te mostramos qué se crea, qué se actualiza y qué filas tienen errores; nada se guarda sin tu confirmación."
      />

      {!isLoading && !canManage ? (
        <Callout tone="neutral" icon={Lock} title="Sólo el dueño o un encargado" className="mt-6">
          Importar y exportar la base es una tarea de administración. Pedile a un encargado que lo haga.
        </Callout>
      ) : (
        <>
          <section className="mt-6 border-t-2 border-ninja-flame pt-4">
            <h2 className="text-base font-semibold">Exportar toda la base</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Un solo Excel con productos, clientes, stock por sucursal, listas de precios, sucursales, garantías y
              motivos de devolución. Cada hoja tiene los mismos encabezados que su plantilla: podés editarla y volver a
              importarla.
            </p>
            <GatedButton
              feature="export_xlsx"
              featureLabel="Exportar a Excel"
              variant="secondary"
              className="mt-3"
              onClick={onExportAll}
              loading={exporting}
            >
              <Download size={16} /> Exportar base completa (XLSX)
            </GatedButton>
          </section>

          <section className="mt-8">
            <h2 className="text-base font-semibold">Importar desde Excel</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Bajá la plantilla, completala y subila. Son tres pasos: subir, revisar y confirmar.
            </p>
            <ul className="mt-2 divide-y divide-border">
              {IMPORT_DEFINITIONS.map((d) => (
                <EntityRow key={d.entity} def={d as AnyDef} context={context} onImport={setActive} />
              ))}
            </ul>
          </section>
        </>
      )}

      {activeDef && (
        <ImportWizard
          definition={activeDef}
          open={active !== null}
          onOpenChange={(o) => !o && setActive(null)}
          context={context}
        />
      )}
    </PageContainer>
  );
}
