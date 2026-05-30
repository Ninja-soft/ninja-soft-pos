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
  Package,
  Receipt,
  ShoppingCart,
  Users,
  Wallet,
  X,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils/cn";
import { Isotype } from "@/components/brand/Logo";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { ChangePasswordModal } from "@/components/ui/ChangePasswordModal";

type Item = { href: string; label: string; icon: React.ElementType };
type Group = { label: string; items: Item[] };

// Estructura escalable: agregar grupos/items acá.
const NAV: { top: Item[]; groups: Group[] } = {
  top: [{ href: "/dashboard", label: "Inicio", icon: LayoutDashboard }],
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
        href="/dashboard"
        onClick={() => setDrawer(false)}
        className="mb-4 flex items-center gap-2 px-2 py-1"
      >
        <Isotype className="h-8 w-auto" />
        <span className="font-display text-lg font-bold tracking-tight">
          Ninja<span className="text-ninja-flameSoft">Soft</span>
        </span>
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
              className="flex w-full items-center justify-between px-3 py-1 font-display text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground"
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

      <div className="mt-auto space-y-2 border-t border-border pt-3">
        <div className="truncate px-3 text-xs text-muted-foreground">{email}</div>
        <div className="flex items-center gap-2 px-1">
          <ThemeToggle />
        </div>
        <button
          onClick={() => setPwOpen(true)}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
        >
          <KeyRound size={16} /> Cambiar contraseña
        </button>
        <button
          onClick={signOut}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-destructive transition hover:bg-destructive/10"
        >
          <LogOut size={16} /> Cerrar sesión
        </button>
      </div>
    </nav>
  );

  return (
    <div className="flex min-h-dvh">
      {/* Sidebar fijo (desktop) */}
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 border-r border-border bg-background/60 backdrop-blur-xl lg:block">
        {nav}
      </aside>

      {/* Drawer (mobile) */}
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
        {/* Topbar mobile */}
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
