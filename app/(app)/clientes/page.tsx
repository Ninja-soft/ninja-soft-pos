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
    <div className="ninja-dark-bg min-h-screen text-ninja-softWhite">
      <header className="sticky top-0 z-40 border-b border-border bg-background/70 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <Link href="/dashboard" className="flex items-center gap-3">
            <Isotype className="h-7 w-auto" />
            <span className="flex items-center gap-1 text-sm text-ninja-lavender">
              <ArrowLeft size={15} /> Panel
            </span>
          </Link>
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">
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
            className="h-11 w-full rounded-ninjaLg border border-input bg-background pl-9 pr-4 text-sm text-foreground outline-none focus:border-ninja-flameSoft focus:ring-4 focus:ring-ninja-flameSoft/15"
          />
        </div>

        <div className="mt-6 overflow-hidden rounded-ninjaLg border border-white/10 bg-white/[0.04]">
          <table className="w-full text-sm">
            <thead className="bg-white/[0.06] text-left text-xs uppercase tracking-[0.14em] text-white/45">
              <tr>
                <th className="px-4 py-3">Nombre</th>
                <th className="px-4 py-3">Documento</th>
                <th className="px-4 py-3">IVA</th>
                <th className="px-4 py-3">Teléfono</th>
                <th className="px-4 py-3 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/10 text-white/80">
              {isLoading && (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-white/50">
                    Cargando…
                  </td>
                </tr>
              )}
              {!isLoading && customers?.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-white/50">
                    Sin clientes. Creá el primero.
                  </td>
                </tr>
              )}
              {customers?.map((c) => (
                <tr key={c.id} className="transition hover:bg-white/[0.03]">
                  <td className="px-4 py-3 font-medium text-white">{c.name}</td>
                  <td className="px-4 py-3 text-white/60">
                    {c.document_type
                      ? `${DOC_TYPE_LABELS[c.document_type as keyof typeof DOC_TYPE_LABELS] ?? c.document_type} ${c.document_number ?? ""}`
                      : "—"}
                  </td>
                  <td className="px-4 py-3 text-white/60">
                    {c.iva_condition
                      ? (IVA_LABELS[c.iva_condition as keyof typeof IVA_LABELS] ??
                        c.iva_condition)
                      : "—"}
                  </td>
                  <td className="px-4 py-3 text-white/60">{c.phone ?? "—"}</td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      <button
                        onClick={() => {
                          setSelected(c);
                          setFormOpen(true);
                        }}
                        title="Editar"
                        className="rounded-ninjaSm p-2 text-white/60 transition hover:bg-white/10 hover:text-white"
                      >
                        <Pencil size={16} />
                      </button>
                      <button
                        onClick={() => onDelete(c)}
                        title="Eliminar"
                        className="rounded-ninjaSm p-2 text-white/60 transition hover:bg-red-400/15 hover:text-red-300"
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
      </main>

      <CustomerFormModal
        open={formOpen}
        onOpenChange={setFormOpen}
        customer={selected}
      />
    </div>
  );
}
