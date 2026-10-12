"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ArrowDownCircle,
  ArrowLeft,
  ArrowUpCircle,
  Download,
  Printer,
  Receipt,
  ShoppingCart,
  Wallet,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { InfoHint } from "@/components/ui/InfoHint";
import { Card, CardContent } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";
import { Isotype } from "@/components/brand/Logo";
import { useDefaultRegister, useOpenShift } from "@/modules/pos/hooks";
import { locationLabel } from "@/modules/branches/logic";
import { useShiftMovements, useAddMovement } from "@/modules/cash/hooks";
import { summarize } from "@/modules/cash/api";
import { ZClosuresHistory } from "@/components/cash/ZClosuresHistory";
import { usePrintProfiles } from "@/modules/tickets/hooks";
import { webPrintCopies } from "@/lib/print/webPrint";
import { formatCurrency } from "@/lib/utils/format";
import { exportXlsx } from "@/lib/utils/xlsx";
import { PAYMENT_METHOD_LABELS as METHOD_LABELS } from "@/lib/utils/paymentMethods";
import { format } from "date-fns";
import { PageHeader, SectionHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";

export default function CajaPage() {
  const { toast } = useToast();
  const { data: shift } = useOpenShift();
  // F17 · H90: la caja de este dispositivo ("Centro · Caja 1").
  const { data: register, store: registerStore } = useDefaultRegister();
  const where = locationLabel(registerStore, register);
  const { data: movements } = useShiftMovements(shift?.id ?? null);
  const addMovement = useAddMovement();
  // Perfil de impresión del "cierre Z" (H22): copias configuradas por el negocio.
  const { data: printProfiles } = usePrintProfiles();
  const zCopies = printProfiles?.z_close.copies ?? 1;

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

  async function exportZ() {
    if (!shift || !summary) return;
    await exportXlsx(`reporte-z-${format(new Date(), "yyyy-MM-dd")}`, [
      {
        name: "Reporte Z",
        title: `Reporte Z · ${where ? `${where} · ` : ""}turno ${shift.id.slice(0, 8)}`,
        columns: [
          { header: "Concepto", key: "k", width: 22 },
          { header: "Monto", key: "v", type: "money", width: 18 },
        ],
        rows: [
          { k: "Apertura", v: summary.opening },
          { k: "Ventas netas", v: summary.salesTotal },
          { k: "Ingresos manuales", v: summary.income },
          { k: "Egresos manuales", v: summary.expense },
          { k: "Efectivo esperado", v: summary.cashExpected },
        ],
      },
      {
        name: "Por medio de pago",
        columns: [
          { header: "Medio", key: "method", width: 18 },
          { header: "Monto", key: "amount", type: "money" },
        ],
        rows: Object.entries(summary.byMethod).map(([k, v]) => ({
          method: METHOD_LABELS[k] ?? k,
          amount: v,
        })),
        totals: {
          amount: Object.values(summary.byMethod).reduce(
            (a, v) => a + (v as number),
            0,
          ),
        },
      },
    ]);
  }

  return (
    <>
      <div className="mx-auto w-full max-w-5xl px-4 pb-[calc(2.5rem+env(safe-area-inset-bottom))] pt-6 sm:px-6 sm:pt-8">
        <PageHeader
          eyebrow="Operación"
          title="Caja"
          description={where || undefined}
          icon={Wallet}
          help={<InfoHint section="caja" size={18} />}
        />

        {!shift ? (
          <Card className="mt-6">
            <EmptyState
              icon={Wallet}
              title="No hay una caja abierta"
              description="Abrila desde el punto de venta para registrar ingresos, egresos y el cierre Z."
              action={
                <Link href="/pos" className={buttonVariants({ size: "sm" })}>
                  <ShoppingCart size={16} /> Ir al punto de venta
                </Link>
              }
            />
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
              <Button variant="secondary" onClick={exportZ}>
                <Download size={16} /> Exportar Z (XLSX)
              </Button>
              <Button
                variant="secondary"
                onClick={() => webPrintCopies(zCopies)}
                title={zCopies > 1 ? `Imprimir Z (${zCopies} copias)` : "Imprimir Z"}
              >
                <Printer size={16} /> Imprimir Z
                {zCopies > 1 ? ` (${zCopies})` : ""}
              </Button>
            </div>

            {/* Reporte Z imprimible */}
            <div className="ticket-print mt-6 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3">
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

            <SectionHeader className="mt-8" title="Ventas por medio de pago" />
            <Card className="mt-3">
              <CardContent className="p-4">
                {Object.keys(summary!.byMethod).length === 0 ? (
                  <EmptyState compact icon={Receipt} title="Sin ventas en este turno" />
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

            <SectionHeader className="mt-8" title="Movimientos" />
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
                                : m.type === "account_payment"
                                  ? "Cobro cuenta corriente"
                                  : m.type === "account_payment_void"
                                    ? "Anulación cobro cuenta corriente"
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
                          m.type === "expense" ||
                          m.type === "sale_void" ||
                          m.type === "account_payment_void"
                            ? "text-danger"
                            : "text-success"
                        }
                      >
                        {formatCurrency(m.amount)}
                      </span>
                    </li>
                  ))}
                  {(movements ?? []).length === 0 && (
                    <li>
                      <EmptyState
                        compact
                        icon={ArrowDownCircle}
                        title="Sin movimientos"
                        description="Los ingresos y egresos manuales aparecen acá."
                      />
                    </li>
                  )}
                </ul>
              </CardContent>
            </Card>
          </>
        )}

        <div className="mt-10">
          <ZClosuresHistory />
        </div>
      </div>

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
    </>
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
      <CardContent className="p-4 sm:p-5">
        <p className="text-xs text-muted-foreground sm:text-sm">{label}</p>
        <p
          className={
            highlight
              ? "price-hl mt-1.5 font-price tabular-nums text-xl font-black sm:mt-2 sm:text-2xl"
              : "mt-1.5 font-price tabular-nums text-xl font-bold sm:mt-2 sm:text-2xl"
          }
        >
          {formatCurrency(value)}
        </p>
      </CardContent>
    </Card>
  );
}
