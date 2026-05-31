import { cn } from "@/lib/utils/cn";

// Avatares de miembros: presets emoji o iniciales con color determinístico.
// La subida de imagen propia se habilita en F6 (WebP).
export const AVATAR_PRESETS = [
  "🦊", "🐯", "🐼", "🦁", "🐵", "🐧", "🐶", "🐱", "🦉", "🐝",
  "🚀", "⭐", "🔥", "🎯", "🍦", "☕", "✂️", "🛒",
] as const;

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
  className,
}: {
  name: string;
  avatar?: string | null;
  size?: number;
  className?: string;
}) {
  const isEmoji = !!avatar && /\p{Extended_Pictographic}/u.test(avatar);
  const color = COLORS[hash(name || avatar || "?") % COLORS.length];
  return (
    <span
      className={cn(
        "inline-grid shrink-0 place-items-center rounded-full font-semibold text-white",
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: isEmoji ? size * 0.55 : size * 0.4,
        background: isEmoji ? "rgba(127,127,127,0.15)" : color,
      }}
      aria-hidden
    >
      {isEmoji ? avatar : initials(name)}
    </span>
  );
}
