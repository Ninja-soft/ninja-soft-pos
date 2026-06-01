"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  SlidersHorizontal,
  Percent,
  CircleDollarSign,
  PackageMinus,
  Barcode,
  Lock,
  UserCheck,
  Hash,
} from "lucide-react";
import { formatSaleNumber } from "@/lib/utils/saleNumber";
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
  sku_auto: boolean;
  sku_prefix: string;
  require_close_reason: boolean;
  close_tolerance: number;
  require_customer: boolean;
  sale_prefix: string;
  sale_pad: number;
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
    queryKey: ["op-settings-ctx"],
    queryFn: async (): Promise<{ tenantId: string; role: string } | null> => {
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
      return { tenantId: mem.tenant_id, role: mem.role };
    },
  });
  const tenantId = ctx?.tenantId ?? "";

  const { data: settings } = useQuery({
    queryKey: ["pos-settings", tenantId],
    enabled: !!tenantId,
    queryFn: async (): Promise<Settings> => {
      const { data } = await supabase
        .from("pos_settings")
        .select(
          "max_discount, rounding_multiple, allow_negative_stock, sku_auto, sku_prefix, require_close_reason, close_tolerance, require_customer, sale_prefix, sale_pad",
        )
        .eq("tenant_id", tenantId)
        .maybeSingle();
      return (
        (data as Settings) ?? {
          max_discount: { owner: 100, manager: 100, cashier: 100, viewer: 100 },
          rounding_multiple: 0,
          allow_negative_stock: true,
          sku_auto: false,
          sku_prefix: "",
          require_close_reason: false,
          close_tolerance: 0,
          require_customer: false,
          sale_prefix: "",
          sale_pad: 0,
        }
      );
    },
  });

  const [maxDisc, setMaxDisc] = useState<Record<string, number>>({});
  const [rounding, setRounding] = useState(0);
  const [allowNeg, setAllowNeg] = useState(false);
  const [skuAuto, setSkuAuto] = useState(false);
  const [skuPrefix, setSkuPrefix] = useState("");
  const [requireReason, setRequireReason] = useState(false);
  const [tolerance, setTolerance] = useState(0);
  const [requireCustomer, setRequireCustomer] = useState(false);
  const [salePrefix, setSalePrefix] = useState("");
  const [salePad, setSalePad] = useState(0);

  useEffect(() => {
    if (!settings) return;
    setMaxDisc({
      owner: settings.max_discount?.owner ?? 100,
      manager: settings.max_discount?.manager ?? 100,
      cashier: settings.max_discount?.cashier ?? 100,
    });
    setRounding(settings.rounding_multiple ?? 0);
    setAllowNeg(settings.allow_negative_stock ?? true);
    setSkuAuto(settings.sku_auto ?? false);
    setSkuPrefix(settings.sku_prefix ?? "");
    setRequireReason(settings.require_close_reason ?? false);
    setTolerance(settings.close_tolerance ?? 0);
    setRequireCustomer(settings.require_customer ?? false);
    setSalePrefix(settings.sale_prefix ?? "");
    setSalePad(settings.sale_pad ?? 0);
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
          sku_auto: skuAuto,
          sku_prefix: skuPrefix.trim(),
          require_close_reason: requireReason,
          close_tolerance: Math.max(0, Number(tolerance) || 0),
          require_customer: requireCustomer,
          sale_prefix: salePrefix.trim(),
          sale_pad: Math.max(0, Math.min(12, Number(salePad) || 0)),
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

  if (!ctx || ctx.role !== "owner") return null;

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

      {/* SKU automático */}
      <Card>
        <CardContent className="p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 font-semibold">
                <Barcode size={16} className="text-ninja-flameSoft" /> SKU automático
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                Si un producto se crea sin SKU, se genera solo con un prefijo + número.
              </p>
            </div>
            <Switch
              checked={skuAuto}
              onCheckedChange={setSkuAuto}
              label="SKU automático"
            />
          </div>
          {skuAuto && (
            <div className="mt-3 flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Prefijo</span>
              <input
                value={skuPrefix}
                onChange={(e) => setSkuPrefix(e.target.value)}
                placeholder="Ej. ART-"
                maxLength={12}
                className="h-9 w-40 rounded-md border border-input bg-background px-2 text-sm outline-none focus:border-ninja-flameSoft"
              />
              <span className="text-xs text-muted-foreground">
                → {(skuPrefix || "") + "00001"}
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Cierre de caja */}
      <Card>
        <CardContent className="p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 font-semibold">
                <Lock size={16} className="text-ninja-flameSoft" /> Motivo en el cierre de caja
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                Exige escribir un motivo al cerrar si la diferencia (faltante o
                sobrante) supera la tolerancia.
              </p>
            </div>
            <Switch
              checked={requireReason}
              onCheckedChange={setRequireReason}
              label="Exigir motivo en el cierre"
            />
          </div>
          {requireReason && (
            <div className="mt-3 flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Tolerancia $</span>
              <input
                type="number"
                min="0"
                step="1"
                value={tolerance}
                onChange={(e) => setTolerance(Number(e.target.value) || 0)}
                className={numCls}
              />
              <span className="text-xs text-muted-foreground">
                Diferencias hasta este monto no piden motivo.
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Numeración del comprobante */}
      <Card>
        <CardContent className="p-5">
          <div className="flex items-center gap-2 font-semibold">
            <Hash size={16} className="text-ninja-flameSoft" /> Numeración del comprobante
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Personalizá cómo se ve el N° de venta. El correlativo interno no cambia.
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="text-sm">
              <span className="mb-1 block text-muted-foreground">Prefijo</span>
              <input
                value={salePrefix}
                onChange={(e) => setSalePrefix(e.target.value)}
                placeholder="Ej. NINJA-"
                maxLength={12}
                className="h-9 w-40 rounded-md border border-input bg-background px-2 text-sm outline-none focus:border-ninja-flameSoft"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-muted-foreground">Ceros (padding)</span>
              <input
                type="number"
                min={0}
                max={12}
                value={salePad}
                onChange={(e) => setSalePad(Number(e.target.value) || 0)}
                className={numCls}
              />
            </label>
            <span className="text-sm text-muted-foreground">
              Vista previa:{" "}
              <span className="font-mono font-semibold text-foreground">
                {formatSaleNumber(42, { prefix: salePrefix, pad: salePad })}
              </span>
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Requerir cliente */}
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-5">
          <div>
            <div className="flex items-center gap-2 font-semibold">
              <UserCheck size={16} className="text-ninja-flameSoft" /> Requerir cliente
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Obliga a elegir un cliente antes de cobrar (no permite “consumidor final”).
            </p>
          </div>
          <Switch
            checked={requireCustomer}
            onCheckedChange={setRequireCustomer}
            label="Requerir cliente"
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
