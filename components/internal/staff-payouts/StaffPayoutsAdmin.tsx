"use client";

// =============================================================================
// Panel "Participación y gastos" (F21 · ADR-121, spec docs/40 §20): sólo
// super_admin. Resumen, Participaciones, Gastos, Liquidaciones, Pagos y
// Simulador. La base y los permisos los valida el servidor (RLS y RPC).
// =============================================================================

import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { Route } from "next";
import { Calculator, CircleAlert, CreditCard, HandCoins, LayoutDashboard, ListChecks, Receipt, Users } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Segmented } from "@/components/ui/Segmented";
import { Callout } from "@/components/ui/Callout";
import { Skeleton } from "@/components/ui/Skeleton";
import { staffErrorMessage } from "@/lib/staffPayouts/format";
import { useStaffData, useStaffPreview } from "@/modules/staffPayouts/api";
import { SummaryTab } from "./SummaryTab";
import { SharesTab } from "./SharesTab";
import { ExpensesTab } from "./ExpensesTab";
import { RunsTab } from "./RunsTab";
import { PaymentsTab } from "./PaymentsTab";
import { SimulatorTab } from "./SimulatorTab";

const TABS = [
  { value: "resumen", label: "Resumen", icon: <LayoutDashboard size={15} aria-hidden /> },
  { value: "participaciones", label: "Participaciones", icon: <Users size={15} aria-hidden /> },
  { value: "gastos", label: "Gastos", icon: <Receipt size={15} aria-hidden /> },
  { value: "liquidaciones", label: "Liquidaciones", icon: <ListChecks size={15} aria-hidden /> },
  { value: "pagos", label: "Pagos", icon: <CreditCard size={15} aria-hidden /> },
  { value: "simulador", label: "Simulador", icon: <Calculator size={15} aria-hidden /> },
] as const;
type Tab = (typeof TABS)[number]["value"];
const isTab = (v: string | null): v is Tab => TABS.some((t) => t.value === v);

export function StaffPayoutsAdmin() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const tabParam = sp.get("tab");
  const tab: Tab = isTab(tabParam) ? tabParam : "resumen";
  const setTab = (t: Tab) => {
    const q = new URLSearchParams(sp.toString());
    if (t === "resumen") q.delete("tab");
    else q.set("tab", t);
    const qs = q.toString();
    router.replace((qs ? `${pathname}?${qs}` : pathname) as Route, { scroll: false });
  };
  const [period, setPeriod] = useState<string | null>(null);
  const data = useStaffData();
  const preview = useStaffPreview(period, tab !== "simulador");
  const err = data.error ?? (tab !== "simulador" ? preview.error : null);
  const loading = data.isLoading || (tab !== "simulador" && preview.isLoading);

  return (
    <>
      <PageHeader
        eyebrow="Panel interno"
        title="Participación y gastos"
        icon={HandCoins}
        description="Cuánto le toca a cada persona del staff del cobrado neto, los gastos que se descuentan, las liquidaciones mensuales y los pagos."
      />
      <div className="slim-scrollbar -mx-4 mt-6 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <Segmented<Tab> aria-label="Secciones" value={tab} onChange={setTab} options={TABS.map((t) => ({ ...t }))} className="flex-nowrap" />
      </div>
      <div className="mt-6">
        {err && (
          <Callout tone="warning" icon={CircleAlert} title="No se pudo cargar" className="mb-6">
            {staffErrorMessage(err)}
          </Callout>
        )}
        {tab === "simulador" ? (
          <SimulatorTab houseLabel={data.data?.settings?.house_label ?? "NinjaSoft"} />
        ) : loading ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-busy>
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-[120px] rounded-lg" />
            ))}
          </div>
        ) : data.data && preview.data ? (
          <>
            {tab === "resumen" && <SummaryTab preview={preview.data} />}
            {tab === "participaciones" && <SharesTab data={data.data} />}
            {tab === "gastos" && <ExpensesTab data={data.data} />}
            {tab === "liquidaciones" && <RunsTab data={data.data} preview={preview.data} onPeriod={setPeriod} />}
            {tab === "pagos" && <PaymentsTab data={data.data} />}
          </>
        ) : null}
      </div>
    </>
  );
}
