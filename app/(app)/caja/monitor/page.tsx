"use client";

import Link from "next/link";
import { ArrowLeft, MonitorDot } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/ui/PageHeader";
import { buttonVariants } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { CashMonitor } from "@/components/cash/CashMonitor";
import { BranchOverviewGrid } from "@/components/cash/BranchOverviewGrid";
import { useBranchContext, useBranchScope } from "@/modules/branches/hooks";

// Cajas abiertas (F17 · H115): por sucursal, quién, desde cuándo, ventas y
// efectivo esperado; detalle y cierre forzado con PIN. Dueño y encargado.
export default function CashMonitorPage() {
  const scope = useBranchScope();
  const ctx = useBranchContext();
  const role = scope.data?.role ?? null;
  const allowed = role === "owner" || role === "manager";
  return (
    <PageContainer size="xl">
      <PageHeader
        eyebrow="Operación"
        title="Cajas abiertas"
        icon={MonitorDot}
        description={
          ctx.filterStore
            ? `En ${ctx.filterStore.name}. Se actualiza solo cada 30 segundos.`
            : "Todas tus sucursales. Se actualiza solo cada 30 segundos."
        }
        actions={
          <Link href="/caja" className={buttonVariants({ size: "sm", variant: "secondary" })}>
            <ArrowLeft size={16} /> Mi caja
          </Link>
        }
      />
      <div className="mt-6">
        {scope.isLoading ? null : allowed ? (
          <div className="space-y-8">
            <BranchOverviewGrid />
            <CashMonitor />
          </div>
        ) : (
          <Card>
            <EmptyState
              icon={MonitorDot}
              title="Sólo para dueño y encargados"
              description="Tu caja la ves en Caja."
            />
          </Card>
        )}
      </div>
    </PageContainer>
  );
}
