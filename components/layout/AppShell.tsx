"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  BarChart3,
  Bike,
  Building2,
  CalendarClock,
  CalendarDays,
  ChevronDown,
  KeyRound,
  LayoutDashboard,
  Lock,
  LogOut,
  Menu,
  Moon,
  Package,
  Receipt,
  RotateCcw,
  Settings,
  ShieldCheck,
  ShoppingBag,
  ShoppingCart,
  Sun,
  Tag,
  UserCog,
  Users,
  Utensils,
  Wallet,
  X,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils/cn";
import { capitalizeName } from "@/lib/utils/format";
import { useTheme } from "@/lib/theme/ThemeProvider";
import { Isotype, WordmarkPos } from "@/components/brand/Logo";
import { ChangePasswordModal } from "@/components/ui/ChangePasswordModal";
import { MembershipProfileModal } from "@/components/account/MembershipProfileModal";
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
import { AssistantBubble } from "@/components/ai/AssistantBubble";
import { useFeature } from "@/modules/saas/gating";
import { useDiningEnabled } from "@/modules/dining/hooks";
import { useDeliveryEnabled } from "@/modules/delivery/hooks";
import { UpgradeModal } from "@/components/saas/UpgradeModal";
import { useAccountStatus } from "@/modules/saas/accountStatus";
import { SuspendedGate } from "@/components/saas/SuspendedGate";
import { PastDueBanner } from "@/components/saas/PastDueBanner";
import { InactivityGuard } from "@/components/system/InactivityGuard";

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
        { href: "/caja", label: "Caja", icon: Wallet },
        { href: "/ventas", label: "Ventas", icon: Receipt },
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
        { href: "/tiendita", label: "Tiendita", icon: ShoppingBag },
        { href: "/etiquetas", label: "Etiquetas", icon: Tag },
      ],
    },
    {
      label: "Gestión",
      items: [
        { href: "/clientes", label: "Clientes", icon: Users },
        { href: "/reportes", label: "Reportes", icon: BarChart3 },
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
      const {
        data: { user },
      } = await supabase.auth.getUser();
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
    Gestión: true,
  });

  // Contexto del usuario: staff NinjaSoft + rol en el tenant (para gatear el menú).
  const { data: shell } = useQuery({
    queryKey: ["shell-ctx"],
    queryFn: async () => {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return { isInternal: false, role: null as string | null };
      const isInternal = !!(user.app_metadata as { is_internal?: boolean } | null)
        ?.is_internal;
      const { data: mem } = await supabase
        .from("tenant_users")
        .select("role")
        .eq("user_id", user.id)
        .eq("status", "active")
        .limit(1)
        .maybeSingle();
      return { isInternal, role: mem?.role ?? null };
    },
  });
  const isInternal = shell?.isInternal ?? false;
  const canOwnerPanel = shell?.role === "owner" || shell?.role === "manager";

  // Modo gastronómico (H43) y delivery (H49): oculta los ítems con requiresDining
  // / requiresDelivery si su toggle del tenant está apagado.
  const { data: diningEnabled } = useDiningEnabled();
  const { data: deliveryEnabled } = useDeliveryEnabled();
  const showItem = (it: Item) =>
    (!it.requiresDining || Boolean(diningEnabled)) &&
    (!it.requiresDelivery || Boolean(deliveryEnabled));

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
      <Link
        href="/dashboard"
        onClick={() => setDrawer(false)}
        className="mb-3 flex shrink-0 items-center gap-2.5 px-2 py-2"
      >
        <Isotype className="h-9 w-auto" priority />
        <WordmarkPos className="h-7 w-auto" priority />
      </Link>

      {/* Navegación scrolleable */}
      <div className="slim-scrollbar -mr-1 min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
        {NAV.top
          .filter((it) => it.href !== "/dashboard-team" || canOwnerPanel)
          .map((it) => (
            <NavLink
              key={it.href}
              item={it}
              active={pathname === it.href}
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
            className="group flex items-center gap-2.5 rounded-lg border border-border bg-card p-2 transition hover:border-ninja-flameSoft/50 hover:bg-muted"
          >
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-ninja-gradient text-ninja-voidViolet shadow-ninjaGlow">
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
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 border-r border-border bg-background/60 backdrop-blur-xl lg:block">
        {nav}
      </aside>

      {drawer && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setDrawer(false)}
          />
          <aside className="absolute left-0 top-0 h-full w-64 border-r border-border bg-popover">
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
        <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b border-border bg-background/70 px-4 backdrop-blur-xl lg:hidden">
          <button onClick={() => setDrawer(true)} aria-label="Abrir menú">
            <Menu size={20} />
          </button>
          <Isotype className="h-6 w-auto" />
          <div className="ml-auto">
            <NotificationBell />
          </div>
        </header>

        {/* Campana flotante arriba a la derecha, sobre el contenido (solo desktop).
            z-40 < z-50 de los modales: nunca tapa overlays. */}
        <div className="fixed right-4 top-4 z-40 hidden lg:block">
          <NotificationBell floating />
        </div>

        <main className="app-bg slim-scrollbar min-h-0 flex-1 overflow-y-auto">
          <PastDueBanner />
          <BlockingNotificationBanner />
          {children}
        </main>
      </div>

      <ChangePasswordModal open={pwOpen} onOpenChange={setPwOpen} />
      <MembershipProfileModal open={pfOpen} onOpenChange={setPfOpen} />
      <AssistantBubble />
    </div>
  );
}
