"use client";

import { useEffect, useState } from "react";
import { Cake, Clock, Download, Pencil, Plus, Search, Trash2, Upload, Wallet } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Eyebrow, Display } from "@/components/ui/Typography";
import { InfoHint } from "@/components/ui/InfoHint";
import { useToast } from "@/components/ui/Toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Pagination } from "@/components/ui/Pagination";
import { GatedButton } from "@/components/saas/GatedAction";
import { CustomerFormModal } from "@/components/customers/CustomerFormModal";
import { CustomerHistoryModal } from "@/components/customers/CustomerHistoryModal";
import { AccountsReceivableModal } from "@/components/customers/AccountsReceivableModal";
import { BirthdaysModal } from "@/components/customers/BirthdaysModal";
import { ImportCustomersModal } from "@/components/customers/ImportCustomersModal";
import { useCustomersPaged, useCustomerMutations } from "@/modules/customers/hooks";
import {
  DOC_TYPE_LABELS,
  IVA_LABELS,
} from "@/modules/customers/schemas";
import type { Customer } from "@/modules/customers/api";
import { usePageSize } from "@/hooks/usePageSize";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { createClient } from "@/lib/supabase/client";
import { exportXlsx } from "@/lib/utils/xlsx";
import { CUSTOMER_IMPORT_COLUMNS } from "@/modules/customers/import";

