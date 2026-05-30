"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  BarChart3,
  ChevronDown,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  Package,
  Receipt,
  Settings,
  ShoppingCart,
  Sun,
  Users,
  Wallet,
  X,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils/cn";
import { useTheme } from "@/lib/theme/ThemeProvider";
import { Isotype, WordmarkPos } from "@/components/brand/Logo";
import { ChangePasswordModal } from "@/components/ui/ChangePasswordModal";
import {
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownLabel,
  DropdownSeparator,
  DropdownTrigger,
} from "@/components/ui/Dropdown";

type Item = { href: string; label: string; icon: React.ElementType };
type Group = { label: string; items: Item[] };

const NAV: { top: Item[]; groups: Group[] } = {
  top: [{ href: "/dashboard-team", label: "Inicio", icon: LayoutDashboard }],
  groups: [
    {
      label: "Operación",
      items: [
        { href: "/pos", label: "Punto de venta", icon: ShoppingCart },
        { href: "/caja", label: "Caja", icon: Wallet },
        { href: "/ventas", label: "Ventas", icon: Receipt },
      ],
    },
    {
      label: "Catálogo",
      items: [{ href: "/productos", label: "Productos", icon: Package }],
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
  onChangePassword,
  onSignOut,
}: {
  email: string;
  onChangePassword: () => void;
  onSignOut: () => void;
}) {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "ninja-dark" || theme === "ninja-noir";
  const initial = (email[0] ?? "?").toUpperCase();

  return (
    <Dropdown>
      <DropdownTrigger asChild>
        <button className="flex w-full items-center gap-2.5 rounded-lg border border-border bg-card p-2 text-left transition hover:bg-muted">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-ninja-gradient text-sm font-bold text-ninja-voidViolet">
            {initial}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm text-foreground">
            {email}
          </span>
          <ChevronDown size={15} className="shrink-0 text-muted-foreground" />
        </button>
      </DropdownTrigger>
      <DropdownContent align="start" className="w-[232px]">
        <DropdownLabel>Cuenta</DropdownLabel>
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
  const [open, setOpen] = useState<Record<string, boolean>>({
    Operación: true,
    Catálogo: true,
    Gestión: true,
  });

  async function signOut() {
    await createClient().auth.signOut();
    router.push("/login");
    router.refresh();
  }

  const nav = (
    <nav className="flex h-full flex-col gap-1 p-3">
      <Link
        href="/dashboard-team"
        onClick={() => setDrawer(false)}
        className="mb-4 flex items-center gap-2.5 px-2 py-2"
      >
        <Isotype className="h-9 w-auto" priority />
        <WordmarkPos className="h-5 w-auto" priority />
      </Link>

      {NAV.top.map((it) => (
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
          <div key={g.label} className="mt-3">
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
                {g.items.map((it) => (
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

      <div className="mt-auto pt-3">
        <UserMenu
          email={email}
          onChangePassword={() => setPwOpen(true)}
          onSignOut={signOut}
        />
      </div>
    </nav>
  );

  return (
    <div className="flex min-h-dvh">
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

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b border-border bg-background/70 px-4 backdrop-blur-xl lg:hidden">
          <button onClick={() => setDrawer(true)} aria-label="Abrir menú">
            <Menu size={20} />
          </button>
          <Isotype className="h-6 w-auto" />
        </header>

        <main className="app-bg min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>

      <ChangePasswordModal open={pwOpen} onOpenChange={setPwOpen} />
    </div>
  );
}
