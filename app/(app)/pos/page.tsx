"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Banknote,
  Bike,
  CalendarDays,
  Lock,
  Minus,
  MonitorSmartphone,
  Package,
  Plus,
  ScanBarcode,
  Search,
  Star,
  Ticket,
  User,
  Utensils,
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
  useCustomersForPicker,
  useStoreCreditBalance,
  useCustomerMutations,
  useCustomerLastSaleItems,
} from "@/modules/customers/hooks";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
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
import type { SaleExtraInput } from "@/modules/pos/api";
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
import { useAppointment } from "@/modules/agenda/hooks";
import { appointmentsApi } from "@/modules/agenda/api";
import { useTableOrder, useTableOrderItems } from "@/modules/dining/hooks";
import {
  useDeliveryOrder,
  useDeliveryOrderItems,
} from "@/modules/delivery/hooks";
import {
  OpenShiftModal,
  CloseShiftModal,
  PaymentModal,
  type PaymentExtra,
} from "@/components/pos/PosModals";
import { TicketModal } from "@/components/sales/TicketModal";
import { VoucherRedeemModal } from "@/components/pos/VoucherRedeemModal";
import { SellPackModal } from "@/components/pos/SellPackModal";
import { useCustomerPackCredits } from "@/modules/packs/hooks";
import type { CustomerPackCredit } from "@/modules/packs/api";
import { BarcodeScanner } from "@/components/pos/BarcodeScanner";
import { useTicketBranding } from "@/modules/tickets/hooks";
import {
  publishDisplayState,
  type DisplayBranding,
  type DisplayQr,
  type DisplayState,
} from "@/lib/pos/customerDisplay";
import { formatCurrency, formatQty } from "@/lib/utils/format";

