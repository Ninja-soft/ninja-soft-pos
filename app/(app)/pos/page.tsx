"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Lock,
  Minus,
  Plus,
  ScanBarcode,
  Search,
  Trash2,
  Unlock,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { useToast } from "@/components/ui/Toast";
import { Isotype } from "@/components/brand/Logo";
import { useProducts } from "@/modules/products/hooks";
import {
  useCartStore,
  cartSubtotal,
  lineSubtotal,
} from "@/modules/pos/store";
import {
  useOpenShift,
  useDefaultRegister,
  usePosMutations,
} from "@/modules/pos/hooks";
import {
  OpenShiftModal,
  CloseShiftModal,
  PaymentModal,
} from "@/components/pos/PosModals";
import { TicketModal } from "@/components/sales/TicketModal";
import { BarcodeScanner } from "@/components/pos/BarcodeScanner";
import { formatCurrency, formatQty } from "@/lib/utils/format";

export default function PosPage() {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [openShiftModal, setOpenShiftModal] = useState(false);
  const [closeShiftModal, setCloseShiftModal] = useState(false);
  const [paymentModal, setPaymentModal] = useState(false);
  const [ticketId, setTicketId] = useState<string | null>(null);
  const [ticketOpen, setTicketOpen] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);

  const { data: products } = useProducts(search);
  const { data: shift } = useOpenShift();
  const { data: register } = useDefaultRegister();
  const { open, close, sale } = usePosMutations();

  const lines = useCartStore((s) => s.lines);
  const discountTotal = useCartStore((s) => s.discountTotal);
  const addProduct = useCartStore((s) => s.addProduct);
  const setQuantity = useCartStore((s) => s.setQuantity);
  const removeLine = useCartStore((s) => s.removeLine);
  const setDiscountTotal = useCartStore((s) => s.setDiscountTotal);
  const clear = useCartStore((s) => s.clear);

  const subtotal = cartSubtotal(lines);
  const total = Math.max(0, subtotal - discountTotal);
  const hasShift = Boolean(shift);

  async function handleOpenShift(opening: number) {
    if (!register) {
      toast({ title: "No hay caja configurada", variant: "error" });
      return;
    }
    try {
      await open.mutateAsync({ registerId: register.id, opening });
      setOpenShiftModal(false);
      toast({ title: "Caja abierta", variant: "success" });
    } catch (e) {
      toast({
        title: "No se pudo abrir",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  async function handleCloseShift(closing: number, notes: string) {
    if (!shift) return;
    try {
      const diff = await close.mutateAsync({ shiftId: shift.id, closing, notes });
      setCloseShiftModal(false);
      toast({
        title: "Caja cerrada",
        description: `Diferencia: ${formatCurrency(diff)}`,
        variant: diff === 0 ? "success" : "info",
      });
    } catch (e) {
      toast({
        title: "No se pudo cerrar",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  async function handleSale(payments: { method: string; amount: number }[]) {
    try {
      const res = await sale.mutateAsync({
        items: lines.map((l) => ({
          product_id: l.productId,
          quantity: l.quantity,
          unit_price: l.unitPrice,
          discount: l.discount,
        })),
        payments: payments as never,
        discountTotal,
      });
      setPaymentModal(false);
      clear();
      toast({
        title: `Venta #${res.number} registrada`,
        description: `Total ${formatCurrency(res.total)}`,
        variant: "success",
      });
      setTicketId(res.sale_id);
      setTicketOpen(true);
    } catch (e) {
      toast({
        title: "No se pudo cobrar",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  return (
    <div className="app-bg min-h-screen text-foreground">
      <header className="sticky top-0 z-40 border-b border-border bg-background/70 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
          <Link href="/dashboard" className="flex items-center gap-3">
            <Isotype className="h-7 w-auto" />
            <span className="flex items-center gap-1 text-sm text-muted-foreground">
              <ArrowLeft size={15} /> Panel
            </span>
          </Link>
          <div className="flex items-center gap-3">
            <span
              className={
                hasShift
                  ? "inline-flex items-center gap-1.5 rounded-ninjaFull border border-emerald-400/25 bg-emerald-400/10 px-3 py-1 text-xs font-semibold text-emerald-300"
                  : "inline-flex items-center gap-1.5 rounded-ninjaFull border border-border bg-muted px-3 py-1 text-xs font-semibold text-muted-foreground"
              }
            >
              {hasShift ? <Unlock size={13} /> : <Lock size={13} />}
              {hasShift ? "Caja abierta" : "Caja cerrada"}
            </span>
            {hasShift ? (
              <Button variant="secondary" size="sm" onClick={() => setCloseShiftModal(true)}>
                Cerrar caja
              </Button>
            ) : (
              <Button variant="secondary" size="sm" onClick={() => setOpenShiftModal(true)}>
                Abrir caja
              </Button>
            )}
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-7xl gap-6 px-6 py-6 lg:grid-cols-[1fr_380px]">
        {/* Búsqueda + productos */}
        <section>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search
                size={16}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar producto por nombre, SKU o código…"
                autoFocus
                className="h-12 w-full rounded-lg border border-input bg-background pl-9 pr-4 text-sm text-foreground outline-none focus:border-ninja-flameSoft focus:ring-4 focus:ring-ninja-flameSoft/15"
              />
            </div>
            <Button
              variant="secondary"
              size="icon"
              className="h-12 w-12"
              onClick={() => setScanOpen(true)}
              aria-label="Escanear código"
            >
              <ScanBarcode size={18} />
            </Button>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {products?.map((p) => (
              <button
                key={p.id}
                onClick={() =>
                  addProduct({ id: p.id, name: p.name, sku: p.sku, price: p.price })
                }
                className="rounded-ninjaLg border border-border bg-card p-4 text-left transition hover:border-ninja-flameSoft/30 hover:bg-muted"
              >
                <div className="truncate font-medium text-foreground">{p.name}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {formatQty(p.stock)} {p.unit}
                </div>
                <div className="mt-2 font-semibold text-ninja-gold">
                  {formatCurrency(p.price)}
                </div>
              </button>
            ))}
            {products?.length === 0 && (
              <p className="col-span-full py-10 text-center text-sm text-muted-foreground">
                Sin resultados.
              </p>
            )}
          </div>
        </section>

        {/* Carrito */}
        <aside className="flex h-[calc(100vh-7rem)] flex-col rounded-ninjaXl border border-border bg-card p-4">
          <h2 className="font-display text-lg font-bold">Carrito</h2>
          <div className="mt-3 flex-1 space-y-2 overflow-y-auto">
            {lines.length === 0 && (
              <p className="py-10 text-center text-sm text-muted-foreground">
                Agregá productos para vender.
              </p>
            )}
            {lines.map((l) => (
              <div
                key={l.productId}
                className="rounded-ninjaMd border border-border bg-muted/40 p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="text-sm font-medium text-foreground">{l.name}</span>
                  <button
                    onClick={() => removeLine(l.productId)}
                    className="text-muted-foreground hover:text-red-300"
                  >
                    <X size={15} />
                  </button>
                </div>
                <div className="mt-2 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setQuantity(l.productId, l.quantity - 1)}
                      className="rounded-ninjaSm border border-border p-1 hover:bg-muted"
                    >
                      <Minus size={14} />
                    </button>
                    <span className="w-8 text-center text-sm">{l.quantity}</span>
                    <button
                      onClick={() => setQuantity(l.productId, l.quantity + 1)}
                      className="rounded-ninjaSm border border-border p-1 hover:bg-muted"
                    >
                      <Plus size={14} />
                    </button>
                  </div>
                  <span className="text-sm font-semibold">
                    {formatCurrency(lineSubtotal(l))}
                  </span>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-3 space-y-2 border-t border-border pt-3">
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>Subtotal</span>
              <span>{formatCurrency(subtotal)}</span>
            </div>
            <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
              <span>Descuento</span>
              <input
                type="number"
                step="0.01"
                value={discountTotal || ""}
                onChange={(e) => setDiscountTotal(Number(e.target.value) || 0)}
                placeholder="0"
                className="h-8 w-24 rounded-ninjaSm border border-input bg-background px-2 text-right text-sm text-foreground outline-none focus:border-ninja-flameSoft"
              />
            </div>
            <div className="flex items-center justify-between pt-1">
              <span className="font-display text-lg font-bold">Total</span>
              <span className="font-mono tabular-nums text-3xl font-black text-ninja-gold">
                {formatCurrency(total)}
              </span>
            </div>
            <Button
              size="lg"
              className="w-full"
              disabled={!hasShift || lines.length === 0}
              onClick={() => setPaymentModal(true)}
            >
              {hasShift ? "Cobrar" : "Abrí la caja para vender"}
            </Button>
          </div>
        </aside>
      </main>

      <OpenShiftModal
        open={openShiftModal}
        onOpenChange={setOpenShiftModal}
        onConfirm={handleOpenShift}
        loading={open.isPending}
      />
      <CloseShiftModal
        open={closeShiftModal}
        onOpenChange={setCloseShiftModal}
        onConfirm={handleCloseShift}
        loading={close.isPending}
      />
      <PaymentModal
        open={paymentModal}
        onOpenChange={setPaymentModal}
        total={total}
        onConfirm={handleSale}
        loading={sale.isPending}
      />
      <TicketModal open={ticketOpen} onOpenChange={setTicketOpen} saleId={ticketId} />
      <BarcodeScanner
        open={scanOpen}
        onOpenChange={setScanOpen}
        onDetected={(code) => setSearch(code)}
      />
    </div>
  );
}
