"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { Segmented } from "@/components/ui/Segmented";
import type { PeriodKey } from "@/lib/internal/saasKpis";

const OPTIONS: { value: PeriodKey; label: string }[] = [
  { value: "mes", label: "Este mes" },
  { value: "anterior", label: "Mes anterior" },
  { value: "12m", label: "Últimos 12 meses" },
];

// Selector de período del dashboard (spec §15.1.6). Vive en la URL (?periodo=).
export function PeriodSwitch({ value }: { value: PeriodKey }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, start] = useTransition();
  return (
    <div aria-busy={pending || undefined} className={pending ? "opacity-70 transition" : undefined}>
      <Segmented
        size="sm"
        aria-label="Período"
        value={value}
        options={OPTIONS}
        onChange={(v) => {
          const next = new URLSearchParams(params?.toString());
          if (v === "mes") next.delete("periodo");
          else next.set("periodo", v);
          const qs = next.toString();
          start(() => router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false }));
        }}
      />
    </div>
  );
}
