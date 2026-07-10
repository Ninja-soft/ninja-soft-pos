"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Ticket } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { vouchersApi, type VoucherLookup } from "@/modules/sales/api";
import { useRedeemVoucher } from "@/modules/sales/hooks";
import { formatCurrency } from "@/lib/utils/format";

// Canje de vale por código en el POS. Acredita el saldo a favor al cliente de la
// venta (o al cliente del propio vale) y deja ese saldo disponible para pagar.
export function VoucherRedeemModal({
  open,
  onOpenChange,
  customer,
  storeId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  customer: { id: string; name: string } | null;
  storeId: string | null;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const redeem = useRedeemVoucher();
  const [code, setCode] = useState("");
  const [looking, setLooking] = useState(false);
  const [found, setFound] = useState<VoucherLookup | null>(null);
  const [lookupDone, setLookupDone] = useState(false);

  useEffect(() => {
    if (open) {
      setCode("");
      setFound(null);
      setLookupDone(false);
    }
  }, [open]);

  async function lookup() {
    const c = code.trim();
    if (!c) return;
    setLooking(true);
    setLookupDone(false);
    try {
      const v = await vouchersApi.lookup(c);
      setFound(v);
      setLookupDone(true);
    } catch {
      setFound(null);
      setLookupDone(true);
    } finally {
      setLooking(false);
    }
  }

  // Cliente al que se acredita: el del vale si lo tiene, si no el de la venta.
  const targetCustomerId = found?.customer_id ?? customer?.id ?? null;
  const needsCustomer = found != null && found.status === "active" && !targetCustomerId;

  async function doRedeem() {
    if (!found) return;
    try {
      const res = await redeem.mutateAsync({
        code: found.code,
        customerId: customer?.id ?? null,
        storeId,
      });
      // Refresca el saldo de vale del cliente acreditado (pill + medio de pago).
      qc.invalidateQueries({ queryKey: ["customers", "store-credit", res.customer_id] });
      qc.invalidateQueries({ queryKey: ["customers"] });
      toast({
        title: `Vale canjeado: ${formatCurrency(res.amount)} de saldo`,
        variant: "success",
      });
      onOpenChange(false);
    } catch (e) {
      toast({ title: redeemError(e), variant: "error" });
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Canjear vale"
      description="Ingresá el código del vale para acreditar el saldo a favor."
      className="max-w-sm"
    >
      <div className="space-y-4">
        <div className="flex gap-2">
          <input
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="VAL-XXXXXXXX"
            className="h-11 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 font-mono text-sm uppercase tracking-wider outline-none focus:border-ninja-flameSoft"
            onKeyDown={(e) => {
              if (e.key === "Enter") lookup();
            }}
          />
          <Button variant="secondary" loading={looking} onClick={lookup}>
            Buscar
          </Button>
        </div>

        {lookupDone && !found && (
          <p className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
            No se encontró un vale con ese código.
          </p>
        )}

        {found && (
          <div className="rounded-lg border border-border p-4">
            <div className="flex items-center gap-2 font-mono text-base font-bold tracking-wider">
              <Ticket size={16} className="text-ninja-flameSoft" />
              {found.code}
            </div>
            <div className="mt-2 flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Saldo del vale</span>
              <span className="price-hl font-price text-lg font-black tabular-nums">
                {formatCurrency(found.amount)}
              </span>
            </div>
            {found.expires_at && (
              <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                <span>Vence</span>
                <span>{new Date(found.expires_at).toLocaleDateString("es-AR")}</span>
              </div>
            )}
            <div className="mt-2">
              <VoucherStatus status={found.status} />
            </div>
            {needsCustomer && (
              <p className="mt-2 text-xs text-warning">
                Este vale no tiene cliente. Elegí un cliente en la venta para acreditarle el saldo.
              </p>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cerrar
          </Button>
          <Button
            loading={redeem.isPending}
            disabled={!found || found.status !== "active" || needsCustomer}
            onClick={doRedeem}
          >
            <CheckCircle2 size={16} /> Canjear
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function VoucherStatus({ status }: { status: VoucherLookup["status"] }) {
  const map: Record<VoucherLookup["status"], { label: string; cls: string }> = {
    active: { label: "Disponible", cls: "bg-emerald-400/15 text-success" },
    redeemed: { label: "Ya canjeado", cls: "bg-muted text-muted-foreground" },
    void: { label: "Anulado", cls: "bg-muted text-muted-foreground" },
    expired: { label: "Vencido", cls: "bg-amber-400/15 text-warning" },
  };
  const m = map[status];
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${m.cls}`}>
      {m.label}
    </span>
  );
}

function redeemError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const map: Record<string, string> = {
    voucher_not_found: "No se encontró ese vale",
    voucher_already_redeemed: "El vale ya fue canjeado",
    voucher_void: "El vale está anulado",
    voucher_expired: "El vale está vencido",
    voucher_wrong_branch: "El vale no es válido en esta sucursal",
    voucher_needs_customer: "Elegí un cliente para acreditar el saldo",
  };
  const key = Object.keys(map).find((k) => msg.includes(k));
  return (key && map[key]) || "No se pudo canjear el vale";
}
