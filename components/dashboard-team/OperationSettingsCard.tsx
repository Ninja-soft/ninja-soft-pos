"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SlidersHorizontal, Percent, CircleDollarSign, PackageMinus } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/ui/Toast";
import { Card, CardContent } from "@/components/ui/Card";
import { Heading } from "@/components/ui/Typography";
import { Switch } from "@/components/ui/Switch";
import { Button } from "@/components/ui/Button";

type Settings = {
  max_discount: Record<string, number>;
  rounding_multiple: number;
  allow_negative_stock: boolean;
};

const ROLES: { key: string; label: string }[] = [
  { key: "owner", label: "Dueño" },
  { key: "manager", label: "Encargado" },
  { key: "cashier", label: "Cajero" },
];

const numCls =
  "h-9 w-24 rounded-md border border-input bg-background px-2 text-right text-sm outline-none focus:border-ninja-flameSoft";

export function OperationSettingsCard() {
  const supabase = createClient();
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: ctx } = useQuery({
    queryKey: ["my-payments-ctx"],
    queryFn: async (): Promise<{ tenantId: string; canManage: boolean } | null> => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return null;
      const { data: mem } = await supabase
        .from("tenant_users")
        .select("tenant_id, role")
        .eq("user_id", user.id)
        .eq("status", "active")
        .limit(1)
        .maybeSingle();
      if (!mem) return null;
      return {
        tenantId: mem.tenant_id,
        canManage: ["owner", "manager"].includes(mem.role),
      };
    },
  });
  const tenantId = ctx?.tenantId ?? "";

  const { data: settings } = useQuery({
    queryKey: ["pos-settings", tenantId],
    enabled: !!tenantId,
    queryFn: async (): Promise<Settings> => {
      const { data } = await supabase
        .from("pos_settings")
        .select("max_discount, rounding_multiple, allow_negative_stock")
        .eq("tenant_id", tenantId)
        .maybeSingle();
      return (
        (data as Settings) ?? {
          max_discount: { owner: 100, manager: 100, cashier: 100, viewer: 100 },
          rounding_multiple: 0,
          allow_negative_stock: true,
        }
      );
    },
  });

  const [maxDisc, setMaxDisc] = useState<Record<string, number>>({});
  const [rounding, setRounding] = useState(0);
  const [allowNeg, setAllowNeg] = useState(false);

  useEffect(() => {
    if (!settings) return;
    setMaxDisc({
      owner: settings.max_discount?.owner ?? 100,
      manager: settings.max_discount?.manager ?? 100,
      cashier: settings.max_discount?.cashier ?? 100,
    });
    setRounding(settings.rounding_multiple ?? 0);
    setAllowNeg(settings.allow_negative_stock ?? true);
  }, [settings]);

  const save = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("pos_settings").upsert(
        {
          tenant_id: tenantId,
          max_discount: {
            owner: clampPct(maxDisc.owner),
            manager: clampPct(maxDisc.manager),
            cashier: clampPct(maxDisc.cashier),
            viewer: 0,
          },
          rounding_multiple: Math.max(0, Number(rounding) || 0),
          allow_negative_stock: allowNeg,
        },
        { onConflict: "tenant_id" },
      );
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Guardado", variant: "success" });
      qc.invalidateQueries({ queryKey: ["pos-settings", tenantId] });
    },
    onError: () => toast({ title: "No se pudo guardar", variant: "error" }),
  });

  if (!ctx || !ctx.canManage) return null;

  return (
    <section className="space-y-4">
      <div>
        <Heading as="h2" className="flex items-center gap-2 text-base">
          <SlidersHorizontal size={18} /> Operación del POS
        </Heading>
        <p className="mt-1 text-sm text-muted-foreground">
          Reglas de cobro que se aplican en el punto de venta.
        </p>
      </div>

      {/* Descuento máximo por rol */}
      <Card>
        <CardContent className="p-5">
          <div className="flex items-center gap-2 font-semibold">
            <Percent size={16} className="text-ninja-flameSoft" /> Descuento máximo por rol
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Tope de % de descuento que cada rol puede aplicar al cobrar. El cajero
            no puede superarlo.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            {ROLES.map((r) => (
              <label key={r.key} className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
                <span className="text-sm">{r.label}</span>
                <span className="flex items-center gap-1">
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="1"
                    value={maxDisc[r.key] ?? 0}
                    onChange={(e) =>
                      setMaxDisc((p) => ({ ...p, [r.key]: Number(e.target.value) }))
                    }
                    className={numCls}
                  />
                  <span className="text-sm text-muted-foreground">%</span>
                </span>
              </label>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Redondeo */}
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-5">
          <div>
            <div className="flex items-center gap-2 font-semibold">
              <CircleDollarSign size={16} className="text-ninja-flameSoft" /> Redondeo del total
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Redondea el total al múltiplo indicado. 0 = sin redondeo (ej. 10 → $1.237 cobra $1.240).
            </p>
          </div>
          <span className="flex items-center gap-1">
            <span className="text-sm text-muted-foreground">$</span>
            <input
              type="number"
              min="0"
              step="1"
              value={rounding}
              onChange={(e) => setRounding(Number(e.target.value) || 0)}
              className={numCls}
            />
          </span>
        </CardContent>
      </Card>

      {/* Venta en negativo */}
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-5">
          <div>
            <div className="flex items-center gap-2 font-semibold">
              <PackageMinus size={16} className="text-ninja-flameSoft" /> Vender sin stock
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Permite vender productos aunque el stock quede en negativo. Se puede
              forzar por producto en su ficha.
            </p>
          </div>
          <Switch
            checked={allowNeg}
            onCheckedChange={setAllowNeg}
            label="Permitir venta en negativo"
          />
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Guardando…" : "Guardar cambios"}
        </Button>
      </div>
    </section>
  );
}

function clampPct(v: number | undefined) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}
