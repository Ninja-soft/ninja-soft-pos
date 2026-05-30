"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { Eyebrow, Display } from "@/components/ui/Typography";
import { useToast } from "@/components/ui/Toast";
import { Isotype } from "@/components/brand/Logo";
import { CustomerFormModal } from "@/components/customers/CustomerFormModal";
import { useCustomers, useCustomerMutations } from "@/modules/customers/hooks";
import {
  DOC_TYPE_LABELS,
  IVA_LABELS,
} from "@/modules/customers/schemas";
import type { Customer } from "@/modules/customers/api";

export default function ClientesPage() {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [selected, setSelected] = useState<Customer | null>(null);
  const { data: customers, isLoading } = useCustomers(search);
  const { remove } = useCustomerMutations();

  async function onDelete(c: Customer) {
    if (!window.confirm(`¿Eliminar "${c.name}"?`)) return;
    try {
      await remove.mutateAsync(c.id);
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
            <Display className="mt-3 text-3xl md:text-4xl">Clientes</Display>
          </div>
          <Button
            onClick={() => {
              setSelected(null);
              setFormOpen(true);
            }}
          >
            <Plus size={16} /> Nuevo cliente
          </Button>
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

        <div className="mt-6 overflow-hidden rounded-lg border border-border bg-card">
          <table className="w-full text-sm">
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
              {!isLoading && customers?.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">
                    Sin clientes. Creá el primero.
                  </td>
                </tr>
              )}
              {customers?.map((c) => (
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
                        onClick={() => onDelete(c)}
                        title="Eliminar"
                        className="rounded-md p-2 text-muted-foreground transition hover:bg-red-400/15 hover:text-red-300"
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
      </div>

      <CustomerFormModal
        open={formOpen}
        onOpenChange={setFormOpen}
        customer={selected}
      />
    </>
  );
}
