"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Banknote,
  Lock,
  Minus,
  MonitorSmartphone,
  Plus,
  ScanBarcode,
  Search,
  Star,
  Ticket,
  User,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { InfoHint } from "@/components/ui/InfoHint";
import { useToast } from "@/components/ui/Toast";
import {
  useProducts,
  useTopProducts,
  useFavoriteProducts,
  useProductSerials,
  useCategories,
  useWarrantyPlans,
} from "@/modules/products/hooks";
import { useMyTenant } from "@/modules/tenants/hooks";
import {
  useCustomers,
  useStoreCreditBalance,
  useCustomerMutations,
} from "@/modules/customers/hooks";
import { DniScanModal } from "@/components/customers/DniScanModal";
import type { ParsedDni } from "@/lib/customers/dniParse";
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
  useProviderMethod,
  usePosSettings,
} from "@/modules/pos/hooks";
import { useScanner } from "@/modules/pos/useScanner";
import { useFeature } from "@/modules/saas/gating";
import { useFeatureGate } from "@/components/saas/GatedAction";
import { QrCheckoutModal } from "@/components/pos/QrCheckoutModal";
import { VariantPickerModal } from "@/components/pos/VariantPickerModal";
import { ModifierPickerModal } from "@/components/pos/ModifierPickerModal";
import { WarrantyOfferCard } from "@/components/pos/WarrantyOfferCard";
import { useProductsWithModifiers } from "@/modules/products/modifiers";
import { productsApi, variantLabel } from "@/modules/products/api";
import { CategoryNav, subtreeIds } from "@/components/pos/CategoryNav";
import { FavoritesGrid } from "@/components/pos/FavoritesGrid";
import type { Product } from "@/modules/products/api";
import { useMostradorPricing } from "@/modules/prices/hooks";
import { resolvePrice } from "@/lib/prices/resolve";
import {
  OpenShiftModal,
  CloseShiftModal,
  PaymentModal,
} from "@/components/pos/PosModals";
import { TicketModal } from "@/components/sales/TicketModal";
import { VoucherRedeemModal } from "@/components/pos/VoucherRedeemModal";
import { BarcodeScanner } from "@/components/pos/BarcodeScanner";
import { useTicketBranding } from "@/modules/tickets/hooks";
import {
  publishDisplayState,
  type DisplayBranding,
  type DisplayQr,
  type DisplayState,
} from "@/lib/pos/customerDisplay";
import { formatCurrency, formatQty } from "@/lib/utils/format";

