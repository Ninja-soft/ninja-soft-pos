"use client";

// Logística (ADR-149 · L0, A24): un solo menú con sus sub-páginas. Esta barra
// va arriba de Expedición, Reparto, Flota, Remitos y Envíos para pasar de una a otra sin
// volver al menú. Las que el plan no incluye se ven con candado (la página
// explica cómo sumarlas). Mobile-first: una fila con scroll lateral.

import Link from "next/link";
import type { Route } from "next";
import { usePathname } from "next/navigation";
import { FileText, Lock, PackageCheck, Route as RouteIcon, Send, Truck, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { useFeature } from "@/modules/saas/gating";

export interface LogisticsSection {
  href: string;
  label: string;
  icon: LucideIcon;
  feature: string;
}

export const LOGISTICS_SECTIONS: LogisticsSection[] = [
  { href: "/expedicion", label: "Expedición", icon: PackageCheck, feature: "pedidos_despacho" },
  // ADR-161 (L2): hojas de ruta y flota del reparto propio.
  { href: "/logistica/reparto", label: "Reparto", icon: RouteIcon, feature: "reparto_propio" },
  { href: "/logistica/flota", label: "Flota", icon: Truck, feature: "reparto_propio" },
  { href: "/remitos", label: "Remitos", icon: FileText, feature: "entregas_remitos" },
  { href: "/envios", label: "Envíos", icon: Send, feature: "envios" },
];

/** ¿Esta ruta es parte de Logística? (para marcar el ítem del menú). */
export function isLogisticsPath(pathname: string): boolean {
  return pathname === "/logistica" || LOGISTICS_SECTIONS.some((s) => pathname === s.href || pathname.startsWith(`${s.href}/`));
}

function SectionLink({ s, active }: { s: LogisticsSection; active: boolean }) {
  const on = useFeature(s.feature);
  const Icon = s.icon;
  return (
    <Link
      href={s.href as Route}
      aria-current={active ? "page" : undefined}
      className={cn(
        "inline-flex h-10 shrink-0 items-center gap-2 rounded-lg px-3.5 text-sm font-medium transition",
        active ? "bg-ninja-flame/15 text-ninja-flameSoft" : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <Icon size={16} aria-hidden />
      {s.label}
      {on === false && <Lock size={13} aria-label="No incluido en tu plan" />}
    </Link>
  );
}

export function LogisticsNav({ className }: { className?: string }) {
  const pathname = usePathname() ?? "";
  return (
    <nav aria-label="Logística" className={cn("-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0", className)}>
      <div className="flex w-max gap-1 rounded-xl bg-muted/50 p-1">
        {LOGISTICS_SECTIONS.map((s) => (
          <SectionLink key={s.href} s={s} active={pathname === s.href || pathname.startsWith(`${s.href}/`)} />
        ))}
      </div>
    </nav>
  );
}
LogisticsNav.displayName = "LogisticsNav";
