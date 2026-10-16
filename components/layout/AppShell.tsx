"use client";

import { PinQuickAccess } from "@/components/security/PinQuickAccess";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import dynamic from "next/dynamic";
import { usePathname, useRouter } from "next/navigation";
import {
  BarChart3,
  Handshake,
  Bike,
  Building2,
  CalendarClock,
  CloudOff,
  CalendarDays,
  ChevronDown,
  CreditCard,
  HandCoins,
  KeyRound,
  LayoutDashboard,
  Lock,
  LogOut,
  Menu,
  MonitorDot,
  Moon,
  Package,
  Receipt,
  RotateCcw,
  Settings,
  ShieldCheck,
  ClipboardCheck,
  ShoppingBag,
  ShoppingCart,
  SlidersHorizontal,
  Sun,
  Tag,
  UserCog,
  Users,
  Utensils,
  Wallet,
  Warehouse,
  Hourglass,
  X,
  ArrowLeftRight,
  ClipboardList,
  FileText,
  FileSignature,
  PackageCheck,
  Truck,
  Undo2,
  Boxes,
  Landmark,
  BookOpenCheck,
  BookText,
  FileArchive,
  ListTree,
  FileSpreadsheet,
  Stamp,
  GraduationCap,
  PackageSearch,
  Radar,
  ShieldAlert,
  ArrowDownUp,
  Clock3,
  Banknote,
  LineChart,
  RefreshCcw,
  Settings2,
  CalendarCheck,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { isLogisticsPath } from "@/components/logistics/LogisticsNav";
import { useStores } from "@/modules/stock/hooks";
import { getCurrentUser } from "@/lib/supabase/currentUser";
import { cn } from "@/lib/utils/cn";
import { useMyMembershipProfile } from "@/hooks/useMyMembershipProfile";
import { capitalizeName } from "@/lib/utils/format";
import { useTheme } from "@/lib/theme/ThemeProvider";
import { Isotype, WordmarkPos } from "@/components/brand/Logo";
import { BusinessBadge } from "@/components/layout/BusinessBadge";
import { Avatar } from "@/components/ui/Avatar";
import {
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownLabel,
  DropdownSeparator,
  DropdownTrigger,
} from "@/components/ui/Dropdown";
import {
  BlockingNotificationBanner,
  NotificationBell,
} from "@/components/notifications/NotificationBell";
import { useGating } from "@/modules/saas/gating";
import {
  HIDDEN_ID,
  TOP_GROUP,
  applyVisible,
  isDefault,
  mergeLayout,
  visibleLayout,
  type MenuDefaults,
  type MenuLayout,
} from "@/lib/nav/menuLayout";
import { useNavMenu } from "@/lib/nav/useNavMenu";
import type { CustomizerItem } from "@/components/layout/MenuCustomizer";
import { useDiningEnabled } from "@/modules/dining/hooks";
import { useCatalogMode } from "@/modules/services/hooks";
import { useDeliveryEnabled } from "@/modules/delivery/hooks";
import { UpgradeModal } from "@/components/saas/UpgradeModal";
import { useAccountStatus } from "@/modules/saas/accountStatus";
import { SuspendedGate } from "@/components/saas/SuspendedGate";
import { PastDueBanner } from "@/components/saas/PastDueBanner";
import { SoftRestrictionGate } from "@/components/saas/SoftRestrictionGate";
import { ReadOnlyBanner } from "@/components/permissions/RoleGate";
import { InactivityGuard } from "@/components/system/InactivityGuard";
import { ImpersonationBanner } from "@/components/layout/ImpersonationBanner";
import { RememberBusiness } from "@/components/layout/RememberBusiness";
import { MountWhenOpened } from "@/components/ui/MountWhenOpened";
import { useCartStore } from "@/modules/pos/store";
import { usePrefetchPos } from "@/modules/pos/layoutHooks";
import { BranchSwitcher } from "@/components/branches/BranchSwitcher";
import { useBranchTabTitle, useCrossContextNotice } from "@/modules/branches/crossContext";
import { SupervisorPinHost } from "@/components/security/SupervisorPinHost";
import { StaffAccessGate, TenantClaimHealer } from "@/components/staff/StaffAccessGate";
import { HelpButton } from "@/components/help/HelpPanel";

// Burbuja del asistente IA en su propio chunk: no pesa en la primera carga.
const AssistantBubble = dynamic(
  () => import("@/components/ai/AssistantBubble").then((m) => m.AssistantBubble),
  { ssr: false },
);

// Recorridos guiados y sugerencias (F15 · H70, H74 · ADR-089): chunks aparte,
// sin SSR (miden el DOM y usan sessionStorage).
const TourHost = dynamic(
  () => import("@/components/onboarding/TourHost").then((m) => m.TourHost),
  { ssr: false },
);
const NudgeHost = dynamic(
  () => import("@/components/onboarding/NudgeHost").then((m) => m.NudgeHost),
  { ssr: false },
);
const OnboardingNextStepToasts = dynamic(
  () => import("@/components/onboarding/OnboardingNextStepToasts").then((m) => m.OnboardingNextStepToasts),
  { ssr: false },
);

// Modo "Personalizar menú" (ADR-134): @dnd-kit viaja sólo en este chunk, que
// se carga al entrar al modo (el menú se pinta en todas las páginas).
const MenuCustomizer = dynamic(
  () => import("@/components/layout/MenuCustomizer").then((m) => m.MenuCustomizer),
  {
    ssr: false,
    loading: () => <p className="px-3 py-2 text-xs text-muted-foreground">Cargando…</p>,
  },
);

// Modales del menú de usuario: chunks aparte y montados recién al abrirlos
// (el de perfil arrastra el recortador de avatar; el de contraseña consultaba
// el proveedor de auth en cada carga del panel aunque nunca se abriera).
const ChangePasswordModal = dynamic(
  () => import("@/components/ui/ChangePasswordModal").then((m) => m.ChangePasswordModal),
  { ssr: false },
);
const MembershipProfileModal = dynamic(
  () =>
    import("@/components/account/MembershipProfileModal").then(
      (m) => m.MembershipProfileModal,
    ),
  { ssr: false },
);

// Roles que pueden vender (el de "Solo lectura" no ve el acceso rápido).
const SELL_ROLES = new Set(["owner", "manager", "cashier"]);
// Atajo global para ir a vender (el POS usa F2 para buscar y F12 para cobrar).
const SELL_SHORTCUT = "F1";

// La pantalla de venta (y sus vistas a pantalla completa) no muestra la
// burbuja del asistente IA: tapa el carrito y los botones de cobro.
export function isPosRoute(pathname: string | null): boolean {
  return pathname === "/pos" || Boolean(pathname?.startsWith("/pos/"));
}

// Acceso rápido a la venta. Con un carrito en curso lleva directo al cobro
// (/pos?cobrar=1, lo abre la página del POS).
function SellQuickAction({
  compact = false,
  onNavigate,
}: {
  compact?: boolean;
  onNavigate?: () => void;
}) {
  const count = useCartStore((s) => s.lines.length);
  const prefetchPos = usePrefetchPos();
  // F17 · H90: el panel mira una sucursal y la venta sería en otra.
  const cross = useCrossContextNotice();
  const href = count > 0 ? "/pos?cobrar=1" : "/pos";
  const label = count > 0 ? "Cobrar" : "Vender";
  const baseHint = count > 0 ? `Ir al cobro (${SELL_SHORTCUT})` : `Ir a vender (${SELL_SHORTCUT})`;
  const hint = cross ? `${baseHint}. ${cross.hint}` : baseHint;
  const link = (
    <Link
      href={href as never}
      onClick={onNavigate}
      onMouseEnter={prefetchPos}
      onFocus={prefetchPos}
      onTouchStart={prefetchPos}
      title={hint}
      aria-label={hint}
      aria-keyshortcuts={SELL_SHORTCUT}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-lg bg-ninja-flame font-semibold text-white transition hover:brightness-105 active:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        compact ? "h-9 px-3 text-sm" : "h-10 w-full px-3 text-sm",
      )}
    >
      <ShoppingCart size={16} aria-hidden />
      <span>{label}</span>
      {count > 0 && (
        <span className="grid h-5 min-w-5 place-items-center rounded-md bg-white/20 px-1 text-[11px] font-bold tabular-nums">
          {count}
        </span>
      )}
      {!compact && (
        <kbd className="ml-auto rounded bg-white/20 px-1.5 py-0.5 font-sans text-[10px] font-semibold">
          {SELL_SHORTCUT}
        </kbd>
      )}
      {compact && cross && <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-warning" />}
    </Link>
  );
  if (compact || !cross) return link;
  return (
    <div>
      {link}
      <p role="status" className="mt-1 flex items-start gap-1.5 px-1 text-[11px] leading-snug text-warning">
        <span aria-hidden className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />
        <span>{cross.message}</span>
      </p>
    </div>
  );
}