export default function PosPage() {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [openShiftModal, setOpenShiftModal] = useState(false);
  const [closeShiftModal, setCloseShiftModal] = useState(false);
  const [paymentModal, setPaymentModal] = useState(false);
  // Plan de garantía extendida pre-seleccionado por la oferta contextual (H28).
  // Se pasa a PaymentModal para que entre como línea (mecanismo existente).
  const [offeredWarrantyId, setOfferedWarrantyId] = useState("");
  const [ticketId, setTicketId] = useState<string | null>(null);
  const [ticketOpen, setTicketOpen] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [qrMobbexOpen, setQrMobbexOpen] = useState(false);
  const [qrModoOpen, setQrModoOpen] = useState(false);
  // Preferencia por dispositivo: auto-imprimir el ticket al cobrar.
  const [autoPrint, setAutoPrint] = useState(false);
  useEffect(() => {
    setAutoPrint(localStorage.getItem("pos_auto_print") === "1");
  }, []);
  useEffect(() => {
    localStorage.setItem("pos_auto_print", autoPrint ? "1" : "0");
  }, [autoPrint]);
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
    warrantyMonths?: number;
  } | null>(null);
  const [serialChoice, setSerialChoice] = useState("");
  const [serialOther, setSerialOther] = useState("");
  const [variantProduct, setVariantProduct] = useState<{
    id: string;
    name: string;
    sku: string | null;
    price: number;
    warrantyMonths?: number;
  } | null>(null);
  // Producto con modificadores (H37) pendiente de elegir opciones en el picker.
  const [modifierProduct, setModifierProduct] = useState<{
    id: string;
    name: string;
    sku: string | null;
    price: number;
    warrantyMonths?: number;
  } | null>(null);
  // IDs de productos del tenant que tienen modificadores → rutean al picker.
  const { data: withMods } = useProductsWithModifiers();
  const { data: serialList } = useProductSerials(
    serialProduct?.id ?? null,
    serialProduct !== null,
  );

  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const { data: categories } = useCategories();
  // El filtro por categoría es por sub-árbol (la categoría + sus descendientes):
  // elegir un rubro padre muestra también los productos de sus sub-rubros. Se
  // resuelve en cliente, así que la query al server va sin categoría.
  const { data: allProducts } = useProducts(search);
  const products = useMemo(() => {
    if (!categoryFilter) return allProducts;
    const ids = subtreeIds(categories ?? [], categoryFilter);
    return (allProducts ?? []).filter(
      (p) => p.category_id && ids.has(p.category_id),
    );
  }, [allProducts, categories, categoryFilter]);
  // Ruta "Rubro › Sub-rubro › …" de la categoría activa, para el encabezado de
  // la grilla de productos (da contexto al filtrar profundo).
  const categoryPath = useMemo(() => {
    if (!categoryFilter) return null;
    const byId = new Map((categories ?? []).map((c) => [c.id, c]));
    const parts: string[] = [];
    let cur: string | null = categoryFilter;
    while (cur) {
      const c = byId.get(cur);
      if (!c) break;
      parts.unshift(c.name);
      cur = c.parent_id;
    }
    return parts.length ? parts.join(" › ") : null;
  }, [categories, categoryFilter]);
  const { data: shift } = useOpenShift();
  const { data: register } = useDefaultRegister();
  const { open, close, sale } = usePosMutations();
  const { data: myTenant } = useMyTenant();
  const quickSale = verticalHas(myTenant?.industry, "quickSale");
  const { data: mp } = useMpMethod();
  // El plan debe permitir el medio (gating real, espejo del backend). Sin la
  // feature, además de ocultar el botón, la Edge de QR rechaza la creación del
  // cobro. `!== false` = optimista mientras carga el gating.
  const mpFeature = useFeature("mercado_pago");
  const mobbexFeature = useFeature("mobbex");
  const modoFeature = useFeature("modo");
  // Descuentos manuales en la venta es feature de plan (Pro). Sin ella, el campo
  // de descuento queda bloqueado y al tocarlo se abre el UpgradeModal.
  const discountGate = useFeatureGate("descuentos", "Descuentos");
  const mpReady = Boolean(mp?.enabled && mp?.connected && mpFeature !== false);
  const { data: mobbex } = useProviderMethod("mobbex");
  const mobbexReady = Boolean(mobbex?.enabled && mobbex?.connected && mobbexFeature !== false);
  const { data: modo } = useProviderMethod("modo");
  const modoReady = Boolean(modo?.enabled && modo?.connected && modoFeature !== false);
  const { data: posSettings } = usePosSettings();
  // Oferta contextual de garantía (H28): planes activos del tenant + flag para
  // des/activar la oferta automática (Configuración → Operación). Default on.
  const { data: warrantyPlans } = useWarrantyPlans(true);
  const offerWarranty = posSettings?.offerWarranty ?? true;
  const role = myTenant?.role ?? "cashier";
  // Venta libre (monto manual · H36): habilitada por flag del negocio
  // (pos_settings.allow_free_sale) Y sólo para owner/manager. Un cashier sin
  // permiso no ve el botón. Default del flag = true.
  const allowFreeSale = posSettings?.allowFreeSale ?? true;
  const canFreeSale = allowFreeSale && (role === "owner" || role === "manager");
  const maxDiscPct = posSettings?.maxDiscount?.[role] ?? 100;
  const rounding = posSettings?.rounding ?? 0;
  const requireCustomer = posSettings?.requireCustomer ?? false;
  const [customer, setCustomer] = useState<{ id: string; name: string } | null>(null);
  const [custOpen, setCustOpen] = useState(false);
  const [dniOpen, setDniOpen] = useState(false);
  const [voucherOpen, setVoucherOpen] = useState(false);
  const [custSearch, setCustSearch] = useState("");
  const { data: customers } = useCustomers(custSearch);
  const { createQuick } = useCustomerMutations();

  // Alta rápida de cliente desde el DNI escaneado (H31): crea un cliente mínimo
  // con nombre + documento (DNI) y lo selecciona para la venta. El cajero ya
  // confirmó los datos en la validación visual del DniScanModal.
  async function quickAddFromDni(d: ParsedDni) {
    try {
      const created = await createQuick.mutateAsync({
        name: d.nombreCompleto,
        document_type: "dni",
        document_number: d.dni,
      });
      setCustomer({ id: created.id, name: created.name });
      setDniOpen(false);
      setCustOpen(false);
      toast({ title: `Cliente ${created.name} agregado`, variant: "success" });
    } catch (e) {
      toast({
        title: "No se pudo crear el cliente",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }
  const { data: scBalance } = useStoreCreditBalance(customer?.id);
  const showFrequent = quickSale && !search.trim();
  const { data: topProducts } = useTopProducts(showFrequent);
  // Favoritos (H36): botones rápidos grandes arriba de la grilla. Se muestran
  // cuando no se está buscando ni filtrando por categoría (pantalla de cobro
  // rápido sin búsqueda). Independiente del rubro: si hay favoritos, aparecen.
  const showFavorites = !search.trim() && !categoryFilter;
  const { data: favorites } = useFavoriteProducts(showFavorites);

  // ----- Pantalla del cliente / doble pantalla (F10 · H25) -----
  // Branding del negocio (logo + nombre + acento) para la pantalla del cliente.
  const { data: dispBranding } = useTicketBranding();
  // QR de cobro activo (lo reporta el QrCheckoutModal abierto). Cuando hay uno, la
  // pantalla del cliente muestra el QR + monto en vez de los totales.
  const [displayQr, setDisplayQr] = useState<DisplayQr | null>(null);
  const handleQrState = useCallback((qr: DisplayQr | null) => setDisplayQr(qr), []);
  // Snapshot de la última venta cobrada → pantalla "Pago recibido" + vuelto.
  // Mientras está seteado, la pantalla del cliente muestra el agradecimiento;
  // un timeout lo limpia y la pantalla vuelve a idle.
  const [paidView, setPaidView] = useState<{ change: number } | null>(null);
  const paidTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const displayBranding = useMemo<DisplayBranding>(
    () => ({
      businessName: dispBranding?.legal_name ?? null,
      logoUrl: dispBranding?.logo_url ?? null,
      accent: dispBranding?.accent ?? null,
      registerLabel: register?.name ?? null,
      welcomeMessage: posSettings?.displayWelcomeMessage ?? null,
      thanksMessage: posSettings?.displayThanksMessage ?? null,
      showUnitPrices: posSettings?.displayShowUnitPrices ?? true,
    }),
    [dispBranding, register?.name, posSettings],
  );

  const lines = useCartStore((s) => s.lines);
  const discountTotal = useCartStore((s) => s.discountTotal);
  const addProduct = useCartStore((s) => s.addProduct);
  const addWeighed = useCartStore((s) => s.addWeighed);
  const addSerialized = useCartStore((s) => s.addSerialized);
  const addVariant = useCartStore((s) => s.addVariant);
  const addWithModifiers = useCartStore((s) => s.addWithModifiers);
  const addFreeAmount = useCartStore((s) => s.addFreeAmount);

  // Lista de precios 'mostrador' activa (si existe): el precio unitario al
  // agregar al carrito se resuelve contra esta lista. Sin lista → precio base.
  const { data: mostrador } = useMostradorPricing();
  // basePrice = price_override de la variante (si aplica) ya resuelto por el
  // caller. Devuelve el precio efectivo de mostrador.
  function priceFor(
    productId: string,
    variantId: string | null,
    basePrice: number,
  ): number {
    return resolvePrice(
      basePrice,
      productId,
      variantId,
      mostrador?.list ?? null,
      mostrador?.items ?? [],
    );
  }

  // Click en un producto: serializado abre picker de serial; por peso (kg) abre
  // modal de peso; si no, lo agrega directo (precio resuelto por la lista mostrador).
  // `warranty_months` (garantía de fábrica) viaja a la línea para la oferta
  // contextual de garantía extendida (H28).
  function pickProduct(p: {
    id: string;
    name: string;
    sku: string | null;
    price: number;
    unit: string;
    is_serialized?: boolean;
    has_variants?: boolean;
    warranty_months?: number;
  }) {
    if (p.has_variants) {
      setVariantProduct({
        id: p.id,
        name: p.name,
        sku: p.sku,
        price: p.price,
        warrantyMonths: p.warranty_months ?? 0,
      });
    } else if (p.is_serialized) {
      setSerialProduct({
        id: p.id,
        name: p.name,
        sku: p.sku,
        price: p.price,
        warrantyMonths: p.warranty_months ?? 0,
      });
      setSerialChoice("");
      setSerialOther("");
    } else if (withMods?.has(p.id)) {
      // H37: producto con modificadores (tamaños/sabores/toppings) → picker. El
      // precio base se resuelve por la lista mostrador; el picker suma los deltas.
      setModifierProduct({
        id: p.id,
        name: p.name,
        sku: p.sku,
        price: priceFor(p.id, null, p.price),
        warrantyMonths: p.warranty_months ?? 0,
      });
    } else if (p.unit === "kg") {
      setWeighProduct({
        id: p.id,
        name: p.name,
        sku: p.sku,
        price: priceFor(p.id, null, p.price),
      });
      setWeighGrams("");
    } else {
      addProduct({
        ...p,
        price: priceFor(p.id, null, p.price),
        warrantyMonths: p.warranty_months ?? 0,
      });
    }
  }

  // ----- Favoritos / cantidades rápidas (H36) -----
  // Tap del botón favorito: rutea por tipo (serial/variante/peso) o agrega 1.
  function favTap(p: Product) {
    pickProduct({
      id: p.id,
      name: p.name,
      sku: p.sku,
      price: p.price,
      unit: p.unit,
      is_serialized: p.is_serialized,
      has_variants: p.has_variants,
      warranty_months: p.warranty_months ?? undefined,
    });
  }
  // Cantidad rápida (×2/×6/×12) para un favorito por unidad simple: suma qty de
  // un toque. El precio se resuelve contra la lista mostrador.
  function favQuickUnits(p: Product, qty: number) {
    addProduct(
      {
        id: p.id,
        name: p.name,
        sku: p.sku,
        price: priceFor(p.id, null, p.price),
        unit: p.unit,
        warrantyMonths: p.warranty_months ?? 0,
      },
      qty,
    );
  }
  // Peso rápido (½ kg / 1 kg) para un favorito por peso.
  function favQuickWeight(p: Product, kg: number) {
    addWeighed(
      { id: p.id, name: p.name, sku: p.sku, price: priceFor(p.id, null, p.price) },
      kg,
    );
  }

  function confirmSerial() {
    if (!serialProduct) return;
    const serial =
      serialChoice === "__other__" ? serialOther.trim() : serialChoice.trim();
    if (!serial) {
      toast({ title: "Elegí o ingresá un N° de serie", variant: "error" });
      return;
    }
    addSerialized(
      { ...serialProduct, price: priceFor(serialProduct.id, null, serialProduct.price) },
      serial,
    );
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

  // Si ya no queda un producto elegible en el carrito (se quitó el ítem con
  // garantía), descartá la garantía pre-seleccionada para que no se cobre sola.
  const hasEligibleWarranty = lines.some((l) => (l.warrantyMonths ?? 0) > 0);
  useEffect(() => {
    if (!hasEligibleWarranty && offeredWarrantyId) setOfferedWarrantyId("");
  }, [hasEligibleWarranty, offeredWarrantyId]);

  const subtotal = cartSubtotal(lines);
  const rawTotal = Math.max(0, subtotal - discountTotal);
  // Redondeo del total al múltiplo configurado (H30). El server reaplica el
  // mismo redondeo de forma autoritativa en create_sale.
  const total = rounding > 0 ? Math.round(rawTotal / rounding) * rounding : rawTotal;
  const hasShift = Boolean(shift);

  // Publica el estado a la pantalla del cliente (H25) en cada cambio relevante.
  // Prioridad de fase: pago recibido (paidView) > cobro QR activo (displayQr) >
  // carrito con ítems > idle. El payload solo lleva datos de la venta en curso.
  useEffect(() => {
    const phase: DisplayState["phase"] = paidView
      ? "paid"
      : displayQr
        ? "paying"
        : lines.length > 0
          ? "cart"
          : "idle";
    publishDisplayState({
      v: 1,
      phase,
      branding: displayBranding,
      lines: lines.map((l) => ({
        lineId: l.lineId,
        name: l.name,
        variantLabel: l.variantLabel ?? null,
        unit: l.unit,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        lineTotal: lineSubtotal(l),
      })),
      subtotal,
      discountTotal,
      total,
      change: paidView?.change ?? 0,
      qr: displayQr,
      at: Date.now(),
    });
  }, [lines, subtotal, discountTotal, total, displayBranding, displayQr, paidView]);

  // Tope de descuento por rol (H30): no se puede pasar del máximo del rol.
  function handleDiscountChange(value: number) {
    const max = (subtotal * maxDiscPct) / 100;
    if (value > max + 0.001) {
      setDiscountTotal(Math.max(0, Math.floor(max)));
      toast({
        title: `Descuento máximo ${maxDiscPct}% para tu rol`,
        variant: "error",
      });
    } else {
      setDiscountTotal(Math.max(0, value));
    }
  }

  // Lector USB/Bluetooth (HID): escanea en cualquier parte del POS y agrega.
  useScanner(async (code) => {
    try {
      const res = await productsApi.findByCode(code);
      if (res) {
        const { product: p, variant } = res;
        if (variant) {
          // Barcode/SKU de variante: agrega directo, sin abrir el picker. El
          // precio base de la variante (override o padre) se resuelve por la
          // lista mostrador.
          addVariant({
            id: p.id,
            name: p.name,
            sku: variant.sku ?? p.sku,
            price: priceFor(p.id, variant.id, variant.price_override ?? p.price),
            variantId: variant.id,
            variantLabel: variantLabel(variant),
            warrantyMonths: p.warranty_months ?? 0,
          });
        } else {
          pickProduct({
            id: p.id,
            name: p.name,
            sku: p.sku,
            price: p.price,
            unit: p.unit,
            is_serialized: p.is_serialized,
            has_variants: p.has_variants,
            warranty_months: p.warranty_months,
          });
        }
      } else {
        setSearch(code);
        toast({ title: `Sin producto para "${code}"`, variant: "info" });
      }
    } catch {
      setSearch(code);
    }
  }, {
    prefix: posSettings?.scannerPrefix ?? "",
    suffix: posSettings?.scannerSuffix ?? "",
    beep: posSettings?.scannerBeep ?? true,
    dupMs: posSettings?.scannerDupMs ?? 1500,
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
      const msg = e instanceof Error ? e.message : undefined;
      toast({
        title:
          msg && msg.includes("close_needs_reason")
            ? "Escribí un motivo: la diferencia supera la tolerancia"
            : "No se pudo cerrar",
        description:
          msg && msg.includes("close_needs_reason") ? undefined : msg,
        variant: "error",
      });
    }
  }

  // Muestra "Pago recibido ✓ / ¡Gracias!" (+ vuelto) en la pantalla del cliente
  // unos segundos y luego vuelve a idle (H25). Cancela cualquier timer previo.
  function flashPaidScreen(change: number) {
    if (paidTimer.current) clearTimeout(paidTimer.current);
    setPaidView({ change: Math.max(0, change || 0) });
    paidTimer.current = setTimeout(() => setPaidView(null), 6000);
  }
  useEffect(() => () => {
    if (paidTimer.current) clearTimeout(paidTimer.current);
  }, []);

  async function handleSale(
    payments: {
      method: string;
      amount: number;
      reference?: string;
      // Voucher de tarjeta (H27): lote/cupón/autorización. create_sale lo persiste.
      card_voucher?: { lote: string; cupon: string; autorizacion: string };
    }[],
    extras?: { name: string; amount: number; kind?: "warranty" | "surcharge" }[],
    change?: number,
  ) {
    try {
      const items = lines.map((l) => ({
        product_id: l.productId,
        ...(l.productId ? {} : { name: l.name }),
        ...(l.serial ? { serial: l.serial } : {}),
        ...(l.variantId ? { variant_id: l.variantId } : {}),
        // Modificadores (H37): snapshot por línea; el precio ya está en unit_price.
        ...(l.modifiers && l.modifiers.length > 0 ? { modifiers: l.modifiers } : {}),
        quantity: l.quantity,
        unit_price: l.unitPrice,
        discount: l.discount,
      }));
      // Extras del cobro (recargo H27, garantía extendida H28): cada uno entra
      // como ítem de venta para que el total y el ticket lo reflejen.
      for (const ex of extras ?? []) {
        if (ex.amount > 0) {
          items.push({
            product_id: null,
            name: ex.name,
            quantity: 1,
            unit_price: ex.amount,
            discount: 0,
          } as never);
        }
      }
      // Señal de gating server-side: la prima de garantía (kind='warranty') se
      // valida contra la feature 'garantias' en create_sale. Los recargos
      // (kind='surcharge') no se gatean. El importe ya va como ítem (arriba).
      const saleExtras = (extras ?? [])
        .filter((ex) => ex.amount > 0 && ex.kind)
        .map((ex) => ({ kind: ex.kind as "warranty" | "surcharge", amount: ex.amount }));
      const res = await sale.mutateAsync({
        items: items as never,
        payments: payments as never,
        discountTotal,
        customerId: customer?.id ?? null,
        extras: saleExtras,
      });
      setPaymentModal(false);
      clear();
      setCustomer(null);
      setOfferedWarrantyId("");
      // Pantalla del cliente (H25): "Pago recibido" + vuelto (efectivo).
      flashPaidScreen(change ?? 0);
      toast({
        title: `Venta #${res.number} registrada`,
        description: `Total ${formatCurrency(res.total)}`,
        variant: "success",
      });
      setTicketId(res.sale_id);
      setTicketOpen(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      const title = msg.includes("feature_not_in_plan: descuentos")
        ? "Los descuentos no están incluidos en tu plan"
        : msg.includes("feature_not_in_plan: garantias")
          ? "La garantía extendida no está incluida en tu plan"
          : msg.includes("feature_not_in_plan: cuenta_corriente")
            ? "La cuenta corriente no está incluida en tu plan"
            : msg.includes("credit_limit_exceeded")
              ? "Supera el límite de cuenta corriente del cliente"
              : msg.includes("account_needs_customer")
                ? "La cuenta corriente necesita un cliente"
                : msg.includes("insufficient_store_credit")
                  ? "El cliente no tiene saldo de vale suficiente"
                  : "No se pudo cobrar";
      toast({
        title,
        description: title === "No se pudo cobrar" ? msg || undefined : undefined,
        variant: "error",
      });
    }
  }

  // Si el negocio exige cliente, bloquea el cobro hasta elegir uno.
  function ensureCustomer(): boolean {
    if (requireCustomer && !customer) {
      toast({ title: "Elegí un cliente para esta venta", variant: "error" });
      setCustOpen(true);
      return false;
    }
    return true;
  }

  // Abre la pantalla del cliente (H25) en una ventana nueva, lista para arrastrar
  // al 2do monitor. Limitación del navegador: no se puede posicionar la ventana
  // en otro monitor ni forzar fullscreen sin gesto del usuario; el cajero la
  // mueve y la pone en pantalla completa (F11). La ventana se sincroniza sola
  // (BroadcastChannel/localStorage). Se publica el estado actual al abrir.
  function openCustomerDisplay() {
    window.open("/customer-display", "ninja-customer-display", "noopener");
  }

  return (
    <>
      <div className="mx-auto max-w-7xl px-6 py-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h1 className="flex items-center gap-2 text-lg font-bold tracking-tight">
            Punto de venta
            <InfoHint section="pos" />
          </h1>
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={openCustomerDisplay}
              title="Abrir la pantalla del cliente en otra ventana (arrastrala al 2do monitor)"
            >
              <MonitorSmartphone size={16} /> Pantalla cliente
            </Button>
            <span
              className={
                hasShift
                  ? "inline-flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-lg border border-emerald-400/30 px-3 text-sm font-medium text-emerald-300"
                  : "inline-flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-lg border border-border px-3 text-sm font-medium text-muted-foreground"
              }
            >
              <span
                className={
                  hasShift
                    ? "h-2 w-2 shrink-0 rounded-full bg-emerald-400"
                    : "h-2 w-2 shrink-0 rounded-full bg-muted-foreground/50"
                }
              />
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
              onChange={(e) => { setSearch(e.target.value); setCategoryFilter(null); }}
              placeholder="Buscar por nombre, PLU, SKU o código…"
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

          {/* Venta libre (H36): monto manual + concepto. Sólo owner/manager y si
              el negocio la habilita (pos_settings.allow_free_sale). Un cashier
              sin permiso no ve el botón. */}
          {canFreeSale && (
            <Button
              type="button"
              variant="secondary"
              className="mt-3 w-full"
              onClick={() => setFreeOpen(true)}
            >
              <Banknote size={16} /> Venta libre (monto manual)
            </Button>
          )}
          {/* Navegador de categorías: raíces como pestañas + drill-down a
              sub-categorías (filtra por sub-árbol). Disponible para cualquier
              rubro que tenga categorías cargadas. */}
          {!search.trim() && (categories ?? []).length > 0 && (
            <div className="mt-3">
              <CategoryNav
                categories={categories ?? []}
                selected={categoryFilter}
                onSelect={setCategoryFilter}
              />
            </div>
          )}

          {/* Grilla táctil de favoritos (H36): botones grandes para cobrar sin
              buscar. Tap = agrega 1 (o abre serial/variante/peso); chips de
              cantidad rápida ×2/×6/×12 o ½/1 kg. */}
          {showFavorites && (
            <FavoritesGrid
              products={favorites ?? []}
              onTap={favTap}
              onQuickUnits={favQuickUnits}
              onQuickWeight={favQuickWeight}
            />
          )}

          {showFrequent && !categoryFilter && topProducts && topProducts.length > 0 && (
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
                        has_variants: p.has_variants,
                        warranty_months: p.warranty_months,
                      })
                    }
                    className="rounded-lg border border-ninja-flameSoft/30 bg-ninja-flame/5 p-4 text-left transition hover:border-ninja-flameSoft/50 hover:bg-ninja-flame/10"
                  >
                    <div className="flex items-start justify-between gap-1.5">
                      <div className="truncate font-medium text-foreground">{p.name}</div>
                      {p.has_variants && (
                        <span className="shrink-0 rounded-full bg-ninja-flame/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ninja-flameSoft">
                          Variantes
                        </span>
                      )}
                    </div>
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
                {categoryPath ?? "Todos los productos"}
              </div>
            </div>
          )}
          {!(showFrequent && !categoryFilter) && categoryPath && (
            <div className="mt-3 mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {categoryPath}
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
                    has_variants: p.has_variants,
                    warranty_months: p.warranty_months,
                  })
                }
                className="rounded-lg border border-border bg-card p-4 text-left transition hover:border-ninja-flameSoft/30 hover:bg-muted"
              >
                <div className="flex items-start justify-between gap-1.5">
                  <div className="truncate font-medium text-foreground">{p.name}</div>
                  {p.has_variants && (
                    <span className="shrink-0 rounded-full bg-ninja-flame/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ninja-flameSoft">
                      Variantes
                    </span>
                  )}
                </div>
                <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                  <span>
                    {formatQty(p.stock)} {p.unit}
                  </span>
                  {p.plu && (
                    <span className="rounded bg-ninja-flame/10 px-1.5 py-0.5 font-mono font-semibold text-ninja-flameSoft">
                      {p.plu}
                    </span>
                  )}
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
                    {l.variantLabel && (
                      <span className="block text-xs font-medium text-ninja-flameSoft">
                        {l.variantLabel}
                      </span>
                    )}
                    {l.serial && (
                      <span className="block font-mono text-xs text-muted-foreground">
                        S/N: {l.serial}
                      </span>
                    )}
                    {l.modifiersLabel && (
                      <span className="block text-xs text-muted-foreground">
                        {l.modifiersLabel}
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
                {/* Cantidades rápidas en la línea (H36): suma de un toque sin
                    teclear. Sólo para ítems por unidad (los de peso usan kg). */}
                {l.unit !== "kg" && (
                  <div className="mt-2 flex gap-1.5">
                    {[2, 6, 12].map((q) => (
                      <button
                        key={q}
                        type="button"
                        onClick={() => setQuantity(l.lineId, l.quantity + q)}
                        title={`Sumar ${q}`}
                        className="rounded-md border border-border bg-card px-2 py-1 text-xs font-semibold text-muted-foreground transition active:scale-95 hover:border-ninja-flameSoft/50 hover:text-ninja-flameSoft"
                      >
                        +{q}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="mt-3 space-y-2 border-t border-border pt-3">
            {/* Oferta contextual de garantía extendida (H28): aparece cuando hay
                un producto con garantía de fábrica en el carrito. Descartable. */}
            {offerWarranty && (
              <WarrantyOfferCard
                lines={lines}
                plans={warrantyPlans ?? []}
                base={rawTotal}
                selectedWarrantyId={offeredWarrantyId}
                onSelect={setOfferedWarrantyId}
              />
            )}
            {/* Cliente de la venta */}
            <button
              type="button"
              onClick={() => setCustOpen(true)}
              className={
                requireCustomer && !customer
                  ? "flex w-full items-center justify-between rounded-lg border border-ninja-flameSoft/50 bg-ninja-flame/5 px-3 py-2 text-sm"
                  : "flex w-full items-center justify-between rounded-lg border border-border px-3 py-2 text-sm"
              }
            >
              <span className="flex items-center gap-2 truncate">
                <User size={14} className="shrink-0 text-muted-foreground" />
                <span className="truncate">{customer ? customer.name : "Consumidor final"}</span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                {customer && (scBalance ?? 0) > 0 && (
                  <span className="rounded-full bg-emerald-400/15 px-2 py-0.5 text-xs font-semibold text-emerald-400">
                    vale {formatCurrency(scBalance ?? 0)}
                  </span>
                )}
                <span className="text-xs font-medium text-ninja-flameSoft">
                  {customer ? "Cambiar" : requireCustomer ? "Elegir (obligatorio)" : "Elegir"}
                </span>
              </span>
            </button>
            {/* Canje de vale por código → acredita saldo a favor del cliente */}
            <button
              type="button"
              onClick={() => setVoucherOpen(true)}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:border-ninja-flameSoft/40 hover:text-ninja-flameSoft"
            >
              <Ticket size={13} /> Canjear vale
            </button>
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>Subtotal</span>
              <span>{formatCurrency(subtotal)}</span>
            </div>
            <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
              <span className="flex items-center gap-1.5">
                Descuento
                {discountGate.locked && (
                  <Lock size={12} className="text-ninja-flameSoft" />
                )}
              </span>
              {discountGate.locked ? (
                <button
                  type="button"
                  onClick={() => discountGate.run(() => {})}
                  title="Descuentos: función no incluida en tu plan"
                  className="h-8 w-24 rounded-md border border-input bg-muted/40 px-2 text-right text-sm text-muted-foreground/60 outline-none"
                >
                  0
                </button>
              ) : (
                <input
                  type="number"
                  step="0.01"
                  value={discountTotal || ""}
                  onChange={(e) => handleDiscountChange(Number(e.target.value) || 0)}
                  placeholder="0"
                  className="h-8 w-24 rounded-md border border-input bg-background px-2 text-right text-sm text-foreground outline-none focus:border-ninja-flameSoft"
                />
              )}
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
              onClick={() => ensureCustomer() && setPaymentModal(true)}
            >
              {hasShift ? "Cobrar" : "Abrí la caja para vender"}
            </Button>
            {mpReady && (
              <button
                type="button"
                disabled={!hasShift || lines.length === 0}
                onClick={() => ensureCustomer() && setQrOpen(true)}
                className="flex w-full items-center justify-center gap-2.5 rounded-xl border border-[#009ee3]/40 bg-[#009ee3]/10 px-4 py-3 font-semibold text-[#0b69b4] transition hover:bg-[#009ee3]/20 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-md bg-white">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src="/img/medios_de_pago/mercado_pago_cube.webp"
                    alt="Mercado Pago"
                    className="h-full w-full object-contain p-0.5"
                  />
                </span>
                Cobrar con QR · Mercado Pago
              </button>
            )}
            {mobbexReady && (
              <button
                type="button"
                disabled={!hasShift || lines.length === 0}
                onClick={() => ensureCustomer() && setQrMobbexOpen(true)}
                className="flex w-full items-center justify-center gap-2.5 rounded-xl border border-ninja-brightViolet/40 bg-ninja-brightViolet/10 px-4 py-3 font-semibold text-ninja-lavender transition hover:bg-ninja-brightViolet/20 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-md">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src="/img/medios_de_pago/Mobbex_cube.webp"
                    alt="Mobbex"
                    className="h-full w-full object-contain"
                  />
                </span>
                Cobrar con QR · Mobbex
              </button>
            )}
            {modoReady && (
              <button
                type="button"
                disabled={!hasShift || lines.length === 0}
                onClick={() => ensureCustomer() && setQrModoOpen(true)}
                className="flex w-full items-center justify-center gap-2.5 rounded-xl border border-[#00d1c1]/40 bg-[#00d1c1]/10 px-4 py-3 font-semibold text-[#0bb5a8] transition hover:bg-[#00d1c1]/20 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-md">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src="/img/medios_de_pago/Modo_cube.webp"
                    alt="MODO"
                    className="h-full w-full object-contain"
                  />
                </span>
                Cobrar con QR · MODO
              </button>
            )}
            <label className="flex cursor-pointer items-center justify-between gap-2 pt-1 text-xs text-muted-foreground">
              <span>Imprimir ticket al cobrar</span>
              <Switch
                checked={autoPrint}
                onCheckedChange={setAutoPrint}
                label="Imprimir ticket al cobrar"
              />
            </label>
          </div>
        </aside>
        </div>
      </div>

      <Modal open={custOpen} onOpenChange={setCustOpen} title="Cliente de la venta">
        <div className="space-y-3">
          <Input
            placeholder="Buscar por nombre, documento…"
            value={custSearch}
            onChange={(e) => setCustSearch(e.target.value)}
            autoFocus
          />
          {/* Alta rápida por DNI (H31): escanea el frente, crea el cliente y lo
              selecciona para esta venta. */}
          <Button
            type="button"
            variant="secondary"
            className="w-full"
            onClick={() => setDniOpen(true)}
          >
            <ScanBarcode size={16} /> Escanear DNI y agregar cliente
          </Button>
          <div className="max-h-72 space-y-1 overflow-y-auto">
            <button
              type="button"
              onClick={() => {
                setCustomer(null);
                setCustOpen(false);
              }}
              className="flex w-full items-center justify-between rounded-lg border border-border px-3 py-2 text-left text-sm hover:bg-muted"
            >
              <span>Consumidor final</span>
              {!customer && <span className="text-xs text-emerald-400">Actual</span>}
            </button>
            {customers?.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  setCustomer({ id: c.id, name: c.name });
                  setCustOpen(false);
                }}
                className="flex w-full items-center justify-between rounded-lg border border-border px-3 py-2 text-left text-sm hover:bg-muted"
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{c.name}</span>
                  {(c.document_number || c.phone) && (
                    <span className="block truncate text-xs text-muted-foreground">
                      {c.document_number ?? c.phone}
                    </span>
                  )}
                </span>
                {customer?.id === c.id && (
                  <span className="text-xs text-emerald-400">Actual</span>
                )}
              </button>
            ))}
            {customers?.length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Sin clientes. Cargalos en la sección Clientes.
              </p>
            )}
          </div>
        </div>
      </Modal>

      <DniScanModal open={dniOpen} onOpenChange={setDniOpen} onConfirm={quickAddFromDni} />

      {discountGate.modal}
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
        base={rawTotal}
        rounding={rounding}
        onConfirm={handleSale}
        loading={sale.isPending}
        storeCreditBalance={scBalance ?? 0}
        hasCustomer={customer !== null}
        initialWarrantyId={offeredWarrantyId}
      />
      <QrCheckoutModal
        open={qrOpen}
        onOpenChange={setQrOpen}
        base={total}
        onQrState={handleQrState}
        onApproved={(reference, amount, extras) => {
          setQrOpen(false);
          handleSale([{ method: "qr", amount, reference }], extras);
        }}
      />
      <QrCheckoutModal
        open={qrMobbexOpen}
        onOpenChange={setQrMobbexOpen}
        base={total}
        provider="mobbex"
        providerName="Mobbex"
        onQrState={handleQrState}
        onApproved={(reference, amount, extras) => {
          setQrMobbexOpen(false);
          handleSale([{ method: "qr", amount, reference }], extras);
        }}
      />
      <QrCheckoutModal
        open={qrModoOpen}
        onOpenChange={setQrModoOpen}
        base={total}
        provider="modo"
        providerName="MODO"
        onQrState={handleQrState}
        onApproved={(reference, amount, extras) => {
          setQrModoOpen(false);
          handleSale([{ method: "qr", amount, reference }], extras);
        }}
      />
      <TicketModal
        open={ticketOpen}
        onOpenChange={setTicketOpen}
        saleId={ticketId}
        autoPrint={autoPrint}
      />
      <VoucherRedeemModal
        open={voucherOpen}
        onOpenChange={setVoucherOpen}
        customer={customer}
        storeId={register?.store_id ?? null}
      />
      <BarcodeScanner
        open={scanOpen}
        onOpenChange={setScanOpen}
        onDetected={(code) => setSearch(code)}
      />
      <VariantPickerModal
        product={variantProduct}
        onClose={() => setVariantProduct(null)}
        onPick={({ variantId, variantLabel: label, price }) => {
          if (!variantProduct) return;
          addVariant({
            id: variantProduct.id,
            name: variantProduct.name,
            sku: variantProduct.sku,
            price: priceFor(variantProduct.id, variantId, price),
            variantId,
            variantLabel: label,
            warrantyMonths: variantProduct.warrantyMonths ?? 0,
          });
          setVariantProduct(null);
        }}
      />
      <ModifierPickerModal
        product={modifierProduct}
        onClose={() => setModifierProduct(null)}
        onConfirm={({ price, modifiers, modifiersLabel }) => {
          if (!modifierProduct) return;
          addWithModifiers({
            id: modifierProduct.id,
            name: modifierProduct.name,
            sku: modifierProduct.sku,
            price, // base (lista mostrador) + suma de deltas
            modifiers,
            modifiersLabel,
            warrantyMonths: modifierProduct.warrantyMonths ?? 0,
          });
          setModifierProduct(null);
        }}
      />
      <Modal open={freeOpen} onOpenChange={setFreeOpen} title="Venta libre">
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Cobra un monto manual con un concepto. No descuenta stock (ítem sin
            SKU). Útil para servicios sueltos, cargos o ítems fuera del catálogo.
          </p>
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
            label="Concepto / motivo (opcional)"
            value={freeName}
            onChange={(e) => setFreeName(e.target.value)}
            placeholder="Venta libre"
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
        title={weighProduct ? `Peso • ${weighProduct.name}` : "Peso"}
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
        title={serialProduct ? `N° de serie • ${serialProduct.name}` : "N° de serie"}
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
