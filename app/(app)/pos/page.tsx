"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { Bike, CalendarDays, Utensils } from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import {
  useProducts,
  useProductsByIds,
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
} from "@/modules/customers/hooks";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import type { ParsedDni } from "@/lib/customers/dniParse";
import { verticalHas } from "@/lib/verticals/config";
import { useCartStore } from "@/modules/pos/store";
import { useOpenShift, useDefaultRegister, usePosMutations, usePosSettings } from "@/modules/pos/hooks";
import { useBranchScope } from "@/modules/branches/hooks";
import { branchErrorMessage, locationLabel } from "@/modules/branches/logic";
import { PosLocationPicker } from "@/components/branches/PosLocationPicker";
import { usePosLayout, usePosLayoutMutations, useResolvedTenders } from "@/modules/pos/layoutHooks";
import { useScanner } from "@/modules/pos/useScanner";
import { useFeature } from "@/modules/saas/gating";
import { useFeatureGate } from "@/components/saas/GatedAction";
import { WarrantyOfferCard } from "@/components/pos/WarrantyOfferCard";
import { useProductsWithModifiers } from "@/modules/products/modifiers";
import { productsApi, variantLabel, type Product } from "@/modules/products/api";
import { subtreeIds } from "@/components/pos/CategoryNav";
import { MenuFilterBar } from "@/components/pos/MenuFilterBar";
import { useMostradorPricing } from "@/modules/prices/hooks";
import { resolvePrice } from "@/lib/prices/resolve";
import { useDiningEnabled } from "@/modules/dining/hooks";
import { useMenus, useActiveMenuIds, useMenuProductIds } from "@/modules/menus/hooks";
import { useCustomerPackCredits } from "@/modules/packs/hooks";
import type { CustomerPackCredit } from "@/modules/packs/api";
import { MountWhenOpened } from "@/components/ui/MountWhenOpened";
import { useTicketBranding } from "@/modules/tickets/hooks";
import {
  publishDisplayState,
  type DisplayBranding,
  type DisplayQr,
  type DisplayState,
} from "@/lib/pos/customerDisplay";
import { lineSubtotal } from "@/modules/pos/store";
import { pinnedTenders } from "@/lib/pos/tenders";
import type { PosPreset } from "@/lib/pos/layout";
import { PosShell } from "@/components/pos/screen/PosShell";
import { PosTopBar } from "@/components/pos/screen/PosTopBar";
import { ModeBanner } from "@/components/pos/screen/ModeBanner";
import { ProductPane } from "@/components/pos/screen/ProductPane";
import { CartLines, CartSummary } from "@/components/pos/screen/CartPane";
import { QuickKeypadPanel, QuickScanPane } from "@/components/pos/screen/QuickScanPane";
import { CategoryRail } from "@/components/pos/ui/CategoryBar";
import { applyKey, type KeypadKey } from "@/components/pos/ui/Keypad";
import { accentVars } from "@/components/pos/ui/posStyles";
import {
  CustomerPickerDialog,
  FreeSaleDialog,
  SerialDialog,
  WeighDialog,
} from "@/components/pos/screen/PosDialogs";
import { toPick, type PickInput, type ResolvedQuickKey } from "@/components/pos/screen/types";
import { usePosOrigins } from "@/modules/pos/screen/usePosOrigins";
import { usePosPricing } from "@/modules/pos/screen/usePosPricing";
import { usePosSale } from "@/modules/pos/screen/usePosSale";
import { formatCurrency } from "@/lib/utils/format";

// Pantalla de venta. La página orquesta datos y reglas de negocio (carrito,
// orígenes, promos, venta); la piel la decide el diseño elegido (PosShell +
// presets) y el cobro pasa SIEMPRE por la hoja única (CheckoutSheet).
//
// Modales en chunks aparte (next/dynamic); se montan al abrirlos y se
// precargan en idle tras el primer render.
const loadPosModals = () => import("@/components/pos/PosModals");
const loadCheckout = () => import("@/components/pos/checkout/CheckoutSheetConnected");
const loadQrCheckout = () => import("@/components/pos/QrCheckoutModal");
const loadPointCheckout = () => import("@/components/pos/PointCheckoutModal");
const loadVariantPicker = () => import("@/components/pos/VariantPickerModal");
const loadModifierPicker = () => import("@/components/pos/ModifierPickerModal");
const loadTicketModal = () => import("@/components/sales/TicketModal");
const loadVoucherRedeem = () => import("@/components/pos/VoucherRedeemModal");
const loadSellPack = () => import("@/components/pos/SellPackModal");
const loadBarcodeScanner = () => import("@/components/pos/BarcodeScanner");
const loadDniScan = () => import("@/components/customers/DniScanModal");
const loadSalon = () => import("@/components/pos/screen/SalonTablesConnected");

