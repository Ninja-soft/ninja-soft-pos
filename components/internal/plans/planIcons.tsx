"use client";

import {
  Store,
  Building2,
  Rocket,
  Crown,
  Star,
  Zap,
  Gem,
  Briefcase,
  ShoppingBag,
  ShoppingCart,
  Package,
  Boxes,
  Sparkles,
  Flame,
  Shield,
  Tag,
  type LucideIcon,
} from "lucide-react";

// Picker curado de íconos para planes. La clave (key lucide) se persiste en
// plans.icon. Fallback a Tag si la clave no está en el catálogo.
export const PLAN_ICONS: { key: string; Icon: LucideIcon }[] = [
  { key: "Store", Icon: Store },
  { key: "Building2", Icon: Building2 },
  { key: "Rocket", Icon: Rocket },
  { key: "Crown", Icon: Crown },
  { key: "Star", Icon: Star },
  { key: "Zap", Icon: Zap },
  { key: "Gem", Icon: Gem },
  { key: "Briefcase", Icon: Briefcase },
  { key: "ShoppingBag", Icon: ShoppingBag },
  { key: "ShoppingCart", Icon: ShoppingCart },
  { key: "Package", Icon: Package },
  { key: "Boxes", Icon: Boxes },
  { key: "Sparkles", Icon: Sparkles },
  { key: "Flame", Icon: Flame },
  { key: "Shield", Icon: Shield },
  { key: "Tag", Icon: Tag },
];

export const DEFAULT_PLAN_ICON = "Store";

const ICON_MAP = new Map(PLAN_ICONS.map((i) => [i.key, i.Icon]));

export function planIcon(key: string | null | undefined): LucideIcon {
  if (key && ICON_MAP.has(key)) return ICON_MAP.get(key)!;
  return Tag;
}

export function PlanIcon({
  iconKey,
  size = 18,
  className,
}: {
  iconKey: string | null | undefined;
  size?: number;
  className?: string;
}) {
  const Icon = planIcon(iconKey);
  return <Icon size={size} className={className} />;
}