// `feature` (opcional): si el plan no la incluye, el ítem de nav se ve
// deshabilitado (candado) y al click abre el UpgradeModal en vez de navegar.
type Item = {
  href: string;
  label: string;
  icon: React.ElementType;
  feature?: string;
  // Gating "cualquiera de" (T12, ADR-158): el ítem se habilita si el plan trae
  // al menos una de estas features. Tiene prioridad sobre `feature`.
  featureAny?: string[];
  // Sólo visible con el modo gastronómico (pos_settings.dining_enabled · H43)
  // activo. No es gating de plan: es un toggle del tenant → se oculta, sin candado.
  requiresDining?: boolean;
  // Sólo visible con delivery activo (pos_settings.delivery_enabled · H49). Igual
  // que requiresDining: toggle del tenant, se oculta sin candado. Independiente
  // de las mesas (delivery puede ir sin modo gastronómico de mesas).
  requiresDelivery?: boolean;
  // Sólo con 2+ sucursales (traslados · F17/H95): con una sola no tiene sentido
  // y se oculta sin candado.
  requiresMultiStore?: boolean;
  // Sólo dueño o encargado (monitor de cajas, ADR-051).
  managersOnly?: boolean;
  // ADR-116: el nombre sale del modo del catálogo (Productos / Servicios).
  catalogLabel?: boolean;
};
// `id` estable: el orden personalizado del usuario se guarda por id (ADR-134).
type Group = { id: string; label: string; items: Item[] };

const ROLE_LABELS: Record<string, string> = {
  owner: "Dueño",
  manager: "Encargado",
  cashier: "Cajero",
  viewer: "Solo lectura",
};

