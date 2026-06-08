"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Minus, Plus, Search, Ticket, UserPlus } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import {
  useSaleDetail,
  useReturnSaleV2,
  useReturnReasons,
  useReturnSettings,
  useBranches,
  useSaleNumberFormat,
} from "@/modules/sales/hooks";
import { useCustomers, useCustomerMutations } from "@/modules/customers/hooks";
import { useActiveTemplate, useTicketBranding } from "@/modules/tickets/hooks";
import { defaultSaleBlocks } from "@/lib/tickets/blocks";
import { TemplateRenderer } from "@/components/tickets/TemplateRenderer";
import { Barcode, type TicketData } from "@/components/tickets/TicketRenderer";
import { STOCK_DESTINATIONS, type ReturnV2Result } from "@/modules/sales/api";
import { formatCurrency, formatQty } from "@/lib/utils/format";

type Refund = "cash" | "store_credit";

// Devolución PRO. El motivo fija el destino de stock; la política del tenant
// puede forzar el reintegro; si es vale se puede cargar un cliente al vuelo y
// limitar el vale a sucursales; el comprobante se imprime con la plantilla activa.
export function ReturnModal({
  open,
  onOpenChange,
  saleId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  saleId: string | null;
}) {
  const { toast } = useToast();
  const { data } = useSaleDetail(saleId, open);
  const { data: reasons } = useReturnReasons(true);
  const { data: settings } = useReturnSettings();
  const { data: branches } = useBranches(open);
  const ret = useReturnSaleV2();

  const [qtys, setQtys] = useState<Record<string, number>>({});
  const [reasonId, setReasonId] = useState<string>("");
  const [refundChoice, setRefundChoice] = useState<Refund>("cash");
  const [customer, setCustomer] = useState<{ id: string; name: string } | null>(null);
  const [allowedBranchIds, setAllowedBranchIds] = useState<string[]>([]);
  const [result, setResult] = useState<
    | (ReturnV2Result & {
        items: { name: string; qty: number; subtotal: number }[];
        reasonLabel: string;
      })
    | null
  >(null);

  useEffect(() => {
    if (open) {
      setQtys({});
      setReasonId("");
      setRefundChoice("cash");
      setCustomer(null);
      setAllowedBranchIds([]);
      setResult(null);
    }
  }, [open, saleId]);

  const policy = settings?.return_policy ?? "cashier_choice";
  // La política puede forzar el reintegro; si no, manda la elección del cajero.
  const effectiveRefund: Refund =
    policy === "always_credit" ? "store_credit" : policy === "always_cash" ? "cash" : refundChoice;
  const isVoucher = effectiveRefund === "store_credit";
  const multiBranch = (branches ?? []).length > 1;

  const chosenReason = (reasons ?? []).find((r) => r.id === reasonId) ?? null;
  const destMeta = chosenReason
    ? STOCK_DESTINATIONS.find((d) => d.value === chosenReason.stock_destination)
    : null;

  // Cliente del vale: el de la venta, o el cargado en este flujo.
  const saleCustomerId = data?.sale.customer_id ?? null;
  const voucherCustomerId = saleCustomerId ?? customer?.id ?? null;
  const needsCustomer = isVoucher && !voucherCustomerId;

  const total = useMemo(() => {
    if (!data) return 0;
    return data.items.reduce((acc, it) => {
      const q = qtys[it.id] ?? 0;
      const unit = it.quantity > 0 ? it.subtotal / it.quantity : it.unit_price;
      return acc + unit * q;
    }, 0);
  }, [data, qtys]);

  function setQty(itemId: string, qty: number, max: number) {
    setQtys((p) => ({ ...p, [itemId]: Math.max(0, Math.min(qty, max)) }));
  }

  async function confirm() {
    if (!saleId || !data) return;
    const items = Object.entries(qtys)
      .filter(([, q]) => q > 0)
      .map(([sale_item_id, q]) => ({ sale_item_id, quantity: q }));
    if (items.length === 0) {
      toast({ title: "Elegí al menos un ítem a devolver", variant: "error" });
      return;
    }
    if (needsCustomer) {
      toast({ title: "El vale necesita un cliente. Cargá uno abajo.", variant: "error" });
      return;
    }
    const snapshot = data.items
      .filter((it) => (qtys[it.id] ?? 0) > 0)
      .map((it) => {
        const qty = qtys[it.id] ?? 0;
        const unit = it.quantity > 0 ? it.subtotal / it.quantity : it.unit_price;
        return { name: it.product_name, qty, subtotal: unit * qty };
      });
    try {
      const res = await ret.mutateAsync({
        saleId,
        items,
        reasonId: reasonId || null,
        refund: effectiveRefund,
        customerId: voucherCustomerId,
        // Sin selección = válido en todas las sucursales (null).
        allowedBranchIds: isVoucher && allowedBranchIds.length > 0 ? allowedBranchIds : null,
      });
      toast({ title: `Devolución #${res.number} registrada`, variant: "success" });
      setResult({ ...res, items: snapshot, reasonLabel: chosenReason?.label ?? "" });
    } catch (e) {
      toast({ title: returnError(e), variant: "error" });
    }
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Devolución / cambio" className="max-w-lg">
      {!data ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Cargando…</p>
      ) : result ? (
        <ReturnResult result={result} onClose={() => onOpenChange(false)} />
      ) : (
        <div className="space-y-4">
          {/* Ítems a devolver */}
          <div className="space-y-2">
            {data.items.map((it) => {
              const available = it.quantity - (it.returned_qty ?? 0);
              const q = qtys[it.id] ?? 0;
              return (
                <div key={it.id} className="rounded-lg border border-border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{it.product_name}</div>
                      <div className="text-xs text-muted-foreground">
                        Vendido {formatQty(it.quantity)} · disponible {formatQty(available)} ·{" "}
                        {formatCurrency(it.quantity > 0 ? it.subtotal / it.quantity : it.unit_price)} c/u
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <button
                        type="button"
                        aria-label="Quitar uno"
                        className="grid h-8 w-8 place-items-center rounded-md border border-border text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
                        disabled={q <= 0}
                        onClick={() => setQty(it.id, q - 1, available)}
                      >
                        <Minus size={15} />
                      </button>
                      <input
                        className="h-8 w-12 rounded-md border border-input bg-background px-1 text-center text-sm tabular-nums outline-none focus:border-ninja-flameSoft"
                        type="number"
                        min={0}
                        max={available}
                        value={q}
                        onChange={(e) => setQty(it.id, Number(e.target.value) || 0, available)}
                      />
                      <button
                        type="button"
                        aria-label="Agregar uno"
                        className="grid h-8 w-8 place-items-center rounded-md border border-border text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
                        disabled={q >= available}
                        onClick={() => setQty(it.id, q + 1, available)}
                      >
                        <Plus size={15} />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Motivo (define destino de stock) */}
          <div>
            <span className="mb-1 block text-sm font-medium text-muted-foreground">Motivo</span>
            <select
              value={reasonId}
              onChange={(e) => setReasonId(e.target.value)}
              className="h-10 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus:border-ninja-flameSoft"
            >
              <option value="">Elegí un motivo…</option>
              {(reasons ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
            {destMeta && chosenReason && (
              <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                Destino del stock:
                <span
                  className={
                    "rounded-full px-2 py-0.5 font-medium " +
                    (chosenReason.stock_destination === "resale"
                      ? "bg-emerald-400/15 text-emerald-400"
                      : chosenReason.stock_destination === "warehouse"
                        ? "bg-sky-400/15 text-sky-400"
                        : "bg-amber-400/15 text-amber-400")
                  }
                >
                  {destMeta.label}
                </span>
                <span>· {destMeta.hint}</span>
              </p>
            )}
          </div>

          {/* Reintegro (efectivo / vale) — respeta la política del tenant */}
          <div>
            <span className="mb-1 block text-sm font-medium text-muted-foreground">Reintegro</span>
            {policy === "cashier_choice" ? (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setRefundChoice("cash")}
                  className={
                    effectiveRefund === "cash"
                      ? "flex-1 rounded-lg border border-ninja-flame bg-ninja-flame/10 px-3 py-2 text-sm font-medium"
                      : "flex-1 rounded-lg border border-border px-3 py-2 text-sm"
                  }
                >
                  Efectivo
                </button>
                <button
                  type="button"
                  onClick={() => setRefundChoice("store_credit")}
                  className={
                    effectiveRefund === "store_credit"
                      ? "flex-1 rounded-lg border border-ninja-flame bg-ninja-flame/10 px-3 py-2 text-sm font-medium"
                      : "flex-1 rounded-lg border border-border px-3 py-2 text-sm"
                  }
                >
                  Vale (saldo a favor)
                </button>
              </div>
            ) : (
              <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm">
                {policy === "always_credit" ? (
                  <span className="flex items-center gap-2">
                    <Ticket size={15} className="text-ninja-flameSoft" /> Política del negocio:{" "}
                    <strong>siempre vale</strong> (saldo a favor)
                  </span>
                ) : (
                  <span>
                    Política del negocio: <strong>siempre efectivo</strong>
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Cliente del vale (cargar al vuelo si la venta no tenía) */}
          {isVoucher && !saleCustomerId && (
            <VoucherCustomerPicker selected={customer} onSelect={setCustomer} />
          )}

          {/* Sucursales permitidas (solo multi-sucursal + vale) */}
          {isVoucher && multiBranch && (
            <div>
              <span className="mb-1 block text-sm font-medium text-muted-foreground">
                Sucursales donde vale el comprobante
              </span>
              <p className="mb-2 text-xs text-muted-foreground">
                Sin selección = válido en todas las sucursales.
              </p>
              <div className="flex flex-wrap gap-2">
                {(branches ?? []).map((b) => {
                  const on = allowedBranchIds.includes(b.id);
                  return (
                    <button
                      key={b.id}
                      type="button"
                      onClick={() =>
                        setAllowedBranchIds((p) =>
                          on ? p.filter((x) => x !== b.id) : [...p, b.id],
                        )
                      }
                      className={
                        on
                          ? "inline-flex items-center gap-1.5 rounded-full border border-ninja-flame bg-ninja-flame/10 px-3 py-1 text-sm font-medium"
                          : "inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-sm"
                      }
                    >
                      {on && <Check size={13} />}
                      {b.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Total + acciones */}
          <div className="flex items-center justify-between border-t border-border pt-3">
            <span className="text-sm text-muted-foreground">A devolver</span>
            <span className="price-hl font-price text-xl font-black tabular-nums">
              {formatCurrency(total)}
            </span>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button loading={ret.isPending} disabled={total <= 0 || needsCustomer} onClick={confirm}>
              {isVoucher ? "Devolver y emitir vale" : "Registrar devolución"}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// Selector / alta rápida de cliente para el vale cuando la venta no tenía uno.
function VoucherCustomerPicker({
  selected,
  onSelect,
}: {
  selected: { id: string; name: string } | null;
  onSelect: (c: { id: string; name: string } | null) => void;
}) {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const { data: customers } = useCustomers(search);
  const { createQuick } = useCustomerMutations();

  if (selected) {
    return (
      <div className="rounded-lg border border-emerald-400/30 bg-emerald-400/[0.06] px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2 text-sm">
            <UserPlus size={15} className="text-emerald-400" />
            Vale para <strong>{selected.name}</strong>
          </span>
          <button
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
            onClick={() => onSelect(null)}
          >
            Cambiar
          </button>
        </div>
      </div>
    );
  }

  function create() {
    if (newName.trim().length < 1) {
      toast({ title: "Poné un nombre", variant: "error" });
      return;
    }
    createQuick.mutate(
      { name: newName, phone: newPhone },
      {
        onSuccess: (c) => {
          onSelect({ id: c.id, name: c.name });
          setCreating(false);
          setNewName("");
          setNewPhone("");
        },
        onError: () => toast({ title: "No se pudo crear el cliente", variant: "error" }),
      },
    );
  }

  return (
    <div className="rounded-lg border border-amber-400/30 bg-amber-400/[0.05] p-3">
      <div className="mb-2 text-sm font-medium">El vale necesita un cliente</div>
      {creating ? (
        <div className="space-y-2">
          <Input
            placeholder="Nombre del cliente"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="h-9"
          />
          <Input
            placeholder="Teléfono (opcional)"
            value={newPhone}
            onChange={(e) => setNewPhone(e.target.value)}
            className="h-9"
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" className="h-8 px-2" onClick={() => setCreating(false)}>
              Volver
            </Button>
            <Button className="h-8 px-2" loading={createQuick.isPending} onClick={create}>
              <Plus size={14} /> Crear y usar
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="relative">
            <Search
              size={15}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar cliente…"
              className="h-9 w-full rounded-md border border-input bg-background pl-8 pr-3 text-sm outline-none focus:border-ninja-flameSoft"
            />
          </div>
          {search.trim() && (
            <div className="mt-2 max-h-40 space-y-1 overflow-y-auto">
              {(customers ?? []).slice(0, 6).map((c) => (
                <button
                  key={c.id}
                  onClick={() => onSelect({ id: c.id, name: c.name })}
                  className="flex w-full items-center justify-between rounded-md border border-border px-3 py-1.5 text-left text-sm transition hover:border-ninja-flameSoft/40 hover:bg-muted"
                >
                  <span className="truncate">{c.name}</span>
                </button>
              ))}
              {(customers ?? []).length === 0 && (
                <p className="py-2 text-center text-xs text-muted-foreground">Sin resultados.</p>
              )}
            </div>
          )}
          <button
            onClick={() => {
              setCreating(true);
              setNewName(search);
            }}
            className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-ninja-flameSoft"
          >
            <UserPlus size={15} /> Cargar nuevo cliente
          </button>
        </>
      )}
    </div>
  );
}

// Resultado: si es vale, muestra el código y el comprobante con la plantilla de
// ticket activa (no inventa layout). Imprimible.
function ReturnResult({
  result,
  onClose,
}: {
  result: ReturnV2Result & {
    items: { name: string; qty: number; subtotal: number }[];
    reasonLabel: string;
  };
  onClose: () => void;
}) {
  const { data: brand } = useTicketBranding(true);
  const { data: printTpl } = useActiveTemplate("print", true);
  const ticketRef = useRef<HTMLDivElement>(null);
  const isVoucher = result.refund === "store_credit" && Boolean(result.voucher_code);

  const fallbackBlocks = useMemo(
    () =>
      defaultSaleBlocks().filter((b) => {
        if (b.type === "qr") return brand?.ticket_show_qr === true;
        if (b.type === "logo") return brand?.ticket_show_logo !== false;
        return true;
      }),
    [brand],
  );

  // El comprobante de devolución/vale reutiliza la plantilla de ticket activa:
  // mismos encabezado/logo/pie/ancho del negocio. El "número" del comprobante es
  // el código del vale (si lo hay) o el N° de devolución.
  const ticketData: TicketData = {
    sale: {
      number: result.number,
      numberLabel: isVoucher ? (result.voucher_code as string) : `DEV #${result.number}`,
      created_at: new Date().toISOString(),
      subtotal: result.total,
      discount_total: 0,
      total: result.total,
      status: "completed",
    },
    items: result.items.map((it, i) => ({
      id: String(i),
      product_name: it.name,
      quantity: it.qty,
      unit_price: it.qty > 0 ? it.subtotal / it.qty : it.subtotal,
      subtotal: it.subtotal,
    })),
    payments: [{ id: "r", method: isVoucher ? "store_credit" : "cash", amount: result.total }],
    customer: null,
    brand: brand ?? null,
  };

  const paper =
    (printTpl?.paper as "58" | "80" | "a4" | undefined) ??
    (brand?.ticket_width === "58" ? "58" : "80");

  return (
    <div className="space-y-4">
      <div className="ticket-print" ref={ticketRef}>
        <TemplateRenderer
          template={printTpl ?? null}
          fallbackBlocks={fallbackBlocks}
          data={ticketData}
          paperOverride={paper}
        />
        {/* Panel del vale (código + vencimiento): info del vale, no un layout
            alternativo del ticket (ese lo provee la plantilla activa de arriba). */}
        {isVoucher && (
          <div className="mx-auto mt-1 max-w-[80mm] px-3 pb-3 text-center font-mono">
            <div className="border-t border-dashed border-neutral-400 pt-2 text-xs font-bold uppercase tracking-wide">
              Vale · saldo a favor
            </div>
            <div className="mt-1 text-lg font-black tracking-wider">{result.voucher_code}</div>
            <div className="mx-auto mt-1 max-w-[60mm]">
              <Barcode value={result.voucher_code as string} />
            </div>
            <div className="mt-1 text-sm font-bold">{formatCurrency(result.total)}</div>
            <div className="mt-0.5 text-[11px] text-neutral-500">
              {result.voucher_expires_at
                ? `Vence el ${new Date(result.voucher_expires_at).toLocaleDateString("es-AR")}`
                : "Sin vencimiento"}
            </div>
            <div className="text-[11px] text-neutral-500">Canjeable en el POS por su código.</div>
          </div>
        )}
      </div>

      <div className="no-print rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Total devuelto</span>
          <span className="font-semibold">{formatCurrency(result.total)}</span>
        </div>
        <div className="mt-1 flex items-center justify-between">
          <span className="text-muted-foreground">Reintegro</span>
          <span>{isVoucher ? "Vale (saldo a favor)" : "Efectivo"}</span>
        </div>
        {result.reasonLabel && (
          <div className="mt-1 flex items-center justify-between">
            <span className="text-muted-foreground">Motivo</span>
            <span>{result.reasonLabel}</span>
          </div>
        )}
      </div>

      <div className="no-print flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cerrar
        </Button>
        <Button onClick={() => window.print()}>Imprimir</Button>
      </div>
    </div>
  );
}

function returnError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const map: Record<string, string> = {
    no_open_shift: "Abrí la caja para reintegrar en efectivo",
    store_credit_needs_customer: "El vale necesita un cliente",
    sale_not_returnable: "La venta ya no es devolvible (fue anulada)",
    qty_exceeds: "La cantidad supera lo disponible; refrescá e intentá de nuevo",
    empty_return: "Elegí al menos un ítem a devolver",
    item_not_found: "Un ítem ya no existe; refrescá e intentá de nuevo",
  };
  const key = Object.keys(map).find((k) => msg.includes(k));
  return (key && map[key]) || "No se pudo registrar la devolución";
}
