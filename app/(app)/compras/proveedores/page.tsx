"use client";

import { useMemo, useState } from "react";
import { Building2, Download, Plus, Search, Settings2 } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Switch } from "@/components/ui/Switch";
import { EmptyState } from "@/components/ui/EmptyState";
import { TableStateRow, TableWrap } from "@/components/ui/Table";
import { cn } from "@/lib/utils/cn";
import { exportXlsx } from "@/lib/utils/xlsx";
import { SUPPLIER_IVA_LABEL, formatCuit, normalizeCuit } from "@/lib/purchases/suppliers";
import { useMyTenant } from "@/modules/tenants/hooks";
import { usePurchasesAccess, useSupplierBalances, useSuppliers } from "@/modules/purchases/hooks";
import type { Supplier } from "@/modules/purchases/api";
import { ComprasLocked, ComprasTabs, formatMoney, today } from "@/components/purchases/shared";
import { SupplierFormModal } from "@/components/purchases/SupplierFormModal";
import { SupplierDetailModal } from "@/components/purchases/SupplierDetailModal";
import { PurchaseSettingsModal } from "@/components/purchases/PurchaseSettingsModal";

// Proveedores (F18 · H101, ADR-050).
export default function ProveedoresPage() {
  const access = usePurchasesAccess();
  const { data: me } = useMyTenant();
  const canManage = Boolean(me?.canManage);
  const [search, setSearch] = useState("");
  const [archived, setArchived] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const { data: suppliers = [], isLoading, isError, refetch } = useSuppliers(
    { includeArchived: archived },
    access.enabled,
  );
  const { data: balances = [] } = useSupplierBalances(access.enabled);
  const balanceOf = useMemo(() => new Map(balances.map((b) => [b.supplier_id, b])), [balances]);
  const now = today();

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const qDigits = normalizeCuit(q);
    return suppliers
      .filter((s) => (archived ? true : !s.deleted_at))
      .filter(
        (s) =>
          !q ||
          s.name.toLowerCase().includes(q) ||
          (s.trade_name ?? "").toLowerCase().includes(q) ||
          (qDigits.length >= 3 && (s.cuit ?? "").includes(qDigits)),
      );
  }, [suppliers, search, archived]);

  const cols = access.pro ? 7 : 6;

  function exportList() {
    void exportXlsx("proveedores", [
      {
        name: "Proveedores",
        title: "Proveedores",
        columns: [
          { header: "Razón social", key: "name", width: 28 },
          { header: "Fantasía", key: "trade", width: 20 },
          { header: "CUIT", key: "cuit", width: 15 },
          { header: "Condición IVA", key: "iva", width: 20 },
          { header: "Contacto", key: "contact", width: 18 },
          { header: "Email", key: "email", width: 24 },
          { header: "Teléfono", key: "phone", width: 16 },
          { header: "Plazo (días)", key: "terms", type: "number" },
          { header: "Moneda", key: "currency", width: 8 },
          { header: "CBU", key: "cbu", width: 24 },
          { header: "Alias", key: "alias", width: 18 },
          { header: "Saldo", key: "balance", type: "money" },
        ],
        rows: rows.map((s) => ({
          name: s.name,
          trade: s.trade_name ?? "",
          cuit: s.cuit ? formatCuit(s.cuit) : "",
          iva: SUPPLIER_IVA_LABEL[s.iva_condition] ?? s.iva_condition,
          contact: s.contact_name ?? "",
          email: s.email ?? "",
          phone: s.phone ?? s.whatsapp ?? "",
          terms: s.payment_terms_days,
          currency: s.currency,
          cbu: s.cbu ?? "",
          alias: s.alias ?? "",
          balance: balanceOf.get(s.id)?.balance_ars ?? 0,
        })),
        totals: { balance: rows.reduce((t, s) => t + (balanceOf.get(s.id)?.balance_ars ?? 0), 0) },
      },
    ]);
  }

  const header = (
    <PageHeader
      eyebrow="Compras"
      title="Proveedores"
      icon={Building2}
      description="Tus proveedores con sus datos fiscales, condiciones de pago, productos y cuenta corriente."
      actions={
        access.enabled ? (
          <>
            {canManage && (
              <Button onClick={() => setFormOpen(true)}>
                <Plus size={16} /> Nuevo proveedor
              </Button>
            )}
            <Button variant="secondary" onClick={exportList} disabled={rows.length === 0}>
              <Download size={16} /> XLSX
            </Button>
            {canManage && (
              <Button variant="ghost" onClick={() => setSettingsOpen(true)}>
                <Settings2 size={16} /> Configuración
              </Button>
            )}
          </>
        ) : undefined
      }
    />
  );

  if (access.locked) {
    return (
      <PageContainer>
        {header}
        <ComprasLocked />
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      {header}
      <ComprasTabs />

      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1 sm:max-w-sm">
          <Search
            size={15}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nombre o CUIT"
            aria-label="Buscar proveedor"
            className="h-10 w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm outline-none focus:border-ninja-flameSoft"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Switch checked={archived} onCheckedChange={setArchived} label="Ver archivados" />
          Ver archivados
        </label>
      </div>

      <div className="mt-4">
        <TableWrap>
          <table className="w-full text-sm">
            <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Proveedor</th>
                <th className="hidden px-4 py-3 md:table-cell">Condición IVA</th>
                <th className="hidden px-4 py-3 lg:table-cell">Contacto</th>
                <th className="hidden px-4 py-3 sm:table-cell">Plazo</th>
                {access.pro && <th className="hidden px-4 py-3 md:table-cell">Moneda</th>}
                <th className="px-4 py-3 text-right">Saldo</th>
                <th className="hidden px-4 py-3 sm:table-cell">Estado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {(isLoading || !access.ready) && <TableStateRow colSpan={cols} loading />}
              {isError && (
                <tr>
                  <td colSpan={cols} className="px-4 py-10 text-center text-danger">
                    Error al cargar.{" "}
                    <button onClick={() => refetch()} className="underline">
                      Reintentar
                    </button>
                  </td>
                </tr>
              )}
              {!isLoading && !isError && access.enabled && rows.length === 0 && (
                <TableStateRow colSpan={cols}>
                  <EmptyState
                    compact
                    icon={Building2}
                    title={search ? "Sin resultados" : "Todavía no cargaste proveedores"}
                    description={
                      search
                        ? "Probá con otro nombre o CUIT."
                        : "Cargá a quién le comprás para armar órdenes de compra y llevar su cuenta corriente."
                    }
                    action={
                      canManage && !search ? (
                        <Button size="sm" onClick={() => setFormOpen(true)}>
                          <Plus size={15} /> Nuevo proveedor
                        </Button>
                      ) : undefined
                    }
                  />
                </TableStateRow>
              )}
              {rows.map((s: Supplier) => {
                const b = balanceOf.get(s.id);
                const bal = b?.balance_ars ?? 0;
                const overdue = bal > 0 && Boolean(b?.oldest_due && b.oldest_due < now);
                return (
                  <tr
                    key={s.id}
                    onClick={() => setDetailId(s.id)}
                    className={cn("cursor-pointer transition hover:bg-muted/40", s.deleted_at && "opacity-60")}
                  >
                    <td className="px-4 py-3">
                      <div className="font-medium">{s.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {[s.trade_name, s.cuit ? formatCuit(s.cuit) : null].filter(Boolean).join(" · ")}
                      </div>
                    </td>
                    <td className="hidden px-4 py-3 text-muted-foreground md:table-cell">
                      {SUPPLIER_IVA_LABEL[s.iva_condition] ?? s.iva_condition}
                    </td>
                    <td className="hidden px-4 py-3 lg:table-cell">
                      <div>{s.contact_name ?? ""}</div>
                      <div className="text-xs text-muted-foreground">{s.phone ?? s.whatsapp ?? s.email ?? ""}</div>
                    </td>
                    <td className="hidden px-4 py-3 text-muted-foreground sm:table-cell">
                      {s.payment_terms_days > 0 ? `${s.payment_terms_days} días` : "Contado"}
                    </td>
                    {access.pro && <td className="hidden px-4 py-3 md:table-cell">{s.currency}</td>}
                    <td
                      className={cn(
                        "px-4 py-3 text-right font-mono tabular-nums",
                        overdue && "font-semibold text-danger",
                        bal < 0 && "text-success",
                      )}
                    >
                      {formatMoney(bal)}
                      {overdue && <div className="text-[11px] font-normal">Vencido</div>}
                    </td>
                    <td className="hidden px-4 py-3 sm:table-cell">
                      {s.deleted_at ? (
                        <Badge tone="neutral">Archivado</Badge>
                      ) : s.is_active ? (
                        <Badge tone="success">Activo</Badge>
                      ) : (
                        <Badge tone="warning">Inactivo</Badge>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableWrap>
      </div>

      <SupplierDetailModal supplierId={detailId} onOpenChange={(o) => !o && setDetailId(null)} />
      <SupplierFormModal open={formOpen} onOpenChange={setFormOpen} onSaved={(s) => setDetailId(s.id)} />
      <PurchaseSettingsModal open={settingsOpen} onOpenChange={setSettingsOpen} />
    </PageContainer>
  );
}