// "Inicio" queda fijo arriba (no entra en el menú personalizable, ADR-134): es
// la salida segura a la que vuelve el logo. "Vender" es el botón de arriba.
const HOME: Item = { href: "/dashboard", label: "Inicio", icon: LayoutDashboard };

const NAV: { groups: Group[] } = {
  groups: [
    {
      // Accesos sin título debajo de Inicio (siempre primero entre los grupos).
      id: TOP_GROUP,
      label: "",
      items: [
        { href: "/dashboard-team", label: "Panel del dueño", icon: Building2, managersOnly: true },
        // F15 · H69 (ADR-086): Escuela NinjaSoft, BASE con key `escuela`.
        { href: "/escuela", label: "Escuela", icon: GraduationCap, feature: "escuela" },
      ],
    },
    {
      id: "operacion",
      label: "Operación",
      items: [
        { href: "/pos", label: "Punto de venta", icon: ShoppingCart },
        // Salón (F13 · H44). Sólo visible con el modo gastronómico activo (H43);
        // se oculta cuando dining_enabled = false (no es gating de plan).
        { href: "/salon", label: "Salón", icon: Utensils, requiresDining: true },
        // Reservas (F13 · H51). Parte de la suite de mesas: misma puerta que Salón
        // (pos_settings.dining_enabled · H43); se oculta sin candado (no es plan).
        { href: "/reservas", label: "Reservas", icon: CalendarClock, requiresDining: true },
        // Delivery y take away (F13 · H49). Sólo visible con delivery activo
        // (pos_settings.delivery_enabled); independiente del modo gastronómico de
        // mesas (puede ir sin mesas).
        { href: "/delivery", label: "Delivery", icon: Bike, requiresDelivery: true },
        // Agenda y turnos (F12 · H38). Feature 'agenda' es básica → visible por
        // defecto; un plan puede apagarla y el ítem queda con candado.
        { href: "/agenda", label: "Agenda", icon: CalendarDays, feature: "agenda" },
        // Cobros en espera (ADR-048): QR y links compartidos que esperan el
        // pago. Con candado si el plan no la incluye.
        { href: "/cobros-en-espera", label: "Cobros en espera", icon: Hourglass, feature: "cobros_en_espera" },
        // Reservas de stock y retiro en tienda (F16 · H77, ADR-091).
        { href: "/reservas-stock", label: "Reservas y retiros", icon: PackageSearch, feature: "reservas_stock" },
        // Pedidos de salón (F11 · H32, ADR-129): OPTIONAL Pro+.
        { href: "/pedidos", label: "Pedidos de salón", icon: ClipboardList, feature: "pedidos_despacho" },
        // Logística (ADR-149 · L0): un solo ítem para Expedición, Remitos y
        // Envíos (sub-páginas con su barra arriba). OPTIONAL Pro+.
        { href: "/logistica", label: "Logística", icon: Truck, feature: "pedidos_despacho" },
        // Presupuestos (ADR-122): OPTIONAL Pro+, con candado si no está.
        { href: "/presupuestos", label: "Presupuestos", icon: FileSignature, feature: "presupuestos" },
        { href: "/caja", label: "Caja", icon: Wallet },
        // Monitor de cajas abiertas (F17 · H115, BASE). Dueño y encargado.
        { href: "/caja/monitor", label: "Cajas abiertas", icon: MonitorDot, feature: "monitor_cajas", managersOnly: true },
        { href: "/ventas", label: "Ventas", icon: Receipt },
        // Ventas offline con problemas (ADR-077, FLAG-OPERATIVO): dueño y encargado.
        { href: "/ventas-offline", label: "Ventas offline", icon: CloudOff, managersOnly: true },
        {
          href: "/devoluciones",
          label: "Devoluciones",
          icon: RotateCcw,
          feature: "devoluciones",
        },
      ],
    },
    {
      id: "catalogo",
      label: "Catálogo",
      items: [
        // ADR-116: "Servicios" o "Productos y servicios" según el modo del catálogo.
        { href: "/productos", label: "Productos", icon: Package, catalogLabel: true },
        { href: "/traslados", label: "Traslados", icon: ArrowLeftRight, feature: "traslados", requiresMultiStore: true },
        // Depósitos internos de la sucursal (F11 · H33, ADR-085).
        { href: "/depositos", label: "Depósitos", icon: Warehouse, feature: "depositos" },
        // Inventario (F14 · H64, ADR-092 y ADR-137): stock con foto, ajustes con
        // motivo y aprobación (BASE + aprobacion_ajustes), conteos, movimientos,
        // valuación y series. Las partes Pro llevan su candado adentro.
        { href: "/inventario", label: "Inventario", icon: ClipboardCheck },
        { href: "/tiendita", label: "Tiendita", icon: ShoppingBag },
        // Mercado Libre (H87 · ADR-104): publicaciones, ventas, preguntas y envíos.
        { href: "/mercadolibre", label: "Mercado Libre", icon: Handshake, feature: "mercadolibre", managersOnly: true },
        { href: "/etiquetas", label: "Etiquetas", icon: Tag },
      ],
    },
    {
      // Compras y proveedores (F18 · H101, ADR-050). Con candado si el plan no
      // incluye la feature compras.
      id: "compras",
      label: "Compras",
      items: [
        { href: "/compras/ordenes", label: "Órdenes de compra", icon: ClipboardList, feature: "compras" },
        { href: "/compras/recepciones", label: "Recepciones", icon: PackageCheck, feature: "compras" },
        { href: "/compras/devoluciones", label: "Devoluciones a proveedor", icon: Undo2, feature: "compras" },
        { href: "/compras/facturas", label: "Facturas y pagos", icon: FileText, feature: "compras" },
        { href: "/compras/lotes", label: "Lotes y despachos", icon: Boxes, feature: "compras" },
        { href: "/compras/proveedores", label: "Proveedores", icon: Truck, feature: "compras" },
      ],
    },
    {
      // Tesorería (F23 · H155, ADR-158): dónde está la plata, qué entró y salió,
      // qué falta acreditar, conciliación, cheques, flujo y NubCeo.
      id: "tesoreria",
      label: "Tesorería",
      items: [
        { href: "/tesoreria", label: "Posición", icon: Landmark, feature: "tesoreria", managersOnly: true },
        { href: "/tesoreria/movimientos", label: "Movimientos", icon: ArrowDownUp, feature: "tesoreria", managersOnly: true },
        { href: "/tesoreria/a-acreditar", label: "A acreditar", icon: Clock3, feature: "tesoreria", managersOnly: true },
        // Conciliación (ADR-044, ADR-061): con cualquiera de las dos features (T12).
        {
          href: "/tesoreria/conciliacion",
          label: "Conciliación",
          icon: CreditCard,
          featureAny: ["conciliacion_procesadores", "conciliacion_tarjetas"],
        },
        { href: "/tesoreria/cheques", label: "Cheques", icon: Banknote, feature: "tesoreria", managersOnly: true },
        { href: "/tesoreria/flujo", label: "Flujo de fondos", icon: LineChart, feature: "tesoreria", managersOnly: true },
        { href: "/tesoreria/nubceo", label: "NubCeo", icon: RefreshCcw, feature: "integracion_nubceo", managersOnly: true },
      ],
    },
    {
      // Contabilidad (F18 · H109, ADR-066): asientos, libros, plan de cuentas,
      // mapeos y cierres. Dueño o encargado; con candado sin la feature.
      id: "contabilidad",
      label: "Contabilidad",
      items: [
        { href: "/contabilidad", label: "Contabilidad", icon: BookOpenCheck, feature: "contabilidad", managersOnly: true },
        { href: "/contabilidad/asientos", label: "Asientos", icon: FileText, feature: "contabilidad", managersOnly: true },
        { href: "/contabilidad/libros", label: "Libros", icon: BookText, feature: "contabilidad", managersOnly: true },
        { href: "/contabilidad/plan-de-cuentas", label: "Plan de cuentas", icon: ListTree, feature: "contabilidad", managersOnly: true },
        // Mapeos y cierres a la vista (H155, ADR-158).
        { href: "/contabilidad/mapeos", label: "Mapeos", icon: Settings2, feature: "contabilidad", managersOnly: true },
        { href: "/contabilidad/cierres", label: "Cierres", icon: CalendarCheck, feature: "contabilidad", managersOnly: true },
      ],
    },
    {
      // Impuestos como grupo propio (H155, ADR-158): como sujeto (ADR-095),
      // como agente (ADR-079) y el Libro IVA Digital (ADR-076).
      id: "impuestos",
      label: "Impuestos",
      items: [
        { href: "/impuestos/sufridas", label: "Retenciones sufridas", icon: Receipt, feature: "percepciones_retenciones", managersOnly: true },
        { href: "/impuestos/iibb", label: "Ingresos Brutos", icon: Landmark, feature: "percepciones_retenciones", managersOnly: true },
        { href: "/compras/retenciones", label: "Retenciones practicadas", icon: Stamp, feature: "percepciones_retenciones", managersOnly: true },
        { href: "/contabilidad/libro-iva", label: "Libro IVA Digital", icon: FileArchive, feature: "facturacion_afip", managersOnly: true },
      ],
    },
    {
      id: "gestion",
      label: "Gestión",
      items: [
        { href: "/clientes", label: "Clientes", icon: Users },
        // Cuenta corriente v2: tablero de cobranza. Con candado si el plan no la incluye.
        { href: "/clientes/cuentas", label: "Cuentas corrientes", icon: HandCoins, feature: "cuenta_corriente" },
        { href: "/reportes", label: "Reportes", icon: BarChart3 },
        // Cockpit de comercio unificado y riesgo operativo (F16 · H76, H82, ADR-091).
        { href: "/cockpit", label: "Cockpit", icon: Radar, feature: "cockpit_comercio", managersOnly: true },
        { href: "/riesgo", label: "Riesgo operativo", icon: ShieldAlert, feature: "prevencion_fraude", managersOnly: true },
        // Importar y exportar en Excel (TX-4, ADR-078). Dueño o encargado; el
        // plan se chequea por importación (importacion_excel / export_xlsx).
        // Control comercial (F14 · H63, H67, ADR-092): aprobaciones y márgenes.
        { href: "/comercial", label: "Control comercial", icon: ShieldCheck, managersOnly: true },
        { href: "/importaciones", label: "Importar y exportar", icon: FileSpreadsheet, managersOnly: true },
        { href: "/configuracion", label: "Configuración", icon: Settings },
      ],
    },
  ],
};

