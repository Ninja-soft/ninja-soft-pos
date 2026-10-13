"use client";

import { useState } from "react";
import { clearRememberedBusiness } from "@/lib/auth/rememberedBusiness";
import { useRememberedBusiness } from "@/lib/auth/useRememberedBusiness";
import { cn } from "@/lib/utils/cn";

// Versión celular del negocio recordado (en desktop vive en el panel de marca,
// ver BusinessOrbit): logo chico + nombre arriba del formulario de login, con
// el link para olvidarlo. Si la imagen falla, no se muestra.
export function RememberedBusinessChip({ className }: { className?: string }) {
  const { business } = useRememberedBusiness();
  const [failed, setFailed] = useState<string | null>(null);
  if (!business || business.logoUrl === failed) return null;
  return (
    <div className={cn("flex items-center gap-3 rounded-lg border border-border bg-card p-3", className)}>
      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-border bg-white">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={business.logoUrl}
          alt={`Logo de ${business.name}`}
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(business.logoUrl)}
          className="h-8 w-8 object-contain"
        />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted-foreground">Hola de nuevo</p>
        <p className="truncate text-sm font-semibold text-foreground">{business.name}</p>
        <button
          type="button"
          onClick={() => clearRememberedBusiness()}
          className="mt-0.5 rounded-sm text-xs text-muted-foreground underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          ¿No es tu negocio? Usar otra cuenta
        </button>
      </div>
    </div>
  );
}
