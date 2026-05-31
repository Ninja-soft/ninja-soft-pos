import {
  Cat,
  Dog,
  Bird,
  Fish,
  Rabbit,
  Crown,
  Star,
  Heart,
  Rocket,
  Flame,
  Coffee,
  IceCream,
  Scissors,
  ShoppingCart,
  Store,
  Sparkles,
  Leaf,
  Smile,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils/cn";

// Avatares de miembros: iconos (lucide) o iniciales con color determinístico.
// La subida de imagen propia se habilita en F6 (WebP). Sin emojis.
export const AVATAR_ICONS: Record<string, LucideIcon> = {
  cat: Cat,
  dog: Dog,
  bird: Bird,
  fish: Fish,
  rabbit: Rabbit,
  crown: Crown,
  star: Star,
  heart: Heart,
  rocket: Rocket,
  flame: Flame,
  coffee: Coffee,
  icecream: IceCream,
  scissors: Scissors,
  cart: ShoppingCart,
  store: Store,
  sparkles: Sparkles,
  leaf: Leaf,
  smile: Smile,
};

export const AVATAR_PRESETS = Object.keys(AVATAR_ICONS);

const COLORS = [
  "#ff6a2c", "#ec3f17", "#ffb020", "#7c4dff", "#2db8a3",
  "#3b82f6", "#e8456b", "#16a34a", "#0ea5e9", "#a855f7",
];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0] ?? "";
  if (!first) return "?";
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  const last = parts[parts.length - 1] ?? "";
  return ((first[0] ?? "") + (last[0] ?? "")).toUpperCase();
}

export function Avatar({
  name,
  avatar,
  size = 36,
  loading = false,
  className,
}: {
  name: string;
  avatar?: string | null;
  size?: number;
  loading?: boolean;
  className?: string;
}) {
  if (loading) {
    return (
      <span
        className={cn(
          "inline-grid shrink-0 place-items-center rounded-full bg-muted",
          className,
        )}
        style={{ width: size, height: size }}
        aria-label="Cargando"
      >
        <span
          className="animate-spin rounded-full border-2 border-muted-foreground/30 border-t-ninja-flameSoft"
          style={{ width: size * 0.5, height: size * 0.5 }}
        />
      </span>
    );
  }
  const isUrl = !!avatar && /^https?:\/\//.test(avatar);
  const Icon = avatar && !isUrl ? AVATAR_ICONS[avatar] : undefined;
  const color = COLORS[hash(name || avatar || "?") % COLORS.length];

  if (isUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={avatar!}
        alt={name}
        className={cn("shrink-0 rounded-full object-cover", className)}
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <span
      className={cn(
        "inline-grid shrink-0 place-items-center rounded-full font-semibold text-white",
        className,
      )}
      style={{ width: size, height: size, fontSize: size * 0.4, background: color }}
      aria-hidden
    >
      {Icon ? <Icon size={Math.round(size * 0.5)} /> : initials(name)}
    </span>
  );
}
