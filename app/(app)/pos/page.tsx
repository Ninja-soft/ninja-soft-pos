"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import type { Route } from "next";
import { Bike, CalendarDays, ClipboardList, FileSignature, Hourglass, PackageCheck, Pause, Utensils } from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import {
  useProducts,
  useProductsByIds,
  useTopProducts,
  useFavoriteProducts,
  useProductSerials,
  useCategories,
} from "@/modules/products/hooks";
import { useWarrantyCatalog } from "@/modules/warranty/hooks";
import { buildWarrantyTargets } from "@/lib/warranty/pos";
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
import { useBranchContext, useBranchScope } from "@/modules/branches/hooks";
import { usePosBranchStock } from "@/modules/pos/branchStock";
import { branchQty, branchStockCheck, branchShortfalls, otherBranchesStock, otherBranchesText } from "@/lib/stock/posBranchStock";
import { formatQty } from "@/lib/utils/format";
import { branchErrorMessage, liveRegisters, locationLabel } from "@/modules/branches/logic";
import { PosLocationPicker } from "@/components/branches/PosLocationPicker";
import { useRegisterHeartbeat } from "@/modules/branches/heartbeat";
import { ForeignShiftBanner, useShiftOwnership } from "@/components/branches/ForeignShiftBanner";
import {
  usePosBootSnapshot,
  usePosLayout,
  usePosLayoutMutations,
  useResolvedTenders,
  useTendersReady,
} from "@/modules/pos/layoutHooks";
import { effectivePreset, posBootKey, posBootScope, safeLocalStorage, writePosBoot } from "@/lib/pos/bootCache";
import { useReconciled } from "@/hooks/useReconciled";
import { PosBootSkeleton } from "@/components/pos/screen/PosBootSkeleton";
import { useScanner } from "@/modules/pos/useScanner";
import { useFeature } from "@/modules/saas/gating";
import { useAppointmentDeposits } from "@/modules/agenda/hooks";
import { depositAvailable } from "@/modules/agenda/deposits";
import { useFeatureGate } from "@/components/saas/GatedAction";
import { WarrantyOfferCard } from "@/components/pos/WarrantyOfferCard";
import { useProductsWithModifiers } from "@/modules/products/modifiers";
import { productsApi, variantLabel, type Product } from "@/modules/products/api";
import { subtreeIds } from "@/components/pos/CategoryNav";
import { MenuFilterBar } from "@/components/pos/MenuFilterBar";
import { useApplyDuePrices, usePriceResolver } from "@/modules/prices/proHooks";
import { usePricingContext } from "@/lib/prices/pricingContext";
import { useCartReprice } from "@/modules/pos/screen/useCartReprice";
import { PosPriceContextBar } from "@/components/pos/PosPriceContextBar";
import { selectList } from "@/lib/prices/resolve";
import { useDiningEnabled } from "@/modules/dining/hooks";
import { useCatalogMode, useServiceClarifications, useServiceProducts } from "@/modules/services/hooks";
import { defaultServicePeriod } from "@/lib/catalog/mode";
import { ServicePeriodBar } from "@/components/pos/ServicePeriodBar";
import { ServiceLineModal } from "@/components/pos/ServiceLineModal";
import { useMenus, useActiveMenuIds, useMenuProductIds } from "@/modules/menus/hooks";
import { useCustomerPackCredits } from "@/modules/packs/hooks";
import type { CustomerPackCredit } from "@/modules/packs/api";
import { MountWhenOpened } from "@/components/ui/MountWhenOpened";
import { useTicketBranding } from "@/modules/tickets/hooks";
import { brandDisplayName } from "@/lib/branding/businessName";
import {
  publishDisplayState,
  type DisplayBranding,
  type DisplayQr,
  type DisplayTransfer,
  type DisplayState,
} from "@/lib/pos/customerDisplay";
import { lineSubtotal } from "@/modules/pos/store";
import { pinnedTenders } from "@/lib/pos/tenders";
import { isTenderAllowedOffline } from "@/lib/pos/offline/policy";
import type { OfflineQueueEntry } from "@/lib/pos/offline/queue";
import { useOfflinePos } from "@/modules/pos/offline/useOfflinePos";
import { OfflineBanner } from "@/components/pos/offline/OfflineBanner";
import { OfflineTicketModal } from "@/components/pos/offline/OfflineTicketModal";
import { SwUpdateBanner } from "@/components/pwa/SwUpdateBanner";
import { PRESET_DEFAULTS, type PosPreset } from "@/lib/pos/layout";
import { PosShell } from "@/components/pos/screen/PosShell";
import { PosTopBar } from "@/components/pos/screen/PosTopBar";
import { matchPosShortcut } from "@/lib/pos/shortcuts";
import { ModeBanner } from "@/components/pos/screen/ModeBanner";
import { ArcaPosIndicator } from "@/components/arca/ArcaPosIndicator";
import { ProductPane } from "@/components/pos/screen/ProductPane";
import { CartLines, CartSummary } from "@/components/pos/screen/CartPane";
import { QuickKeypadPanel, QuickScanPane } from "@/components/pos/screen/QuickScanPane";
import { CategoryRail } from "@/components/pos/ui/CategoryBar";
import { applyKey, type KeypadKey } from "@/components/pos/ui/Keypad";
import { accentVars } from "@/components/pos/ui/posStyles";
import type { OpenPriceTarget, PriceOverrideTarget } from "@/components/pos/screen/PosDialogs";
import { isOpenPrice, openPriceRange } from "@/lib/prices/openPrice";
import { toPick, type PickInput, type ResolvedQuickKey } from "@/components/pos/screen/types";
import { usePosOrigins } from "@/modules/pos/screen/usePosOrigins";
import { useQuoteOrigin } from "@/modules/quotes/useQuoteOrigin";
import { QuoteCartButton } from "@/components/quotes/QuoteCartButton";
import { usePosPricing } from "@/modules/pos/screen/usePosPricing";
import { cartToSaleLines, usePosSale } from "@/modules/pos/screen/usePosSale";
import { formatCurrency } from "@/lib/utils/format";
import { usePosPark, type EditingCharge } from "@/modules/pos/screen/usePosPark";
import { usePosPause } from "@/modules/pos/screen/usePosPause";
import { usePriceRefresh } from "@/modules/pos/screen/usePriceRefresh";
import { SaleActions } from "@/components/pos/screen/SaleActions";
import { PausedSalesBar } from "@/components/paused-sales/PausedSalesBar";
import type { PausedCart, PausedSale } from "@/modules/paused-sales/logic";
import { buildPausedCart } from "@/modules/paused-sales/logic";
// H32 (ADR-129): pedidos de salón (vendedor arma, caja cobra) y disponible sin lo reservado.
import { useOrderOrigin } from "@/modules/orders/useOrderOrigin";
import { useOrderConfig, useReservedStock, useSaleOrders } from "@/modules/orders/hooks";
import { useFulfillmentSources } from "@/modules/pos/fulfillment";
import { deliverySummary, fulfillmentLines, groupDeliveries, shippingFeeOf, type DeliveryChoice, type PlanPayload } from "@/lib/stock/fulfillment";
import type { RemitoSource } from "@/components/remitos/RemitoIssueModal";
import type { FulfillmentState } from "@/components/pos/fulfillment/FulfillmentModal";
import { DeliveriesDoneModal, DeliveryBar } from "@/components/pos/fulfillment/DeliveryBar";
import type { CreateSaleResult } from "@/modules/pos/api";
import { OrdersBar } from "@/components/orders/OrdersBar";
import { DELIVERY_TYPE_LABEL, availableStock, reservationLabel } from "@/lib/orders/logic";
import { useProfessionals } from "@/modules/pos/hooks";
import { useProfessionalsForPosStore } from "@/modules/branches/staffHooks";
import { usePendingChargesWatcher } from "@/components/pending-charges/usePendingChargesWatcher";
import { usePendingChargeMutations } from "@/modules/pending-charges/hooks";
import { pendingChargesApi, cancelAtProvider } from "@/modules/pending-charges/api";
import {
  buildSaleItemsAndExtras,
  closeShiftDecision,
  PARK_BLOCK_COPY,
  pendingChargeErrorCopy,
  restorableCart,
  type PendingCharge,
} from "@/modules/pending-charges/logic";
import type { CartLine } from "@/modules/pos/store";
import { Modal } from "@/components/ui/Modal";
import { usePosHardware } from "@/modules/hardware/pos";
import { scaleLine } from "@/lib/barcode/scaleLabel";
import { ScaleLiveWeight } from "@/components/hardware/ScaleLiveWeight";
import { PosDrawerButton } from "@/components/hardware/PosDrawerButton";

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
const loadQuickCustomer = () => import("@/components/customers/QuickCustomerModal");
const loadSalon = () => import("@/components/pos/screen/SalonTablesConnected");
// Diálogos chicos (cliente, venta libre, peso, serie, precio), ventas pausadas y
// atajos: tampoco hacen falta para pintar la primera pantalla.
const loadPosDialogs = () => import("@/components/pos/screen/PosDialogs");
const loadPausedDialogs = () => import("@/components/paused-sales/PausedSaleDialogs");
const loadPausedPanel = () => import("@/components/paused-sales/PausedSalesPanel");
const loadShortcutsHelp = () => import("@/components/pos/PosShortcutsHelp");

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
const QuickCustomerModal = dynamic(() => loadQuickCustomer().then((m) => m.QuickCustomerModal), { ssr: false });
const SalonTablesConnected = dynamic(() => loadSalon().then((m) => m.SalonTablesConnected), { ssr: false });
const CustomerPickerDialog = dynamic(() => loadPosDialogs().then((m) => m.CustomerPickerDialog), { ssr: false });
const FreeSaleDialog = dynamic(() => loadPosDialogs().then((m) => m.FreeSaleDialog), { ssr: false });
const PriceOverrideDialog = dynamic(() => loadPosDialogs().then((m) => m.PriceOverrideDialog), { ssr: false });
const OpenPriceDialog = dynamic(() => loadPosDialogs().then((m) => m.OpenPriceDialog), { ssr: false });
const SerialDialog = dynamic(() => loadPosDialogs().then((m) => m.SerialDialog), { ssr: false });
const WeighDialog = dynamic(() => loadPosDialogs().then((m) => m.WeighDialog), { ssr: false });
const ClearBlockedDialog = dynamic(() => loadPausedDialogs().then((m) => m.ClearBlockedDialog), { ssr: false });
const ClearConfirmDialog = dynamic(() => loadPausedDialogs().then((m) => m.ClearConfirmDialog), { ssr: false });
const IntentWaitDialog = dynamic(() => loadPausedDialogs().then((m) => m.IntentWaitDialog), { ssr: false });
const PausedOnCloseDialog = dynamic(() => loadPausedDialogs().then((m) => m.PausedOnCloseDialog), { ssr: false });
const SwitchSaleDialog = dynamic(() => loadPausedDialogs().then((m) => m.SwitchSaleDialog), { ssr: false });
const PausedSalesPanel = dynamic(() => loadPausedPanel().then((m) => m.PausedSalesPanel), { ssr: false });
// ADR-122: "Presupuesto" junto a Cobrar (chunk aparte, se baja al abrirlo).
const QuoteFromCartModal = dynamic(() => import("@/components/quotes/QuoteFromCartModal").then((m) => m.QuoteFromCartModal), { ssr: false });
// H32 (ADR-129): "Pedido" junto a Pausar (chunk aparte, se baja al abrirlo).
const OrderFromCartModal = dynamic(() => import("@/components/orders/OrderFromCartModal").then((m) => m.OrderFromCartModal), { ssr: false });
// ADR-136: entregas de la venta (chunk aparte, se baja al abrirlo).
const FulfillmentModal = dynamic(() => import("@/components/pos/fulfillment/FulfillmentModal").then((m) => m.FulfillmentModal), { ssr: false });
// ADR-146: entrega dentro de la hoja de cobro y remito después de cobrar.
const CheckoutDeliveryBlock = dynamic(
  () => import("@/components/pos/checkout/CheckoutDeliveryBlock").then((m) => m.CheckoutDeliveryBlock),
  { ssr: false },
);
// Pestaña "Ítems" de la hoja de cobro (cantidad, precio y comentario por renglón).
const CheckoutItemsBlock = dynamic(
  () => import("@/components/pos/checkout/CheckoutItemsBlock").then((m) => m.CheckoutItemsBlock),
  { ssr: false },
);
const RemitoIssueModal = dynamic(() => import("@/components/remitos/RemitoIssueModal").then((m) => m.RemitoIssueModal), { ssr: false });
const RemitoDetailModal = dynamic(() => import("@/components/remitos/RemitoDetailModal").then((m) => m.RemitoDetailModal), { ssr: false });
const PosShortcutsHelp = dynamic(() => loadShortcutsHelp().then((m) => m.PosShortcutsHelp), { ssr: false });
// Cobros en espera (ADR-048): la pestaña se abre como hoja dentro del POS.
const PendingChargesPanel = dynamic(
  () => import("@/components/pending-charges/PendingChargesPanel").then((m) => m.PendingChargesPanel),
  { ssr: false },
);

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
    loadPosDialogs,
    loadPausedDialogs,
    loadPausedPanel,
    loadShortcutsHelp,
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
  // El diseño efectivo depende de varias consultas (settings, override del
  // usuario, overrides por sucursal/caja, modo gastronómico). Para no pintar el
  // preset por defecto y saltar al real: el primer cuadro usa la foto guardada
  // en este dispositivo (usuario + negocio + caja) y, sin foto, un esqueleto
  // neutro. Al llegar el servidor se reconcilia (sólo cambia si es distinto).
  const liveLayout = usePosLayout();
  const { user: userLayout, hasUserOverride } = liveLayout;
  const { saveUser } = usePosLayoutMutations();
  const { data: diningEnabled, isFetched: diningFetched } = useDiningEnabled();
  const branchCtx = useBranchContext();
  const bootScope = useBranchScope().data ?? null;
  const currentUserId = bootScope?.userId ?? null;
  const { data: register, store: registerStore, isFetched: registerFetched } = useDefaultRegister();
  const bootKey = posBootKey(bootScope?.tenantId ?? null, currentUserId, registerFetched ? (register?.id ?? null) : null);
  const boot = usePosBootSnapshot(registerFetched ? bootKey : null, posBootScope(bootScope?.tenantId ?? null, currentUserId));
  // Salón requiere el modo gastronómico: sin él cae a Mostrador.
  const layoutLive = liveLayout.ready && (liveLayout.layout.preset !== "salon" || diningFetched);
  const resolvedLayout = layoutLive ? effectivePreset(liveLayout.layout, diningEnabled) : (boot?.layout ?? null);
  const shownLayout = useReconciled(resolvedLayout);
  const layout = shownLayout ?? PRESET_DEFAULTS.mostrador;
  const effectiveLayout = layout;
  const preset = layout.preset;
  const usingOwn = liveLayout.ready ? hasUserOverride && Boolean(userLayout.preset) : (boot?.usingOwn ?? false);
  // Red de seguridad: si alguna consulta no responde, no dejar el esqueleto.
  const [bootTimedOut, setBootTimedOut] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setBootTimedOut(true), 6000);
    return () => clearTimeout(t);
  }, []);

  // ── Estado de la pantalla ───────────────────────────────────────────────────
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const [openShiftModal, setOpenShiftModal] = useState(false);
  const [closeShiftModal, setCloseShiftModal] = useState(false);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [checkoutTender, setCheckoutTender] = useState<string | null>(null);
  // Garantía pre-seleccionada por la oferta contextual (H28).
  const [offeredWarrantyId, setOfferedWarrantyId] = useState("");
  // Tickets abiertos (ADR-111). Con "Imprimir ticket al cobrar" el de la venta
  // recién cobrada es silencioso (imprime solo, con CAE si es fiscal) y puede
  // seguir esperando a ARCA mientras se cobra la siguiente: por eso es una
  // lista y no un único ticket.
  const [tickets, setTickets] = useState<{ key: number; saleId: string; silent: boolean; open: boolean }[]>([]);
  const ticketSeq = useRef(0);
  const openTicket = useCallback((saleId: string, silent = false) => {
    ticketSeq.current += 1;
    const key = ticketSeq.current;
    setTickets((list) => [...list.filter((t) => t.saleId !== saleId), { key, saleId, silent, open: true }]);
  }, []);
  const closeTicket = useCallback((key: number) => {
    setTickets((list) => list.map((t) => (t.key === key ? { ...t, open: false } : t)));
    // Se desmonta después de la animación de cierre.
    setTimeout(() => setTickets((list) => list.filter((t) => t.key !== key)), 400);
  }, []);
  // Cobros en espera (ADR-048): hoja de la pestaña y cobro en edición.
  const [pendingOpen, setPendingOpen] = useState(false);
  const [pendingInitialId, setPendingInitialId] = useState<string | null>(null);
  const [editingCharge, setEditingCharge] = useState<EditingCharge | null>(null);
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

  // Venta offline (ADR-077): conectividad, foto local, cola y sincronización.
  const { data: offShift } = useOpenShift();
  const { data: offSettings } = usePosSettings();
  const [offlineTicket, setOfflineTicket] = useState<OfflineQueueEntry | null>(null);
  const offline = useOfflinePos({
    tenantId: bootScope?.tenantId ?? null,
    userId: currentUserId,
    shiftId: offShift?.id ?? null,
    storeId: register?.store_id ?? null,
    policy: offSettings?.offlinePolicy,
    onSynced: (r) => {
      if (r.stopped === "auth") {
        toast({ title: "Iniciá sesión de nuevo para enviar las ventas offline", variant: "error" });
        return;
      }
      const parts = [
        r.synced > 0 ? `${r.synced} registrada${r.synced === 1 ? "" : "s"}` : null,
        r.conflicts > 0 ? `${r.conflicts} con diferencias` : null,
        r.review > 0 ? `${r.review} para revisar` : null,
        r.held > 0 ? `${r.held} retenida${r.held === 1 ? "" : "s"} en este dispositivo` : null,
      ].filter(Boolean);
      toast({
        title: "Ventas offline sincronizadas",
        description: parts.join(", "),
        variant: r.review > 0 || r.held > 0 ? "info" : "success",
      });
    },
  });

  // Filtro por rubro = sub-árbol (en cliente); el de menú combina encima.
  // Sin conexión, la búsqueda sale de la foto local del catálogo.
  const { data: liveProducts, isFetching: productsLoading } = useProducts(search);
  const { isOffline: posOffline, searchProducts: searchOffline } = offline;
  const offlineProducts = useMemo(
    () => (posOffline ? searchOffline(search) : null),
    [posOffline, searchOffline, search],
  );
  const allProducts = offlineProducts ?? liveProducts;
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
  // F17 · H99: señal de esta caja para el monitor de sucursales.
  // Arranca con el turno ya resuelto: antes salía una señal sin turno y otra
  // apenas llegaba (dos RPC en el arranque).
  useRegisterHeartbeat(shiftFetched ? (register?.id ?? null) : null, shift?.id ?? null);
  const { open, close } = usePosMutations();
  const { data: myTenant, isFetched: myTenantFetched } = useMyTenant();
  // Rubro y rol cambian piezas visibles (frecuentes, venta libre): hasta que
  // llegan se usa lo de la foto del arranque.
  const quickSale = myTenantFetched ? verticalHas(myTenant?.industry, "quickSale") : (boot?.quickSale ?? false);
  // Descuentos manuales: feature de plan (Pro). Sin ella el campo queda bloqueado.
  const discountGate = useFeatureGate("descuentos", "Descuentos");
  // ADR-122: presupuestos (OPTIONAL Pro+; la base lo exige en quote_save).
  const quoteGate = useFeatureGate("presupuestos", "Presupuestos");
  const [quoteOpen, setQuoteOpen] = useState(false);
  // H32 (ADR-129): pedidos de salón (OPTIONAL Pro+; la base lo exige en sale_order_create).
  const orderGate = useFeatureGate("pedidos_despacho", "Pedidos de salón");
  const ordersFeature = useFeature("pedidos_despacho");
  const [orderOpen, setOrderOpen] = useState(false);
  const { data: posSettings, isFetched: posSettingsFetched } = usePosSettings();
  const offerWarranty = posSettings?.offerWarranty ?? true;
  // Garantías extendidas (ADR-139): los tipos y su alcance se piden recién con
  // algo en el carrito (antes, en cada arranque del POS) y si el plan las incluye.
  const cartHasLines = useCartStore((s) => s.lines.length > 0);
  const warrantyFeature = useFeature("garantias");
  const { data: warrantyCatalog } = useWarrantyCatalog(cartHasLines && warrantyFeature === true);
  const role = myTenant?.role ?? "cashier";
  // Venta libre (H36): flag del negocio Y sólo owner/manager.
  const allowFreeSale = posSettings?.allowFreeSale ?? true;
  const liveFreeSale = allowFreeSale && (role === "owner" || role === "manager");
  const canFreeSale = myTenantFetched && posSettingsFetched ? liveFreeSale : (boot?.freeSale ?? false);
  const maxDiscPct = posSettings?.maxDiscount?.[role] ?? 100;
  const rounding = posSettings?.rounding ?? 0;
  const requireCustomer = posSettings?.requireCustomer ?? false;
  const [customer, setCustomer] = useState<{ id: string; name: string } | null>(null);
  const [custOpen, setCustOpen] = useState(false);
  const [dniOpen, setDniOpen] = useState(false);
  const [newCustOpen, setNewCustOpen] = useState(false);
  const [newCustSearch, setNewCustSearch] = useState("");
  const [voucherOpen, setVoucherOpen] = useState(false);
  const [sellPackOpen, setSellPackOpen] = useState(false);
  const [custSearch, setCustSearch] = useState("");
  const custSearchDebounced = useDebouncedValue(custSearch, 300);
  const { data: customers } = useCustomersForPicker(custSearchDebounced, custOpen);
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
  // Cobro por transferencia en curso: datos de la cuenta (ADR-055).
  const [displayTransfer, setDisplayTransfer] = useState<DisplayTransfer | null>(null);
  const handleTransferState = useCallback((t: DisplayTransfer | null) => setDisplayTransfer(t), []);
  const [paidView, setPaidView] = useState<{ change: number } | null>(null);
  const paidTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const displayBranding = useMemo<DisplayBranding>(
    () => ({
      // ADR-124: el cliente ve el nombre de fantasía (si no, el de la cuenta).
      businessName: dispBranding ? brandDisplayName(dispBranding, "") || null : null,
      logoUrl: dispBranding?.logo_url ?? null,
      accent: dispBranding?.accent ?? null,
      // Con varias sucursales, "Centro · Caja 1"; con una, sólo la caja.
      registerLabel:
        branchCtx.isMulti && registerStore ? locationLabel(registerStore, register ?? null) : (register?.name ?? null),
      welcomeMessage: posSettings?.displayWelcomeMessage ?? null,
      thanksMessage: posSettings?.displayThanksMessage ?? null,
      showUnitPrices: posSettings?.displayShowUnitPrices ?? true,
    }),
    [dispBranding, register, registerStore, branchCtx.isMulti, posSettings],
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
  // F18 · H100 (ADR-056): cambio manual de precio con motivo.
  const setLinePrice = useCartStore((s) => s.setLinePrice);
  const [priceTarget, setPriceTarget] = useState<PriceOverrideTarget | null>(null);
  // ADR-151: precio a definir al cobrar. Al agregar (pick) o al editar la línea.
  const addOpenPrice = useCartStore((s) => s.addOpenPrice);
  const setOpenLinePrice = useCartStore((s) => s.setOpenLinePrice);
  const [openPick, setOpenPick] = useState<
    { pick: PickInput; qty: number; lineId?: undefined } | { pick?: undefined; qty?: undefined; lineId: string } | null
  >(null);
  const [openTarget, setOpenTarget] = useState<OpenPriceTarget | null>(null);
  function askOpenPrice(p: PickInput, qty: number) {
    const r = openPriceRange({ price_mode: p.price_mode, open_price_min: p.open_price_min, open_price_max: p.open_price_max, price: p.price });
    setOpenPick({ pick: p, qty });
    setOpenTarget({ name: p.name, min: r.min, max: r.max, suggested: r.suggested, isService: p.is_service });
  }
  function confirmOpenPrice(price: number) {
    if (openPick?.pick) {
      const p = openPick.pick;
      const r = openPriceRange({ price_mode: p.price_mode, open_price_min: p.open_price_min, open_price_max: p.open_price_max, price: p.price });
      addOpenPrice(
        { id: p.id, name: p.name, sku: p.sku, unit: p.unit, warrantyMonths: p.warranty_months ?? 0, categoryId: p.categoryId ?? null },
        price,
        r,
        openPick.qty,
      );
    } else if (openPick?.lineId) {
      setOpenLinePrice(openPick.lineId, price);
    }
    setOpenPick(null);
    setOpenTarget(null);
  }
  function openPriceEdit(lineId: string) {
    const l = useCartStore.getState().lines.find((x) => x.lineId === lineId);
    if (!l) return;
    if (l.openPrice) {
      setOpenPick({ lineId });
      setOpenTarget({ name: l.name, ...l.openPrice, current: l.unitPrice });
      return;
    }
    setPriceTarget({
      lineId,
      name: l.name,
      unitPrice: l.unitPrice,
      listPrice: l.listPrice ?? l.unitPrice,
      reason: l.overrideReason ?? "",
    });
  }
  const clear = useCartStore((s) => s.clear);
  // ADR-116: servicios profesionales. Con el catálogo en servicios (o mixto),
  // cada renglón de servicio admite aclaraciones para la factura y la venta
  // pide el período del servicio y el vencimiento del pago (ARCA, concepto 2/3).
  const { mode: catalogMode } = useCatalogMode();
  const servicesOn = catalogMode !== "productos";
  const serviceProducts = useServiceProducts(servicesOn);
  const { data: activeClarifications = [] } = useServiceClarifications(true, servicesOn);
  const servicePeriod = useCartStore((s) => s.servicePeriod);
  const setServicePeriod = useCartStore((s) => s.setServicePeriod);
  const setLineService = useCartStore((s) => s.setLineService);
  const [serviceLineId, setServiceLineId] = useState<string | null>(null);
  const isServiceLine = useCallback(
    (l: CartLine) => Boolean(servicesOn && l.productId && serviceProducts.map.has(l.productId)),
    [servicesOn, serviceProducts.map],
  );

  // Precio de lista (ADR-058): el mismo resolver que el servidor, con la foto de
  // precios de la sucursal y el cliente y la lista o condición elegidas acá.
  // Contra una base sin la migración, la lista 'mostrador' de siempre.
  useApplyDuePrices();
  // Espera a la caja: sin esto la foto se pedía una vez sin sucursal y otra
  // con la sucursal real.
  const priceResolver = usePriceResolver({
    storeId: register?.store_id ?? null,
    customerId: customer?.id ?? null,
    enabled: registerFetched,
  });
  const resetPricingContext = usePricingContext((s) => s.reset);
  useEffect(() => () => resetPricingContext(), [resetPricingContext]);
  function priceFor(productId: string, variantId: string | null, basePrice: number, qty = 1): number {
    return priceResolver.priceFor({
      productId,
      variantId,
      basePrice,
      variantPrice: variantId ? basePrice : null,
      qty,
    });
  }

  // Tocar un producto: variante, serial, opciones o peso abren su picker; si no,
  // va directo al carrito (precio por lista mostrador). `qty` sólo aplica a
  // productos simples por unidad (Caja rápida).
  function pickProduct(p: PickInput, qty = 1) {
    // ADR-151: precio a definir al cobrar (producto simple o servicio): se pide
    // el precio antes de sumarlo. Con variantes, serie, opciones o peso sigue el
    // camino de siempre (el precio de venta queda como sugerido).
    if (isOpenPrice(p) && !p.has_variants && !p.is_serialized && !withMods?.has(p.id) && p.unit !== "kg") {
      if (!branchStockGate(p.id, null, qty)) return;
      askOpenPrice(p, qty);
      return;
    }
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
      if (!branchStockGate(p.id, null, qty)) return;
      addProduct({ ...p, price: priceFor(p.id, null, p.price, qty), warrantyMonths: p.warranty_months ?? 0 }, qty);
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
    if (isOpenPrice(p)) {
      pickProduct(toPick(p), qty);
      return;
    }
    if (!branchStockGate(p.id, null, qty)) return;
    addProduct({ id: p.id, name: p.name, sku: p.sku, price: priceFor(p.id, null, p.price, qty), unit: p.unit, warrantyMonths: p.warranty_months ?? 0, categoryId: p.category_id }, qty);
  }
  function favQuickWeight(p: Product, kg: number) {
    if (!branchStockGate(p.id, null, kg)) return;
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
    if (!branchStockGate(weighProduct.id, null, grams / 1000)) return;
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
  // ADR-122: cobro de un presupuesto (/pos?quote=<id>).
  const quoteOrigin = useQuoteOrigin({ setCustomer });
  // H32 (ADR-129): cobro de un pedido de salón (/pos?order=<id>). El carrito se
  // carga con la misma función que retoma una venta pausada (se asigna abajo).
  const applyCartRef = useRef<(c: PausedCart) => void>(() => undefined);
  const resetSaleRef = useRef<() => void>(() => undefined);
  const orderOrigin = useOrderOrigin({
    applyCart: (c) => applyCartRef.current(c),
    resetSale: () => resetSaleRef.current(),
    offline: offline.isOffline,
  });
  // Lista con la que se vende (misma regla que el servidor): la usan las promos por lista.
  const appliedList = useMemo(() => {
    const w = priceResolver.world;
    return w ? selectList(w, Date.now(), null, priceResolver.listId) : null;
  }, [priceResolver.world, priceResolver.listId]);
  const pricing = usePosPricing({
    rounding,
    customerId: customer?.id ?? null,
    storeId: register?.store_id ?? null,
    priceListId: appliedList?.id ?? null,
  });
  // Repreciado al cambiar lista, condición, cliente o cantidad (no en mesa ni delivery).
  const cartReprice = useCartReprice({
    enabled: Boolean(priceResolver.world) && !origins.tableActive && !origins.deliveryActive,
    resolve: priceResolver.resolve,
  });
  const appliedListName = appliedList?.name ?? null;
  const { lines, discountTotal, subtotal, total, rawTotal } = pricing;
  // ADR-116: la venta lleva servicios (pide período y vencimiento).
  const hasServiceLines = servicesOn && lines.some(isServiceLine);
  const serviceLine = serviceLineId ? lines.find((l) => l.lineId === serviceLineId) ?? null : null;
  // ADR-088: seña del turno que se cobra. Entra como pago fijo en la hoja y
  // create_sale exige ese pago 'sena' (sin cobrar dos veces).
  const { data: apptDeposits } = useAppointmentDeposits(origins.appointmentId);
  const apptAvailable = depositAvailable(apptDeposits ?? []);
  const apptPrepaid = useMemo(
    () => (apptAvailable > 0 ? { amount: apptAvailable, label: "Seña del turno" } : null),
    [apptAvailable],
  );

  // ── Stock de la sucursal del POS (F17 · H94) ───────────────────────────────
  // Con 2+ sucursales y stock_sucursales, la grilla muestra el saldo de ESTA
  // sucursal (con lo que hay en las otras) y al agregar se avisa o se bloquea
  // (según "vender sin stock", que puede ser distinto por sucursal) cuando no
  // alcanza acá, aunque el total del negocio sí alcance.
  const trackedIds = useMemo(() => {
    const set = new Set<string>();
    for (const p of allProducts ?? []) if (p.track_stock) set.add(p.id);
    for (const p of topProducts ?? []) if (p.track_stock) set.add(p.id);
    return set;
  }, [allProducts, topProducts]);
  const trackedSeen = useRef<Set<string>>(new Set());
  for (const id of trackedIds) trackedSeen.current.add(id);
  const cartProductKey = lines
    .map((l) => l.productId)
    .filter((id): id is string => Boolean(id))
    .sort()
    .join(",");
  const stockIds = useMemo(
    () => [...new Set([...(products ?? []).map((p) => p.id), ...(cartProductKey ? cartProductKey.split(",") : [])])],
    [products, cartProductKey],
  );
  const branchStock = usePosBranchStock(stockIds);
  const allowNegativeStock = posSettings?.allowNegativeStock ?? true;
  // H32 (ADR-129): lo reservado vigente (pedidos de salón y reservas) no se
  // muestra como disponible. Con stock por sucursal, lo de ESTA sucursal; si
  // no, lo reservado en todo el negocio contra el total.
  // Se pide con pedidos_despacho (la RPC llega con su migración); sin ella el
  // servidor igual bloquea vender lo reservado (ADR-096).
  const reservedStock = useReservedStock(branchStock.enabled ? branchStock.storeId : null, ordersFeature === true);
  const shownProducts = useMemo(() => {
    if (!products) return products;
    const reservedOf = (id: string) => reservedStock.byProduct.get(id) ?? 0;
    const withReserved = <T extends { id: string; stock: number; track_stock: boolean; stockHint?: string | null }>(p: T): T => {
      const r = reservedOf(p.id);
      if (!p.track_stock || r <= 0) return p;
      return {
        ...p,
        stock: availableStock(p.stock, r),
        stockHint: `${p.stockHint ? `${p.stockHint} · ` : ""}Reservado: ${formatQty(r)}`,
      };
    };
    if (!branchStock.loaded || !branchStock.storeId) {
      return reservedStock.byProduct.size > 0 ? products.map((p) => withReserved(p)) : products;
    }
    const storeId = branchStock.storeId;
    return products.map((p) => {
      if (!p.track_stock) return p;
      const others = otherBranchesText(
        otherBranchesStock(branchStock.rows, p.id, storeId, branchStock.names),
        (n) => formatQty(n),
      );
      return withReserved({
        ...p,
        stock: branchStock.qtyByProduct.get(p.id) ?? 0,
        stockHint: others ? `En otras sucursales: ${others}` : "Sin stock en otras sucursales",
      });
    });
  }, [products, branchStock.loaded, branchStock.storeId, branchStock.rows, branchStock.qtyByProduct, branchStock.names, reservedStock.byProduct]);

  function branchStockGate(productId: string, variantId: string | null, adding: number): boolean {
    const storeId = branchStock.storeId;
    if (!branchStock.loaded || !storeId || !trackedSeen.current.has(productId)) return true;
    // H32: sin lo reservado por otros (al cobrar un pedido o un retiro, su
    // propia reserva no cuenta: lo valida el servidor).
    const ownReservation = Boolean(orderOrigin.reservationId || origins.reservationId);
    const have =
      branchQty(branchStock.rows, storeId, productId, variantId) -
      (ownReservation ? 0 : (reservedStock.byProduct.get(productId) ?? 0));
    const inCart = useCartStore
      .getState()
      .lines.filter((l) => l.productId === productId && (variantId === null || (l.variantId ?? null) === variantId))
      .reduce((acc, l) => acc + (Number(l.quantity) || 0), 0);
    const check = branchStockCheck({ have, inCart, adding, allowNegative: allowNegativeStock });
    if (check === "ok") return true;
    const others = otherBranchesText(
      otherBranchesStock(branchStock.rows, productId, storeId, branchStock.names),
      (n) => formatQty(n),
    );
    const where = branchStock.storeName ?? "esta sucursal";
    const detail = `En ${where} quedan ${formatQty(Math.max(have, 0))}.${others ? ` En otras sucursales: ${others}.` : ""}`;
    if (check === "block") {
      // ADR-136: con stock en otra sucursal o depósito habilitado, se agrega y
      // al cobrar se elige de dónde sale (Entregas). El servidor valida.
      if (fulfillEnabled && others) {
        toast({ title: `No alcanza en ${where}`, description: `${detail} Al cobrar elegí de dónde sale en Entregas.`, variant: "info" });
        return true;
      }
      toast({ title: `Sin stock suficiente en ${where}`, description: detail, variant: "error" });
      return false;
    }
    toast({ title: `Queda en negativo en ${where}`, description: detail, variant: "info" });
    return true;
  }

  // ADR-136: ¿algún renglón no alcanza en esta sucursal? (sin avisar).
  function branchShortfallExists(): boolean {
    const storeId = branchStock.storeId;
    if (allowNegativeStock || !branchStock.loaded || !storeId) return false;
    return branchShortfalls(lines, branchStock.rows, storeId, trackedSeen.current).length > 0;
  }

  // Al cobrar: si la sucursal no permite vender sin stock, se corta antes de
  // mandar la venta (el carrito pudo cambiar de cantidad después de agregar).
  function branchStockBlocksSale(): boolean {
    const storeId = branchStock.storeId;
    if (allowNegativeStock || !branchStock.loaded || !storeId) return false;
    const short = branchShortfalls(lines, branchStock.rows, storeId, trackedSeen.current);
    if (short.length === 0) return false;
    const names = short
      .map((s) => lines.find((l) => l.productId === s.productId)?.name ?? "Producto")
      .slice(0, 3)
      .join(", ");
    toast({
      title: `Sin stock suficiente en ${branchStock.storeName ?? "esta sucursal"}`,
      description: `${names}${short.length > 3 ? " y otros" : ""}. Ajustá las cantidades o pedí un traslado.`,
      variant: "error",
    });
    return true;
  }

  // ADR-096 / ADR-139: líneas con garantías disponibles según el alcance de
  // cada tipo (producto > categoría > todos), con el precio ya calculado. La
  // garantía se enlaza a una de ellas (con serie primero, después la más cara).
  // ── Entregas (ADR-136): vender de otra sucursal o depósito y partir la
  // entrega (retira ahora, retira en una sucursal o envío). Sin reparto, la
  // venta va por create_sale como siempre. ─────────────────────────────────
  const entregasFeature = useFeature("entregas_remitos");
  const { config: orderCfg } = useOrderConfig(entregasFeature === true);
  const posStoreId = register?.store_id ?? branchStock.storeId ?? null;
  const fulfillEnabled =
    entregasFeature === true &&
    Boolean(posStoreId) &&
    !offline.isOffline &&
    !origins.tableOrderId &&
    !origins.deliveryOrderId &&
    !origins.reservationId &&
    !orderOrigin.active;
  const productMeta = useMemo(() => {
    const map = new Map<string, { track: boolean; kit: boolean }>();
    for (const p of [...(allProducts ?? []), ...(topProducts ?? [])]) {
      map.set(p.id, { track: Boolean(p.track_stock), kit: Boolean((p as { is_kit?: boolean }).is_kit) });
    }
    return map;
  }, [allProducts, topProducts]);
  // Foto de cada línea para la pestaña "Ítems" de la hoja de cobro (lo que ya
  // está cargado en el POS; sin foto, ícono).
  const productImages = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of [...(allProducts ?? []), ...(topProducts ?? []), ...(quickKeyProducts ?? [])]) {
      const url = (p as { image_url?: string | null }).image_url;
      if (url) map.set(p.id, url);
    }
    return map;
  }, [allProducts, topProducts, quickKeyProducts]);
  const imageForLine = useCallback(
    (l: CartLine) => (l.productId ? productImages.get(l.productId) ?? null : null),
    [productImages],
  );
  const fLines = useMemo(
    () =>
      fulfillEnabled
        ? fulfillmentLines(lines, (id) => {
            const line = lines.find((l) => l.productId === id);
            if (line && isServiceLine(line)) return { service: true, localOnly: true };
            const meta = productMeta.get(id);
            const tracked = meta ? meta.track : trackedSeen.current.has(id);
            return { service: false, localOnly: !tracked || Boolean(meta?.kit) };
          })
        : [],
    [fulfillEnabled, lines, productMeta, isServiceLine],
  );
  const [fulfillOpen, setFulfillOpen] = useState(false);
  const [fulfill, setFulfill] = useState<FulfillmentState | null>(null);
  // ADR-146: entrega elegida en la hoja de cobro (null = se lo lleva ahora),
  // lo que falta para cobrarla y si el bloque ya pidió los orígenes con stock.
  const [deliveryChoice, setDeliveryChoice] = useState<DeliveryChoice | null>(null);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);
  const [deliverySourcesWanted, setDeliverySourcesWanted] = useState(false);
  const [remitoIssue, setRemitoIssue] = useState<RemitoSource | null>(null);
  const [remitoOpen, setRemitoOpen] = useState<string | null>(null);
  // Domicilio de cada envío del último cobro (para precargar el remito).
  const lastShipAddress = useRef<Map<string, string>>(new Map());
  const customerNameAtSale = useRef<string | null>(null);
  const [doneDeliveries, setDoneDeliveries] = useState<{ saleNumber: number; list: NonNullable<CreateSaleResult["deliveries"]> } | null>(null);
  const planRef = useRef<PlanPayload | null>(null);
  // Cobro que esperaba el reparto (no alcanzaba en esta sucursal).
  const pendingChargeRef = useRef<unknown[] | null>(null);
  const fSources = useFulfillmentSources(
    posStoreId,
    fLines.map((l) => ({ product_id: l.productId, variant_id: l.variantId })),
    fulfillEnabled && (fulfillOpen || (checkoutOpen && deliverySourcesWanted)),
  );
  const fulfillRules = useMemo(
    () => ({
      storeId: posStoreId ?? "",
      retiroEnabled: ordersFeature === true && orderCfg.delivery_types.retiro.enabled,
      envioEnabled: ordersFeature === true && orderCfg.delivery_types.envio.enabled,
      retiroCrossBranch: orderCfg.delivery_types.retiro.cross_branch,
    }),
    [posStoreId, ordersFeature, orderCfg],
  );
  const fulfillGroups = useMemo(
    () => (fulfill && planRef.current ? groupDeliveries(fulfill.allocations, fulfillRules.storeId) : []),
    [fulfill, fulfillRules.storeId],
  );
  const storeNameOf = (id: string) => branchStock.names.get(id) ?? (id === posStoreId ? (branchStock.storeName ?? "Esta sucursal") : "Otra sucursal");
  const fulfillStores = useMemo(
    () =>
      [...branchStock.names.entries()]
        .map(([id, name]) => ({ id, name }))
        .concat(posStoreId && !branchStock.names.has(posStoreId) ? [{ id: posStoreId, name: branchStock.storeName ?? "Esta sucursal" }] : []),
    [branchStock.names, branchStock.storeName, posStoreId],
  );
  const fulfillSummary = planRef.current && fulfillGroups.length > 0 ? deliverySummary(fulfillGroups, storeNameOf, fulfill?.info) : null;
  // ADR-146: costo de envío (renglón "Envío" que agrega el servidor). Va en la
  // base del cobro, antes del redondeo, igual que en create_sale.
  const shipFee = deliveryChoice?.kind === "envio" && planRef.current ? shippingFeeOf(deliveryChoice.fee) : 0;
  const clearDelivery = () => {
    planRef.current = null;
    setFulfill(null);
    setDeliveryChoice(null);
    setDeliveryError(null);
  };
  // El reparto deja de valer si cambia el carrito (cantidades o productos).
  const fLinesKey = fLines.map((l) => `${l.key}:${l.quantity}`).join(",");
  useEffect(() => {
    if (!fulfill) return;
    const fits =
      fLines.length > 0 &&
      fLines.every(
        (l) => Math.abs(fulfill.allocations.filter((a) => a.key === l.key).reduce((t, a) => t + a.qty, 0) - l.quantity) < 0.0005,
      ) &&
      fulfill.allocations.every((a) => fLines.some((l) => l.key === a.key));
    if (!fits) {
      planRef.current = null;
      setFulfill(null);
      setDeliveryChoice(null);
      setDeliveryError(null);
      if (fLines.length > 0) toast({ title: "Cambió el carrito: volvé a repartir las entregas", variant: "info" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fLinesKey]);

  // ADR-096: la garantía extendida se enlaza a una de estas líneas (con serie primero).
  const warrantyTargets = useMemo(
    () =>
      warrantyFeature === true && warrantyCatalog
        ? buildWarrantyTargets(lines, warrantyCatalog.plans, warrantyCatalog.scopes, categories ?? [])
        : [],
    [lines, warrantyCatalog, categories, warrantyFeature],
  );
  // Si ya no queda un producto elegible, descartá la garantía pre-seleccionada.
  const hasEligibleWarranty = warrantyTargets.length > 0;
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

  // ADR-051 (H114): el turno de otra persona no cuenta como caja abierta propia.
  const shiftOwnership = useShiftOwnership(shift);
  const hasShift = Boolean(shift) && shiftOwnership.usable;

  // Balanza y cajón de esta caja con las reglas de su sucursal (ADR-063).
  const posHw = usePosHardware(register?.id ?? null, register?.store_id ?? null, hasShift);

  // Publica el estado a la pantalla del cliente (H25).
  useEffect(() => {
    const phase: DisplayState["phase"] = paidView
      ? "paid"
      : displayQr || displayTransfer
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
      transfer: displayTransfer,
      at: Date.now(),
    });
  }, [lines, subtotal, discountTotal, total, displayBranding, displayQr, displayTransfer, paidView]);

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
    // Etiqueta de balanza (H23, ADR-063): EAN-13 con prefijo 20-29 y precio o
    // peso embebido según el formato de la sucursal.
    const scan = await posHw.scanScaleLabel(code);
    if (scan) {
      if (scan.kind === "error") {
        toast({ title: scan.message, variant: "error" });
        return true;
      }
      const p = scan.product;
      const price = priceFor(p.id, null, p.price);
      const line = scaleLine(scan.decoded, price);
      if (!line) {
        toast({ title: `${p.name} no tiene precio por kilo: cargalo para vender con etiqueta`, variant: "error" });
        return true;
      }
      if (!branchStockGate(p.id, null, line.quantityKg)) return true;
      addWeighed({ id: p.id, name: p.name, sku: p.sku, price, categoryId: p.category_id }, line.quantityKg);
      return true;
    }
    const offlineHit = offline.isOffline ? offline.findByCode(code) : null;
    const res = offline.isOffline
      ? offlineHit
        ? { product: offlineHit, variant: undefined }
        : null
      : await productsApi.findByCode(code);
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

  async function handleCloseShift(
    closing: number,
    notes: string,
    pendingAction: "cancel" | "carry" | null,
    zeroCloseReason?: string | null,
  ) {
    if (!shift) return;
    // Cobros en espera del turno que se cancelan: baja en el proveedor después.
    const toCancel = pendingAction === "cancel"
      ? pendingWatch.open.filter((c) => c.cash_shift_id === shift.id && c.status === "waiting")
      : [];
    try {
      const diff = await close.mutateAsync({ shiftId: shift.id, closing, notes, pendingAction, zeroCloseReason });
      for (const c of toCancel) void cancelAtProvider(c.provider_key, c.channel, c.intent_id);
      setCloseShiftModal(false);
      toast({ title: "Caja cerrada", description: `Diferencia: ${formatCurrency(diff)}`, variant: diff === 0 ? "success" : "info" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : undefined;
      const known =
        msg &&
        (msg.includes("close_needs_reason") ||
          msg.includes("pending_charges_decision_required") ||
          msg.includes("close_zero_needs_confirmation"));
      toast({
        title: msg && msg.includes("close_needs_reason")
          ? "Escribí un motivo: la diferencia supera la tolerancia"
          : msg && msg.includes("close_zero_needs_confirmation")
            ? "Contaste $0 y el sistema espera efectivo: volvé a contar o escribí por qué cerrás así"
          : msg && msg.includes("pending_charges_decision_required")
            ? pendingChargeErrorCopy(msg)
            : "No se pudo cerrar",
        description: known ? undefined : msg,
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

  // ── Pausar venta (ADR-106) ─────────────────────────────────────────────────
  // El hook se arma más abajo (necesita totales y el cobro); los callbacks de
  // la venta y los atajos lo leen por ref.
  const pauseRef = useRef<ReturnType<typeof usePosPause>>(null as unknown as ReturnType<typeof usePosPause>);
  const sheetPauseRef = useRef<(() => void) | null>(null);
  const sheetClearRef = useRef<(() => void) | null>(null);
  const [pausedOpen, setPausedOpen] = useState(false);
  const [pausedClose, setPausedClose] = useState<PausedSale[] | null>(null);
  // Cupón de una venta retomada: se vuelve a aplicar solo (el servidor lo valida).
  const [autoCoupon, setAutoCoupon] = useState<string | null>(null);
  const handlePriceMismatchRaw = usePriceRefresh();

  // ── Cobros en espera (ADR-048) ─────────────────────────────────────────────
  const pcMut = usePendingChargeMutations();
  const parkFeature = useFeature("cobros_en_espera");
  const pendingWatch = usePendingChargesWatcher({
    storeId: register?.store_id ?? null,
    // Siempre: aunque el plan ya no incluya la función, los cobros que quedaron
    // abiertos se tienen que poder ver, cobrar y decidir al cerrar la caja.
    enabled: true,
    onPrint: (saleId) => openTicket(saleId),
    // Factura electrónica todavía no disponible: se abre el comprobante (con
    // email y PDF). Cuando exista AFIP, este es el punto de entrada.
    onInvoice: (saleId) => {
      openTicket(saleId);
      toast({ title: "La factura electrónica llega con la integración con ARCA. Por ahora enviá o imprimí el comprobante.", variant: "info" });
    },
    onOpen: (id) => {
      setPendingInitialId(id);
      setPendingOpen(true);
    },
  });
  const parkBlockedReason = offline.isOffline
    ? "Sin conexión no se puede dejar un cobro en espera"
    : parkFeature === false
      ? PARK_BLOCK_COPY.feature_off
      : !hasShift
        ? PARK_BLOCK_COPY.no_shift
        : origins.tableOrderId || origins.deliveryOrderId
          ? PARK_BLOCK_COPY.table_or_delivery
          : origins.appointmentId
            ? PARK_BLOCK_COPY.appointment
            : origins.reservationId
              ? "Los retiros de reservas se cobran en el momento."
              : orderOrigin.active
                ? "Los pedidos de salón se cobran en el momento."
                : deliveryChoice
                  ? "Las ventas con retiro, envío o entrega repartida se cobran en el momento."
                  : null;
  const parker = usePosPark({
    lines,
    discountTotal,
    customer,
    salePromo: pricing.salePromo,
    couponId: pricing.couponDiscount > 0 ? pricing.appliedCoupon?.coupon_id ?? null : null,
    couponCode: pricing.appliedCoupon?.code ?? null,
    editing: editingCharge,
    onParked: () => {
      // ADR-106: una pausada retomada que se deja en espera sigue como cobro en espera.
      pauseRef.current.onSaleDone(null);
      setCheckoutOpen(false);
      clear();
      setCustomer(null);
      setOfferedWarrantyId("");
      pricing.clearCoupon();
      setEditingCharge(null);
    },
  });
  const closePending = shift ? closeShiftDecision(pendingWatch.open, shift.id) : null;

  // "Editar en el POS": el carrito del cobro vuelve al POS; al generar el QR
  // nuevo, "Actualizar cobro en espera" le cambia carrito, monto y link.
  function editPendingCharge(c: PendingCharge) {
    if (useCartStore.getState().lines.length > 0) {
      toast({ title: "Terminá o vaciá la venta en curso para editar un cobro en espera", variant: "error" });
      return;
    }
    const snap = restorableCart(c.cart);
    if (!snap) {
      toast({ title: "Este cobro no guardó el carrito: cancelalo y cobrá de nuevo", variant: "error" });
      return;
    }
    useCartStore.setState({ lines: snap.lines as unknown as CartLine[], discountTotal: snap.discountTotal });
    setCustomer(snap.customer);
    if (snap.couponCode) {
      pricing.setCouponInput(snap.couponCode);
      toast({ title: `Volvé a aplicar el cupón ${snap.couponCode}`, variant: "info" });
    }
    setEditingCharge({ id: c.id, version: c.version, provider: c.provider_key, number: c.id.slice(0, 6) });
    setPendingOpen(false);
  }
  const editRef = useRef(editPendingCharge);
  editRef.current = editPendingCharge;

  // ADR-068: ítems para la vista previa de percepciones (los mismos de create_sale).
  const taxPreviewItems = useMemo(
    () =>
      buildSaleItemsAndExtras(cartToSaleLines(lines), []).items.map((i) => ({
        product_id: i.product_id,
        variant_id: i.variant_id ?? null,
        quantity: i.quantity,
        unit_price: i.unit_price,
        discount: i.discount,
      })),
    [lines],
  );

  const { handleSale, saving } = usePosSale({
    lines,
    discountTotal,
    customerId: customer?.id ?? null,
    tableOrderId: origins.tableOrderId,
    deliveryOrderId: origins.deliveryOrderId,
    appointmentId: origins.appointmentId,
    reservationId: origins.reservationId ?? orderOrigin.reservationId,
    salePromo: pricing.salePromo,
    couponId: pricing.couponDiscount > 0 ? pricing.appliedCoupon?.coupon_id ?? null : null,
    // ADR-116: sólo con servicios en el carrito.
    service: hasServiceLines ? (servicePeriod ?? defaultServicePeriod()) : null,
    // ADR-136: reparto de entregas y aviso con los códigos de retiro.
    fulfillmentRef: planRef,
    onDeliveries: (list, saleNumber) => {
      // Domicilio de cada envío (por sucursal de origen) para el remito.
      const addr = new Map<string, string>();
      for (const d of planRef.current?.deliveries ?? []) {
        const origin = d.items[0]?.source_store_id;
        if (d.mode === "envio" && d.ship_address && origin) addr.set(origin, d.ship_address);
      }
      lastShipAddress.current = addr;
      customerNameAtSale.current = customer?.name ?? null;
      setDoneDeliveries({ saleNumber, list });
    },
    onSuccess: ({ saleId, change, hadCash }) => {
      clearDelivery();
      setDeliverySourcesWanted(false);
      // Cajón al cobrar en efectivo (ADR-063): la venta ya está; un fallo sólo avisa.
      void posHw.openOnSale(saleId, hadCash).then((warn) => {
        if (warn) toast({ title: warn, variant: "info" });
      });
      // Se cobró en el momento lo que estaba en espera: el cobro viejo se cancela.
      if (editingCharge) {
        const ed = editingCharge;
        setEditingCharge(null);
        void pendingChargesApi
          .get(ed.id)
          .then((c) => (c ? pcMut.cancel.mutateAsync({ charge: c, reason: "Cobrado en el momento" }) : null))
          .catch(() =>
            toast({ title: "Revisá el cobro en espera que estabas editando: no se pudo cancelar", variant: "error" }),
          );
      }
      setCheckoutOpen(false);
      clear();
      setCustomer(null);
      setOfferedWarrantyId("");
      pricing.clearCoupon();
      origins.afterSale();
      quoteOrigin.afterSale(saleId);
      orderOrigin.afterSale(saleId);
      // ADR-106: si era una venta pausada retomada, queda completada.
      pauseRef.current.onSaleDone(saleId);
      flashPaidScreen(change);
      openTicket(saleId, autoPrint);
    },
    // ADR-077: sin conexión la venta va a la cola local con ticket provisorio.
    offline,
    onOfflineSuccess: ({ entry, change }) => {
      setCheckoutOpen(false);
      clear();
      setCustomer(null);
      setOfferedWarrantyId("");
      pricing.clearCoupon();
      origins.afterSale();
      quoteOrigin.afterSale(null);
      orderOrigin.afterSale(null);
      pauseRef.current.onSaleDone(null);
      flashPaidScreen(change);
      setOfflineTicket(entry);
    },
    // H32: la reserva del pedido venció o el carrito ya no la cubre.
    onError: (msg) => orderOrigin.onSaleError(msg),
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
  const liveTenders = useResolvedTenders({ hasCustomer: customer !== null, storeCreditBalance: scBalance ?? 0 });
  // ADR-077: sin conexión sólo efectivo, transferencia y tarjeta en posnet.
  const tenders = useMemo(
    () => (offline.isOffline ? liveTenders.filter(isTenderAllowedOffline) : liveTenders),
    [offline.isOffline, liveTenders],
  );
  const livePinned = useMemo(() => pinnedTenders(tenders, layout.payments), [tenders, layout.payments]);
  const tendersReady = useTendersReady();
  const pinned = useReconciled(
    useMemo(
      () =>
        tendersReady || !boot
          ? livePinned.map((t) => ({ id: t.id, group: t.group, label: t.label, logo: t.logo }))
          : boot.pinned,
      [tendersReady, boot, livePinned],
    ),
  );
  // Estado de la caja: hasta que llega el turno se muestra el último conocido.
  const shiftKnown = shiftFetched && shiftOwnership.ready;
  const shiftShown = shiftKnown ? hasShift : (boot?.shiftOpen ?? false);
  const locationSnap = useMemo(
    () =>
      registerStore
        ? {
            full: locationLabel(registerStore, register ?? null),
            short: locationLabel(registerStore, register ?? null, true),
            color: registerStore.color ?? null,
            pickable:
              branchCtx.allowed.filter((b) => b.is_active).length > 1 ||
              liveRegisters(registerStore.registers).length > 1,
          }
        : null,
    [registerStore, register, branchCtx.allowed],
  );
  // Todo lo que define el primer cuadro ya llegó del servidor.
  const bootLive =
    layoutLive && shiftKnown && tendersReady && branchCtx.ready && registerFetched && myTenantFetched && posSettingsFetched;
  const canPaint = bootLive || Boolean(boot) || bootTimedOut;
  useEffect(() => {
    if (!bootLive || !bootKey || !resolvedLayout) return;
    writePosBoot(safeLocalStorage(), bootKey, {
      layout: resolvedLayout,
      dining: Boolean(diningEnabled),
      usingOwn,
      location: locationSnap,
      shiftOpen: hasShift,
      pinned,
      freeSale: canFreeSale,
      quickSale,
    });
  }, [bootLive, bootKey, resolvedLayout, diningEnabled, usingOwn, locationSnap, hasShift, pinned, canFreeSale, quickSale]);
  const canCheckout = hasShift && lines.length > 0;
  function startCheckout(tenderId?: string) {
    if (shiftOwnership.foreign) {
      toast({ title: "Esta caja la tiene abierta otra persona", description: "Elegí otra caja arriba y abrila a tu nombre.", variant: "error" });
      return;
    }
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

  const editParam = searchParams.get("editar");
  useEffect(() => {
    if (!editParam) return;
    router.replace("/pos", { scroll: false });
    void pendingChargesApi
      .get(editParam)
      .then((c) => (c ? editRef.current(c) : null))
      .catch(() => toast({ title: "No se encontró el cobro en espera", variant: "error" }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editParam]);

  // Atajos de teclado (TX-3, lib/pos/shortcuts.ts): F2 busca, F4 cliente,
  // F8 cobros en espera, F9 (o F12) cobra y "?" abre la ayuda. Con un diálogo
  // abierto sólo se atiende la ayuda: el resto queda para ese diálogo.
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const checkoutOpenRef = useRef(checkoutOpen);
  checkoutOpenRef.current = checkoutOpen;
  const shortcutRef = useRef<(a: ReturnType<typeof matchPosShortcut>) => boolean>(() => false);
  shortcutRef.current = (action) => {
    switch (action) {
      case "search":
        searchRef.current?.focus();
        searchRef.current?.select();
        return true;
      case "checkout":
        startCheckoutRef.current();
        return true;
      case "customer":
        setCustOpen(true);
        return true;
      case "pause":
        if (checkoutOpen) sheetPauseRef.current?.();
        else void pauseRef.current.pause();
        return true;
      case "clear":
        if (pauseRef.current.dialogs.clearConfirm) pauseRef.current.confirmClear();
        else if (checkoutOpen) sheetClearRef.current?.();
        else pauseRef.current.requestClear();
        return true;
      case "pending":
        if (parkFeature === false && pendingWatch.open.length === 0) return false;
        setPendingInitialId(null);
        setPendingOpen(true);
        return true;
      case "help":
        setShortcutsOpen(true);
        return true;
      default:
        return false;
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = matchPosShortcut(e, e.target as HTMLElement | null);
      if (!action) return;
      const dialogOpen = Boolean(document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]'));
      // ADR-106: pausar y limpiar también andan con la hoja de cobro (o el QR)
      // abierta, y Shift + F4 confirma la limpieza pedida.
      const allowed =
        action === "help" ||
        (action === "pause" && checkoutOpenRef.current) ||
        // ADR-146: F4 elige el cliente también desde la hoja de cobro (si no hay otro diálogo encima).
        (action === "customer" &&
          checkoutOpenRef.current &&
          document.querySelectorAll('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]').length <= 1) ||
        (action === "clear" && (checkoutOpenRef.current || Boolean(pauseRef.current.dialogs.clearConfirm)));
      if (dialogOpen && !allowed) return;
      if (shortcutRef.current(action)) e.preventDefault();
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

  // ADR-106: mesa, delivery, turno, reserva y cobro en espera tienen su propio
  // guardado (o su cierre atómico): esas ventas no se pausan.
  const pauseBlockedReason =
    origins.tableOrderId || origins.deliveryOrderId
      ? "Las mesas y los pedidos ya quedan guardados: salí del cobro y retomalos desde el Salón o Pedidos."
      : origins.appointmentId
        ? "El cobro de un turno no se pausa: salí y cobralo desde la agenda cuando vuelva."
        : origins.reservationId
          ? "El retiro de una reserva no se pausa: la reserva sigue guardada."
          : orderOrigin.active
            ? "Un pedido no se pausa: salí sin cobrar y vuelve a la lista de pedidos."
            : editingCharge
            ? "Estás editando un cobro en espera: actualizalo o salí sin cambios."
            : deliveryChoice
              ? "Una venta con retiro, envío o entrega repartida no se pausa: volvé a Se lo lleva ahora para pausarla."
              : null;
  const pauser = usePosPause({
    storeId: register?.store_id ?? null,
    registerId: register?.id ?? null,
    shiftId: hasShift ? (shift?.id ?? null) : null,
    tenantId: bootScope?.tenantId ?? null,
    userId: currentUserId,
    offline: offline.isOffline,
    blockedReason: pauseBlockedReason,
    cartInput: () => {
      const st = useCartStore.getState();
      const pc = usePricingContext.getState();
      return {
        lines: st.lines,
        discountTotal: st.discountTotal,
        couponCode: pricing.appliedCoupon?.code ?? (pricing.couponInput.trim() || null),
        customer,
        offeredWarrantyId,
        pricing: { listId: pc.listId, termId: pc.termId },
        notes: null,
      };
    },
    // Mismos argumentos que create_sale (ADR-048): el servidor ensaya la venta al retomar.
    saleArgs: () => {
      const { items, extras } = buildSaleItemsAndExtras(cartToSaleLines(useCartStore.getState().lines), []);
      const promo = pricing.salePromo(null);
      const promoDisc = promo && promo.discount > 0 ? promo.discount : 0;
      const couponId = pricing.couponDiscount > 0 ? (pricing.appliedCoupon?.coupon_id ?? null) : null;
      return {
        items,
        extras,
        discount_total: useCartStore.getState().discountTotal,
        customer_id: customer?.id ?? null,
        ...(promoDisc > 0 ? { promo_discount: promoDisc, promo_id: promo?.id ?? null, promo_name: promo?.name ?? null } : {}),
        ...(couponId ? { coupon_id: couponId } : {}),
      };
    },
    total: total + origins.deliveryFee,
    itemCount,
    resetSale: () => {
      setCheckoutOpen(false);
      clear();
      setCustomer(null);
      setOfferedWarrantyId("");
      pricing.clearCoupon();
      setAutoCoupon(null);
      resetPricingContext();
    },
    applyCart: (c) => {
      useCartStore.setState({ lines: c.lines, discountTotal: c.discountTotal });
      setCustomer(c.customer);
      setOfferedWarrantyId(c.offeredWarrantyId);
      usePricingContext.getState().setList(c.pricing.listId);
      usePricingContext.getState().setTerm(c.pricing.termId);
      pricing.clearCoupon();
      if (c.couponCode) {
        pricing.setCouponInput(c.couponCode);
        setAutoCoupon(c.couponCode);
      }
    },
    priceFor: (productId, variantId, current, qty) =>
      priceResolver.world ? priceFor(productId, variantId, current, qty) : null,
    handlePriceMismatch: (e) => handlePriceMismatchRaw(e, useCartStore.getState().lines),
    openCheckout: () => startCheckoutRef.current(),
  });
  pauseRef.current = pauser;
  // H32: el pedido se carga y se limpia igual que una venta pausada.
  applyCartRef.current = (c) => {
    useCartStore.setState({ lines: c.lines, discountTotal: c.discountTotal });
    setCustomer(c.customer);
    setOfferedWarrantyId(c.offeredWarrantyId);
    usePricingContext.getState().setList(c.pricing.listId);
    usePricingContext.getState().setTerm(c.pricing.termId);
    pricing.clearCoupon();
    if (c.couponCode) {
      pricing.setCouponInput(c.couponCode);
      setAutoCoupon(c.couponCode);
    }
  };
  resetSaleRef.current = () => {
    setCheckoutOpen(false);
    clear();
    setCustomer(null);
    setOfferedWarrantyId("");
    pricing.clearCoupon();
    setAutoCoupon(null);
    resetPricingContext();
  };
  // Motivo por el que el carrito no se guarda como pedido (tiene su propio origen).
  const orderBlockedReason =
    origins.tableOrderId || origins.deliveryOrderId
      ? "Las mesas y el delivery se cobran desde su pantalla."
      : origins.appointmentId
        ? "El cobro de un turno no se guarda como pedido."
        : origins.reservationId
          ? "El retiro de una reserva ya tiene su reserva."
          : quoteOrigin.active
            ? "Estás cobrando un presupuesto."
            : orderOrigin.active
              ? "Ya estás cobrando un pedido."
              : editingCharge
                ? "Estás editando un cobro en espera."
                : null;
  const posStoreForOrders = register?.store_id ?? null;
  const { data: openOrders } = useSaleOrders(
    posStoreForOrders,
    true,
    ordersFeature === true && Boolean(posStoreForOrders) && !offline.isOffline,
  );
  const { data: allSellers } = useProfessionals();
  const orderSellers = useProfessionalsForPosStore(allSellers);
  function takeOrder(o: { id: string }) {
    if (useCartStore.getState().lines.length > 0) {
      toast({ title: "Pausá o limpiá la venta en curso para cobrar un pedido", variant: "info" });
      return;
    }
    router.push(`/pos?order=${o.id}` as Route);
  }
  useEffect(() => {
    if (!autoCoupon || pricing.couponInput.trim() !== autoCoupon) return;
    setAutoCoupon(null);
    void pricing.applyCoupon();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoCoupon, pricing.couponInput]);
  // Ventas pausadas de ESTE turno al cerrar la caja.
  function pausedOfShift(): PausedSale[] {
    if (!shift) return [];
    return pauser.all.filter((x) => x.cash_shift_id === shift.id && (x.status === "paused" || x.status === "resumed"));
  }
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
      promoByLine={pricing.promoByLine}
      dense={preset === "caja_rapida"}
      onQty={setQuantity}
      onRemove={removeLine}
      creditForLine={creditForLine}
      onCover={coverLineWithPack}
      onUncover={uncoverLine}
      onEditPrice={openPriceEdit}
      emptyHint={preset === "caja_rapida" ? "Escaneá un código o tipeá un PLU." : undefined}
      isServiceLine={servicesOn ? isServiceLine : undefined}
      onEditService={servicesOn ? setServiceLineId : undefined}
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
      promos={(pricing.cartPromo?.applied ?? []).map((a) => ({ label: a.label, amount: a.discount }))}
      coupon={pricing.appliedCoupon ? { code: pricing.appliedCoupon.code, amount: pricing.couponDiscount } : null}
      couponInput={pricing.couponInput}
      onCouponInput={pricing.setCouponInput}
      onApplyCoupon={pricing.applyCoupon}
      onRemoveCoupon={pricing.clearCoupon}
      deliveryFee={origins.deliveryFee}
      total={total}
      itemCount={itemCount}
      pinned={pinned}
      hasShift={shiftShown}
      shiftPending={!shiftKnown}
      canCheckout={canCheckout}
      checkingOut={saving}
      onCheckout={startCheckout}
      onOpenShift={() => setOpenShiftModal(true)}
      autoPrint={autoPrint}
      onAutoPrint={setAutoPrint}
      compact={preset === "caja_rapida"}
      quoteAction={
        <QuoteCartButton
          disabled={lines.length === 0 || origins.tableActive || origins.deliveryActive || quoteOrigin.active}
          locked={quoteGate.locked}
          onClick={() => quoteGate.run(() => setQuoteOpen(true))}
        />
      }
      actionsSlot={
        <SaleActions
          disabled={lines.length === 0}
          pauseBlocked={pauseBlockedReason}
          onPause={() => void pauser.pause()}
          onClear={() => pauser.requestClear()}
          // H32 (ADR-129): el vendedor deja el carrito como pedido para la caja.
          onOrder={
            preset === "caja_rapida" || ordersFeature === undefined
              ? undefined
              : () => orderGate.run(() => setOrderOpen(true))
          }
          orderLocked={orderGate.locked}
          orderBlocked={orderBlockedReason ?? (offline.isOffline ? "Sin conexión no se guardan pedidos." : null)}
          compact={preset === "caja_rapida"}
        />
      }
      serviceSlot={
        hasServiceLines ? (
          <ServicePeriodBar period={servicePeriod ?? defaultServicePeriod()} onChange={setServicePeriod} />
        ) : null
      }
      deliverySlot={
        fulfillEnabled && fLines.length > 0 && preset !== "caja_rapida" ? (
          <DeliveryBar
            summary={fulfillSummary}
            onOpen={() => setFulfillOpen(true)}
          />
        ) : null
      }
      priceSlot={
        priceResolver.world && !origins.tableActive && !origins.deliveryActive ? (
          <PosPriceContextBar
            lists={priceResolver.selectable}
            appliedListName={appliedListName}
            terms={priceResolver.terms}
            customerTermId={priceResolver.world.customerTermId}
            totalWithTerm={cartReprice.totalWithTerm}
          />
        ) : null
      }
      warrantySlot={
        offerWarranty ? (
          <WarrantyOfferCard
            targets={warrantyTargets}
            selectedWarrantyId={offeredWarrantyId}
            onSelect={setOfferedWarrantyId}
          />
        ) : null
      }
    />
  );

  const banners = (
    <>
      <OfflineBanner
        isOffline={offline.isOffline}
        pending={offline.pending}
        held={offline.held}
        syncing={offline.syncing}
        enabled={offline.policy.enabled}
        onRetry={() => void (offline.held > 0 ? offline.releaseHeld() : offline.syncNow())}
      />
      {/* H65 (ADR-087): versión nueva; no recarga con carrito o cobro en curso. */}
      <SwUpdateBanner busy={checkoutOpen || saving || lines.length > 0} />
      <ForeignShiftBanner shift={shift} />
      {/* ADR-106: ventas pausadas, a un toque de retomarlas. */}
      <PausedSalesBar
        list={pauser.list}
        busyId={pauser.busyId}
        onResume={(x) => void pauser.resume(x)}
        onOpenAll={() => setPausedOpen(true)}
      />
      {/* H32 (ADR-129): pedidos de salón esperando caja, a un toque de cobrarlos. */}
      {ordersFeature === true && hasShift && (
        <OrdersBar
          list={(openOrders ?? []).filter((o) => o.id !== orderOrigin.order?.id)}
          currentUserId={currentUserId}
          onTake={takeOrder}
        />
      )}
      {orderOrigin.order && (
        <ModeBanner
          icon={<ClipboardList size={18} />}
          title={`Cobrando el pedido N° ${orderOrigin.order.number}`}
          text={`${orderOrigin.order.seller_name ? `Vendedor: ${orderOrigin.order.seller_name}. ` : ""}${DELIVERY_TYPE_LABEL[orderOrigin.order.delivery_type]}. ${orderOrigin.order.reservation_active ? reservationLabel(orderOrigin.order) : orderOrigin.order.reservation_id ? "La reserva venció: se cobra si hay stock" : "Sin reserva de stock"}. Al cobrar, pasa a expedición.`}
          exitLabel="Salir sin cobrar"
          onExit={orderOrigin.exit}
        />
      )}
      {pauser.resumed && (
        <ModeBanner
          tone="info"
          icon={<Pause size={18} />}
          title={`Retomaste "${pauser.resumed.label}"`}
          text="Cobrala como siempre. Si el cliente se va de nuevo, volvé a pausarla: conserva el nombre y los pagos."
          exitLabel="Pausar de nuevo"
          onExit={() => void pauser.pause()}
        />
      )}
      {/* F3 · ADR-072: ARCA caído, facturando en contingencia (no bloquea). */}
      <ArcaPosIndicator />
      {editingCharge && (
        <ModeBanner
          tone="info"
          icon={<Hourglass size={18} />}
          title="Editando un cobro en espera"
          text="Cambiá lo que haga falta y generá el QR o link de nuevo: “Actualizar cobro en espera” reemplaza el link anterior. Si lo cobrás ahora con otro medio, el cobro en espera se cancela."
          exitLabel="Salir sin cambios"
          onExit={() => {
            setEditingCharge(null);
            clear();
            setCustomer(null);
            pricing.clearCoupon();
          }}
        />
      )}
      {origins.apptActive && origins.pendingAppt && (
        <ModeBanner
          icon={<CalendarDays size={18} />}
          title={`Cobrando turno: ${origins.pendingAppt.service_name}`}
          text={`${origins.pendingAppt.customers?.name ? `Cliente: ${origins.pendingAppt.customers.name}. ` : ""}${apptAvailable > 0 ? `Seña cobrada: ${formatCurrency(apptAvailable)} (se descuenta sola). ` : ""}Sumá productos extra si hace falta y cobrá normalmente.`}
          exitLabel="Cancelar cobro del turno"
          onExit={origins.exitAppointmentMode}
        />
      )}
      {quoteOrigin.active && (
        <ModeBanner
          icon={<FileSignature size={18} />}
          title={`Cobrando el presupuesto N° ${quoteOrigin.label}`}
          text={`${quoteOrigin.quote?.customer_name ? `Cliente: ${quoteOrigin.quote.customer_name}. ` : ""}Se cargó con los precios acordados. Al cobrar, el presupuesto queda convertido en esta venta.`}
          exitLabel="Salir sin cobrar"
          onExit={quoteOrigin.exit}
        />
      )}
      {origins.reservation && (
        <ModeBanner
          icon={<PackageCheck size={18} />}
          title={`Retiro de la reserva #${origins.reservation.number}`}
          text={`Cliente: ${origins.reservation.customer_name}. Cobrá los productos reservados: al confirmar, la reserva queda entregada con esta venta.`}
          exitLabel="Cancelar retiro"
          onExit={origins.exitReservationMode}
        />
      )}
      {origins.tableActive && (
        <ModeBanner
          icon={<Utensils size={18} />}
          title={origins.tableOrder?.split_label ? `Cobrando mesa · ${origins.tableOrder.split_label}` : "Cobrando mesa"}
          text={
            origins.tableOrder?.parent_order_id
              ? "Cuenta separada: se emite un ticket propio. La mesa sigue abierta hasta cobrar lo último."
              : "Pedido cargado desde el Salón. Al confirmar, la mesa queda libre."
          }
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
        products={shownProducts}
        loading={productsLoading}
        onPickProduct={onPickProduct}
        onQuickUnits={favQuickUnits}
        onQuickWeight={favQuickWeight}
      />
    );

  if (!canPaint) return <PosBootSkeleton />;

  return (
    <>
      <PosShell
        layout={effectiveLayout}
        topBar={
          <PosTopBar
            hasShift={shiftShown}
            shiftPending={!shiftKnown}
            registerName={register?.name ?? null}
            location={
              <PosLocationPicker
                placeholder={boot?.location ?? null}
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
            onCloseShift={() => {
              // ADR-077: las ventas offline del turno se envían antes del cierre.
              if (offline.isOffline || offline.pending > 0) {
                toast({
                  title: offline.isOffline
                    ? "Sin conexión no se puede cerrar la caja"
                    : "Enviá las ventas offline antes de cerrar la caja",
                  variant: "error",
                });
                if (!offline.isOffline) void offline.syncNow();
                return;
              }
              // ADR-106: avisar las ventas pausadas del turno antes del arqueo.
              const mine = pausedOfShift();
              if (mine.length > 0) {
                setPausedClose(mine);
                return;
              }
              setCloseShiftModal(true);
            }}
            onCustomerDisplay={openCustomerDisplay}
            onShortcuts={() => setShortcutsOpen(true)}
            drawerSlot={
              posHw.hasDrawer ? (
                <PosDrawerButton hw={posHw.hw} decision={posHw.noSaleDecision} open={posHw.opener} />
              ) : null
            }
            pausedSlot={
              pauser.list.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setPausedOpen(true)}
                  className="relative grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-fg-4 text-muted-foreground transition-colors hover:bg-fg-6 hover:text-foreground"
                  aria-label={`Ventas pausadas: ${pauser.list.length}`}
                  title="Ventas pausadas"
                >
                  <Pause size={18} aria-hidden />
                  <span className="absolute -right-1 -top-1 grid h-5 min-w-5 place-items-center rounded-md bg-[var(--pos-solid)] px-1 text-[11px] font-bold text-[color:var(--pos-on)]">
                    {pauser.list.length}
                  </span>
                </button>
              ) : undefined
            }
            pendingSlot={
              parkFeature !== false || pendingWatch.open.length > 0 ? (
                <button
                  type="button"
                  onClick={() => {
                    setPendingInitialId(null);
                    setPendingOpen(true);
                  }}
                  className="relative grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-fg-4 text-muted-foreground transition-colors hover:bg-fg-6 hover:text-foreground"
                  aria-label={`Cobros en espera${pendingWatch.waiting ? `: ${pendingWatch.waiting}` : ""}`}
                  title="Cobros en espera"
                >
                  <Hourglass size={18} aria-hidden />
                  {pendingWatch.waiting + pendingWatch.attention > 0 && (
                    <span
                      className={
                        "absolute -right-1 -top-1 grid h-5 min-w-5 place-items-center rounded-md px-1 text-[11px] font-bold " +
                        (pendingWatch.attention > 0
                          ? "bg-warning text-white"
                          : "bg-[var(--pos-solid)] text-[color:var(--pos-on)]")
                      }
                    >
                      {pendingWatch.waiting + pendingWatch.attention}
                    </span>
                  )}
                </button>
              ) : undefined
            }
            preset={preset}
            usingOwn={usingOwn}
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
        linesInCenter={preset === "caja_rapida"}
        aside={
          preset === "caja_rapida" && effectiveLayout.keypad ? (
            <QuickKeypadPanel onKey={onQuickKey} onTimes={onQuickTimes} onEnter={quickEnter} />
          ) : undefined
        }
        checkoutOpen={checkoutOpen}
      />

      <MountWhenOpened open={shortcutsOpen}>
        <PosShortcutsHelp open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      </MountWhenOpened>
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
        onNewCustomer={() => {
          setNewCustSearch(custSearch);
          setNewCustOpen(true);
        }}
      />

      <MountWhenOpened open={newCustOpen}>
        <QuickCustomerModal
          open={newCustOpen}
          onOpenChange={setNewCustOpen}
          initialSearch={newCustSearch}
          onCreated={(c) => {
            setCustomer(c);
            setNewCustOpen(false);
            setCustOpen(false);
            setCustSearch("");
          }}
        />
      </MountWhenOpened>

      <MountWhenOpened open={dniOpen}>
        <DniScanModal open={dniOpen} onOpenChange={setDniOpen} onConfirm={quickAddFromDni} />
      </MountWhenOpened>

      {discountGate.modal}
      {quoteGate.modal}
      {orderGate.modal}
      {orderOpen && (
        <OrderFromCartModal
          open={orderOpen}
          onOpenChange={setOrderOpen}
          storeId={register?.store_id ?? null}
          stores={branchCtx.all.filter((b) => !b.deleted_at).map((b) => ({ id: b.id, name: b.short_name || b.name }))}
          cart={() =>
            buildPausedCart({
              lines: useCartStore.getState().lines,
              discountTotal: useCartStore.getState().discountTotal,
              couponCode: pricing.appliedCoupon?.code ?? (pricing.couponInput.trim() || null),
              customer,
              offeredWarrantyId,
              pricing: { listId: usePricingContext.getState().listId, termId: usePricingContext.getState().termId },
              notes: null,
            })
          }
          lines={lines}
          total={total}
          itemCount={itemCount}
          customer={customer}
          sellers={(orderSellers ?? []).map((p) => ({ id: p.id, name: p.name, user_id: p.user_id }))}
          currentUserId={currentUserId}
          onSaved={() => resetSaleRef.current()}
        />
      )}
      {quoteOpen && (
        <QuoteFromCartModal
          open={quoteOpen}
          onOpenChange={setQuoteOpen}
          lines={lines}
          discountTotal={discountTotal}
          customer={customer}
          servicePeriod={hasServiceLines ? (servicePeriod ?? defaultServicePeriod()) : null}
          businessName={myTenant?.name ?? "nuestro negocio"}
          onSaved={() => {
            clear();
            setCustomer(null);
            pricing.clearCoupon();
          }}
        />
      )}
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
          pending={closePending}
          shiftId={shift?.id ?? null}
          opening={shift?.opening_amount ?? 0}
        />
      </MountWhenOpened>

      {/* Cobros en espera (ADR-048): pestaña dentro del POS. */}
      <MountWhenOpened open={pendingOpen}>
        <Modal open={pendingOpen} onOpenChange={setPendingOpen} title="Cobros en espera" className="sm:max-w-2xl">
          <PendingChargesPanel
            storeId={register?.store_id ?? null}
            initialId={pendingInitialId}
            onEditInPos={editPendingCharge}
            onPrint={(saleId) => openTicket(saleId)}
            canForce={role === "owner" || role === "manager"}
            compact
          />
        </Modal>
      </MountWhenOpened>

      {/* Ventas pausadas (ADR-106). */}
      <MountWhenOpened open={pausedOpen}>
        <Modal open={pausedOpen} onOpenChange={setPausedOpen} title="Ventas pausadas" className="sm:max-w-xl">
          <PausedSalesPanel
            list={pauser.list}
            busyId={pauser.busyId}
            role={role}
            currentUserId={currentUserId}
            onResume={(x) => {
              setPausedOpen(false);
              void pauser.resume(x);
            }}
            onRename={(x, label) => void pauser.rename(x, label)}
            onDiscard={pauser.discard}
          />
        </Modal>
      </MountWhenOpened>
      <ClearConfirmDialog
        open={Boolean(pauser.dialogs.clearConfirm)}
        onOpenChange={(o) => !o && pauser.dialogs.setClearConfirm(false)}
        total={pauser.dialogs.clearConfirm?.total ?? 0}
        cash={pauser.dialogs.clearConfirm?.cash ?? 0}
        pendingIntents={pauser.dialogs.clearConfirm?.pendingIntents ?? 0}
        onConfirm={pauser.confirmClear}
      />
      <ClearBlockedDialog
        credited={pauser.dialogs.clearBlocked?.credited ?? null}
        onClose={() => pauser.dialogs.setClearBlocked(null)}
        onPause={() => {
          pauser.dialogs.setClearBlocked(null);
          if (checkoutOpen) sheetPauseRef.current?.();
          else void pauser.pause();
        }}
      />
      <IntentWaitDialog
        sale={pauser.dialogs.intentWait}
        onClose={() => pauser.dialogs.setIntentWait(null)}
        onCancelAndResume={(x) => void pauser.resume(x, { cancelPending: true, force: true })}
      />
      <SwitchSaleDialog
        sale={pauser.dialogs.switchTarget}
        onClose={() => pauser.dialogs.setSwitchTarget(null)}
        onSwitch={(x) => void pauser.switchTo(x)}
      />
      <PausedOnCloseDialog
        list={pausedClose}
        onClose={() => setPausedClose(null)}
        onCarry={() => {
          setPausedClose(null);
          setCloseShiftModal(true);
        }}
        onDiscardFree={async () => {
          for (const x of pausedClose ?? []) {
            const live = x.payments.filter((p) => p.status !== "cancelled" && p.status !== "expired");
            if (live.length === 0) await pauser.discard(x, "Cierre de caja", false);
          }
          setPausedClose(null);
          setCloseShiftModal(true);
        }}
      />

      {/* Cobro único: todos los medios, pago dividido, propina y promo por medio. */}
      <MountWhenOpened open={checkoutOpen}>
        <CheckoutSheetConnected
          open={checkoutOpen}
          onOpenChange={setCheckoutOpen}
          base={rawTotal + shipFee}
          shippingFee={shipFee}
          rounding={rounding}
          deliveryFee={origins.deliveryFee}
          cartPromo={pricing.cartPromo}
          promoForMethod={pricing.promoForMethod}
          promoForPayments={pricing.promoForPayments}
          promoBanks={pricing.promoBanks}
          tenders={tenders}
          offline={offline.isOffline}
          customerId={customer?.id ?? null}
          taxPreview={
            customer?.id
              ? {
                  items: shipFee > 0 ? [...taxPreviewItems, { product_id: null, quantity: 1, unit_price: shipFee }] : taxPreviewItems,
                  customerId: customer.id,
                }
              : null
          }
          customerBlock={{
            customer,
            onPick: () => setCustOpen(true),
            onNew: () => {
              setNewCustSearch("");
              setNewCustOpen(true);
            },
            onClear: () => setCustomer(null),
          }}
          itemsSlot={
            <CheckoutItemsBlock
              open={checkoutOpen}
              lines={lines}
              imageFor={imageForLine}
              promoByLine={pricing.promoByLine}
              onQty={setQuantity}
              onRemove={removeLine}
              onEditPrice={openPriceEdit}
              onNote={(lineId, note) => setLineService(lineId, { lineNote: note })}
              isServiceLine={servicesOn ? isServiceLine : undefined}
              onEditService={servicesOn ? setServiceLineId : undefined}
            />
          }
          deliverySlot={
            fulfillEnabled && fLines.length > 0 && posStoreId ? (
              <CheckoutDeliveryBlock
                open={checkoutOpen}
                lines={fLines}
                sources={fSources.data ?? []}
                sourcesLoading={fSources.isLoading}
                rules={fulfillRules}
                stores={fulfillStores}
                locks={{
                  retiro:
                    ordersFeature !== true
                      ? "Tu plan no incluye el retiro en sucursal"
                      : !orderCfg.delivery_types.retiro.enabled
                        ? "El retiro está apagado en Configuración"
                        : null,
                  envio:
                    ordersFeature !== true
                      ? "Tu plan no incluye el envío a domicilio"
                      : !orderCfg.delivery_types.envio.enabled
                        ? "El envío está apagado en Configuración"
                        : null,
                }}
                choice={deliveryChoice}
                summary={fulfillSummary}
                error={deliveryError}
                customerId={customer?.id ?? null}
                customerName={customer?.name ?? null}
                onNeedSources={() => setDeliverySourcesWanted(true)}
                onApply={(r) => {
                  planRef.current = r.plan;
                  setFulfill(r.plan ? r.state : null);
                  setDeliveryChoice(r.choice);
                  setDeliveryError(r.error);
                }}
                onSplit={() => setFulfillOpen(true)}
                onPickCustomer={() => setCustOpen(true)}
                onNewCustomer={() => {
                  setNewCustSearch("");
                  setNewCustOpen(true);
                }}
                saleTotal={rawTotal}
                offline={offline.isOffline}
              />
            ) : null
          }
          prepaid={origins.appointmentId ? apptPrepaid : null}
          prefs={layout.payments}
          initialTenderId={checkoutTender}
          initialWarrantyId={offeredWarrantyId}
          warrantyTargets={warrantyTargets}
          storeCreditBalance={scBalance ?? 0}
          splitItems={pricing.splitItems}
          tipPresets={layout.tipPresets}
          quickCash={layout.payments.quickCash}
          keypad={layout.keypad}
          checkout={layout.checkout}
          style={accentVars(effectiveLayout.accent)}
          loading={saving}
          onConfirm={(...args: Parameters<typeof handleSale>) => {
            // ADR-146: la entrega elegida en la hoja tiene que estar completa.
            if (deliveryChoice && deliveryError) {
              toast({ title: "Revisá la entrega", description: deliveryError, variant: "error" });
              return;
            }
            // ADR-136: con reparto, el servidor valida cada origen.
            if (!planRef.current && fulfillEnabled && fLines.length > 0 && branchShortfallExists()) {
              pendingChargeRef.current = args;
              toast({ title: "No alcanza en esta sucursal", description: "Elegí de dónde sale y cómo se entrega.", variant: "info" });
              setFulfillOpen(true);
              return;
            }
            if (!planRef.current && branchStockBlocksSale()) return;
            return handleSale(...args);
          }}
          onQrState={handleQrState}
          onTransferState={handleTransferState}
          pause={{
            blockedReason: pauseBlockedReason,
            onPause: (snap, live) => void pauser.pause(snap, live),
            onClear: (snap) => pauser.requestClear(snap),
          }}
          restore={pauser.checkoutRestore ?? orderOrigin.checkoutRestore}
          pauseRef={sheetPauseRef}
          clearRef={sheetClearRef}
          park={{
            blockedReason: parkBlockedReason,
            label: editingCharge ? "Actualizar cobro en espera" : "Dejar en espera",
            customerName: customer?.name ?? null,
            customerEmail: parker.customerEmail,
            customerPhone: parker.customerPhone,
            onPark: parker.onPark,
            onEmail: parker.onEmail,
          }}
        />
      </MountWhenOpened>

      {/* ADR-136: entregas (otra sucursal, depósito, retiro, envío). */}
      {fulfillOpen && (
        <FulfillmentModal
          open={fulfillOpen}
          onOpenChange={(o) => {
            setFulfillOpen(o);
            if (!o) pendingChargeRef.current = null;
          }}
          lines={fLines}
          sources={fSources.data ?? []}
          loading={fSources.isLoading}
          rules={fulfillRules}
          stores={fulfillStores}
          customerName={customer?.name ?? null}
          initial={fulfill}
          onConfirm={(state, plan) => {
            planRef.current = plan;
            setFulfill(plan ? state : null);
            setDeliveryChoice(plan ? { kind: "split" } : null);
            setDeliveryError(null);
            setFulfillOpen(false);
            const pending = pendingChargeRef.current;
            pendingChargeRef.current = null;
            if (pending) void handleSale(...(pending as Parameters<typeof handleSale>));
          }}
          onClear={() => {
            clearDelivery();
            setFulfillOpen(false);
            pendingChargeRef.current = null;
          }}
        />
      )}
      <DeliveriesDoneModal
        done={doneDeliveries}
        storeName={storeNameOf}
        onClose={() => setDoneDeliveries(null)}
        onRemito={(d, saleNumber) => {
          setDoneDeliveries(null);
          setRemitoIssue({
            dispatchId: d.id,
            saleId: null,
            label: `Entrega N° ${d.number} · Venta #${saleNumber}`,
            kind: "envio",
            receiverName: customerNameAtSale.current,
            deliveryAddress: lastShipAddress.current.get(d.origin_store_id) ?? null,
          });
        }}
      />
      {/* ADR-146: remito del envío recién cobrado (ADR-136). */}
      <MountWhenOpened open={remitoIssue !== null || remitoOpen !== null}>
        <RemitoIssueModal
          source={remitoIssue}
          onClose={() => setRemitoIssue(null)}
          onIssued={(id) => {
            setRemitoIssue(null);
            setRemitoOpen(id);
          }}
        />
        <RemitoDetailModal id={remitoOpen} canManage={role === "owner" || role === "manager"} onClose={() => setRemitoOpen(null)} />
      </MountWhenOpened>

      <OfflineTicketModal entry={offlineTicket} onOpenChange={(o) => !o && setOfflineTicket(null)} />
      {tickets.map((t) => (
        <TicketModal
          key={t.key}
          open={t.open}
          onOpenChange={(o) => !o && closeTicket(t.key)}
          saleId={t.saleId}
          autoPrint={autoPrint}
          silent={t.silent}
          onNewSale={() => searchRef.current?.focus()}
        />
      ))}
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
            if (!branchStockGate(variantProduct.id, variantId, 1)) return;
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
      {servicesOn && (
        <ServiceLineModal
          open={serviceLine != null}
          onOpenChange={(o) => !o && setServiceLineId(null)}
          line={serviceLine}
          info={serviceLine?.productId ? serviceProducts.map.get(serviceLine.productId) ?? null : null}
          clarifications={activeClarifications}
          onSave={(v) => {
            if (serviceLine) setLineService(serviceLine.lineId, v);
          }}
        />
      )}
      <PriceOverrideDialog
        line={priceTarget}
        onClose={() => setPriceTarget(null)}
        onConfirm={(price, reason) => {
          if (priceTarget) setLinePrice(priceTarget.lineId, price, reason);
          setPriceTarget(null);
        }}
      />
      <OpenPriceDialog
        target={openTarget}
        onClose={() => {
          setOpenPick(null);
          setOpenTarget(null);
        }}
        onConfirm={confirmOpenPrice}
      />
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
        scaleSlot={
          posHw.liveScale && posHw.hw ? (
            <ScaleLiveWeight
              hw={posHw.hw}
              active={weighProduct !== null}
              onStableGrams={(g) => setWeighGrams(String(g))}
            />
          ) : null
        }
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
    <Suspense fallback={<PosBootSkeleton />}>
      <PosPageInner />
    </Suspense>
  );
}
