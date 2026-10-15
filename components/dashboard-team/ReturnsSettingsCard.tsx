"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarClock, Scale, Tags, Ticket } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/ui/Toast";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { ReturnReasonsModal } from "@/components/sales/ReturnReasonsModal";
import {
  useReturnReasons,
  useReturnSettings,
  useSaveReturnSettings,
} from "@/modules/sales/hooks";
import type { ReturnPolicy } from "@/modules/sales/api";
import { ChoiceDot } from "@/components/ui/ChoiceCard";
import { onlyActiveTenant } from "@/lib/tenant/scope";

const POLICIES: { value: ReturnPolicy; label: string; hint: string; tag?: string }[] = [
  {
    value: "cashier_choice",
    label: "El cajero elige caso a caso",
    hint: "En cada devolución el cajero decide entre efectivo y vale.",
  },
  {
    value: "always_credit",
    label: "Siempre saldo a favor (vale)",
    hint: "Toda devolución emite un vale canjeable. Recomendado para retail.",
    tag: "Recomendada",
  },
  {
    value: "always_cash",
    label: "Siempre efectivo",
    hint: "Toda devolución se reintegra por caja en efectivo.",
  },
];

// Sección "Devoluciones" de Configuración: política de devolución del negocio,
// validez del vale y acceso al catálogo de motivos (con destino de stock).
// Card propia — no toca OperationSettingsCard (page_size).
export function ReturnsSettingsCard() {
  const supabase = createClient();
  const { toast } = useToast();
  const [reasonsOpen, setReasonsOpen] = useState(false);

  const { data: ctx } = useQuery({
    queryKey: ["returns-settings-ctx"],
    queryFn: async (): Promise<{ tenantId: string; role: string } | null> => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return null;
      const { data: mem } = await onlyActiveTenant(
        supabase
          .from("tenant_users")
          .select("tenant_id, role")
          .eq("user_id", user.id)
          .eq("status", "active"),
        user,
      )
        .limit(1)
        .maybeSingle();
      if (!mem) return null;
      return { tenantId: mem.tenant_id, role: mem.role };
    },
  });
  const tenantId = ctx?.tenantId ?? "";

  const { data: settings } = useReturnSettings();
  const { data: reasons } = useReturnReasons(false);
  const save = useSaveReturnSettings();

  const [policy, setPolicy] = useState<ReturnPolicy>("cashier_choice");
  const [validity, setValidity] = useState<string>(""); // "" = sin vencimiento

  useEffect(() => {
    if (!settings) return;
    setPolicy(settings.return_policy);
    setValidity(
      settings.voucher_validity_months == null ? "" : String(settings.voucher_validity_months),
    );
  }, [settings]);

  if (!ctx || (ctx.role !== "owner" && ctx.role !== "manager")) return null;

  function persist() {
    const months = validity.trim() === "" ? null : Math.max(1, Math.min(120, Number(validity) || 0));
    save.mutate(
      { tenantId, input: { return_policy: policy, voucher_validity_months: months } },
      {
        onSuccess: () => toast({ title: "Guardado", variant: "success" }),
        onError: () => toast({ title: "No se pudo guardar", variant: "error" }),
      },
    );
  }

  const activeReasons = (reasons ?? []).filter((r) => r.is_active).length;

  return (
    <section className="space-y-4">
      {/* Política de devolución */}
      <Card>
        <CardContent className="p-5">
          <div className="flex items-center gap-2 font-semibold">
            <Scale size={16} className="text-ninja-flameSoft" /> Política de devolución
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Define el reintegro por defecto al registrar una devolución.
          </p>
          <div className="mt-3 space-y-2">
            {POLICIES.map((p) => {
              const active = policy === p.value;
              return (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => setPolicy(p.value)}
                  className={
                    active
                      ? "flex w-full items-start gap-3 rounded-lg border choice-on px-4 py-3 text-left"
                      : "flex w-full items-start gap-3 rounded-lg border border-border px-4 py-3 text-left transition hover:bg-muted"
                  }
                >
                  <ChoiceDot selected={active} className="mt-0.5" />
                  <span className="min-w-0">
                    <span className="flex items-center gap-2 text-sm font-medium">
                      {p.label}
                      {p.tag && (
                        <span className="rounded-md bg-emerald-400/15 px-2 py-0.5 text-[11px] font-semibold text-success">
                          {p.tag}
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{p.hint}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Validez del vale */}
      <Card>
        <CardContent className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
          <div>
            <div className="flex items-center gap-2 font-semibold">
              <CalendarClock size={16} className="text-ninja-flameSoft" /> Validez del vale (meses)
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Cuántos meses dura un vale antes de vencer. Vacío = sin vencimiento.
            </p>
          </div>
          <span className="flex items-center gap-1">
            <input
              type="number"
              min={1}
              max={120}
              step={1}
              value={validity}
              placeholder="∞"
              onChange={(e) => setValidity(e.target.value)}
              className="h-9 w-24 rounded-md border border-input bg-background px-2 text-right text-sm outline-none focus:border-ninja-flameSoft"
            />
            <span className="text-sm text-muted-foreground">meses</span>
          </span>
        </CardContent>
      </Card>

      {/* Motivos de devolución (catálogo con destino de stock) */}
      <Card>
        <CardContent className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
          <div>
            <div className="flex items-center gap-2 font-semibold">
              <Tags size={16} className="text-ninja-flameSoft" /> Motivos de devolución
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {activeReasons > 0
                ? `${activeReasons} motivo${activeReasons === 1 ? "" : "s"} activo${
                    activeReasons === 1 ? "" : "s"
                  }. Cada uno define el destino de stock al devolver.`
                : "Definí los motivos y su destino de stock (vuelve a la venta, depósito, merma…)."}
            </p>
          </div>
          <Button variant="secondary" onClick={() => setReasonsOpen(true)}>
            <Tags size={16} /> Administrar motivos
          </Button>
        </CardContent>
      </Card>

      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <Ticket size={13} className="mt-0.5 shrink-0" />
        <span>
          Los vales se emiten con un código único canjeable en el POS y se imprimen con la
          plantilla de ticket activa.
        </span>
      </p>

      <div className="flex justify-end">
        <Button loading={save.isPending} onClick={persist}>
          Guardar cambios
        </Button>
      </div>

      <ReturnReasonsModal open={reasonsOpen} onOpenChange={setReasonsOpen} />
    </section>
  );
}
