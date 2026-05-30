"use client";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "@/lib/theme/ThemeProvider";
import { AppearanceProvider } from "@/lib/theme/AppearanceProvider";
import { ToastProvider } from "@/components/ui/Toast";
import { PrefsLoader } from "@/components/system/PrefsLoader";

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 30_000, refetchOnWindowFocus: false },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
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
