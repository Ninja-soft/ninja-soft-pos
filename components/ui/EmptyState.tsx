import type { LucideIcon } from "lucide-react";
import { Inbox } from "lucide-react";
import { cn } from "@/lib/utils/cn";

// Estado vacío: ícono en una pastilla tonal + título + bajada + CTA.
// `compact` para listas dentro de cards o modales.
export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
  compact = false,
  className,
}: {
  icon?: LucideIcon;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center text-center",
        compact ? "gap-2 px-4 py-6" : "gap-3 px-6 py-12",
        className,
      )}
    >
      <span
        className={cn(
          "grid place-items-center rounded-lg bg-ninja-flame/10 text-ninja-flameSoft",
          compact ? "h-10 w-10" : "h-14 w-14",
        )}
        aria-hidden
      >
        <Icon size={compact ? 18 : 24} strokeWidth={1.75} />
      </span>
      <div className="max-w-sm space-y-1">
        <p
          className={cn(
            "font-semibold text-foreground",
            compact ? "text-sm" : "text-base",
          )}
        >
          {title}
        </p>
        {description && (
          <p className="text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {action && <div className={compact ? "mt-1" : "mt-2"}>{action}</div>}
    </div>
  );
}
EmptyState.displayName = "EmptyState";