function PosPageInner() {
  const { toast } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  // Cobro desde un turno (F12 · H38): /pos?appointment=<id>. Se carga el servicio
  // del turno en el carrito (+ se permite agregar productos extra) y, al cobrar,
  // la venta queda enlazada al turno (link_appointment_sale → 'realizado').
  const appointmentId = searchParams.get("appointment");
  const { data: pendingAppt } = useAppointment(appointmentId);
  // Evita recargar el servicio al carrito en cada render: sólo una vez por turno.
  const loadedApptRef = useRef<string | null>(null);
  // Recompra rápida (F12 · H40): /pos?repeat=<customerId>. Carga los ítems de la
  // ÚLTIMA venta completada del cliente al carrito (precio ACTUAL del producto;
  // omite los dados de baja) y selecciona al cliente, listo para cobrar.
  const repeatCustomerId = searchParams.get("repeat");
  const { data: repeatSale } = useCustomerLastSaleItems(repeatCustomerId);
  // Sólo una carga por cliente (no en cada render).
  const loadedRepeatRef = useRef<string | null>(null);
  // Cobro de mesa (F13 · H44): /pos?table=<order_id>. Carga los ítems del pedido
  // de la mesa en el carrito y, al cobrar, cierra la mesa (close_dining_table:
  // enlaza la venta, marca el pedido 'cobrada' y libera la mesa). Espeja el flujo
  // de cobro de turno (H38).
  const tableOrderId = searchParams.get("table");
  const { data: tableOrder } = useTableOrder(tableOrderId);
  const { data: tableItems } = useTableOrderItems(tableOrderId);
  // Sólo una carga por pedido de mesa (no en cada render).
  const loadedTableRef = useRef<string | null>(null);
  // Cobro de delivery (F13 · H49): /pos?delivery=<order_id>. ESPEJA el cobro de
  // mesa: carga los ítems del pedido + el costo de envío como línea en el carrito
  // y, al cobrar, create_sale (con p_delivery_order_id) toma el pedido FOR UPDATE,
  // lo enlaza/marca 'entregado' y libera EN LA MISMA transacción.
  const deliveryOrderId = searchParams.get("delivery");
  const { data: deliveryOrder } = useDeliveryOrder(deliveryOrderId);
  const { data: deliveryItems } = useDeliveryOrderItems(deliveryOrderId);
  // Sólo una carga por pedido de delivery (no en cada render).
  const loadedDeliveryRef = useRef<string | null>(null);
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
  const [sellPackOpen, setSellPackOpen] = useState(false);
  const [custSearch, setCustSearch] = useState("");
  // Selector de cliente (bajo consumo de datos): sin término trae sólo los
  // recientes; al tipear, busca server-side con límite. Debounce para no pegar
  // al server por tecla.
  const custSearchDebounced = useDebouncedValue(custSearch, 300);
  const { data: customers } = useCustomersForPicker(custSearchDebounced);
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
        // Fecha de nacimiento parseada del DNI (H31). Antes se mostraba en la
        // preview pero no viajaba al insert: el cliente quedaba sin cumpleaños.
        birth_date: d.fechaNac,
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
  // Packs / sesiones (H41): la feature gatea "Vender paquete" y la oferta de
  // "usar sesión" en el carrito. Saldos disponibles del cliente (no vencidos,
  // con sesiones) para ofrecer cubrir una línea con una sesión del pack.
  const packsFeature = useFeature("packs");
  const packsEnabled = packsFeature !== false; // optimista mientras carga el gating
  const { data: packCredits } = useCustomerPackCredits(
    packsEnabled ? customer?.id : null,
    true,
  );
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
  // Packs (H41): vender un pack y cubrir/descubrir una línea con una sesión.
  const addPack = useCartStore((s) => s.addPack);
  const coverLineWithPack = useCartStore((s) => s.coverLineWithPack);
  const uncoverLine = useCartStore((s) => s.uncoverLine);

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

  // Packs (H41): si cambia el cliente de la venta, quitá la cobertura por pack de
  // las líneas (el saldo de sesiones es del cliente anterior; el nuevo cliente
  // puede tener otros packs u ninguno). Las líneas vuelven a su precio normal.
  const customerId = customer?.id ?? null;
  useEffect(() => {
    for (const l of useCartStore.getState().lines) {
      if (l.packCreditId) uncoverLine(l.lineId);
    }
    // Sólo al cambiar de cliente (no en cada cambio de líneas).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  // Cobro desde un turno (H38): al llegar el turno (?appointment=<id>), cargá su
  // servicio en el carrito UNA sola vez y seleccioná el cliente. Si el turno ya
  // tiene una venta o está cancelado, no se carga (sólo informativo). Usa el
  // snapshot de precio del turno (estable); si el producto del servicio sigue
  // existiendo lo agrega como línea de producto, si no, como ítem libre.
  useEffect(() => {
    const a = pendingAppt;
    if (!a) return;
    if (loadedApptRef.current === a.id) return;
    loadedApptRef.current = a.id;
    if (a.sale_id || a.status === "cancelado") return; // ya cobrado / cancelado
    clear();
    if (a.service_product_id) {
      addProduct({
        id: a.service_product_id,
        name: a.service_name,
        sku: null,
        price: a.service_price,
        unit: "un",
      });
    } else {
      addFreeAmount({ name: a.service_name, amount: a.service_price });
    }
    if (a.customer_id && a.customers?.name) {
      setCustomer({ id: a.customer_id, name: a.customers.name });
    }
  }, [pendingAppt, clear, addProduct, addFreeAmount]);

  // Sale del modo "cobro de turno": limpia el carrito y el query param.
  function exitAppointmentMode() {
    loadedApptRef.current = null;
    clear();
    setCustomer(null);
    router.replace("/pos");
  }

  // Cobro de mesa (H44): al llegar con ?table=<order_id>, cargá los ítems del
  // pedido en el carrito UNA sola vez. Resuelve cada línea por su unit_price del
  // pedido (snapshot del precio cargado en la mesa); las líneas con producto se
  // agregan como producto (descuentan stock al cobrar si corresponde) y las
  // libres como ítem de monto libre. Si el pedido ya fue cobrado/cancelado, no
  // carga nada. NO aplica al POS mostrador (sin ?table, todo queda igual).
  useEffect(() => {
    const o = tableOrder;
    if (!o) return;
    if (loadedTableRef.current === o.id) return;
    if (tableItems === undefined) return; // ítems aún cargando
    if (o.status !== "abierta" || o.sale_id) {
      // Pedido ya cerrado: no recargar; sólo marcar como visto.
      loadedTableRef.current = o.id;
      return;
    }
    loadedTableRef.current = o.id;
    clear();
    for (const it of tableItems ?? []) {
      const qty = it.qty > 0 ? it.qty : 1;
      if (it.product_id) {
        addProduct(
          {
            id: it.product_id,
            name: it.name,
            sku: null,
            price: it.unit_price,
            unit: "un",
          },
          qty,
        );
      } else {
        // Ítem libre: una línea por unidad acumulada (monto = precio * cantidad).
        addFreeAmount({ name: it.name, amount: it.unit_price * qty });
      }
    }
  }, [tableOrder, tableItems, clear, addProduct, addFreeAmount]);

  // Sale del modo "cobro de mesa": limpia el carrito y el query param (la mesa
  // sigue abierta — el cajero canceló el cobro, no la mesa).
  function exitTableMode() {
    loadedTableRef.current = null;
    clear();
    setCustomer(null);
    router.replace("/pos");
  }

  // Cobro de delivery (H49 · Bug 🟠): al llegar con ?delivery=<order_id>, cargá los
  // ítems del pedido al carrito UNA sola vez. ESPEJA el cobro de mesa. Las líneas
  // con producto se agregan como producto (descuentan stock al cobrar si
  // corresponde); las libres como monto libre. El COSTO DE ENVÍO ya NO se inyecta
  // como línea del carrito: lo agrega create_sale como línea AUTORITATIVA desde
  // delivery_orders.delivery_fee (inviolable, no se puede quitar del carrito para
  // pagar $0). El POS sólo lo suma al total a cobrar (deliveryFee → PaymentModal)
  // para que el cajero cobre productos + envío y el total coincida con el v_total
  // del server. Si el pedido ya fue cobrado/cancelado, no carga nada. Pre-selecciona
  // el cliente del pedido si lo tiene.
  useEffect(() => {
    const o = deliveryOrder;
    if (!o) return;
    if (loadedDeliveryRef.current === o.id) return;
    if (deliveryItems === undefined) return; // ítems aún cargando
    if (o.sale_id || o.status === "entregado" || o.status === "cancelado") {
      loadedDeliveryRef.current = o.id;
      return;
    }
    loadedDeliveryRef.current = o.id;
    clear();
    for (const it of deliveryItems ?? []) {
      const qty = it.qty > 0 ? it.qty : 1;
      if (it.product_id) {
        addProduct(
          { id: it.product_id, name: it.name, sku: null, price: it.unit_price, unit: "un" },
          qty,
        );
      } else {
        addFreeAmount({ name: it.name, amount: it.unit_price * qty });
      }
    }
    if (o.customer_id && o.customer_name) {
      setCustomer({ id: o.customer_id, name: o.customer_name });
    }
  }, [deliveryOrder, deliveryItems, clear, addProduct, addFreeAmount]);

  // Costo de envío a cobrar (Bug 🟠): sólo en cobro de delivery activo, tipo
  // 'delivery', con el pedido aún abierto y fee > 0. Es lo que ve/suma el cajero en
  // PaymentModal (payTotal) por encima de los ítems del carrito. El monto REAL que
  // se cobra/asienta lo fija create_sale desde delivery_orders.delivery_fee (este
  // valor del UI sólo refleja el mismo dato del pedido; el server es inviolable).
  // 0 = no aplica (mostrador, mesa, takeaway o pedido ya cerrado).
  const deliveryFee = useMemo(() => {
    const o = deliveryOrder;
    if (!deliveryOrderId || !o) return 0;
    if (o.sale_id || o.status === "entregado" || o.status === "cancelado") return 0;
    if (o.order_type !== "delivery") return 0;
    return Math.max(0, Number(o.delivery_fee) || 0);
  }, [deliveryOrderId, deliveryOrder]);

  // Sale del modo "cobro de delivery": limpia el carrito y el query param (el
  // pedido sigue abierto — el cajero canceló el cobro, no el pedido).
  function exitDeliveryMode() {
    loadedDeliveryRef.current = null;
    clear();
    setCustomer(null);
    router.replace("/pos");
  }

  // Recompra rápida (H40): al entrar con ?repeat=<customerId>, cargá los ítems de
  // la última venta del cliente UNA sola vez. Resuelve el precio ACTUAL de cada
  // producto (lista mostrador) y omite los dados de baja (con aviso). Las líneas
  // sin producto (venta libre / servicios sueltos) se recrean a su precio
  // histórico. Selecciona al cliente y limpia el query param. Best-effort.
  useEffect(() => {
    if (!repeatCustomerId) return;
    const r = repeatSale; // null = el cliente no tiene ventas previas
    if (repeatSale === undefined) return; // aún cargando
    if (loadedRepeatRef.current === repeatCustomerId) return;
    loadedRepeatRef.current = repeatCustomerId;
    let cancelled = false;
    // Cliente de la venta (nombre del join; sin fetch extra). Si no hay venta
    // previa igual lo seleccionamos por id para que la próxima venta sea de él.
    setCustomer({ id: repeatCustomerId, name: r?.customerName ?? "Cliente" });
    (async () => {
      if (!r || r.items.length === 0) {
        if (!cancelled)
          toast({
            title: "El cliente no tiene una venta para repetir",
            variant: "info",
          });
        if (!cancelled) router.replace("/pos");
        return;
      }
      // Productos vigentes (precio actual + baja). Las líneas sin producto se
      // recrean aparte a su precio histórico.
      const productIds = r.items
        .map((it) => it.product_id)
        .filter((id): id is string => Boolean(id));
      let current: Awaited<ReturnType<typeof productsApi.getByIds>> = [];
      try {
        current = await productsApi.getByIds(productIds);
      } catch {
        /* si falla, se tratan todos como no disponibles */
      }
      if (cancelled) return;
      const byId = new Map(current.map((p) => [p.id, p]));
      clear();
      const omitted: string[] = [];
      for (const it of r.items) {
        const qty = it.quantity > 0 ? it.quantity : 1;
        if (it.product_id) {
          const p = byId.get(it.product_id);
          if (!p) {
            omitted.push(it.product_name);
            continue;
          }
          // Precio actual del producto, resuelto contra la lista mostrador.
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
        } else {
          // Venta libre / servicio suelto: precio histórico de la línea.
          addFreeAmount({ name: it.product_name, amount: it.unit_price * qty });
        }
      }
      if (cancelled) return;
      router.replace("/pos");
      if (omitted.length > 0) {
        toast({
          title:
            omitted.length === 1
              ? `Se omitió "${omitted[0]}" (ya no está disponible)`
              : `Se omitieron ${omitted.length} productos que ya no están disponibles`,
          variant: "info",
        });
      }
      toast({ title: "Última venta cargada en el carrito", variant: "success" });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repeatCustomerId, repeatSale]);

  const subtotal = cartSubtotal(lines);
  const rawTotal = Math.max(0, subtotal - discountTotal);
  // Redondeo del total al múltiplo configurado (H30). El server reaplica el
  // mismo redondeo de forma autoritativa en create_sale.
  const total = rounding > 0 ? Math.round(rawTotal / rounding) * rounding : rawTotal;
  const hasShift = Boolean(shift);

  // Ítems para "Dividir cuenta → por ítem" (F13 · H44): cada línea del carrito con
  // su subtotal (las cubiertas por pack van en 0). El modal reparte el total; la
  // suma de ítems cubre la porción de productos y el split ajusta la diferencia
  // (descuento/redondeo/extras/propina) en la última línea para cuadrar exacto.
  const splitItems = useMemo(
    () =>
      lines.map((l) => ({
        id: l.lineId,
        label: l.variantLabel ? `${l.name} (${l.variantLabel})` : l.name,
        amount: lineSubtotal(l),
      })),
    [lines],
  );

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
    extras?: PaymentExtra[],
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
        // Línea cubierta por una sesión de pack (H41): entra en 0 (no se cobra);
        // create_sale consume la sesión vía el extra 'pack_session'.
        unit_price: l.packCreditId ? 0 : l.unitPrice,
        discount: l.packCreditId ? 0 : l.discount,
      }));
      // Extras que entran como ítem de venta para que el total y el ticket los
      // reflejen: recargo (H27) y garantía extendida (H28). La propina (H39) NO
      // es ítem (va a sales.tip_amount) y 'professional' es sólo atribución.
      for (const ex of extras ?? []) {
        if ((ex.kind === "warranty" || ex.kind === "surcharge") && (ex.amount ?? 0) > 0) {
          items.push({
            product_id: null,
            name: ex.name,
            quantity: 1,
            unit_price: ex.amount,
            discount: 0,
          } as never);
        }
      }
      // p_extras para create_sale: la prima de garantía (kind='warranty') se
      // valida contra 'garantias'; los recargos (kind='surcharge') no se gatean;
      // la propina (kind='tip', amount+method) va a sales.tip_amount; el
      // profesional (kind='professional', id) atribuye la comisión.
      const saleExtras: SaleExtraInput[] = (extras ?? [])
        .filter(
          (ex) =>
            (ex.kind === "professional" && ex.id) ||
            ((ex.kind === "warranty" || ex.kind === "surcharge" || ex.kind === "tip") &&
              (ex.amount ?? 0) > 0),
        )
        .map((ex) => ({
          kind: ex.kind,
          ...(ex.amount != null ? { amount: ex.amount } : {}),
          ...(ex.method ? { method: ex.method } : {}),
          ...(ex.id ? { id: ex.id } : {}),
        }));
      // Packs (H41): por cada línea que vende un pack, una señal 'pack' (acredita
      // sesiones). Por cada línea cubierta por una sesión, una 'pack_session'
      // (descuenta una sesión del crédito). Los ítems ya se enviaron arriba (el
      // pack por su precio; la línea cubierta en 0).
      for (const l of lines) {
        if (l.packId) saleExtras.push({ kind: "pack", id: l.packId });
        if (l.packCreditId) saleExtras.push({ kind: "pack_session", id: l.packCreditId });
      }
      const res = await sale.mutateAsync({
        items: items as never,
        payments: payments as never,
        discountTotal,
        customerId: customer?.id ?? null,
        extras: saleExtras,
        // Cobro de mesa (H44): atómico. Cuando se cobra una mesa (/pos?table=),
        // create_sale cierra el pedido y libera la mesa EN LA MISMA transacción
        // (toma el pedido FOR UPDATE → sin doble cobro por dos pestañas). Ya NO
        // se llama tableOrdersApi.close por separado.
        tableOrderId: tableOrderId ?? null,
        // Cobro de delivery (H49): ESPEJA mesa. Con /pos?delivery=, create_sale
        // toma el delivery_order FOR UPDATE, lo enlaza/marca 'entregado' y libera
        // en la misma transacción (sin cierre aparte → sin doble cobro).
        deliveryOrderId: deliveryOrderId ?? null,
      });
      setPaymentModal(false);
      clear();
      setCustomer(null);
      setOfferedWarrantyId("");
      // Cobro desde turno (H38): enlazá la venta al turno y marcalo 'realizado'.
      // Best-effort: si el enlace falla, la venta igual quedó registrada.
      if (appointmentId) {
        try {
          await appointmentsApi.linkSale(appointmentId, res.sale_id);
        } catch (linkErr) {
          console.warn("No se pudo enlazar el turno con la venta:", linkErr);
        }
        loadedApptRef.current = null;
        router.replace("/pos");
      }
      // Cobro de mesa (H44): el cierre de la mesa (enlazar venta, marcar el
      // pedido 'cobrada' y liberar la mesa) ya ocurrió ATÓMICAMENTE dentro de
      // create_sale (vía tableOrderId). No hay close_dining_table aparte: eso
      // permitía un doble cobro si dos pestañas veían la mesa abierta. Acá sólo
      // limpiamos el modo de cobro de mesa y volvemos al POS.
      if (tableOrderId) {
        loadedTableRef.current = null;
        router.replace("/pos");
      }
      // Cobro de delivery (H49): el cierre del pedido (enlazar venta, marcar
      // 'entregado') ya ocurrió ATÓMICAMENTE dentro de create_sale (vía
      // deliveryOrderId). Acá sólo limpiamos el modo y volvemos al POS.
      if (deliveryOrderId) {
        loadedDeliveryRef.current = null;
        router.replace("/pos");
      }
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
      const title = msg.includes("table_order_not_open")
        ? "La mesa ya fue cobrada o cerrada"
        : msg.includes("delivery_order_not_open")
          ? "El pedido ya fue cobrado o cancelado"
        : msg.includes("qr_already_charged")
          ? "Este cobro QR ya fue registrado"
          : msg.includes("qr_not_allowed")
            ? "El cobro con QR no está incluido en tu plan"
            : msg.includes("feature_not_in_plan: descuentos")
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
                  : msg.includes("pack_needs_customer")
                    ? "Elegí un cliente para vender o usar un pack"
                    : msg.includes("pack_no_sessions_left")
                      ? "El pack ya no tiene sesiones disponibles"
                      : msg.includes("pack_expired")
                        ? "El pack del cliente está vencido"
                        : msg.includes("pack_credit_not_found")
                          ? "No se encontró el saldo de pack del cliente"
                          : msg.includes("pack_not_found")
                            ? "No se encontró el paquete"
                            : "No se pudo cobrar";
      toast({
        title,
        description: title === "No se pudo cobrar" ? msg || undefined : undefined,
        variant: "error",
      });
    }
  }

  // Packs / sesiones (H41): saldo restante por crédito, descontando las líneas
  // del carrito que YA lo cubren (una sesión por línea). Evita ofrecer la misma
  // sesión a más líneas de las que el crédito tiene. El backend revalida igual.
  const packRemaining = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of packCredits ?? []) m.set(c.id, c.sessions_left);
    for (const l of lines) {
      if (l.packCreditId && m.has(l.packCreditId)) {
        m.set(l.packCreditId, (m.get(l.packCreditId) ?? 0) - 1);
      }
    }
    return m;
  }, [packCredits, lines]);

  // Crédito de pack que puede cubrir esta línea: del producto de la línea (o
  // genérico), con sesión disponible (saldo restante > 0). Devuelve el de
  // vencimiento más próximo (packCredits ya viene ordenado por la RPC). Excluye
  // líneas sin producto, gratis, ya cubiertas o que venden un pack.
  function creditForLine(l: (typeof lines)[number]): CustomerPackCredit | null {
    if (!packsEnabled || l.packId || l.packCreditId) return null;
    if (l.unitPrice <= 0) return null;
    for (const c of packCredits ?? []) {
      const matches = c.product_id == null || c.product_id === l.productId;
      if (matches && (packRemaining.get(c.id) ?? 0) > 0) return c;
    }
    return null;
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
      {/* overflow-x-hidden: red de seguridad para que NINGÚN modo (mostrador /
          mesa / delivery / turno) genere scroll lateral en mobile aunque un hijo
          se pase de ancho. El layout real se controla con min-w-0 en las columnas. */}
      <div className="mx-auto max-w-7xl overflow-x-hidden px-6 py-6">
        {/* Cobro desde un turno (H38): banner con el servicio cargado. Se puede
            agregar productos extra antes de cobrar; al cobrar, la venta queda
            enlazada al turno. */}
        {pendingAppt && !pendingAppt.sale_id && pendingAppt.status !== "cancelado" && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-ninja-flame/30 bg-ninja-flame/[0.08] px-4 py-3">
            <span className="flex min-w-0 items-center gap-2.5 text-sm">
              <CalendarDays size={18} className="shrink-0 text-ninja-flameSoft" />
              <span className="min-w-0">
                <span className="block font-semibold text-foreground">
                  Cobrando turno: {pendingAppt.service_name}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {pendingAppt.customers?.name
                    ? `Cliente: ${pendingAppt.customers.name} · `
                    : ""}
                  Agregá productos extra si hace falta y cobrá normalmente.
                </span>
              </span>
            </span>
            <button
              type="button"
              onClick={exitAppointmentMode}
              className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
            >
              <X size={14} /> Cancelar cobro del turno
            </button>
          </div>
        )}
        {/* Cobro de mesa (H44): banner con el pedido cargado. Se pueden sumar
            ítems extra; al cobrar, la venta queda enlazada y la mesa se libera. */}
        {tableOrder && tableOrder.status === "abierta" && !tableOrder.sale_id && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-ninja-flame/30 bg-ninja-flame/[0.08] px-4 py-3">
            <span className="flex min-w-0 items-center gap-2.5 text-sm">
              <Utensils size={18} className="shrink-0 text-ninja-flameSoft" />
              <span className="min-w-0">
                <span className="block font-semibold text-foreground">
                  Cobrando mesa
                </span>
                <span className="block text-xs text-muted-foreground">
                  Pedido cargado desde el Salón. Sumá lo que falte y cobrá
                  normalmente; al confirmar, la mesa queda libre.
                </span>
              </span>
            </span>
            <button
              type="button"
              onClick={exitTableMode}
              className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
            >
              <X size={14} /> Cancelar cobro de la mesa
            </button>
          </div>
        )}
        {/* Cobro de delivery (H49): banner con el pedido cargado (ítems + envío).
            Al confirmar, la venta queda enlazada y el pedido pasa a entregado. */}
        {deliveryOrder &&
          !deliveryOrder.sale_id &&
          deliveryOrder.status !== "entregado" &&
          deliveryOrder.status !== "cancelado" && (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-sky-400/30 bg-sky-400/[0.08] px-4 py-3">
              <span className="flex min-w-0 items-center gap-2.5 text-sm">
                <Bike size={18} className="shrink-0 text-sky-300" />
                <span className="min-w-0">
                  <span className="block break-words font-semibold text-foreground">
                    Cobrando {deliveryOrder.order_type === "takeaway" ? "take away" : "delivery"}
                    {deliveryOrder.customer_name ? ` · ${deliveryOrder.customer_name}` : ""}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    Pedido cargado desde el tablero. El costo de envío se suma al
                    total a cobrar. Sumá lo que falte y cobrá; al confirmar, el
                    pedido queda entregado.
                  </span>
                </span>
              </span>
              <button
                type="button"
                onClick={exitDeliveryMode}
                className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
              >
                <X size={14} /> Cancelar cobro del pedido
              </button>
            </div>
          )}
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
        {/* min-w-0: un grid item arranca con min-width:auto, así que su contenido
            (grilla, banners largos) puede ensanchar la columna por encima del
            viewport y generar scroll lateral en mobile. min-w-0 deja que la
            columna se achique a la pantalla. */}
        <section className="min-w-0">
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
        {/* min-w-0: ídem section — evita que el carrito empuje el ancho de la
            columna en mobile (scroll lateral). */}
        <aside className="flex h-[calc(100vh-7rem)] min-w-0 flex-col rounded-lg border border-border bg-card p-4">
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
                  {l.packCreditId ? (
                    <span className="flex items-center gap-1.5 text-sm font-semibold">
                      <span className="text-xs font-normal text-muted-foreground line-through">
                        {formatCurrency(l.unitPrice * l.quantity)}
                      </span>
                      <span className="text-emerald-300">Gratis</span>
                    </span>
                  ) : (
                    <span className="text-sm font-semibold">
                      {formatCurrency(lineSubtotal(l))}
                    </span>
                  )}
                </div>
                {/* Cantidades rápidas en la línea (H36): suma de un toque sin
                    teclear. Sólo para ítems por unidad (los de peso usan kg). */}
                {l.unit !== "kg" && !l.packCreditId && (
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
                {/* Pack / sesiones (H41): cubrir esta línea con una sesión del
                    pack del cliente, o quitar la cobertura. Sólo si el cliente
                    tiene un pack que cubre esta línea con sesión disponible. */}
                {l.packCreditId ? (
                  <div className="mt-2 flex items-center justify-between gap-2 rounded-md border border-emerald-400/30 bg-emerald-400/10 px-2.5 py-1.5">
                    <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-300">
                      <Package size={13} /> Cubierto por el pack
                    </span>
                    <button
                      type="button"
                      onClick={() => uncoverLine(l.lineId)}
                      className="text-xs font-medium text-muted-foreground transition hover:text-foreground"
                    >
                      Quitar
                    </button>
                  </div>
                ) : (
                  (() => {
                    const credit = creditForLine(l);
                    if (!credit) return null;
                    return (
                      <button
                        type="button"
                        onClick={() => coverLineWithPack(l.lineId, credit.id)}
                        className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-emerald-400/40 px-2.5 py-1.5 text-xs font-medium text-emerald-300 transition hover:bg-emerald-400/10"
                      >
                        <Package size={13} /> Usar sesión del pack ({credit.sessions_left} restantes)
                      </button>
                    );
                  })()
                )}
              </div>
            ))}
          </div>

          {/* pb-20 en mobile: deja aire bajo los controles (Cobrar / QR /
              toggle de ticket) para que la burbuja flotante del Asistente IA
              (fixed bottom-4 right-4) no los tape. En lg el carrito es columna
              lateral con espacio de sobra → sin padding extra. */}
          <div className="mt-3 space-y-2 border-t border-border pt-3 pb-20 lg:pb-0">
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
            <div className="flex gap-2">
              {/* Canje de vale por código → acredita saldo a favor del cliente */}
              <button
                type="button"
                onClick={() => setVoucherOpen(true)}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-dashed border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:border-ninja-flameSoft/40 hover:text-ninja-flameSoft"
              >
                <Ticket size={13} /> Canjear vale
              </button>
              {/* Vender un pack de sesiones (H41) → acredita sesiones al cliente.
                  Requiere cliente; la oferta de "usar sesión" vive en cada línea. */}
              {packsEnabled && (
                <button
                  type="button"
                  onClick={() => {
                    if (!customer) {
                      toast({ title: "Elegí un cliente para venderle un pack", variant: "error" });
                      setCustOpen(true);
                      return;
                    }
                    setSellPackOpen(true);
                  }}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-dashed border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:border-ninja-flameSoft/40 hover:text-ninja-flameSoft"
                >
                  <Package size={13} /> Vender pack
                </button>
              )}
            </div>
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

      <Modal
        open={custOpen}
        onOpenChange={(o) => {
          setCustOpen(o);
          // Al cerrar, limpiá el término para que la próxima apertura muestre los
          // recientes (y no pegue al server con la última búsqueda).
          if (!o) setCustSearch("");
        }}
        title="Cliente de la venta"
      >
        <div className="space-y-3">
          <Input
            placeholder="Buscar por nombre, documento o teléfono…"
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
            {/* Encabezado contextual: sin término muestra los recientes (no todo
                el padrón → bajo consumo); al tipear, los resultados de la
                búsqueda server-side. */}
            <p className="px-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {custSearch.trim() ? "Resultados" : "Recientes"}
            </p>
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
                  <span className="shrink-0 text-xs text-emerald-400">Actual</span>
                )}
              </button>
            ))}
            {customers?.length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {custSearch.trim()
                  ? "Sin resultados. Probá con otro nombre, documento o teléfono."
                  : "Sin clientes recientes. Buscá por nombre, documento o teléfono o cargalos en Clientes."}
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
        splitItems={splitItems}
        deliveryFee={deliveryFee}
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
      <SellPackModal
        open={sellPackOpen}
        onOpenChange={setSellPackOpen}
        onPick={(p) => {
          addPack(p);
          toast({ title: `Pack "${p.name}" agregado`, variant: "success" });
        }}
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

// Wrapper con Suspense: el POS lee ?appointment con useSearchParams (cobro desde
// turno · H38), que en el App Router debe ir dentro de un límite de Suspense.
export default function PosPage() {
  return (
    <Suspense fallback={null}>
      <PosPageInner />
    </Suspense>
  );
}
