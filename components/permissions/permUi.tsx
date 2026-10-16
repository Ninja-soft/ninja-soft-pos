"use client";

import {
  BarChart3,
  Boxes,
  Calculator,
  Crown,
  Eye,
  Landmark,
  MapPinned,
  Package,
  Plug,
  Search,
  Settings,
  Shield,
  ShoppingCart,
  Store,
  Tag,
  Truck,
  User,
  UserCog,
  Users,
  Wallet,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { RISK_LABEL, type CapabilityRisk, type ModuleKey, type RoleColor, type RoleIcon } from "@/lib/permissions/capabilities";
import { ROLE_COLOR_HEX } from "@/lib/permissions/editor";
import { cn } from "@/lib/utils/cn";

// Piezas visuales del editor de permisos (ADR-138): sin degradados, sin
// sombras ni bordes laterales de color; el color del rol va en un punto o en
// el ícono, nunca de fondo de tarjeta.

export const ROLE_ICON: Record<RoleIcon, LucideIcon> = {
  crown: Crown,
  shield: Shield,
  store: Store,
  eye: Eye,
  tag: Tag,
  search: Search,
  user: User,
  wrench: Wrench,
  truck: Truck,
  calculator: Calculator,
};

export const MODULE_ICON: Record<ModuleKey, LucideIcon> = {
  ventas: ShoppingCart,
  caja: Wallet,
  productos: Package,
  stock: Boxes,
  clientes: Users,
  compras: Truck,
  finanzas: Landmark,
  reportes: BarChart3,
  configuracion: Settings,
  equipo: UserCog,
  integraciones: Plug,
  logistica: MapPinned,
};

const RISK_TONE: Record<CapabilityRisk, BadgeTone> = {
  low: "neutral",
  medium: "info",
  high: "warning",
  critical: "danger",
};

export function RiskBadge({ risk, className }: { risk: CapabilityRisk; className?: string }) {
  return (
    <Badge tone={RISK_TONE[risk]} className={cn("px-1.5 py-0 text-[10px]", className)}>
      {RISK_LABEL[risk]}
    </Badge>
  );
}

/** Ícono del rol sobre un fondo neutro, con el color del rol en el trazo. */
export function RoleBadgeIcon({ color, icon, size = 36 }: { color: RoleColor; icon: RoleIcon; size?: number }) {
  const Icon = ROLE_ICON[icon] ?? User;
  return (
    <span
      className="grid shrink-0 place-items-center rounded-lg bg-muted"
      style={{ width: size, height: size, color: ROLE_COLOR_HEX[color] }}
      aria-hidden
    >
      <Icon size={Math.round(size * 0.5)} />
    </span>
  );
}

/** Pastilla compacta con el punto de color y el nombre del rol. */
export function RoleChip({ name, color, className }: { name: string; color: RoleColor; className?: string }) {
  return (
    <span className={cn("inline-flex max-w-full items-center gap-1.5 rounded-md bg-muted px-2 py-0.5 text-xs font-semibold", className)}>
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: ROLE_COLOR_HEX[color] }} aria-hidden />
      <span className="truncate">{name}</span>
    </span>
  );
}
