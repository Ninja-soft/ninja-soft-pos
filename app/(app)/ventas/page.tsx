"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Ban, Receipt } from "lucide-react";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { Eyebrow, Display } from "@/components/ui/Typography";
import { useToast } from "@/components/ui/Toast";
import { Isotype } from "@/components/brand/Logo";
import { TicketModal } from "@/components/sales/TicketModal";
import { useSales, useVoidSale } from "@/modules/sales/hooks";
import { formatCurrency } from "@/lib/utils/format";

export default function VentasPage() {
  const { toast } = useToast();
  const { data: sales, isLoading } = useSales();
  const voidSale = useVoidSale();
  const [ticketId, setTicketId] = useState<string | null>(null);
  const [ticketOpen, setTicketOpen] = useState(false);

  function openTicket(id: string) {
    setTicketId(id);
    setTicketOpen(true);
  }

  async function onVoid(id: string, number: number) {
    const reason = window.prompt(`Motivo de anulación de la venta #${number}:`);
    if (!reason) return;
    try {
      await voidSale.mutateAsync({ id, reason });
      toast({ title: `Venta #${number} anulada`, variant: "success" });
    } catch (e) {
      toast({
        title: "No se pudo anular",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
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
        <Eyebrow>Operación</Eyebrow>
        <Display className="mt-3 text-3xl md:text-4xl">Ventas</Display>

        <div className="mt-6 overflow-hidden rounded-ninjaLg border border-white/10 bg-white/[0.04]">
          <table className="w-full text-sm">
            <thead className="bg-white/[0.06] text-left text-xs uppercase tracking-[0.14em] text-white/45">
              <tr>
                <th className="px-4 py-3">#</th>
                <th className="px-4 py-3">Fecha</th>
                <th className="px-4 py-3 text-right">Total</th>
                <th className="px-4 py-3">Estado</th>
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
              {!isLoading && sales?.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-white/50">
                    No hay ventas registradas.
                  </td>
                </tr>
              )}
              {sales?.map((s) => (
                <tr key={s.id} className="transition hover:bg-white/[0.03]">
                  <td className="px-4 py-3 font-mono">{s.number}</td>
                  <td className="px-4 py-3 text-white/60">
                    {new Date(s.created_at).toLocaleString("es-AR")}
                  </td>
                  <td className="px-4 py-3 text-right font-semibold">
                    {formatCurrency(s.total)}
                  </td>
                  <td className="px-4 py-3">
                    {s.status === "voided" ? (
                      <span className="inline-flex rounded-ninjaFull border border-red-400/25 bg-red-400/10 px-2.5 py-0.5 text-xs font-semibold text-red-300">
                        Anulada
                      </span>
                    ) : (
                      <span className="inline-flex rounded-ninjaFull border border-emerald-400/25 bg-emerald-400/10 px-2.5 py-0.5 text-xs font-semibold text-emerald-300">
                        Completada
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      <button
                        onClick={() => openTicket(s.id)}
                        title="Ticket"
                        className="rounded-ninjaSm p-2 text-white/60 transition hover:bg-white/10 hover:text-white"
                      >
                        <Receipt size={16} />
                      </button>
                      {s.status === "completed" && (
                        <button
                          onClick={() => onVoid(s.id, s.number)}
                          title="Anular"
                          className="rounded-ninjaSm p-2 text-white/60 transition hover:bg-red-400/15 hover:text-red-300"
                        >
                          <Ban size={16} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>

      <TicketModal open={ticketOpen} onOpenChange={setTicketOpen} saleId={ticketId} />
    </div>
  );
}