export default function ClientesPage() {
  const { toast } = useToast();
  const pageSize = usePageSize();
  const [search, setSearch] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [arOpen, setArOpen] = useState(false);
  const [bdayOpen, setBdayOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Customer | null>(null);
  const [historyCustomer, setHistoryCustomer] = useState<Customer | null>(null);
  const [delTarget, setDelTarget] = useState<Customer | null>(null);
  const debouncedSearch = useDebouncedValue(search, 350);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, pageSize]);

  const { data, isLoading, isError, isPlaceholderData, refetch } = useCustomersPaged({
    page,
    pageSize,
    search: debouncedSearch,
  });
  const customers = data?.rows ?? [];
  const total = data?.total ?? 0;
  const { remove } = useCustomerMutations();

  async function exportBase() {
    const supabase = createClient();
    const { data } = await supabase
      .from("customers")
      .select("name, document_type, document_number, iva_condition, email, phone, address, notes")
      .is("deleted_at", null)
      .order("name", { ascending: true });
    // Etiquetas legibles (DNI, Consumidor Final). El import acepta tanto la
    // etiqueta como el código, así que la base exportada se puede reimportar.
    await exportXlsx("clientes", [
      {
        name: "Clientes",
        title: "Base de clientes • NinjaPos",
        columns: CUSTOMER_IMPORT_COLUMNS,
        rows: (data ?? []).map((c) => ({
          name: c.name,
          document_type: c.document_type
            ? (DOC_TYPE_LABELS[c.document_type as keyof typeof DOC_TYPE_LABELS] ??
              c.document_type)
            : "",
          document_number: c.document_number ?? "",
          iva_condition: c.iva_condition
            ? (IVA_LABELS[c.iva_condition as keyof typeof IVA_LABELS] ??
              c.iva_condition)
            : "",
          email: c.email ?? "",
          phone: c.phone ?? "",
          address: c.address ?? "",
          notes: c.notes ?? "",
        })),
      },
    ]);
  }

  async function confirmDelete() {
    if (!delTarget) return;
    try {
      await remove.mutateAsync(delTarget.id);
      setDelTarget(null);
      toast({ title: "Cliente eliminado", variant: "success" });
    } catch {
      toast({ title: "No se pudo eliminar", variant: "error" });
    }
  }

  return (
    <>
<div className="mx-auto max-w-6xl px-6 py-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <Eyebrow>Clientes</Eyebrow>
            <Display className="mt-3 flex items-center gap-2 text-3xl md:text-4xl">
              Clientes
              <InfoHint section="clientes" size={18} />
            </Display>
          </div>
          <div className="-mx-6 flex gap-2 overflow-x-auto px-6 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <GatedButton
              feature="export_xlsx"
              featureLabel="Exportar a Excel"
              variant="secondary"
              className="shrink-0"
              onClick={exportBase}
            >
              <Download size={16} /> Exportar XLSX
            </GatedButton>
            <GatedButton
              feature="importacion_excel"
              featureLabel="Importación desde Excel"
              variant="secondary"
              className="shrink-0"
              onClick={() => setImportOpen(true)}
            >
              <Upload size={16} /> Importar XLSX
            </GatedButton>
            <GatedButton
              feature="cuenta_corriente"
              featureLabel="Cuenta corriente"
              variant="secondary"
              className="shrink-0"
              onClick={() => setArOpen(true)}
            >
              <Wallet size={16} /> Cuentas por cobrar
            </GatedButton>
            <Button variant="secondary" className="shrink-0" onClick={() => setBdayOpen(true)}>
              <Cake size={16} /> Cumpleaños
            </Button>
            <Button
              className="shrink-0"
              onClick={() => {
                setSelected(null);
                setFormOpen(true);
              }}
            >
              <Plus size={16} /> Nuevo cliente
            </Button>
          </div>
        </div>

        <div className="relative mt-6 max-w-md">
          <Search
            size={16}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nombre o documento…"
            className="h-11 w-full rounded-lg border border-input bg-background pl-9 pr-4 text-sm text-foreground outline-none focus:border-ninja-flameSoft focus:ring-4 focus:ring-ninja-flameSoft/15"
          />
        </div>

        <div className="mt-6 overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-muted text-left text-xs uppercase tracking-[0.14em] text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Nombre</th>
                <th className="px-4 py-3">Documento</th>
                <th className="px-4 py-3">IVA</th>
                <th className="px-4 py-3">Teléfono</th>
                <th className="px-4 py-3 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border text-foreground">
              {isLoading && (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">
                    Cargando…
                  </td>
                </tr>
              )}
              {isError && !isLoading && (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-danger">
                    Error al cargar.{" "}
                    <button onClick={() => refetch()} className="underline">
                      Reintentar
                    </button>
                  </td>
                </tr>
              )}
              {!isLoading && !isError && customers.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">
                    {search ? "Sin resultados para la búsqueda." : "Sin clientes. Creá el primero."}
                  </td>
                </tr>
              )}
              {customers.map((c) => (
                <tr key={c.id} className="transition hover:bg-muted/40">
                  <td className="px-4 py-3 font-medium text-foreground">{c.name}</td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {c.document_type
                      ? `${DOC_TYPE_LABELS[c.document_type as keyof typeof DOC_TYPE_LABELS] ?? c.document_type} ${c.document_number ?? ""}`
                      : "—"}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {c.iva_condition
                      ? (IVA_LABELS[c.iva_condition as keyof typeof IVA_LABELS] ??
                        c.iva_condition)
                      : "—"}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{c.phone ?? "—"}</td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      <button
                        onClick={() => setHistoryCustomer(c)}
                        title="Historial"
                        className="rounded-md p-2 text-muted-foreground transition hover:bg-muted hover:text-ninja-flameSoft"
                      >
                        <Clock size={16} />
                      </button>
                      <button
                        onClick={() => {
                          setSelected(c);
                          setFormOpen(true);
                        }}
                        title="Editar"
                        className="rounded-md p-2 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                      >
                        <Pencil size={16} />
                      </button>
                      <button
                        onClick={() => setDelTarget(c)}
                        title="Eliminar"
                        className="rounded-md p-2 text-muted-foreground transition hover:bg-red-400/15 hover:text-danger"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={setPage}
          loading={isPlaceholderData}
        />
      </div>

      <CustomerFormModal
        open={formOpen}
        onOpenChange={setFormOpen}
        customer={selected}
      />
      <ImportCustomersModal open={importOpen} onOpenChange={setImportOpen} />
      <AccountsReceivableModal open={arOpen} onOpenChange={setArOpen} />
      <BirthdaysModal open={bdayOpen} onOpenChange={setBdayOpen} />
      <CustomerHistoryModal
        open={historyCustomer !== null}
        onOpenChange={(o) => !o && setHistoryCustomer(null)}
        customer={historyCustomer}
      />
      <ConfirmDialog
        open={delTarget !== null}
        onOpenChange={(o) => !o && setDelTarget(null)}
        title="Eliminar cliente"
        description={delTarget ? `Se elimina "${delTarget.name}".` : ""}
        confirmLabel="Eliminar"
        danger
        loading={remove.isPending}
        onConfirm={confirmDelete}
      />
    </>
  );
}