const OpenShiftModal = dynamic(() => loadPosModals().then((m) => m.OpenShiftModal), { ssr: false });
const CloseShiftModal = dynamic(() => loadPosModals().then((m) => m.CloseShiftModal), { ssr: false });
const CheckoutSheetConnected = dynamic(() => loadCheckout().then((m) => m.CheckoutSheetConnected), { ssr: false });
const VariantPickerModal = dynamic(() => loadVariantPicker().then((m) => m.VariantPickerModal), { ssr: false });
const ModifierPickerModal = dynamic(() => loadModifierPicker().then((m) => m.ModifierPickerModal), { ssr: false });
const TicketModal = dynamic(() => loadTicketModal().then((m) => m.TicketModal), { ssr: false });
const VoucherRedeemModal = dynamic(() => loadVoucherRedeem().then((m) => m.VoucherRedeemModal), { ssr: false });
const SellPackModal = dynamic(() => loadSellPack().then((m) => m.SellPackModal), { ssr: false });
const BarcodeScanner = dynamic(() => loadBarcodeScanner().then((m) => m.BarcodeScanner), { ssr: false });
const DniScanModal = dynamic(() => loadDniScan().then((m) => m.DniScanModal), { ssr: false });
const SalonTablesConnected = dynamic(() => loadSalon().then((m) => m.SalonTablesConnected), { ssr: false });

function preloadPosModals() {
  for (const load of [
    loadPosModals,
    loadCheckout,
    loadQrCheckout,
    loadPointCheckout,
    loadVariantPicker,
    loadModifierPicker,
    loadTicketModal,
    loadVoucherRedeem,
    loadSellPack,
    loadBarcodeScanner,
    loadDniScan,
  ]) {
    void load().catch(() => {});
  }
}

type PendingProduct = {
  id: string;
  name: string;
  sku: string | null;
  price: number;
  warrantyMonths?: number;
  categoryId?: string | null;
};

