"use client";

import { useEffect, useState } from "react";
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
  Send,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useStores } from "@/modules/stock/hooks";
import { getCurrentUser } from "@/lib/supabase/currentUser";
import { cn } from "@/lib/utils/cn";
import { capitalizeName } from "@/lib/utils/format";
import { useTheme } from "@/lib/theme/ThemeProvider";
import { Isotype, WordmarkPos } from "@/components/brand/Logo";
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
import { useFeature } from "@/modules/saas/gating";
import { useDiningEnabled } from "@/modules/dining/hooks";
import { useDeliveryEnabled } from "@/modules/delivery/hooks";
import { UpgradeModal } from "@/components/saas/UpgradeModal";
import { useAccountStatus } from "@/modules/saas/accountStatus";
import { SuspendedGate } from "@/components/saas/SuspendedGate";
import { PastDueBanner } from "@/components/saas/PastDueBanner";
import { ReadOnlyBanner } from "@/components/permissions/RoleGate";
import { InactivityGuard } from "@/components/system/InactivityGuard";
import { ImpersonationBanner } from "@/components/layout/ImpersonationBanner";
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
};
type Group = { label: string; items: Item[] };

const ROLE_LABELS: Record<string, string> = {
  owner: "Dueño",
  manager: "Encargado",
  cashier: "Cajero",
  viewer: "Solo lectura",
};

