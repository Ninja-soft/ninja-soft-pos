"use client";

// ¿Quién arma el asiento de cada liquidación? (F23 · H153, ADR-162). Una sola
// fuente por negocio, para no contar dos veces la misma comisión: NinjaPOS
// (por defecto, con su propia conciliación) o NubCeo (los asientos que
// devuelve entran al Diario traducidos con la tabla de equivalencias). El
// cambio vale desde el primer día de un mes abierto.

import { useMemo, useState } from "react";
import Link from "next/link";
import { RefreshCcw, Store } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ChoiceCard } from "@/components/ui/ChoiceCard";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { accErrorMessage } from "@/lib/accounting/sources";
import { defaultFromMonth, monthLabel, openMonthStarts } from "@/lib/accounting/settlementSource";
import { fmtDate } from "@/components/purchases/shared";
import {
  useSettlementSourceInfo,
  useSettlementSourceMutations,
  type SettlementSource,
} from "@/modules/accounting/settlementSource";

export function SettlementSourceCard() {
  const { toast } = useToast();
  const { data: info, isLoading } = useSettlementSourceInfo();
  const m = useSettlementSourceMutations();
  const today = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
  const months = useMemo(() => (info?.first_open_month ? openMonthStarts(info.first_open_month, today) : []), [info, today]);
  const [choice, setChoice] = useState<SettlementSource | null>(null);
  const [from, setFrom] = useState<string>("");
  const [confirm, setConfirm] = useState(false);

  if (isLoading || !info) return null;
  const selected = choice ?? info.source;
  const fromValue = from || defaultFromMonth(months, today);
  const changed = selected !== info.source;

  async function apply() {
    try {
      await m.set.mutateAsync({ source: selected, from: fromValue });
      toast({
        title: selected === "nubceo" ? "Los asientos de liquidación ahora vienen de NubCeo" : "NinjaPOS vuelve a armar los asientos de liquidación",
        description: `Desde el ${fmtDate(fromValue)}. Los asientos de liquidación de esas fechas se rearmaron.`,
        variant: "success",
      });
      setChoice(null);
      setConfirm(false);
    } catch (e) {
      toast({ title: "No se pudo cambiar", description: accErrorMessage(e), variant: "error" });
    }
  }

  return (
    <section className="rounded-xl bg-card p-4 ring-1 ring-border">
      <h3 className="font-semibold">Liquidaciones de procesadores: ¿quién arma el asiento?</h3>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
        Cada liquidación (Mercado Pago, Payway, Fiserv...) tiene un asiento: neto al banco o billetera, comisión, IVA de
        la comisión y retenciones. Lo arma una sola fuente para no contarlo dos veces.
        {info.from ? ` Hoy: ${info.source === "nubceo" ? "NubCeo" : "NinjaPOS"} desde el ${fmtDate(info.from)}.` : ""}
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <ChoiceCard
          selected={selected === "ninjapos"}
          icon={<Store size={18} />}
          title="NinjaPOS (recomendado)"
          description="Con la conciliación propia: cada liquidación conciliada arma su asiento. Los asientos de NubCeo se ven como control y no entran al Diario."
          onClick={() => setChoice("ninjapos")}
        />
        <ChoiceCard
          selected={selected === "nubceo"}
          icon={<RefreshCcw size={18} />}
          title="NubCeo"
          description={
            info.nubceo_feature
              ? "Para quien ya tiene NubCeo armado con su estudio: los asientos de liquidación que devuelve NubCeo entran al Diario con tu plan de cuentas."
              : "Tu plan no incluye la integración con NubCeo."
          }
          disabled={!info.nubceo_feature}
          onClick={() => setChoice("nubceo")}
        />
      </div>
      {selected === "nubceo" && (
        <p className="mt-3 text-sm text-muted-foreground">
          NubCeo devolvió {info.nubceo_headers} asientos de liquidación; {info.nubceo_in_journal} están en el Diario
          {info.nubceo_issues > 0 ? ` y ${info.nubceo_issues} esperan cuentas sin equivalencia` : ""}. Las equivalencias
          se cargan en{" "}
          <Link href={"/tesoreria/nubceo?vista=cuentas" as never} className="text-ninja-flameSoft underline">
            Tesorería, NubCeo, Cuentas
          </Link>
          .
        </p>
      )}
      {changed && (
        <div className="mt-3 flex flex-col gap-2 rounded-md bg-muted/40 p-3 sm:flex-row sm:items-end">
          <label className="flex min-w-0 flex-col gap-1 sm:w-60">
            <span className="text-xs text-muted-foreground">Desde</span>
            <select
              className="h-9 rounded-md border border-input bg-background px-2.5 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
              value={fromValue}
              onChange={(e) => setFrom(e.target.value)}
            >
              {months.map((x) => (
                <option key={x} value={x} className="bg-popover text-popover-foreground">
                  1 de {monthLabel(x)}
                </option>
              ))}
            </select>
          </label>
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">
            Sólo meses abiertos. Desde esa fecha se dan de baja los asientos de liquidación de la fuente anterior y se
            arman los de la nueva.
          </p>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setChoice(null)}>
              Cancelar
            </Button>
            <Button disabled={!fromValue} onClick={() => setConfirm(true)}>
              Cambiar
            </Button>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={selected === "nubceo" ? "Pasar los asientos de liquidación a NubCeo" : "Volver a NinjaPOS"}
        description={`Desde el ${fromValue ? fmtDate(fromValue) : ""}, ${
          selected === "nubceo"
            ? "los asientos de cada liquidación salen de lo que devuelve NubCeo. Los que había armado NinjaPOS desde esa fecha se dan de baja."
            : "NinjaPOS arma el asiento de cada liquidación conciliada. Los asientos de NubCeo desde esa fecha salen del Diario."
        } Queda registrado en la auditoría.`}
        confirmLabel="Cambiar la fuente"
        loading={m.set.isPending}
        onConfirm={() => void apply()}
      />
    </section>
  );
}
