"use client";

// "Tus datos de contacto en el presupuesto" (ADR-123): los datos DEL NEGOCIO
// que salen impresos en el documento, separados de los del cliente para que
// no se confundan. Solo lectura; se cambian en Configuración → Presupuestos
// (email y teléfono) o en la marca del comprobante (nombre, CUIT, dirección).
import Link from "next/link";
import type { Route } from "next";
import { Building2, Mail, MapPin, Phone } from "lucide-react";
import { POS_EYEBROW } from "@/components/pos/ui/posStyles";
import type { QuoteBrand } from "@/lib/quotes/logic";
import { cn } from "@/lib/utils/cn";

export function QuoteContactCard({ brand, className }: { brand: QuoteBrand | null; className?: string }) {
  const name = brand?.trade_name || brand?.legal_name || "Tu negocio";
  const rows = [
    { icon: Phone, value: brand?.phone, empty: "Sin teléfono" },
    { icon: Mail, value: brand?.email, empty: "Sin email" },
    { icon: MapPin, value: brand?.address, empty: "Sin dirección" },
  ];
  return (
    <div className={cn("rounded-lg border border-border bg-card p-3", className)}>
      <div className="flex items-center justify-between gap-2">
        <p className={POS_EYEBROW}>Tus datos en el presupuesto</p>
        <Link
          href={"/configuracion?seccion=presupuestos" as Route}
          className="text-xs font-semibold text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Cambiar
        </Link>
      </div>
      <p className="mt-2 flex items-center gap-2 text-sm font-semibold">
        <Building2 size={15} className="shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate">{name}</span>
      </p>
      <ul className="mt-1.5 space-y-1 text-xs">
        {rows.map(({ icon: Icon, value, empty }) => (
          <li key={empty} className="flex items-center gap-2">
            <Icon size={13} className="shrink-0 text-muted-foreground" aria-hidden />
            <span className={cn("truncate", value ? "text-foreground" : "text-muted-foreground")}>{value || empty}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
        Salen impresos en el documento para que el cliente te responda. No son los datos del cliente.
      </p>
    </div>
  );
}
