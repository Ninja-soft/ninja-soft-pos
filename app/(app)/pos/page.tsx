"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Banknote,
  Lock,
  Minus,
  Plus,
  ScanBarcode,
  Search,
  Star,
  Unlock,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import {
  useProducts,
  useTopProducts,
  useProductSerials,
} from "@/modules/products/hooks";
import { useMyTenant } from "@/modules/tenants/hooks";
import { verticalHas } from "@/lib/verticals/config";
import {
  useCartStore,
  cartSubtotal,
  lineSubtotal,
} from "@/modules/pos/store";
import {
  useOpenShift,
  useDefaultRegister,
  usePosMutations,
  useMpMethod,
} from "@/modules/pos/hooks";
import { useScanner } from "@/modules/pos/useScanner";
import { QrCheckoutModal } from "@/components/pos/QrCheckoutModal";
import { productsApi } from "@/modules/products/api";
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
  const [qrOpen, setQrOpen] = useState(false);
  const [freeOpen, setFreeOpen] = useState(false);
  const [freeAmount, setFreeAmount] = useState("");
  const [freeName, setFreeName] = useState("");
  const [weighProduct, setWeighProduct] = useState<{
    id: string;
    name: string;
    sku: string | null;
    price: number;
  } | null>(null);
  const [weighGrams, setWeighGrams] = useState("");
  const [serialProduct, setSerialProduct] = useState<{
    id: string;
    name: string;
    sku: string | null;
    price: number;
  } | null>(null);
  const [serialChoice, setSerialChoice] = useState("");
  const [serialOther, setSerialOther] = useState("");
  const { data: serialList } = useProductSerials(
    serialProduct?.id ?? null,
    serialProduct !== null,
  );

  const { data: products } = useProducts(search);
  const { data: shift } = useOpenShift();
  const { data: register } = useDefaultRegister();
  const { open, close, sale } = usePosMutations();
  const { data: myTenant } = useMyTenant();
  const quickSale = verticalHas(myTenant?.industry, "quickSale");
  const { data: mp } = useMpMethod();
  const mpReady = Boolean(mp?.enabled && mp?.connected);
  const showFrequent = quickSale && !search.trim();
  const { data: topProducts } = useTopProducts(showFrequent);

  const lines = useCartStore((s) => s.lines);
  const discountTotal = useCartStore((s) => s.discountTotal);
  const addProduct = useCartStore((s) => s.addProduct);
  const addWeighed = useCartStore((s) => s.addWeighed);
  const addSerialized = useCartStore((s) => s.addSerialized);
  const addFreeAmount = useCartStore((s) => s.addFreeAmount);

  // Click en un producto: serializado abre picker de serial; por peso (kg) abre
  // modal de peso; si no, lo agrega directo.
  function pickProduct(p: {
    id: string;
    name: string;
    sku: string | null;
    price: number;
    unit: string;
    is_serialized?: boolean;
  }) {
    if (p.is_serialized) {
      setSerialProduct({ id: p.id, name: p.name, sku: p.sku, price: p.price });
      setSerialChoice("");
      setSerialOther("");
    } else if (p.unit === "kg") {
      setWeighProduct({ id: p.id, name: p.name, sku: p.sku, price: p.price });
      setWeighGrams("");
    } else {
      addProduct(p);
    }
  }

  function confirmSerial() {
    if (!serialProduct) return;
    const serial =
      serialChoice === "__other__" ? serialOther.trim() : serialChoice.trim();
    if (!serial) {
      toast({ title: "Elegí o ingresá un N° de serie", variant: "error" });
      return;
    }
    addSerialized(serialProduct, serial);
    setSerialProduct(null);
    setSerialChoice("");
    setSerialOther("");
  }

  function confirmWeigh() {
    if (!weighProduct) return;
    const grams = Number(weighGrams);
    if (!Number.isFinite(grams) || grams <= 0) {
      toast({ title: "Ingresá un peso válido", variant: "error" });
      return;
    }
    addWeighed(weighProduct, grams / 1000);
    setWeighProduct(null);
    setWeighGrams("");
  }
  const setQuantity = useCartStore((s) => s.setQuantity);
  const removeLine = useCartStore((s) => s.removeLine);
  const setDiscountTotal = useCartStore((s) => s.setDiscountTotal);
  const clear = useCartStore((s) => s.clear);

  function confirmFreeAmount() {
    const amount = Number(freeAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast({ title: "Ingresá un monto válido", variant: "error" });
      return;
    }
    addFreeAmount({ name: freeName, amount });
    setFreeAmount("");
    setFreeName("");
    setFreeOpen(false);
  }

  const subtotal = cartSubtotal(lines);
  const total = Math.max(0, subtotal - discountTotal);
  const hasShift = Boolean(shift);

  // Lector USB/Bluetooth (HID): escanea en cualquier parte del POS y agrega.
  useScanner(async (code) => {
    try {
      const p = await productsApi.findByCode(code);
      if (p) {
        pickProduct({
          id: p.id,
          name: p.name,
          sku: p.sku,
          price: p.price,
          unit: p.unit,
          is_serialized: p.is_serialized,
        });
      } else {
        setSearch(code);
        toast({ title: `Sin producto para "${code}"`, variant: "info" });
      }
    } catch {
      setSearch(code);
    }
  });

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

  async function handleSale(
    payments: { method: string; amount: number; reference?: string }[],
  ) {
    try {
      const res = await sale.mutateAsync({
        items: lines.map((l) => ({
          product_id: l.productId,
          ...(l.productId ? {} : { name: l.name }),
          ...(l.serial ? { serial: l.serial } : {}),
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
    <>
      <div className="mx-auto max-w-7xl px-6 py-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-lg font-bold tracking-tight">Punto de venta</h1>
          <div className="flex items-center gap-3">
            <span
              className={
                hasShift
                  ? "inline-flex items-center gap-1.5 rounded-full border border-emerald-400/25 bg-emerald-400/10 px-3 py-1 text-xs font-semibold text-emerald-300"
                  : "inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-3 py-1 text-xs font-semibold text-muted-foreground"
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
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        {/* Búsqueda + productos */}
        <section>
          <div className="relative">
            <Search
              size={16}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar producto por nombre, SKU o código…"
              autoFocus
              className="h-12 w-full rounded-lg border border-input bg-background pl-9 pr-12 text-sm text-foreground outline-none transition focus:border-ninja-flameSoft focus:ring-2 focus:ring-ninja-flameSoft/20"
            />
            <button
              type="button"
              onClick={() => setScanOpen(true)}
              aria-label="Escanear código"
              title="Escanear código"
              className="absolute right-1.5 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-ninja-flameSoft"
            >
              <ScanBarcode size={18} />
            </button>
          </div>

          {quickSale && (
            <Button
              type="button"
              variant="secondary"
              className="mt-3 w-full"
              onClick={() => setFreeOpen(true)}
            >
              <Banknote size={16} /> Venta rápida (monto libre)
            </Button>
          )}
          {showFrequent && topProducts && topProducts.length > 0 && (
            <div className="mt-4">
              <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <Star size={13} className="text-ninja-flameSoft" /> Frecuentes
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {topProducts.map((p) => (
                  <button
                    key={p.id}
                    onClick={() =>
                      pickProduct({
                        id: p.id,
                        name: p.name,
                        sku: p.sku,
                        price: p.price,
                        unit: p.unit,
                        is_serialized: p.is_serialized,
                      })
                    }
                    className="rounded-lg border border-ninja-flameSoft/30 bg-ninja-flame/5 p-4 text-left transition hover:border-ninja-flameSoft/50 hover:bg-ninja-flame/10"
                  >
                    <div className="truncate font-medium text-foreground">{p.name}</div>
                    <div className="mt-2 font-semibold text-foreground">
                      {formatCurrency(p.price)}
                      {p.unit === "kg" && (
                        <span className="text-xs font-normal text-muted-foreground"> /kg</span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
              <div className="mt-5 mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Todos los productos
              </div>
            </div>
          )}
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {products?.map((p) => (
              <button
                key={p.id}
                onClick={() =>
                  pickProduct({
                    id: p.id,
                    name: p.name,
                    sku: p.sku,
                    price: p.price,
                    unit: p.unit,
                    is_serialized: p.is_serialized,
                  })
                }
                className="rounded-lg border border-border bg-card p-4 text-left transition hover:border-ninja-flameSoft/30 hover:bg-muted"
              >
                <div className="truncate font-medium text-foreground">{p.name}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {formatQty(p.stock)} {p.unit}
                </div>
                <div className="mt-2 font-semibold text-foreground">
                  {formatCurrency(p.price)}
                  {p.unit === "kg" && (
                    <span className="text-xs font-normal text-muted-foreground"> /kg</span>
                  )}
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
        <aside className="flex h-[calc(100vh-7rem)] flex-col rounded-lg border border-border bg-card p-4">
          <h2 className="font-display text-lg font-bold">Carrito</h2>
          <div className="mt-3 flex-1 space-y-2 overflow-y-auto">
            {lines.length === 0 && (
              <p className="py-10 text-center text-sm text-muted-foreground">
                Agregá productos para vender.
              </p>
            )}
            {lines.map((l) => (
              <div
                key={l.lineId}
                className="rounded-lg border border-border bg-muted/40 p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-foreground">{l.name}</span>
                    {l.serial && (
                      <span className="block font-mono text-xs text-muted-foreground">
                        S/N: {l.serial}
                      </span>
                    )}
                  </span>
                  <button
                    onClick={() => removeLine(l.lineId)}
                    className="text-muted-foreground hover:text-red-300"
                  >
                    <X size={15} />
                  </button>
                </div>
                <div className="mt-2 flex items-center justify-between">
                  {l.unit === "kg" ? (
                    <span className="text-sm text-muted-foreground">
                      {formatQty(l.quantity)} kg × {formatCurrency(l.unitPrice)}/kg
                    </span>
                  ) : (
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setQuantity(l.lineId, l.quantity - 1)}
                        className="rounded-md border border-border p-1 hover:bg-muted"
                      >
                        <Minus size={14} />
                      </button>
                      <span className="w-8 text-center text-sm">{l.quantity}</span>
                      <button
                        onClick={() => setQuantity(l.lineId, l.quantity + 1)}
                        className="rounded-md border border-border p-1 hover:bg-muted"
                      >
                        <Plus size={14} />
                      </button>
                    </div>
                  )}
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
                className="h-8 w-24 rounded-md border border-input bg-background px-2 text-right text-sm text-foreground outline-none focus:border-ninja-flameSoft"
              />
            </div>
            <div className="flex items-center justify-between pt-1">
              <span className="font-display text-lg font-bold">Total</span>
              <span className="price-hl font-price tabular-nums text-3xl font-black">
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
            {mpReady && (
              <Button
                variant="secondary"
                size="lg"
                className="w-full"
                disabled={!hasShift || lines.length === 0}
                onClick={() => setQrOpen(true)}
              >
                Cobrar con QR (Mercado Pago)
              </Button>
            )}
          </div>
        </aside>
        </div>
      </div>

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
      <QrCheckoutModal
        open={qrOpen}
        onOpenChange={setQrOpen}
        amount={total}
        onApproved={(reference) => {
          setQrOpen(false);
          handleSale([{ method: "qr", amount: total, reference }]);
        }}
      />
      <TicketModal open={ticketOpen} onOpenChange={setTicketOpen} saleId={ticketId} />
      <BarcodeScanner
        open={scanOpen}
        onOpenChange={setScanOpen}
        onDetected={(code) => setSearch(code)}
      />
      <Modal open={freeOpen} onOpenChange={setFreeOpen} title="Venta rápida">
        <div className="space-y-4">
          <Input
            label="Monto"
            type="number"
            inputMode="decimal"
            step="0.01"
            autoFocus
            value={freeAmount}
            onChange={(e) => setFreeAmount(e.target.value)}
            placeholder="0"
            onKeyDown={(e) => {
              if (e.key === "Enter") confirmFreeAmount();
            }}
          />
          <Input
            label="Detalle (opcional)"
            value={freeName}
            onChange={(e) => setFreeName(e.target.value)}
            placeholder="Venta rápida"
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setFreeOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={confirmFreeAmount}>Agregar al carrito</Button>
          </div>
        </div>
      </Modal>
      <Modal
        open={weighProduct !== null}
        onOpenChange={(o) => !o && setWeighProduct(null)}
        title={weighProduct ? `Peso — ${weighProduct.name}` : "Peso"}
      >
        <div className="space-y-4">
          <Input
            label="Peso en gramos"
            type="number"
            inputMode="decimal"
            step="1"
            autoFocus
            value={weighGrams}
            onChange={(e) => setWeighGrams(e.target.value)}
            placeholder="Ej. 350"
            onKeyDown={(e) => {
              if (e.key === "Enter") confirmWeigh();
            }}
          />
          {weighProduct && Number(weighGrams) > 0 && (
            <p className="text-sm text-muted-foreground">
              {formatQty(Number(weighGrams) / 1000)} kg ×{" "}
              {formatCurrency(weighProduct.price)}/kg ={" "}
              <span className="font-semibold text-foreground">
                {formatCurrency((Number(weighGrams) / 1000) * weighProduct.price)}
              </span>
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setWeighProduct(null)}>
              Cancelar
            </Button>
            <Button onClick={confirmWeigh}>Agregar al carrito</Button>
          </div>
        </div>
      </Modal>
      <Modal
        open={serialProduct !== null}
        onOpenChange={(o) => !o && setSerialProduct(null)}
        title={serialProduct ? `N° de serie — ${serialProduct.name}` : "N° de serie"}
      >
        <div className="space-y-4">
          <div className="max-h-56 space-y-1.5 overflow-y-auto">
            {(serialList ?? [])
              .filter((s) => s.status === "in_stock")
              .map((s) => (
                <label
                  key={s.id}
                  className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted"
                >
                  <input
                    type="radio"
                    name="serial"
                    className="accent-ninja-flame"
                    checked={serialChoice === s.serial}
                    onChange={() => setSerialChoice(s.serial)}
                  />
                  <span className="font-mono">{s.serial}</span>
                </label>
              ))}
            {(serialList ?? []).filter((s) => s.status === "in_stock").length === 0 && (
              <p className="text-sm text-muted-foreground">
                Sin seriales precargados. Ingresá uno abajo.
              </p>
            )}
            <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted">
              <input
                type="radio"
                name="serial"
                className="accent-ninja-flame"
                checked={serialChoice === "__other__"}
                onChange={() => setSerialChoice("__other__")}
              />
              Otro (ingresar / escanear)
            </label>
          </div>
          {serialChoice === "__other__" && (
            <Input
              label="N° de serie"
              autoFocus
              value={serialOther}
              onChange={(e) => setSerialOther(e.target.value)}
              placeholder="IMEI / S/N"
              onKeyDown={(e) => {
                if (e.key === "Enter") confirmSerial();
              }}
            />
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setSerialProduct(null)}>
              Cancelar
            </Button>
            <Button onClick={confirmSerial}>Agregar al carrito</Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