// Menú por defecto (ids = href) y búsqueda de ítems para el layout del usuario.
const MENU_DEFAULTS: MenuDefaults = {
  groups: NAV.groups.map((g) => ({ id: g.id, items: g.items.map((it) => it.href) })),
};
const ITEM_BY_HREF = new Map(NAV.groups.flatMap((g) => g.items.map((it) => [it.href, it] as const)));
const GROUP_LABELS: Record<string, string> = Object.fromEntries(NAV.groups.map((g) => [g.id, g.label]));

function isActiveHref(pathname: string, href: string) {
  return (
    pathname === href ||
    (href === "/escuela" && pathname.startsWith("/escuela/")) ||
    (href === "/logistica" && isLogisticsPath(pathname))
  );
}

// Features que habilitan el ítem (featureAny gana sobre feature). Vacío = sin gating.
function itemFeatureKeys(it: Item): string[] {
  if (it.featureAny?.length) return it.featureAny;
  return it.feature ? [it.feature] : [];
}

/** true si el plan no trae ninguna de las features del ítem. */
function itemLocked(it: Item, features: Record<string, boolean> | undefined): boolean {
  const keys = itemFeatureKeys(it);
  if (keys.length === 0 || !features) return false;
  return !keys.some((k) => features[k] === true);
}

