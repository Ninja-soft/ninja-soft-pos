"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ArrowDownCircle,
  ArrowLeft,
  ArrowUpCircle,
  Download,
  Printer,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { Eyebrow, Display } from "@/components/ui/Typography";
import { Card, CardContent } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";
import { Isotype } from "@/components/brand/Logo";
import { useOpenShift } from "@/modules/pos/hooks";
import { useShiftMovements, useAddMovement } from "@/modules/cash/hooks";
import { summarize } from "@/modules/cash/api";
import { formatCurrency } from "@/lib/utils/format";

const METHOD_LABELS: Record<string, string> = {
  cash: "Efectivo",
  debit: "Débito",
  credit: "Crédito",
  transfer: "Transferencia",
  qr: "QR",
  other: "Otro",
};

export default function CajaPage() {
  const { toast } = useToast();
  const { data: shift } = useOpenShift();
  const { data: movements } = useShiftMovements(shift?.id ?? null);
  const addMovement = useAddMovement();

  const [modalType, setModalType] = useState<"income" | "expense" | null>(null);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");

  const summary = shift
    ? summarize(shift.opening_amount, movements ?? [])
    : null;

  async function submitMovement() {
    if (!shift || !modalType) return;
    const amt = Number(amount) || 0;
    if (amt <= 0) {
      toast({ title: "Monto inválido", variant: "error" });
      return;
    }
    try {
      await addMovement.mutateAsync({
        shiftId: shift.id,
        type: modalType,
        amount: amt,
        reason: reason.trim(),
      });
      toast({ title: "Movimiento registrado", variant: "success" });
      setModalType(null);
      setAmount("");
      setReason("");
    } catch (e) {
      toast({
        title: "No se pudo registrar",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  function exportCsv() {
    if (!shift || !summary) return;
    const rows = [
      ["Reporte Z — turno", shift.id],
      ["Apertura", String(summary.opening)],
      ["Ventas netas", String(summary.salesTotal)],
      ["Ingresos manuales", String(summary.income)],
      ["Egresos manuales", String(summary.expense)],
      ["Efectivo esperado", String(summary.cashExpected)],
      [],
      ["Medio de pago", "Monto"],
      ...Object.entries(summary.byMethod).map(([k, v]) => [
        METHOD_LABELS[k] ?? k,
        String(v),
      ]),
    ];
    const csv = rows.map((r) => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `reporte-z-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="app-bg min-h-screen text-foreground">
      <header className="sticky top-0 z-40 border-b border-border bg-background/70 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-6">
          <Link href="/dashboard" className="flex items-center gap-3">
            <Isotype className="h-7 w-auto" />
            <span className="flex items-center gap-1 text-sm text-muted-foreground">
              <ArrowLeft size={15} /> Panel
            </span>
          </Link>
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-10">
        <Eyebrow>Operación</Eyebrow>
        <Display className="mt-3 text-3xl md:text-4xl">Caja</Display>

        {!shift ? (
          <Card className="mt-6">
            <CardContent className="p-6 text-muted-foreground">
              No hay una caja abierta. Abrila desde el{" "}
              <Link href="/pos" className="text-ninja-flameSoft hover:underline">
                punto de venta
              </Link>
              .
            </CardContent>
          </Card>
        ) : (
          <>
            <div className="mt-6 flex flex-wrap gap-3">
              <Button onClick={() => setModalType("income")}>
                <ArrowDownCircle size={16} /> Ingreso
              </Button>
              <Button variant="secondary" onClick={() => setModalType("expense")}>
                <ArrowUpCircle size={16} /> Egreso
              </Button>
              <Button variant="secondary" onClick={exportCsv}>
                <Download size={16} /> Exportar Z (CSV)
              </Button>
              <Button variant="secondary" onClick={() => window.print()}>
                <Printer size={16} /> Imprimir Z
              </Button>
            </div>

            {/* Reporte Z imprimible */}
            <div className="ticket-print mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <SummaryCard label="Apertura" value={summary!.opening} />
              <SummaryCard label="Ventas netas" value={summary!.salesTotal} />
              <SummaryCard label="Ingresos manuales" value={summary!.income} />
              <SummaryCard label="Egresos manuales" value={summary!.expense} />
              <SummaryCard
                label="Efectivo esperado"
                value={summary!.cashExpected}
                highlight
              />
            </div>

            <h2 className="mt-8 font-display text-lg font-bold">
              Ventas por medio de pago
            </h2>
            <Card className="mt-3">
              <CardContent className="p-4">
                {Object.keys(summary!.byMethod).length === 0 ? (
                  <p className="text-sm text-muted-foreground">Sin ventas aún.</p>
                ) : (
                  <ul className="divide-y divide-border">
                    {Object.entries(summary!.byMethod).map(([k, v]) => (
                      <li key={k} className="flex justify-between py-2 text-sm">
                        <span>{METHOD_LABELS[k] ?? k}</span>
                        <span className="font-semibold">{formatCurrency(v)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            <h2 className="mt-8 font-display text-lg font-bold">Movimientos</h2>
            <Card className="mt-3">
              <CardContent className="p-0">
                <ul className="divide-y divide-border">
                  {(movements ?? []).map((m) => (
                    <li
                      key={m.id}
                      className="flex items-center justify-between px-4 py-3 text-sm"
                    >
                      <div>
                        <span className="font-medium">
                          {m.type === "income"
                            ? "Ingreso"
                            : m.type === "expense"
                              ? "Egreso"
                              : m.type === "sale"
                                ? "Venta"
                                : "Anulación"}
                        </span>
                        {m.reason && (
                          <span className="ml-2 text-muted-foreground">{m.reason}</span>
                        )}
                        <div className="text-xs text-muted-foreground">
                          {new Date(m.created_at).toLocaleString("es-AR")}
                          {m.payment_method
                            ? ` · ${METHOD_LABELS[m.payment_method] ?? m.payment_method}`
                            : ""}
                        </div>
                      </div>
                      <span
                        className={
                          m.type === "expense" || m.type === "sale_void"
                            ? "text-red-300"
                            : "text-emerald-300"
                        }
                      >
                        {formatCurrency(m.amount)}
                      </span>
                    </li>
                  ))}
                  {(movements ?? []).length === 0 && (
                    <li className="px-4 py-6 text-center text-sm text-muted-foreground">
                      Sin movimientos.
                    </li>
                  )}
                </ul>
              </CardContent>
            </Card>
          </>
        )}
      </main>

      <Modal
        open={modalType !== null}
        onOpenChange={(o) => !o && setModalType(null)}
        title={modalType === "income" ? "Registrar ingreso" : "Registrar egreso"}
      >
        <div className="space-y-4">
          <Input
            label="Monto"
            type="number"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <Input
            label="Motivo"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={modalType === "expense" ? "Compra de bolsas" : "Aporte"}
          />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setModalType(null)}>
              Cancelar
            </Button>
            <Button loading={addMovement.isPending} onClick={submitMovement}>
              Registrar
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  highlight,
}: {
  label: string;
  value: number;
  highlight?: boolean;
}) {
  return (
    <Card>
      <CardContent className="p-5">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p
          className={
            highlight
              ? "mt-2 font-mono tabular-nums text-2xl font-black text-ninja-gold"
              : "mt-2 font-mono tabular-nums text-2xl font-bold"
          }
        >
          {formatCurrency(value)}
        </p>
      </CardContent>
    </Card>
  );
}