function PosPageInner() {
  const { toast } = useToast();
  useEffect(() => {
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(preloadPosModals);
      return () => w.cancelIdleCallback?.(id);
    }
    const t = setTimeout(preloadPosModals, 1500);
    return () => clearTimeout(t);
  }, []);

  // ── Diseño ──────────────────────────────────────────────────────────────────
  const { layout, user: userLayout, hasUserOverride } = usePosLayout();
  const { saveUser } = usePosLayoutMutations();
  const { data: diningEnabled } = useDiningEnabled();
  // Salón requiere el modo gastronómico: sin él cae a Mostrador.
  const effectiveLayout = useMemo(
    () => (layout.preset === "salon" && diningEnabled === false ? { ...layout, preset: "mostrador" as const } : layout),
    [layout, diningEnabled],
  );
  const preset = effectiveLayout.preset;

  // ── Estado de la pantalla ───────────────────────────────────────────────────
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const [openShiftModal, setOpenShiftModal] = useState(false);
  const [closeShiftModal, setCloseShiftModal] = useState(false);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [checkoutTender, setCheckoutTender] = useState<string | null>(null);
  // Garantía pre-seleccionada por la oferta contextual (H28).
  const [offeredWarrantyId, setOfferedWarrantyId] = useState("");
  const [ticketId, setTicketId] = useState<string | null>(null);
  const [ticketOpen, setTicketOpen] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
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
  const [weighProduct, setWeighProduct] = useState<PendingProduct | null>(null);
  const [weighGrams, setWeighGrams] = useState("");
  const [serialProduct, setSerialProduct] = useState<PendingProduct | null>(null);
  const [serialChoice, setSerialChoice] = useState("");
  const [serialOther, setSerialOther] = useState("");
  const [variantProduct, setVariantProduct] = useState<PendingProduct | null>(null);
  const [modifierProduct, setModifierProduct] = useState<PendingProduct | null>(null);
  // Caja rápida: cantidad para el próximo producto (número + "×").
  const [pendingQty, setPendingQty] = useState(1);
  const { data: withMods } = useProductsWithModifiers();
  const { data: serialList } = useProductSerials(serialProduct?.id ?? null, serialProduct !== null);

  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const { data: categories } = useCategories();

  // Menús por horario (F13 · H47): sólo en modo gastronómico.
  const [menuFilter, setMenuFilter] = useState<string | null>(null);
  const { data: menus } = useMenus(Boolean(diningEnabled));
  const { data: activeMenuIds } = useActiveMenuIds(Boolean(diningEnabled));
  const { data: menuProductIds } = useMenuProductIds(menuFilter);
  const activeMenuSet = useMemo(() => new Set<string>(activeMenuIds ?? []), [activeMenuIds]);
  const menuProductSet = useMemo<Set<string> | null>(
    () => (menuFilter ? new Set<string>(menuProductIds ?? []) : null),
    [menuFilter, menuProductIds],
  );

  // Filtro por rubro = sub-árbol (en cliente); el de menú combina encima.
  const { data: allProducts, isFetching: productsLoading } = useProducts(search);
  const products = useMemo(() => {
    if (!categoryFilter && !menuProductSet) return allProducts;
    let list = allProducts ?? [];
    if (categoryFilter) {
      const ids = subtreeIds(categories ?? [], categoryFilter);
      list = list.filter((p: Product) => p.category_id && ids.has(p.category_id));
    }
    if (menuProductSet) list = list.filter((p: Product) => menuProductSet.has(p.id));
    return list;
  }, [allProducts, categories, categoryFilter, menuProductSet]);
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

  const { data: shift, isFetched: shiftFetched } = useOpenShift();
  const { data: register, store: registerStore } = useDefaultRegister();
  const currentUserId = useBranchScope().data?.userId ?? null;
  const { open, close } = usePosMutations();
  const { data: myTenant } = useMyTenant();
  const quickSale = verticalHas(myTenant?.industry, "quickSale");
  // Descuentos manuales: feature de plan (Pro). Sin ella el campo queda bloqueado.
  const discountGate = useFeatureGate("descuentos", "Descuentos");
  const { data: posSettings } = usePosSettings();
  const { data: warrantyPlans } = useWarrantyPlans(true);
  const offerWarranty = posSettings?.offerWarranty ?? true;
  const role = myTenant?.role ?? "cashier";
  // Venta libre (H36): flag del negocio Y sólo owner/manager.
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
  const custSearchDebounced = useDebouncedValue(custSearch, 300);
  const { data: customers } = useCustomersForPicker(custSearchDebounced);
  const { createQuick } = useCustomerMutations();

  // Alta rápida de cliente desde el DNI escaneado (H31).
  async function quickAddFromDni(d: ParsedDni) {
    try {
      const created = await createQuick.mutateAsync({
        name: d.nombreCompleto,
        document_type: "dni",
        document_number: d.dni,
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
  // Packs / sesiones (H41).
  const packsFeature = useFeature("packs");
  const packsEnabled = packsFeature !== false;
  const { data: packCredits } = useCustomerPackCredits(packsEnabled ? customer?.id : null, true);
  const showFrequent = quickSale && !search.trim();
  const { data: topProducts } = useTopProducts(showFrequent);
  // Favoritos (H36) o teclas rápidas del diseño.
  const showFavorites = !search.trim() && !categoryFilter && !menuFilter;
  const { data: favorites } = useFavoriteProducts(showFavorites && layout.quickKeys.length === 0);
  const quickKeyIds = useMemo(() => layout.quickKeys.map((k) => k.productId), [layout.quickKeys]);
  const { data: quickKeyProducts } = useProductsByIds(quickKeyIds);
  const quickKeys = useMemo<ResolvedQuickKey[]>(() => {
    if (layout.quickKeys.length === 0) return (favorites ?? []).map((p) => ({ product: p }));
    const byId = new Map((quickKeyProducts ?? []).map((p) => [p.id, p]));
    const out: ResolvedQuickKey[] = [];
    for (const k of layout.quickKeys) {
      const product = byId.get(k.productId);
      if (product) out.push({ product, label: k.label, color: k.color });
    }
    return out;
  }, [layout.quickKeys, quickKeyProducts, favorites]);

  // ── Pantalla del cliente (F10 · H25) ───────────────────────────────────────
  const { data: dispBranding } = useTicketBranding();
  const [displayQr, setDisplayQr] = useState<DisplayQr | null>(null);
  const handleQrState = useCallback((qr: DisplayQr | null) => setDisplayQr(qr), []);
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

  // ── Carrito ────────────────────────────────────────────────────────────────
  const addProduct = useCartStore((s) => s.addProduct);
  const addWeighed = useCartStore((s) => s.addWeighed);
  const addSerialized = useCartStore((s) => s.addSerialized);
  const addVariant = useCartStore((s) => s.addVariant);
  const addWithModifiers = useCartStore((s) => s.addWithModifiers);
  const addFreeAmount = useCartStore((s) => s.addFreeAmount);
  const addPack = useCartStore((s) => s.addPack);
  const coverLineWithPack = useCartStore((s) => s.coverLineWithPack);
  const uncoverLine = useCartStore((s) => s.uncoverLine);
  const setQuantity = useCartStore((s) => s.setQuantity);
  const removeLine = useCartStore((s) => s.removeLine);
  const setDiscountTotal = useCartStore((s) => s.setDiscountTotal);
  const clear = useCartStore((s) => s.clear);

  // Lista de precios 'mostrador' activa: el precio al agregar se resuelve acá.
  const { data: mostrador } = useMostradorPricing();
  function priceFor(productId: string, variantId: string | null, basePrice: number): number {
    return resolvePrice(basePrice, productId, variantId, mostrador?.list ?? null, mostrador?.items ?? []);
  }

  // Tocar un producto: variante, serial, opciones o peso abren su picker; si no,
  // va directo al carrito (precio por lista mostrador). `qty` sólo aplica a
  // productos simples por unidad (Caja rápida).
  function pickProduct(p: PickInput, qty = 1) {
    if (p.has_variants) {
      setVariantProduct({ id: p.id, name: p.name, sku: p.sku, price: p.price, warrantyMonths: p.warranty_months ?? 0, categoryId: p.categoryId ?? null });
    } else if (p.is_serialized) {
      setSerialProduct({ id: p.id, name: p.name, sku: p.sku, price: p.price, warrantyMonths: p.warranty_months ?? 0, categoryId: p.categoryId ?? null });
      setSerialChoice("");
      setSerialOther("");
    } else if (withMods?.has(p.id)) {
      // H37: producto con modificadores → picker (precio base por lista mostrador).
      setModifierProduct({ id: p.id, name: p.name, sku: p.sku, price: priceFor(p.id, null, p.price), warrantyMonths: p.warranty_months ?? 0, categoryId: p.categoryId ?? null });
    } else if (p.unit === "kg") {
      setWeighProduct({ id: p.id, name: p.name, sku: p.sku, price: priceFor(p.id, null, p.price), categoryId: p.categoryId ?? null });
      setWeighGrams("");
    } else {
      addProduct({ ...p, price: priceFor(p.id, null, p.price), warrantyMonths: p.warranty_months ?? 0 }, qty);
    }
  }
  // Callback estable para la grilla memoizada.
  const pickRef = useRef(pickProduct);
  pickRef.current = pickProduct;
  const pendingQtyRef = useRef(pendingQty);
  pendingQtyRef.current = pendingQty;
  const onPickProduct = useCallback((p: Product) => {
    pickRef.current(toPick(p), pendingQtyRef.current);
    if (pendingQtyRef.current !== 1) setPendingQty(1);
  }, []);

  function favQuickUnits(p: Product, qty: number) {
    addProduct({ id: p.id, name: p.name, sku: p.sku, price: priceFor(p.id, null, p.price), unit: p.unit, warrantyMonths: p.warranty_months ?? 0, categoryId: p.category_id }, qty);
  }
  function favQuickWeight(p: Product, kg: number) {
    addWeighed({ id: p.id, name: p.name, sku: p.sku, price: priceFor(p.id, null, p.price), categoryId: p.category_id }, kg);
  }

  function confirmSerial() {
    if (!serialProduct) return;
    const serial = serialChoice === "__other__" ? serialOther.trim() : serialChoice.trim();
    if (!serial) {
      toast({ title: "Elegí o ingresá un N° de serie", variant: "error" });
      return;
    }
    addSerialized({ ...serialProduct, price: priceFor(serialProduct.id, null, serialProduct.price) }, serial);
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

  // ── Orígenes (turno, recompra, mesa, delivery) y precios ────────────────────
  const origins = usePosOrigins({ setCustomer, priceFor });
  const pricing = usePosPricing({ rounding, customerId: customer?.id ?? null });
  const { lines, discountTotal, subtotal, total, rawTotal } = pricing;

  // Si ya no queda un producto elegible, descartá la garantía pre-seleccionada.
  const hasEligibleWarranty = lines.some((l) => (l.warrantyMonths ?? 0) > 0);
  useEffect(() => {
    if (!hasEligibleWarranty && offeredWarrantyId) setOfferedWarrantyId("");
  }, [hasEligibleWarranty, offeredWarrantyId]);

  // Packs (H41): al cambiar de cliente se quita la cobertura por pack.
  const customerId = customer?.id ?? null;
  useEffect(() => {
    for (const l of useCartStore.getState().lines) {
      if (l.packCreditId) uncoverLine(l.lineId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  const hasShift = Boolean(shift);

  // Publica el estado a la pantalla del cliente (H25).
  useEffect(() => {
    const phase: DisplayState["phase"] = paidView ? "paid" : displayQr ? "paying" : lines.length > 0 ? "cart" : "idle";
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

  // Tope de descuento por rol (H30).
  function handleDiscountChange(value: number) {
    const max = (subtotal * maxDiscPct) / 100;
    if (value > max + 0.001) {
      setDiscountTotal(Math.max(0, Math.floor(max)));
      toast({ title: `Descuento máximo ${maxDiscPct}% para tu rol`, variant: "error" });
    } else {
      setDiscountTotal(Math.max(0, value));
    }
  }

  // Código encontrado (escáner, Enter en Caja rápida): variante directo; el
  // resto pasa por pickProduct. Devuelve false si no hay producto.
  async function addByCode(code: string): Promise<boolean> {
    const res = await productsApi.findByCode(code);
    if (!res) return false;
    const { product: p, variant } = res;
    if (variant) {
      addVariant({
        id: p.id,
        name: p.name,
        sku: variant.sku ?? p.sku,
        price: priceFor(p.id, variant.id, variant.price_override ?? p.price),
        variantId: variant.id,
        variantLabel: variantLabel(variant),
        warrantyMonths: p.warranty_months ?? 0,
        categoryId: p.category_id,
      });
    } else {
      pickProduct(toPick(p), pendingQty);
    }
    if (pendingQty !== 1) setPendingQty(1);
    return true;
  }

  // Lector USB/Bluetooth (HID). Se desactiva con el escaneo de DNI abierto.
  useScanner(
    async (code) => {
      try {
        if (!(await addByCode(code))) {
          setSearch(code);
          toast({ title: `Sin producto para "${code}"`, variant: "info" });
        }
      } catch {
        setSearch(code);
      }
    },
    {
      enabled: !dniOpen,
      prefix: posSettings?.scannerPrefix ?? "",
      suffix: posSettings?.scannerSuffix ?? "",
      beep: posSettings?.scannerBeep ?? true,
      dupMs: posSettings?.scannerDupMs ?? 1500,
    },
  );

  // Caja rápida: Enter busca el código exacto; si no, el único resultado.
  async function quickEnter() {
    const code = search.trim();
    if (!code) return;
    try {
      if (await addByCode(code)) {
        setSearch("");
        return;
      }
    } catch {
      /* cae a la búsqueda por nombre */
    }
    const only = (products ?? []).length === 1 ? products?.[0] : undefined;
    if (only) {
      onPickProduct(only);
      setSearch("");
    } else {
      toast({ title: `Sin producto para "${code}"`, variant: "info" });
    }
  }
  function onQuickKey(k: KeypadKey) {
    setSearch((v) => applyKey(v, k));
    searchRef.current?.focus();
  }
  function onQuickTimes() {
    const n = Math.floor(Number(search.replace(",", ".")));
    if (n > 1 && n < 1000) {
      setPendingQty(n);
      setSearch("");
    }
    searchRef.current?.focus();
  }

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
      const title = branchErrorMessage(e, "No se pudo abrir");
      toast({
        title,
        description: title === "No se pudo abrir" && e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  async function handleCloseShift(closing: number, notes: string) {
    if (!shift) return;
    try {
      const diff = await close.mutateAsync({ shiftId: shift.id, closing, notes });
      setCloseShiftModal(false);
      toast({ title: "Caja cerrada", description: `Diferencia: ${formatCurrency(diff)}`, variant: diff === 0 ? "success" : "info" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : undefined;
      toast({
        title: msg && msg.includes("close_needs_reason") ? "Escribí un motivo: la diferencia supera la tolerancia" : "No se pudo cerrar",
        description: msg && msg.includes("close_needs_reason") ? undefined : msg,
        variant: "error",
      });
    }
  }

  // "Pago recibido" + vuelto en la pantalla del cliente unos segundos (H25).
  function flashPaidScreen(change: number) {
    if (paidTimer.current) clearTimeout(paidTimer.current);
    setPaidView({ change: Math.max(0, change || 0) });
    paidTimer.current = setTimeout(() => setPaidView(null), 6000);
  }
  useEffect(
    () => () => {
      if (paidTimer.current) clearTimeout(paidTimer.current);
    },
    [],
  );

  const { handleSale, saving } = usePosSale({
    lines,
    discountTotal,
    customerId: customer?.id ?? null,
    tableOrderId: origins.tableOrderId,
    deliveryOrderId: origins.deliveryOrderId,
    appointmentId: origins.appointmentId,
    salePromo: pricing.salePromo,
    couponId: pricing.couponDiscount > 0 ? pricing.appliedCoupon?.coupon_id ?? null : null,
    onSuccess: ({ saleId, change }) => {
      setCheckoutOpen(false);
      clear();
      setCustomer(null);
      setOfferedWarrantyId("");
      pricing.clearCoupon();
      origins.afterSale();
      flashPaidScreen(change);
      setTicketId(saleId);
      setTicketOpen(true);
    },
  });

  // Packs (H41): saldo restante por crédito descontando las líneas que ya lo cubren.
  const packRemaining = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of packCredits ?? []) m.set(c.id, c.sessions_left);
    for (const l of lines) {
      if (l.packCreditId && m.has(l.packCreditId)) m.set(l.packCreditId, (m.get(l.packCreditId) ?? 0) - 1);
    }
    return m;
  }, [packCredits, lines]);
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

  // ── Cobro ──────────────────────────────────────────────────────────────────
  const tenders = useResolvedTenders({ hasCustomer: customer !== null, storeCreditBalance: scBalance ?? 0 });
  const pinned = useMemo(() => pinnedTenders(tenders, layout.payments), [tenders, layout.payments]);
  const canCheckout = hasShift && lines.length > 0;
  function startCheckout(tenderId?: string) {
    if (!hasShift) {
      setOpenShiftModal(true);
      return;
    }
    if (lines.length === 0 || !ensureCustomer()) return;
    setCheckoutTender(tenderId ?? null);
    setCheckoutOpen(true);
  }
  const startCheckoutRef = useRef(startCheckout);
  startCheckoutRef.current = startCheckout;

  // Acceso rápido "Cobrar" del menú (F1): /pos?cobrar=1 abre la hoja de cobro
  // si hay un carrito en curso (sin caja abierta, pide abrirla). El parámetro
  // se limpia para que volver atrás o recargar no reabra el cobro.
  const router = useRouter();
  const searchParams = useSearchParams();
  const wantsCheckout = searchParams.get("cobrar") === "1";
  useEffect(() => {
    if (!wantsCheckout || !shiftFetched) return;
    router.replace("/pos", { scroll: false });
    if (useCartStore.getState().lines.length > 0) startCheckoutRef.current();
  }, [wantsCheckout, shiftFetched, router]);

  // Atajos: F2 busca, F12 cobra.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F2") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (e.key === "F12") {
        e.preventDefault();
        startCheckoutRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function openCustomerDisplay() {
    window.open("/customer-display", "ninja-customer-display", "noopener");
  }

  function pickPreset(p: PosPreset) {
    saveUser.mutate({ ...userLayout, preset: p });
  }

  const itemCount = lines.reduce((a, l) => a + (l.unit === "kg" ? 1 : l.quantity), 0);
  const cartTitle =
    origins.tableActive ? "Cuenta de la mesa" : preset === "salon" ? "Pedido" : "Carrito";

  const onSearch = (v: string) => {
    setSearch(v);
    setCategoryFilter(null);
  };

  const menuBar =
    diningEnabled && (menus ?? []).length > 0 ? (
      <MenuFilterBar menus={menus ?? []} activeIds={activeMenuSet} selected={menuFilter} onSelect={setMenuFilter} />
    ) : null;

  const cartLines = (
    <CartLines
      lines={lines}
      dense={preset === "caja_rapida"}
      onQty={setQuantity}
      onRemove={removeLine}
      creditForLine={creditForLine}
      onCover={coverLineWithPack}
      onUncover={uncoverLine}
      emptyHint={preset === "caja_rapida" ? "Escaneá un código o tipeá un PLU." : undefined}
    />
  );

  const cartSummary = (
    <CartSummary
      customer={customer}
      requireCustomer={requireCustomer}
      storeCredit={scBalance ?? 0}
      onCustomer={() => setCustOpen(true)}
      onVoucher={() => setVoucherOpen(true)}
      packsEnabled={packsEnabled}
      onSellPack={() => {
        if (!customer) {
          toast({ title: "Elegí un cliente para venderle un pack", variant: "error" });
          setCustOpen(true);
          return;
        }
        setSellPackOpen(true);
      }}
      subtotal={subtotal}
      discountTotal={discountTotal}
      discountLocked={discountGate.locked}
      onDiscount={handleDiscountChange}
      onDiscountLocked={() => discountGate.run(() => {})}
      promo={
        pricing.promoActive && pricing.promoResult && pricing.promoDiscount > 0
          ? { name: pricing.promoResult.name ?? "Promoción", amount: pricing.promoDiscount }
          : null
      }
      coupon={pricing.appliedCoupon ? { code: pricing.appliedCoupon.code, amount: pricing.couponDiscount } : null}
      couponInput={pricing.couponInput}
      onCouponInput={pricing.setCouponInput}
      onApplyCoupon={pricing.applyCoupon}
      onRemoveCoupon={pricing.clearCoupon}
      deliveryFee={origins.deliveryFee}
      total={total}
      itemCount={itemCount}
      pinned={pinned}
      hasShift={hasShift}
      canCheckout={canCheckout}
      checkingOut={saving}
      onCheckout={startCheckout}
      onOpenShift={() => setOpenShiftModal(true)}
      autoPrint={autoPrint}
      onAutoPrint={setAutoPrint}
      compact={preset === "caja_rapida"}
      warrantySlot={
        offerWarranty ? (
          <WarrantyOfferCard
            lines={lines}
            plans={warrantyPlans ?? []}
            base={rawTotal}
            selectedWarrantyId={offeredWarrantyId}
            onSelect={setOfferedWarrantyId}
          />
        ) : null
      }
    />
  );

  const banners = (
    <>
      {origins.apptActive && origins.pendingAppt && (
        <ModeBanner
          icon={<CalendarDays size={18} />}
          title={`Cobrando turno: ${origins.pendingAppt.service_name}`}
          text={`${origins.pendingAppt.customers?.name ? `Cliente: ${origins.pendingAppt.customers.name}. ` : ""}Sumá productos extra si hace falta y cobrá normalmente.`}
          exitLabel="Cancelar cobro del turno"
          onExit={origins.exitAppointmentMode}
        />
      )}
      {origins.tableActive && (
        <ModeBanner
          icon={<Utensils size={18} />}
          title="Cobrando mesa"
          text="Pedido cargado desde el Salón. Al confirmar, la mesa queda libre."
          exitLabel="Cancelar cobro de la mesa"
          onExit={origins.exitTableMode}
        />
      )}
      {origins.deliveryActive && origins.deliveryOrder && (
        <ModeBanner
          tone="info"
          icon={<Bike size={18} />}
          title={`Cobrando ${origins.deliveryOrder.order_type === "takeaway" ? "take away" : "delivery"}${origins.deliveryOrder.customer_name ? ` · ${origins.deliveryOrder.customer_name}` : ""}`}
          text="El costo de envío se suma al total. Al confirmar, el pedido queda entregado."
          exitLabel="Cancelar cobro del pedido"
          onExit={origins.exitDeliveryMode}
        />
      )}
    </>
  );

  const center =
    preset === "caja_rapida" ? (
      <QuickScanPane
        ref={searchRef}
        search={search}
        onSearch={onSearch}
        onScan={() => setScanOpen(true)}
        onEnter={quickEnter}
        pendingQty={pendingQty}
        onClearQty={() => setPendingQty(1)}
        results={products}
        onPick={(p) => {
          onPickProduct(p);
          setSearch("");
        }}
        canFreeSale={canFreeSale}
        onFreeSale={() => setFreeOpen(true)}
        ticket={cartLines}
      />
    ) : (
      <ProductPane
        layout={effectiveLayout}
        search={search}
        onSearch={onSearch}
        onScan={() => setScanOpen(true)}
        searchRef={searchRef}
        canFreeSale={canFreeSale}
        onFreeSale={() => setFreeOpen(true)}
        menuBar={menuBar}
        categories={categories ?? []}
        categoryFilter={categoryFilter}
        onCategory={setCategoryFilter}
        quickKeys={showFavorites ? quickKeys : []}
        quickKeysTitle={layout.quickKeys.length > 0 ? "Teclas rápidas" : "Favoritos"}
        frequent={showFrequent && !categoryFilter && !menuFilter ? topProducts : undefined}
        categoryPath={categoryPath}
        products={products}
        loading={productsLoading}
        onPickProduct={onPickProduct}
        onQuickUnits={favQuickUnits}
        onQuickWeight={favQuickWeight}
      />
    );

  return (
    <>
      <PosShell
        layout={effectiveLayout}
        topBar={
          <PosTopBar
            hasShift={hasShift}
            registerName={register?.name ?? null}
            location={
              <PosLocationPicker
                lockedReason={
                  lines.length > 0
                    ? "Terminá o vaciá la venta en curso para cambiar de sucursal o caja."
                    : shift && shift.opened_by === currentUserId
                      ? "Tenés esta caja abierta: cerrala para cambiar de sucursal o caja."
                      : null
                }
              />
            }
            onOpenShift={() => setOpenShiftModal(true)}
            onCloseShift={() => setCloseShiftModal(true)}
            onCustomerDisplay={openCustomerDisplay}
            preset={preset}
            usingOwn={hasUserOverride && Boolean(userLayout.preset)}
            diningEnabled={Boolean(diningEnabled)}
            onPickPreset={pickPreset}
            onResetPreset={() => saveUser.mutate(null)}
          />
        }
        banners={banners}
        center={center}
        rail={
          effectiveLayout.categoryBar === "left" && (categories ?? []).length > 0 ? (
            <CategoryRail categories={categories ?? []} selected={categoryFilter} onSelect={setCategoryFilter} />
          ) : undefined
        }
        tables={preset === "salon" ? <SalonTablesConnected activeOrderId={origins.tableOrderId} /> : undefined}
        cartTitle={cartTitle}
        cartLines={cartLines}
        cartSummary={cartSummary}
        itemCount={itemCount}
        total={total + origins.deliveryFee}
        canCheckout={canCheckout}
        onCheckout={() => startCheckout()}
        onClear={() => {
          clear();
          pricing.clearCoupon();
          setOfferedWarrantyId("");
        }}
        linesInCenter={preset === "caja_rapida"}
        aside={
          preset === "caja_rapida" && effectiveLayout.keypad ? (
            <QuickKeypadPanel onKey={onQuickKey} onTimes={onQuickTimes} onEnter={quickEnter} />
          ) : undefined
        }
        checkoutOpen={checkoutOpen}
      />

      <CustomerPickerDialog
        open={custOpen}
        onOpenChange={(o) => {
          setCustOpen(o);
          if (!o) setCustSearch("");
        }}
        search={custSearch}
        onSearch={setCustSearch}
        customers={customers}
        current={customer}
        onPick={(c) => {
          setCustomer(c);
          setCustOpen(false);
        }}
        onScanDni={() => setDniOpen(true)}
      />

      <MountWhenOpened open={dniOpen}>
        <DniScanModal open={dniOpen} onOpenChange={setDniOpen} onConfirm={quickAddFromDni} />
      </MountWhenOpened>

      {discountGate.modal}
      <MountWhenOpened open={openShiftModal}>
        <OpenShiftModal
          open={openShiftModal}
          onOpenChange={setOpenShiftModal}
          onConfirm={handleOpenShift}
          loading={open.isPending}
          locationLabel={locationLabel(registerStore, register)}
        />
      </MountWhenOpened>
      <MountWhenOpened open={closeShiftModal}>
        <CloseShiftModal
          open={closeShiftModal}
          onOpenChange={setCloseShiftModal}
          onConfirm={handleCloseShift}
          loading={close.isPending}
          locationLabel={locationLabel(registerStore, register)}
        />
      </MountWhenOpened>

      {/* Cobro único: todos los medios, pago dividido, propina y promo por medio. */}
      <MountWhenOpened open={checkoutOpen}>
        <CheckoutSheetConnected
          open={checkoutOpen}
          onOpenChange={setCheckoutOpen}
          base={rawTotal}
          rounding={rounding}
          deliveryFee={origins.deliveryFee}
          cartPromo={pricing.cartPromo}
          promoForMethod={pricing.promoForMethod}
          tenders={tenders}
          customerId={customer?.id ?? null}
          prefs={layout.payments}
          initialTenderId={checkoutTender}
          initialWarrantyId={offeredWarrantyId}
          storeCreditBalance={scBalance ?? 0}
          splitItems={pricing.splitItems}
          tipPresets={layout.tipPresets}
          quickCash={layout.payments.quickCash}
          keypad={layout.keypad}
          checkout={layout.checkout}
          style={accentVars(effectiveLayout.accent)}
          loading={saving}
          onConfirm={handleSale}
          onQrState={handleQrState}
        />
      </MountWhenOpened>

      <MountWhenOpened open={ticketOpen}>
        <TicketModal open={ticketOpen} onOpenChange={setTicketOpen} saleId={ticketId} autoPrint={autoPrint} />
      </MountWhenOpened>
      <MountWhenOpened open={voucherOpen}>
        <VoucherRedeemModal open={voucherOpen} onOpenChange={setVoucherOpen} customer={customer} storeId={register?.store_id ?? null} />
      </MountWhenOpened>
      <MountWhenOpened open={sellPackOpen}>
        <SellPackModal
          open={sellPackOpen}
          onOpenChange={setSellPackOpen}
          onPick={(p) => {
            addPack(p);
            toast({ title: `Pack "${p.name}" agregado`, variant: "success" });
          }}
        />
      </MountWhenOpened>
      <MountWhenOpened open={scanOpen}>
        <BarcodeScanner open={scanOpen} onOpenChange={setScanOpen} onDetected={(code) => setSearch(code)} />
      </MountWhenOpened>
      <MountWhenOpened open={variantProduct !== null}>
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
              categoryId: variantProduct.categoryId ?? null,
            });
            setVariantProduct(null);
          }}
        />
      </MountWhenOpened>
      <MountWhenOpened open={modifierProduct !== null}>
        <ModifierPickerModal
          product={modifierProduct}
          onClose={() => setModifierProduct(null)}
          onConfirm={({ price, modifiers, modifiersLabel }) => {
            if (!modifierProduct) return;
            addWithModifiers({
              id: modifierProduct.id,
              name: modifierProduct.name,
              sku: modifierProduct.sku,
              price,
              modifiers,
              modifiersLabel,
              warrantyMonths: modifierProduct.warrantyMonths ?? 0,
              categoryId: modifierProduct.categoryId ?? null,
            });
            setModifierProduct(null);
          }}
        />
      </MountWhenOpened>
      <FreeSaleDialog
        open={freeOpen}
        onOpenChange={setFreeOpen}
        amount={freeAmount}
        onAmount={setFreeAmount}
        name={freeName}
        onName={setFreeName}
        onConfirm={confirmFreeAmount}
      />
      <WeighDialog
        product={weighProduct}
        grams={weighGrams}
        onGrams={setWeighGrams}
        onClose={() => setWeighProduct(null)}
        onConfirm={confirmWeigh}
      />
      <SerialDialog
        product={serialProduct}
        serials={serialList}
        choice={serialChoice}
        onChoice={setSerialChoice}
        other={serialOther}
        onOther={setSerialOther}
        onClose={() => setSerialProduct(null)}
        onConfirm={confirmSerial}
      />
    </>
  );
}

// useSearchParams (cobro desde turno, mesa, delivery) requiere Suspense.
export default function PosPage() {
  return (
    <Suspense fallback={null}>
      <PosPageInner />
    </Suspense>
  );
}
