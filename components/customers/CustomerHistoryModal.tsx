"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { useCustomerHistory } from "@/modules/customers/hooks";
import { useSaleNumberFormat } from "@/modules/sales/hooks";
import { formatCurrency } from "@/lib/utils/format";
import { formatSaleNumber } from "@/lib/utils/saleNumber";
import { customersApi, type Customer } from "@/modules/customers/api";

const SALE_STATUS: Record<string, string> = {
  completed: "Completada",
  voided: "Anulada",
  suspended: "Suspendida",
};

// Historial del cliente (H31): saldo a favor, compras y devoluciones.
export function CustomerHistoryModal({
  open,
  onOpenChange,
  customer,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  customer: Customer | null;
}) {
  const { data, isLoading } = useCustomerHistory(open ? customer?.id : null);
  const { data: numFmt } = useSaleNumberFormat();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [payAmount, setPayAmount] = useState("");

  const payDebt = useMutation({
    mutationFn: () => customersApi.payDebt(customer!.id, Number(payAmount) || 0),
    onSuccess: () => {
      setPayAmount("");
      qc.invalidateQueries({ queryKey: ["customers", "history", customer?.id] });
      toast({ title: "Pago registrado", variant: "success" });
    },
    onError: () => toast({ title: "No se pudo registrar el pago", variant: "error" }),
  });

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={customer ? `Historial · ${customer.name}` : "Historial"}
      className="max-w-lg"
    >
      {isLoading || !data ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Cargando…</p>
      ) : (
        <div className="space-y-5">
          {/* Saldo a favor + deuda */}
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg border border-border bg-muted/40 px-4 py-3">
              <div className="text-xs text-muted-foreground">Saldo a favor (vale)</div>
              <div
                className={
                  data.creditBalance > 0
                    ? "font-price text-lg font-black tabular-nums text-emerald-400"
                    : "font-price text-lg font-black tabular-nums text-foreground"
                }
              >
                {formatCurrency(data.creditBalance)}
              </div>
            </div>
            <div className="rounded-lg border border-border bg-muted/40 px-4 py-3">
              <div className="text-xs text-muted-foreground">Deuda (cuenta corriente)</div>
              <div
                className={
                  data.accountDebt > 0
                    ? "font-price text-lg font-black tabular-nums text-red-400"
                    : "font-price text-lg font-black tabular-nums text-foreground"
                }
              >
                {formatCurrency(data.accountDebt)}
              </div>
            </div>
          </div>

          {data.accountDebt > 0 && (
            <div className="flex items-end gap-2 rounded-lg border border-border p-3">
              <label className="flex-1 text-xs text-muted-foreground">
                Registrar pago de deuda
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={payAmount}
                  onChange={(e) => setPayAmount(e.target.value)}
                  placeholder={formatCurrency(data.accountDebt)}
                  className="mt-1"
                />
              </label>
              <Button
                disabled={
                  payDebt.isPending ||
                  !(Number(payAmount) > 0)
                }
                onClick={() => payDebt.mutate()}
              >
                {payDebt.isPending ? "Registrando…" : "Cobrar deuda"}
              </Button>
            </div>
          )}

          {/* Compras */}
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Compras ({data.sales.length})
            </div>
            <div className="max-h-44 space-y-1 overflow-y-auto">
              {data.sales.length === 0 && (
                <p className="py-3 text-center text-sm text-muted-foreground">
                  Sin compras.
                </p>
              )}
              {data.sales.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm"
                >
                  <span className="font-mono">{formatSaleNumber(s.number, numFmt)}</span>
                  <span className="text-xs text-muted-foreground">
                    {new Date(s.created_at).toLocaleDateString("es-AR")}
                  </span>
                  <span
                    className={
                      s.status === "voided"
                        ? "text-xs text-red-300"
                        : "text-xs text-muted-foreground"
                    }
                  >
                    {SALE_STATUS[s.status] ?? s.status}
                  </span>
                  <span className="font-semibold">{formatCurrency(s.total)}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Devoluciones */}
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Devoluciones ({data.returns.length})
            </div>
            <div className="max-h-36 space-y-1 overflow-y-auto">
              {data.returns.length === 0 && (
                <p className="py-3 text-center text-sm text-muted-foreground">
                  Sin devoluciones.
                </p>
              )}
              {data.returns.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm"
                >
                  <span className="font-mono">Dev #{r.number}</span>
                  <span className="text-xs text-muted-foreground">
                    {r.refund_method === "store_credit" ? "Vale" : "Efectivo"}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {new Date(r.created_at).toLocaleDateString("es-AR")}
                  </span>
                  <span className="font-semibold">{formatCurrency(r.total)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
