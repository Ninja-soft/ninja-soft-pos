"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils/cn";

const LINKS = [
  { href: "/internal/tenants", label: "Negocios" },
  { href: "/internal/staff", label: "Staff" },
  { href: "/internal/emails", label: "Emails" },
];

export function InternalNav() {
  const pathname = usePathname();
  return (
    <nav className="hidden items-center gap-1 sm:flex">
      {LINKS.map((l) => {
        const active = pathname === l.href || pathname.startsWith(l.href + "/");
        return (
          <Link
            key={l.href}
            href={l.href as never}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm transition",
              active
                ? "bg-ninja-flame/12 font-medium text-ninja-flameSoft"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