// Datos de cada ítem para el modo personalizar (con el candado del plan).
function customizerItems(
  l: MenuLayout,
  withLabel: (it: Item) => Item,
  features: Record<string, boolean> | undefined,
): Record<string, CustomizerItem> {
  const out: Record<string, CustomizerItem> = {};
  const ids = [...l.groups.flatMap((g) => g.items), ...l.hidden];
  for (const id of ids) {
    const raw = ITEM_BY_HREF.get(id);
    if (!raw) continue;
    const it = withLabel(raw);
    out[id] = {
      id,
      label: it.label,
      icon: it.icon,
      locked: Boolean(features) && itemLocked(it, features),
    };
  }
  return out;
}

function NavGroup({
  label,
  count,
  open,
  onToggle,
  children,
}: {
  label: string;
  count?: number;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="pt-3">
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between rounded-md px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground transition hover:text-foreground"
      >
        <span className="flex items-center gap-2">
          {label}
          {count !== undefined && (
            <span className="rounded-md bg-muted px-1.5 text-[10px] tabular-nums tracking-normal">{count}</span>
          )}
        </span>
        <ChevronDown size={14} className={cn("transition", open ? "" : "-rotate-90")} />
      </button>
      {open && <div className="mt-1 space-y-1">{children}</div>}
    </div>
  );
}