const NAV: { top: Item[]; groups: Group[] } = {
  top: [
    { href: "/dashboard", label: "Inicio", icon: LayoutDashboard },
    { href: "/dashboard-team", label: "Panel del dueño", icon: Building2 },
    // F15 · H69 (ADR-086): Escuela NinjaSoft, BASE con key `escuela`.
    { href: "/escuela", label: "Escuela", icon: GraduationCap, feature: "escuela" },
  ],
  groups: [
    {
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
        // Envíos con etiquetas de logísticas integradas (ADR-103).
        { href: "/envios", label: "Envíos", icon: Send, feature: "envios" },
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
      label: "Catálogo",
      items: [
        { href: "/productos", label: "Productos", icon: Package },
        { href: "/traslados", label: "Traslados", icon: ArrowLeftRight, feature: "traslados", requiresMultiStore: true },
        // Depósitos internos de la sucursal (F11 · H33, ADR-085).
        { href: "/depositos", label: "Depósitos", icon: Warehouse, feature: "depositos" },
        // Inventario PRO (F14 · H64, ADR-092): conteo cíclico ABC y garantías por serie.
        { href: "/inventario", label: "Inventario PRO", icon: ClipboardCheck, feature: "conteo_ciclico" },
        { href: "/tiendita", label: "Tiendita", icon: ShoppingBag },
        // Mercado Libre (H87 · ADR-104): publicaciones, ventas, preguntas y envíos.
        { href: "/mercadolibre", label: "Mercado Libre", icon: Handshake, feature: "mercadolibre", managersOnly: true },
        { href: "/etiquetas", label: "Etiquetas", icon: Tag },
      ],
    },
    {
      // Compras y proveedores (F18 · H101, ADR-050). Con candado si el plan no
      // incluye la feature compras.
      label: "Compras",
      items: [
        { href: "/compras/ordenes", label: "Órdenes de compra", icon: ClipboardList, feature: "compras" },
        { href: "/compras/recepciones", label: "Recepciones", icon: PackageCheck, feature: "compras" },
        { href: "/compras/devoluciones", label: "Devoluciones a proveedor", icon: Undo2, feature: "compras" },
        { href: "/compras/facturas", label: "Facturas y pagos", icon: FileText, feature: "compras" },
        { href: "/compras/lotes", label: "Lotes y despachos", icon: Boxes, feature: "compras" },
        { href: "/compras/proveedores", label: "Proveedores", icon: Truck, feature: "compras" },
        // Retenciones practicadas como agente (F18 · H106, ADR-079).
        { href: "/compras/retenciones", label: "Retenciones practicadas", icon: Stamp, feature: "percepciones_retenciones", managersOnly: true },
        // Tesorería (F18 · H111, ADR-059): cuentas, cheques y flujo de fondos.
        { href: "/tesoreria", label: "Tesorería", icon: Landmark, feature: "tesoreria", managersOnly: true },
      ],
    },
    {
      // Contabilidad (F18 · H109, ADR-066): asientos, libros, plan de cuentas,
      // mapeos y cierres. Dueño o encargado; con candado sin la feature.
      label: "Contabilidad",
      items: [
        { href: "/contabilidad", label: "Contabilidad", icon: BookOpenCheck, feature: "contabilidad", managersOnly: true },
        { href: "/contabilidad/asientos", label: "Asientos", icon: FileText, feature: "contabilidad", managersOnly: true },
        { href: "/contabilidad/libros", label: "Libros", icon: BookText, feature: "contabilidad", managersOnly: true },
        { href: "/contabilidad/plan-de-cuentas", label: "Plan de cuentas", icon: ListTree, feature: "contabilidad", managersOnly: true },
        // Libro IVA Digital (F18 · H108, ADR-076): va con la facturación
        // electrónica, no con la contabilidad.
        { href: "/contabilidad/libro-iva", label: "Libro IVA Digital", icon: FileArchive, feature: "facturacion_afip", managersOnly: true },
        // Impuestos como sujeto (F18 · H106, ADR-095): retenciones sufridas y
        // liquidación de Ingresos Brutos.
        { href: "/impuestos/sufridas", label: "Retenciones sufridas", icon: Receipt, feature: "percepciones_retenciones", managersOnly: true },
        { href: "/impuestos/iibb", label: "Ingresos Brutos", icon: Landmark, feature: "percepciones_retenciones", managersOnly: true },
      ],
    },
    {
      label: "Gestión",
      items: [
        { href: "/clientes", label: "Clientes", icon: Users },
        // Cuenta corriente v2: tablero de cobranza. Con candado si el plan no la incluye.
        { href: "/clientes/cuentas", label: "Cuentas corrientes", icon: HandCoins, feature: "cuenta_corriente" },
        { href: "/reportes", label: "Reportes", icon: BarChart3 },
        // Cockpit de comercio unificado y riesgo operativo (F16 · H76, H82, ADR-091).
        { href: "/cockpit", label: "Cockpit", icon: Radar, feature: "cockpit_comercio", managersOnly: true },
        { href: "/riesgo", label: "Riesgo operativo", icon: ShieldAlert, feature: "prevencion_fraude", managersOnly: true },
        // Conciliación de tarjetas (ADR-044) y de procesadores (ADR-061, pestaña). Con candado si el plan no trae la de tarjetas.
        { href: "/reportes/conciliacion", label: "Conciliación", icon: CreditCard, feature: "conciliacion_tarjetas" },
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
  // useFeature siempre se llama (key vacía = sin gating → permitido).
  const allowed = useFeature(item.feature ?? "");
  const [upOpen, setUpOpen] = useState(false);
  const locked = Boolean(item.feature) && allowed === false;

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
          featureKey={item.feature!}
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

function UserMenu({
  email,
  role,
  onChangePassword,
  onEditProfile,
  onSignOut,
}: {
  email: string;
  role: string | null;
  onChangePassword: () => void;
  onEditProfile: () => void;
  onSignOut: () => void;
}) {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "ninja-dark" || theme === "ninja-noir";

  // Perfil del POS = el de la membresía (lo mismo que se ve/edita en Equipo).
  const { data: me, isLoading: meLoading } = useQuery({
    queryKey: ["my-membership-profile"],
    queryFn: async () => {
      const supabase = createClient();
      const user = await getCurrentUser();
      if (!user) return null;
      const { data } = await supabase
        .from("tenant_users")
        .select("display_name, avatar")
        .eq("user_id", user.id)
        .eq("status", "active")
        .limit(1)
        .maybeSingle();
      return {
        display_name: data?.display_name ?? null,
        avatar: data?.avatar ?? null,
      };
    },
  });
  const name = me?.display_name || email;

  return (
    <Dropdown>
      <DropdownTrigger asChild>
        <button className="flex w-full items-center gap-2.5 rounded-lg border border-border bg-card p-2 text-left transition hover:bg-muted">
          <Avatar name={name} avatar={me?.avatar} size={32} loading={meLoading} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-foreground">
              {/* Nombre y apellido siempre capitalizados; el email se deja como está. */}
              {name === email ? name : capitalizeName(name)}
            </span>
            {name !== email && (
              <span className="block truncate text-xs text-muted-foreground">
                {email}
              </span>
            )}
            {role && (
              <span className="mt-0.5 block truncate text-[11px] font-medium text-ninja-flameSoft">
                {ROLE_LABELS[role] ?? role}
              </span>
            )}
          </span>
          <ChevronDown size={15} className="shrink-0 text-muted-foreground" />
        </button>
      </DropdownTrigger>
      <DropdownContent align="start" className="w-[232px]">
        <DropdownLabel>Cuenta</DropdownLabel>
        <DropdownItem onSelect={onEditProfile}>
          <UserCog size={15} /> Editar mi perfil
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
  const [open, setOpen] = useState<Record<string, boolean>>({
    Operación: true,
    Catálogo: true,
    Compras: true,
    Gestión: true,
  });

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
  const showItem = (it: Item) =>
    (!it.requiresDining || Boolean(diningEnabled)) &&
    (!it.requiresDelivery || Boolean(deliveryEnabled)) &&
    (!it.requiresMultiStore || (stores?.length ?? 0) > 1) &&
    (!it.managersOnly || canOwnerPanel);

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
        {NAV.top
          .filter((it) => it.href !== "/dashboard-team" || canOwnerPanel)
          .map((it) => (
            <NavLink
              key={it.href}
              item={it}
              active={pathname === it.href || (it.href === "/escuela" && pathname.startsWith("/escuela/"))}
              onNavigate={() => setDrawer(false)}
            />
          ))}

        {NAV.groups.map((g) => {
          const isOpen = open[g.label] ?? true;
          return (
            <div key={g.label} className="pt-3">
              <button
                onClick={() => setOpen((s) => ({ ...s, [g.label]: !isOpen }))}
                className="flex w-full items-center justify-between rounded-md px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground transition hover:text-foreground"
              >
                {g.label}
                <ChevronDown
                  size={14}
                  className={cn("transition", isOpen ? "" : "-rotate-90")}
                />
              </button>
              {isOpen && (
                <div className="mt-1 space-y-1">
                  {g.items.filter(showItem).map((it) => (
                    <NavLink
                      key={it.href}
                      item={it}
                      active={pathname === it.href}
                      onNavigate={() => setDrawer(false)}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Pie fijo: panel interno + usuario */}
      <div className="mt-3 shrink-0 space-y-3 border-t border-border pt-3">
        {isInternal && (
          <Link
            href="/internal/tenants"
            onClick={() => setDrawer(false)}
            className="group flex items-center gap-2.5 rounded-lg border border-border bg-card p-2 transition hover:bg-muted"
          >
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--pos-solid)] text-white">
              <ShieldCheck size={16} />
            </span>
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block text-sm font-semibold text-foreground">
                Panel NinjaSoft
              </span>
              <span className="block text-xs text-muted-foreground">
                Modo interno
              </span>
            </span>
          </Link>
        )}
        <UserMenu
          email={email}
          role={shell?.role ?? null}
          onChangePassword={() => setPwOpen(true)}
          onEditProfile={() => setPfOpen(true)}
          onSignOut={signOut}
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
        <SuspendedGate email={email} cancelled={account?.isCancelled ?? false} />
      </>
    );
  }

  return (
    <div className="flex min-h-dvh">
      <InactivityGuard />
      <TenantClaimHealer />
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
          {children}
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
    </div>
  );
}
