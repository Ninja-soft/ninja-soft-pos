"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "@/lib/theme/ThemeProvider";
import { AppearanceProvider } from "@/lib/theme/AppearanceProvider";
import { ToastProvider } from "@/components/ui/Toast";
import { PrefsLoader } from "@/components/system/PrefsLoader";
import { TenantCacheGuard } from "@/components/system/TenantCacheGuard";
import { areaOf, createScopedQueryClient } from "@/lib/tenant/scope";

export function Providers({ children }: { children: React.ReactNode }) {
  // Caché partida por área (ADR-152): /internal consulta con el header de
  // alcance interno (ve todos los clientes); el panel del negocio no puede
  // reusar nada de eso aunque la query key coincida.
  const [clients] = useState(() => ({
    app: createScopedQueryClient(),
    internal: createScopedQueryClient(),
  }));
  const area = areaOf(usePathname());

  return (
    <QueryClientProvider client={clients[area]}>
      <TenantCacheGuard clients={[clients.app, clients.internal]} />
      <ThemeProvider>
        <AppearanceProvider>
          <ToastProvider>
            <PrefsLoader />
            {children}
          </ToastProvider>
        </AppearanceProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