function NavLink({
  item,
  active,
  onNavigate,
}: {
  item: Item;
  active: boolean;
  onNavigate: () => void;
}) {
  const prefetchPos = usePrefetchPos();
  // "Punto de venta": precarga el diseño y los medios del POS al acercarse.
  const warm = item.href === "/pos" ? prefetchPos : undefined;
  const Icon = item.icon;
  // Gating del módulo entero: si el plan no incluye la feature, el ítem queda
  // deshabilitado (candado) y el click abre el UpgradeModal en lugar de navegar.
  // Sin features en el ítem = sin gating (permitido).
  const { data: gating } = useGating();
  const [upOpen, setUpOpen] = useState(false);
  const locked = Boolean(gating) && itemLocked(item, gating?.features);

  if (locked) {
    return (
      <>
        <button
          type="button"
          onClick={() => setUpOpen(true)}
          title={`${item.label}: función no incluida en tu plan`}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted-foreground/60 transition hover:bg-muted/60 hover:text-muted-foreground"
        >
          <Icon size={17} />
          <span className="flex-1 text-left">{item.label}</span>
          <Lock size={13} className="text-ninja-flameSoft" />
        </button>
        <UpgradeModal
          open={upOpen}
          onOpenChange={setUpOpen}
          featureKey={itemFeatureKeys(item)[0]!}
          featureLabel={item.label}
        />
      </>
    );
  }

  return (
    <Link
      href={item.href as never}
      onClick={onNavigate}
      onMouseEnter={warm}
      onFocus={warm}
      onTouchStart={warm}
      className={cn(
        "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition",
        active
          ? "bg-ninja-flame/15 font-medium text-ninja-flameSoft"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <Icon size={17} />
      {item.label}
    </Link>
  );
}

// Pie del menú compacto (ADR-134): avatar, a la derecha el nombre completo
// (hasta 2 líneas) con el perfil abajo en chico; el email va en el tooltip y en
// el desplegable. Mis PINes y el panel interno (sólo staff NinjaSoft) son
// íconos al lado, centrados en vertical.
function UserMenu({
  email,
  role,
  isInternal,
  onCustomize,
  onChangePassword,
  onEditProfile,
  onSignOut,
  onNavigate,
}: {
  email: string;
  role: string | null;
  isInternal: boolean;
  onCustomize: () => void;
  onChangePassword: () => void;
  onEditProfile: () => void;
  onSignOut: () => void;
  onNavigate: () => void;
}) {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "ninja-dark" || theme === "ninja-noir";

  // Perfil del POS = el de MI membresía en el negocio ACTIVO (lo mismo que se
  // ve/edita en Equipo y en "Mi perfil"); nunca el de otra cuenta.
  const { data: me, isLoading: meLoading } = useMyMembershipProfile();
  const name = me?.displayName || email;
  // Nombre y apellido siempre capitalizados; el email se deja como está.
  const isEmail = name === email;
  const shown = isEmail ? name : capitalizeName(name);
  const roleLabel = role ? (ROLE_LABELS[role] ?? role) : null;

  return (
    <div className="flex items-center gap-0.5">
      <Dropdown>
        <DropdownTrigger asChild>
          <button
            title={email}
            aria-label={meLoading ? "Cargando tu cuenta" : `Cuenta: ${shown}${roleLabel ? `, ${roleLabel}` : ""}`}
            aria-busy={meLoading || undefined}
            className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-1 text-left transition hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {/* Mientras carga el perfil, sólo el spinner: nada de email partido. */}
            <Avatar name={name} avatar={me?.avatar} size={28} loading={meLoading} />
            {!meLoading && (
              <span className="flex min-w-0 flex-1 flex-col">
                <span
                  className={cn(
                    "text-sm font-medium leading-tight text-foreground",
                    isEmail ? "truncate" : "line-clamp-2 break-words",
                  )}
                >
                  {shown}
                </span>
                {roleLabel && (
                  <span className="truncate text-[11px] font-medium leading-tight text-muted-foreground">{roleLabel}</span>
                )}
              </span>
            )}
          </button>
        </DropdownTrigger>
        <DropdownContent align="start" side="top" className="w-[240px]">
          <div className="px-3 py-2">
            <p className="truncate text-sm font-medium text-foreground">{shown}</p>
            {name !== email && <p className="truncate text-xs text-muted-foreground">{email}</p>}
            {roleLabel && (
              <span className="mt-1 inline-block rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                {roleLabel}
              </span>
            )}
          </div>
          <DropdownSeparator />
          <DropdownItem onSelect={onEditProfile}>
            <UserCog size={15} /> Editar mi perfil
          </DropdownItem>
          <DropdownItem onSelect={onCustomize}>
            <SlidersHorizontal size={15} /> Personalizar menú
          </DropdownItem>
          <DropdownItem
            onSelect={(e) => {
              e.preventDefault();
              toggleTheme();
            }}
          >
            {isDark ? <Sun size={15} /> : <Moon size={15} />}
            {isDark ? "Modo claro" : "Modo oscuro"}
          </DropdownItem>
          <DropdownItem onSelect={onChangePassword}>
            <KeyRound size={15} /> Cambiar contraseña
          </DropdownItem>
          <DropdownSeparator />
          <DropdownItem onSelect={onSignOut} className="text-destructive">
            <LogOut size={15} /> Cerrar sesión
          </DropdownItem>
        </DropdownContent>
      </Dropdown>
      <PinQuickAccess />
      {isInternal && (
        <Link
          href="/internal/tenants"
          onClick={onNavigate}
          title="Panel NinjaSoft · Modo interno"
          aria-label="Panel NinjaSoft, modo interno"
          className="grid h-10 w-9 shrink-0 place-items-center rounded-lg text-ninja-flameSoft transition hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ShieldCheck size={17} aria-hidden />
        </Link>
      )}
    </div>
  );
}

export function AppShell({
  email,
  children,
}: {
  email: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [drawer, setDrawer] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const [pfOpen, setPfOpen] = useState(false);
  // Grupos abiertos por id (todos abiertos salvo "Ocultos", colapsado por defecto).
  const [open, setOpen] = useState<Record<string, boolean>>({ [HIDDEN_ID]: false });
  const [customizing, setCustomizing] = useState(false);

  // Contexto del usuario: staff NinjaSoft + rol en el tenant (para gatear el menú).
  const { data: shell } = useQuery({
    queryKey: ["shell-ctx"],
    queryFn: async () => {
      const supabase = createClient();
      const user = await getCurrentUser();
      if (!user) return { isInternal: false, role: null as string | null };
      const isInternal = !!(user.app_metadata as { is_internal?: boolean } | null)
        ?.is_internal;
      // Rol en el negocio ACTIVO (con dos membresías no vale cualquiera).
      const tenantId = (user.app_metadata as { current_tenant_id?: string } | null)?.current_tenant_id;
      let q = supabase.from("tenant_users").select("role").eq("user_id", user.id).eq("status", "active");
      if (tenantId) q = q.eq("tenant_id", tenantId);
      const { data: mem } = await q.limit(1).maybeSingle();
      return { isInternal, role: mem?.role ?? null };
    },
  });
  const isInternal = shell?.isInternal ?? false;
  const canOwnerPanel = shell?.role === "owner" || shell?.role === "manager";
  const canSell = SELL_ROLES.has(shell?.role ?? "");
  const onPos = isPosRoute(pathname);
  // F17 · H90: la sucursal del chip en el título de la pestaña.
  useBranchTabTitle();

  // Precarga del POS en idle: entrar a Vender ya encuentra el diseño, los
  // overrides y los medios en caché (sin esqueleto ni salto de diseño).
  const prefetchPos = usePrefetchPos();
  useEffect(() => {
    if (!canSell || onPos) return;
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(prefetchPos, { timeout: 4000 });
      return () => w.cancelIdleCallback?.(id);
    }
    const t = setTimeout(prefetchPos, 2000);
    return () => clearTimeout(t);
  }, [canSell, onPos, prefetchPos]);

  // Atajo global F1: ir a vender (o al cobro si hay carrito).
  useEffect(() => {
    if (!canSell) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== SELL_SHORTCUT || e.ctrlKey || e.altKey || e.metaKey) return;
      e.preventDefault();
      const hasCart = useCartStore.getState().lines.length > 0;
      router.push((hasCart ? "/pos?cobrar=1" : "/pos") as never);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canSell, router]);

  // Modo gastronómico (H43) y delivery (H49): oculta los ítems con requiresDining
  // / requiresDelivery si su toggle del tenant está apagado.
  const { data: diningEnabled } = useDiningEnabled();
  const { data: deliveryEnabled } = useDeliveryEnabled();
  const { data: stores } = useStores();
  // ADR-116: "Productos", "Servicios" o "Productos y servicios".
  const { vocab: catalogVocab } = useCatalogMode();
  const withLabel = (it: Item): Item => (it.catalogLabel ? { ...it, label: catalogVocab.title } : it);
  const showItem = (it: Item) =>
    (!it.requiresDining || Boolean(diningEnabled)) &&
    (!it.requiresDelivery || Boolean(deliveryEnabled)) &&
    (!it.requiresMultiStore || (stores?.length ?? 0) > 1) &&
    (!it.managersOnly || canOwnerPanel);

  // Menú personalizado del usuario (ADR-134): orden guardado + menú por
  // defecto, filtrado por lo que este usuario puede ver en este negocio.
  const navMenu = useNavMenu();
  const isVisibleHref = (href: string) => {
    const it = ITEM_BY_HREF.get(href);
    return Boolean(it && showItem(it));
  };
  const fullLayout = useMemo(() => mergeLayout(MENU_DEFAULTS, navMenu.saved), [navMenu.saved]);
  const menu = visibleLayout(fullLayout, isVisibleHref);
  const { data: gating } = useGating();
  function saveVisible(edited: MenuLayout) {
    const next = applyVisible(fullLayout, edited, isVisibleHref);
    if (isDefault(next, MENU_DEFAULTS)) navMenu.reset();
    else navMenu.setLayout(next);
  }
  function finishCustomizing() {
    setCustomizing(false);
    navMenu.flush();
  }

  // Estado de la cuenta (suspensión / cancelación / past_due). Lo setea el motor
  // de dunning. `suspended` Y `cancelled` bloquean TODA la app del POS: ni
  // montamos el shell, mostramos la pantalla de reactivación (de la que solo se
  // sale pagando o cerrando sesión). El gating real también vive en el server
  // (assert_account_active en create_sale / open_cash_shift / devoluciones): la
  // UI no es la única barrera.
  const { data: account } = useAccountStatus();

  async function signOut() {
    await createClient().auth.signOut();
    router.push("/login");
    router.refresh();
  }

  const nav = (
    <nav className="flex h-full flex-col p-3">
      {/* Logo fijo arriba — fuera del área scrolleable */}
      <div className="mb-3 flex shrink-0 items-center gap-2 px-2 py-2">
        <Link
          href="/dashboard"
          onClick={() => setDrawer(false)}
          className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden"
        >
          <Isotype className="h-9 w-auto shrink-0" priority />
          {/* El wordmark se achica para no quedar debajo de Ayuda y la campana. */}
          <WordmarkPos className="h-7 w-auto min-w-0 max-w-full object-contain object-left" priority />
        </Link>
        {/* Campana en la barra lateral (desktop): flotando sobre el contenido
            tapaba botones de la pantalla de cobro. En mobile vive en el header. */}
        <div className="hidden shrink-0 items-center gap-0.5 lg:flex">
          {/* Ayuda contextual (F15 · H72): artículos de la pantalla y el rol. */}
          <HelpButton role={shell?.role ?? null} />
          <NotificationBell align="start" />
        </div>
      </div>

      {/* Negocio activo (ADR-124): nombre de fantasía o el de la cuenta. */}
      <div className="mb-2 shrink-0 empty:hidden">
        <BusinessBadge />
      </div>

      {/* Sucursal actual (F17 · H90): sólo con más de una sucursal. */}
      <div className="mb-2 shrink-0 px-1 empty:hidden">
        <BranchSwitcher />
      </div>

      {canSell && (
        <div className="mb-3 shrink-0 px-1">
          <SellQuickAction onNavigate={() => setDrawer(false)} />
        </div>
      )}

      {/* Navegación scrolleable */}
      <div className="slim-scrollbar -mr-1 min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
        {customizing ? (
          <MenuCustomizer
            layout={menu}
            defaults={MENU_DEFAULTS}
            items={customizerItems(menu, withLabel, gating?.features)}
            groupLabels={GROUP_LABELS}
            onChange={saveVisible}
            onDone={finishCustomizing}
            onReset={navMenu.reset}
            canReset={!isDefault(fullLayout, MENU_DEFAULTS)}
          />
        ) : (
          <>
            <NavLink item={HOME} active={pathname === HOME.href} onNavigate={() => setDrawer(false)} />

            {menu.groups.map((g) => {
              if (g.items.length === 0) return null;
              const links = g.items.map((href) => (
                <NavLink
                  key={href}
                  item={withLabel(ITEM_BY_HREF.get(href)!)}
                  active={isActiveHref(pathname, href)}
                  onNavigate={() => setDrawer(false)}
                />
              ));
              if (g.id === TOP_GROUP) return <div key={g.id} className="space-y-1">{links}</div>;
              const isOpen = open[g.id] ?? true;
              return (
                <NavGroup
                  key={g.id}
                  label={GROUP_LABELS[g.id] ?? g.id}
                  open={isOpen}
                  onToggle={() => setOpen((st) => ({ ...st, [g.id]: !isOpen }))}
                >
                  {links}
                </NavGroup>
              );
            })}

            {/* Lo que el usuario sacó del menú: colapsado por defecto, al final. */}
            {menu.hidden.length > 0 && (
              <NavGroup
                label="Ocultos"
                count={menu.hidden.length}
                open={open[HIDDEN_ID] ?? false}
                onToggle={() => setOpen((st) => ({ ...st, [HIDDEN_ID]: !(st[HIDDEN_ID] ?? false) }))}
              >
                {menu.hidden.map((href) => (
                  <NavLink
                    key={href}
                    item={withLabel(ITEM_BY_HREF.get(href)!)}
                    active={isActiveHref(pathname, href)}
                    onNavigate={() => setDrawer(false)}
                  />
                ))}
              </NavGroup>
            )}
          </>
        )}
      </div>

      {/* Pie fijo compacto: usuario (+ acceso al panel interno para el staff) */}
      <div className="mt-2 shrink-0 border-t border-border pt-2">
        <UserMenu
          email={email}
          role={shell?.role ?? null}
          isInternal={isInternal}
          onCustomize={() => setCustomizing(true)}
          onChangePassword={() => setPwOpen(true)}
          onEditProfile={() => setPfOpen(true)}
          onSignOut={signOut}
          onNavigate={() => setDrawer(false)}
        />
      </div>
    </nav>
  );

  // Cuenta suspendida o cancelada → no montamos el POS: pantalla de reactivación
  // a pantalla completa. El InactivityGuard sigue activo (el auto-logout también
  // corre acá). `cancelled` ajusta el copy (trial vencido / baja, no "suspendida
  // por falta de pago"), pero el bloqueo es el mismo: solo se sale pagando o
  // cerrando sesión.
  if (account?.isSuspended || account?.isCancelled) {
    return (
      <>
        <InactivityGuard />
        <RememberBusiness />
        <SuspendedGate email={email} cancelled={account?.isCancelled ?? false} />
      </>
    );
  }

  return (
    <div className="flex min-h-dvh">
      <InactivityGuard />
      <TenantClaimHealer />
      <RememberBusiness />
      <StaffAccessGate email={email} />
      <SupervisorPinHost />
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 border-r border-border bg-background/60 glass-blur lg:block">
        {nav}
      </aside>

      {drawer && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setDrawer(false)}
          />
          <aside className="absolute left-0 top-0 h-full w-64 border-r border-border bg-popover pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]">
            <button
              onClick={() => setDrawer(false)}
              className="absolute right-3 top-3 text-muted-foreground"
              aria-label="Cerrar menú"
            >
              <X size={18} />
            </button>
            {nav}
          </aside>
        </div>
      )}

      <div className="relative flex min-w-0 flex-1 flex-col">
        <ImpersonationBanner />
        <header className="sticky top-0 z-40 flex h-[calc(3.5rem+env(safe-area-inset-top))] items-center gap-3 border-b border-border bg-background/70 px-4 pt-[env(safe-area-inset-top)] glass-blur lg:hidden">
          <button onClick={() => setDrawer(true)} aria-label="Abrir menú">
            <Menu size={20} />
          </button>
          <Isotype className="h-6 w-auto" />
          <BusinessBadge compact />
          <BranchSwitcher compact />
          <div className="ml-auto flex items-center gap-2">
            {canSell && !onPos && <SellQuickAction compact />}
            <HelpButton role={shell?.role ?? null} />
            <NotificationBell />
          </div>
        </header>

        {/* Fuera del POS flota el Asistente IA abajo a la derecha: reservamos
            espacio al final para que no tape los CTAs de la última fila. */}
        <main
          className={cn(
            "app-bg slim-scrollbar min-h-0 flex-1 overflow-y-auto",
            !onPos && "pb-16 sm:pb-20",
          )}
        >
          <PastDueBanner />
          <BlockingNotificationBanner />
          <ReadOnlyBanner />
          {/* F20-9: restricción blanda de la escalera de mora (nunca en el POS). */}
          <SoftRestrictionGate>{children}</SoftRestrictionGate>
        </main>
      </div>

      <MountWhenOpened open={pwOpen}>
        <ChangePasswordModal open={pwOpen} onOpenChange={setPwOpen} />
      </MountWhenOpened>
      <MountWhenOpened open={pfOpen}>
        <MembershipProfileModal open={pfOpen} onOpenChange={setPfOpen} />
      </MountWhenOpened>
      {!onPos && <AssistantBubble />}
      {shell?.role && <TourHost role={shell.role} />}
      {shell?.role && <NudgeHost role={shell.role} />}
      {/* Puesta en marcha (ADR-154): "listo, lo que sigue es…" al completar un
          paso. Sólo dueño o encargado, y nunca en medio de una venta. */}
      {canOwnerPanel && !onPos && <OnboardingNextStepToasts />}
    </div>
  );
}
