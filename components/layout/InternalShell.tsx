"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Bell,
  Boxes,
  Building2,
  ChevronDown,
  CreditCard,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Mail,
  Menu,
  Moon,
  ScrollText,
  ShieldCheck,
  Sparkles,
  Store,
  Sun,
  Tag,
  UserCog,
  Users,
  X,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils/cn";
import { capitalizeName } from "@/lib/utils/format";
import { useTheme } from "@/lib/theme/ThemeProvider";
import { Isotype } from "@/components/brand/Logo";
import { Avatar } from "@/components/ui/Avatar";
import { ChangePasswordModal } from "@/components/ui/ChangePasswordModal";
import { ProfileEditModal } from "@/components/account/ProfileEditModal";
import { InactivityGuard } from "@/components/system/InactivityGuard";
import {
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownLabel,
  DropdownSeparator,
  DropdownTrigger,
} from "@/components/ui/Dropdown";

const NAV = [
  { href: "/internal", label: "Inicio", icon: LayoutDashboard },
  { href: "/internal/tenants", label: "Negocios", icon: Building2 },
  { href: "/internal/usuarios", label: "Usuarios", icon: Users },
  { href: "/internal/staff", label: "Staff", icon: ShieldCheck },
  { href: "/internal/emails", label: "Emails", icon: Mail },
  { href: "/internal/pagos", label: "Pagos", icon: CreditCard },
  { href: "/internal/planes", label: "Planes", icon: Tag },
  { href: "/internal/notificaciones", label: "Notificaciones", icon: Bell },
  { href: "/internal/addons", label: "Complementos", icon: Sparkles },
  { href: "/internal/catalogos", label: "Catálogos", icon: Boxes },
  { href: "/internal/audit", label: "Auditoría", icon: ScrollText },
];
const LEVEL_LABELS: Record<string, string> = {
  super_admin: "Super admin",
  admin: "Admin",
  support: "Soporte",
};

export function InternalShell({
  email,
  level,
  children,
}: {
  email: string;
  level: string | null;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { theme, toggleTheme } = useTheme();
  const [drawer, setDrawer] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const [pfOpen, setPfOpen] = useState(false);
  const isDark = theme === "ninja-dark" || theme === "ninja-noir";

  const { data: me, isLoading: meLoading } = useQuery({
    queryKey: ["internal-shell-profile"],
    queryFn: async () => {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return null;
      // Cuenta (users) con fallback a la foto/nombre de membresía (POS).
      const [acc, mem] = await Promise.all([
        supabase.from("users").select("full_name, avatar_url").eq("id", user.id).maybeSingle(),
        supabase
          .from("tenant_users")
          .select("display_name, avatar")
          .eq("user_id", user.id)
          .eq("status", "active")
          .limit(1)
          .maybeSingle(),
      ]);
      return {
        full_name: acc.data?.full_name ?? mem.data?.display_name ?? null,
        avatar_url: acc.data?.avatar_url ?? mem.data?.avatar ?? null,
      };
    },
  });
  const name = me?.full_name || email;

  async function signOut() {
    await createClient().auth.signOut();
    router.push("/login");
    router.refresh();
  }

  const nav = (
    <nav className="flex h-full flex-col gap-1 p-3">
      <Link
        href="/internal"
        onClick={() => setDrawer(false)}
        className="mb-1 flex items-center gap-2.5 px-2 py-2"
      >
        <Isotype className="h-8 w-auto" priority />
        <span className="flex flex-col leading-none">
          <span className="font-display text-sm font-extrabold tracking-tight text-foreground">
            NinjaPos
          </span>
          <span className="mt-0.5 text-[10px] font-bold uppercase tracking-[0.22em] text-ninja-flameSoft">
            Panel interno
          </span>
        </span>
      </Link>
      <div className="mb-2" />

      {NAV.map((it) => {
        const Icon = it.icon;
        const active =
          it.href === "/internal"
            ? pathname === "/internal"
            : pathname === it.href || pathname.startsWith(it.href + "/");
        return (
          <Link
            key={it.href}
            href={it.href as never}
            onClick={() => setDrawer(false)}
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition",
              active
                ? "bg-ninja-flame/15 font-medium text-ninja-flameSoft"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <Icon size={17} />
            {it.label}
          </Link>
        );
      })}

      <div className="mt-auto space-y-3 pt-3">
        <Link
          href="/dashboard"
          onClick={() => setDrawer(false)}
          className="flex items-center gap-2.5 rounded-lg border border-border bg-card p-2 transition hover:border-ninja-flameSoft/50 hover:bg-muted"
        >
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-muted text-ninja-flameSoft">
            <Store size={16} />
          </span>
          <span className="text-sm font-medium text-foreground">Volver al POS</span>
        </Link>
        <Dropdown>
          <DropdownTrigger asChild>
            <button className="flex w-full items-center gap-2.5 rounded-lg border border-border bg-card p-2 text-left transition hover:bg-muted">
              <Avatar name={name} avatar={me?.avatar_url} size={32} loading={meLoading} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground">
                  {name === email ? name : capitalizeName(name)}
                </span>
                {name !== email && (
                  <span className="block truncate text-xs text-muted-foreground">
                    {email}
                  </span>
                )}
                <span className="mt-0.5 block truncate text-[11px] font-medium text-ninja-flameSoft">
                  {level ? LEVEL_LABELS[level] ?? level : "Staff"}
                </span>
              </span>
              <ChevronDown size={15} className="shrink-0 text-muted-foreground" />
            </button>
          </DropdownTrigger>
          <DropdownContent align="start" className="w-[232px]">
            <DropdownLabel>{email}</DropdownLabel>
            <DropdownItem
              onSelect={(e) => {
                e.preventDefault();
                toggleTheme();
              }}
            >
              {isDark ? <Sun size={15} /> : <Moon size={15} />}
              {isDark ? "Modo claro" : "Modo oscuro"}
            </DropdownItem>
            <DropdownItem onSelect={() => setPfOpen(true)}>
              <UserCog size={15} /> Editar mi perfil
            </DropdownItem>
            <DropdownItem onSelect={() => setPwOpen(true)}>
              <KeyRound size={15} /> Cambiar contraseña
            </DropdownItem>
            <DropdownSeparator />
            <DropdownItem onSelect={signOut} className="text-destructive">
              <LogOut size={15} /> Cerrar sesión
            </DropdownItem>
          </DropdownContent>
        </Dropdown>
      </div>
    </nav>
  );

  return (
    <div className="flex min-h-dvh">
      {/* Auto-logout por inactividad: aplica también al staff. */}
      <InactivityGuard />
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 border-r border-border bg-background/60 backdrop-blur-xl lg:block">
        {nav}
      </aside>

      {drawer && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setDrawer(false)} />
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
          <span className="text-xs font-semibold text-ninja-flameSoft">Interno</span>
        </header>

        <main className="app-bg min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-6xl px-6 py-8">{children}</div>
        </main>
      </div>

      <ChangePasswordModal open={pwOpen} onOpenChange={setPwOpen} />
      <ProfileEditModal open={pfOpen} onOpenChange={setPfOpen} />
    </div>
  );
}
