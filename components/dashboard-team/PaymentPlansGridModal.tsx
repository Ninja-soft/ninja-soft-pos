"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileDown, Plus, Save, Upload, X } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { createClient } from "@/lib/supabase/client";
import { useProviderPlans, usePaymentPlanMutations } from "@/modules/pos/hooks";
import { type PaymentPlan } from "@/modules/pos/api";
import {
  ALL_BRANDS,
  BRAND_LABEL,
  BRAND_OPTIONS,
  DEBIT_BRANDS,
  DEFAULT_INSTALLMENTS,
  brandLogo,
  planLabel,
} from "@/modules/pos/planConstants";
import { parsePlansXlsx, type PlanRow } from "@/modules/pos/plansXlsx";
import { exportXlsx } from "@/lib/utils/xlsx";

type MethodConfig = { installments?: number[]; brands?: string[]; plan_mode?: "global" | "plans" };

function keyOf(base: string, brand: string | null, n: number) {
  return `${base}|${brand ?? ""}|${n}`;
}

export function PaymentPlansGridModal({
  open,
  onOpenChange,
  providerKey,
  providerName,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  providerKey: string;
  providerName: string;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const supabase = createClient();
  const { data: plans = [] } = useProviderPlans(open ? providerKey : null);
  const m = usePaymentPlanMutations(providerKey);
  const fileRef = useRef<HTMLInputElement>(null);
  const [importRows, setImportRows] = useState<PlanRow[] | null>(null);
  const [editCuotas, setEditCuotas] = useState(false);
  const [editBrands, setEditBrands] = useState(false);
  const [newCuota, setNewCuota] = useState("");
  // Recargo único del medio + modo (global desactiva los planes).
  const [globalMode, setGlobalMode] = useState(false);
  const [globalPct, setGlobalPct] = useState("0");

  // Config visual + recargo del medio (tenant_payment_methods)
  const { data: cfg } = useQuery({
    queryKey: ["method-config", providerKey],
    enabled: open,
    queryFn: async (): Promise<{ config: MethodConfig; surcharge: number }> => {
      const { data } = await supabase
        .from("tenant_payment_methods")
        .select("config, surcharge_pct")
        .eq("provider_key", providerKey)
        .maybeSingle();
      return {
        config: (data?.config as MethodConfig) ?? {},
        surcharge: Number(data?.surcharge_pct) || 0,
      };
    },
  });

  useEffect(() => {
    if (!cfg) return;
    setGlobalMode(cfg.config.plan_mode === "global");
    setGlobalPct(String(cfg.surcharge ?? 0));
  }, [cfg]);

  const saveConfig = useMutation({
    mutationFn: async (patch: MethodConfig) => {
      const { data: row } = await supabase
        .from("tenant_payment_methods")
        .select("config")
        .eq("provider_key", providerKey)
        .maybeSingle();
      const cur = (row?.config as Record<string, unknown>) ?? {};
      const { error } = await supabase
        .from("tenant_payment_methods")
        .update({ config: { ...cur, ...patch } })
        .eq("provider_key", providerKey);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["method-config", providerKey] }),
    onError: () => toast({ title: "No se pudo guardar", variant: "error" }),
  });

  // Guardar: persiste recargo único + modo y activa/desactiva los planes del medio.
  const saveAll = useMutation({
    mutationFn: async () => {
      const { data: row } = await supabase
        .from("tenant_payment_methods")
        .select("config")
        .eq("provider_key", providerKey)
        .maybeSingle();
      const cur = (row?.config as Record<string, unknown>) ?? {};
      const { error } = await supabase
        .from("tenant_payment_methods")
        .update({
          surcharge_pct: Number(globalPct) || 0,
          config: { ...cur, plan_mode: globalMode ? "global" : "plans" },
        })
        .eq("provider_key", providerKey);
      if (error) throw error;
      // Modo global → planes inactivos (no se ofrecen). Modo planes → activos.
      await m.setProviderActive.mutateAsync(!globalMode);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["method-config", providerKey] });
      qc.invalidateQueries({ queryKey: ["tenant-payment-methods"] });
      toast({ title: "Guardado", variant: "success" });
      onOpenChange(false);
    },
    onError: () => toast({ title: "No se pudo guardar", variant: "error" }),
  });

  const installments =
    cfg?.config.installments && cfg.config.installments.length
      ? cfg.config.installments
      : DEFAULT_INSTALLMENTS;
  const brands = cfg?.config.brands && cfg.config.brands.length ? cfg.config.brands : ALL_BRANDS;

  const byKey = new Map<string, PaymentPlan>();
  for (const p of plans) byKey.set(keyOf(p.base ?? "otro", p.brand, p.installments ?? 1), p);

  function setCell(base: string, brand: string | null, n: number, pct: number) {
    m.setCell.mutate({
      provider_key: providerKey,
      base,
      brand,
      installments: n,
      surcharge_pct: pct,
      label: planLabel(base, brand, n),
    });
  }
  function clearCell(base: string, brand: string | null, n: number) {
    m.removeCell.mutate({ base, brand, installments: n });
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const { rows, errors } = await parsePlansXlsx(await file.arrayBuffer());
      if (errors.length) toast({ title: errors[0]!, variant: "error" });
      if (rows.length === 0) return;
      setImportRows(rows);
    } catch {
      toast({ title: "No se pudo leer el archivo", variant: "error" });
    }
  }

  function runImport(mode: "replace" | "append") {
    if (!importRows) return;
    const fn = mode === "replace" ? m.replaceProvider : m.bulkUpsert;
    fn.mutate(importRows, {
      onSuccess: () => {
        toast({ title: `${importRows.length} planes importados`, variant: "success" });
        setImportRows(null);
      },
      onError: () => toast({ title: "No se pudo importar", variant: "error" }),
    });
  }

  async function exportPlans() {
    await exportXlsx(`planes-${providerKey}`, [
      {
        name: "Planes",
        title: `Planes · ${providerName}`,
        columns: [
          { header: "base", key: "base", width: 14 },
          { header: "marca", key: "marca", width: 14 },
          { header: "cuotas", key: "cuotas", type: "number" },
          { header: "recargo", key: "recargo", type: "number" },
        ],
        rows: plans.map((p) => ({
          base: p.base,
          marca: p.brand ?? "",
          cuotas: p.installments ?? 1,
          recargo: Number(p.surcharge_pct) || 0,
        })),
      },
    ]);
  }

  // Plantilla vacía con ejemplos para que el usuario sume filas y recargos.
  async function downloadTemplate() {
    await exportXlsx(`plantilla-planes-${providerKey}`, [
      {
        name: "Planes",
        title: "Plantilla de planes — completá y reimportá",
        columns: [
          { header: "base", key: "base", width: 14 },
          { header: "marca", key: "marca", width: 14 },
          { header: "cuotas", key: "cuotas", type: "number" },
          { header: "recargo", key: "recargo", type: "number" },
        ],
        rows: [
          { base: "debito", marca: "visa", cuotas: 1, recargo: 0 },
          { base: "credito", marca: "visa", cuotas: 3, recargo: 8 },
          { base: "credito", marca: "master", cuotas: 6, recargo: 15 },
        ],
      },
    ]);
  }

  function addCuota() {
    const n = parseInt(newCuota, 10);
    if (!n || n < 1 || installments.includes(n)) {
      setNewCuota("");
      return;
    }
    saveConfig.mutate({ installments: [...installments, n].sort((a, b) => a - b) });
    setNewCuota("");
  }
  function removeCuota(n: number) {
    saveConfig.mutate({ installments: installments.filter((x) => x !== n) });
  }
  function toggleBrand(b: string) {
    const next = brands.includes(b) ? brands.filter((x) => x !== b) : [...brands, b];
    saveConfig.mutate({ brands: next });
  }

  const debitBrands = brands.filter((b) => DEBIT_BRANDS.has(b));
  const disabled = globalMode;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`Planes · ${providerName}`}
      className="max-w-3xl"
    >
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Cargá el recargo por marca y cuotas. Celda vacía = ese plan no se ofrece.
          Al cobrar con {providerName}, el cajero elige el plan y el recargo se suma
          al total.
        </p>

        {/* Recargo único del medio */}
        <div className="rounded-lg border border-border bg-muted/30 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="font-semibold">Recargo único del medio</div>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Aplicá un solo recargo a todo {providerName}. Si lo activás, se
                desactivan los planes por marca/cuota.
              </p>
            </div>
            <Switch checked={globalMode} onCheckedChange={setGlobalMode} label="Usar recargo único" />
          </div>
          {globalMode && (
            <div className="mt-3 flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Recargo</span>
              <span className="relative">
                <input
                  type="number"
                  step="0.5"
                  min="0"
                  value={globalPct}
                  onChange={(e) => setGlobalPct(e.target.value)}
                  className="h-9 w-24 rounded-md border border-input bg-background px-2 pr-6 text-right text-sm outline-none focus:border-ninja-flameSoft"
                />
                <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                  %
                </span>
              </span>
            </div>
          )}
        </div>

        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>
            <Upload size={14} /> Importar XLSX
          </Button>
          <Button variant="secondary" size="sm" onClick={downloadTemplate}>
            <FileDown size={14} /> Plantilla
          </Button>
          <Button variant="secondary" size="sm" onClick={exportPlans} disabled={plans.length === 0}>
            <Download size={14} /> Exportar
          </Button>
          <input ref={fileRef} type="file" accept=".xlsx" className="hidden" onChange={onFile} />
          <span className="flex-1" />
          <Button
            variant={editBrands ? "primary" : "ghost"}
            size="sm"
            onClick={() => setEditBrands((v) => !v)}
          >
            Marcas
          </Button>
          <Button
            variant={editCuotas ? "primary" : "ghost"}
            size="sm"
            onClick={() => setEditCuotas((v) => !v)}
          >
            Cuotas
          </Button>
        </div>

        {/* Editor de marcas */}
        {editBrands && (
          <div className="flex flex-wrap gap-2 rounded-lg border border-border bg-muted/30 p-3">
            {BRAND_OPTIONS.map((b) => {
              const on = brands.includes(b.value);
              return (
                <button
                  key={b.value}
                  onClick={() => toggleBrand(b.value)}
                  className={
                    on
                      ? "rounded-full border border-ninja-flameSoft bg-ninja-flame/15 px-3 py-1 text-xs font-semibold text-ninja-flameSoft"
                      : "rounded-full border border-border px-3 py-1 text-xs text-muted-foreground"
                  }
                >
                  {b.label}
                </button>
              );
            })}
          </div>
        )}

        {/* Editor de cuotas */}
        {editCuotas && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/30 p-3">
            {installments
              .filter((n) => n > 1)
              .map((n) => (
                <span
                  key={n}
                  className="flex items-center gap-1 rounded-full border border-border px-3 py-1 text-xs"
                >
                  {n} cuotas
                  <button onClick={() => removeCuota(n)} className="text-muted-foreground hover:text-destructive">
                    <X size={12} />
                  </button>
                </span>
              ))}
            <span className="flex items-center gap-1">
              <input
                type="number"
                min="2"
                value={newCuota}
                onChange={(e) => setNewCuota(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addCuota()}
                placeholder="+ cuotas"
                className="h-8 w-24 rounded-md border border-input bg-background px-2 text-sm outline-none focus:border-ninja-flameSoft"
              />
              <button onClick={addCuota} className="text-ninja-flameSoft" title="Agregar">
                <Plus size={16} />
              </button>
            </span>
          </div>
        )}

        {/* Grid (se atenúa en modo recargo único) */}
        <div className={disabled ? "pointer-events-none space-y-4 opacity-40" : "space-y-4"}>
          {debitBrands.length > 0 && (
            <Section title="Débito">
              {debitBrands.map((b) => (
                <BrandRow key={`d-${b}`} brand={b}>
                  <PlanCell
                    plan={byKey.get(keyOf("debito", b, 1))}
                    label="Pago"
                    disabled={disabled}
                    onSet={(pct) => setCell("debito", b, 1, pct)}
                    onClear={() => clearCell("debito", b, 1)}
                  />
                </BrandRow>
              ))}
            </Section>
          )}

          <Section title="Crédito">
            {brands.map((b) => (
              <BrandRow key={`c-${b}`} brand={b}>
                {installments.map((n) => (
                  <PlanCell
                    key={n}
                    plan={byKey.get(keyOf("credito", b, n))}
                    label={n === 1 ? "1 pago" : `${n} cuotas`}
                    disabled={disabled}
                    onSet={(pct) => setCell("credito", b, n, pct)}
                    onClear={() => clearCell("credito", b, n)}
                  />
                ))}
              </BrandRow>
            ))}
          </Section>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
          <span className="text-xs text-muted-foreground">
            Los recargos por celda se guardan al instante.
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cerrar
            </Button>
            <Button onClick={() => saveAll.mutate()} loading={saveAll.isPending}>
              <Save size={15} /> Guardar
            </Button>
          </div>
        </div>
      </div>

      {/* Diálogo: import reemplazar vs agregar */}
      <Modal
        open={importRows !== null}
        onOpenChange={(o) => !o && setImportRows(null)}
        title="Importar planes"
        className="max-w-sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Leí <strong>{importRows?.length ?? 0}</strong> planes del archivo. ¿Qué
            querés hacer con los planes de {providerName}?
          </p>
          <div className="flex flex-col gap-2">
            <Button onClick={() => runImport("replace")} loading={m.replaceProvider.isPending}>
              Reemplazar todos
            </Button>
            <Button
              variant="secondary"
              onClick={() => runImport("append")}
              loading={m.bulkUpsert.isPending}
            >
              Agregar / actualizar (no borra)
            </Button>
            <Button variant="ghost" onClick={() => setImportRows(null)}>
              Cancelar
            </Button>
          </div>
        </div>
      </Modal>
    </Modal>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 text-xs font-bold uppercase tracking-wide text-ninja-flameSoft">
        {title}
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function BrandRow({ brand, children }: { brand: string; children: React.ReactNode }) {
  const logo = brandLogo(brand);
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5">
      <div className="flex w-36 shrink-0 items-center gap-2.5">
        <span className="flex h-7 w-11 shrink-0 items-center justify-center">
          {logo && (
            <Image src={logo} alt={brand} width={44} height={28} className="h-7 w-auto object-contain" />
          )}
        </span>
        <span className="text-sm font-medium leading-tight">{BRAND_LABEL[brand] ?? brand}</span>
      </div>
      <div className="flex flex-1 flex-wrap gap-3">{children}</div>
    </div>
  );
}

function PlanCell({
  plan,
  label,
  disabled,
  onSet,
  onClear,
}: {
  plan: PaymentPlan | undefined;
  label: string;
  disabled?: boolean;
  onSet: (pct: number) => void;
  onClear: () => void;
}) {
  const [val, setVal] = useState(plan ? String(plan.surcharge_pct) : "");
  useEffect(() => {
    setVal(plan ? String(plan.surcharge_pct) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan?.id, plan?.surcharge_pct]);

  function commit() {
    const t = val.trim();
    if (t === "") {
      if (plan) onClear();
      return;
    }
    const pct = Number(t.replace(",", ".")) || 0;
    if (!plan || pct !== Number(plan.surcharge_pct)) onSet(pct);
  }

  return (
    <div className="flex flex-col items-center gap-1">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="relative">
        <input
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          placeholder="0"
          disabled={disabled}
          className={
            plan
              ? "h-9 w-[72px] rounded-md border border-ninja-flameSoft/50 bg-ninja-flame/5 px-2 pr-6 text-right text-sm outline-none focus:border-ninja-flameSoft"
              : "h-9 w-[72px] rounded-md border border-input bg-background px-2 pr-6 text-right text-sm outline-none focus:border-ninja-flameSoft"
          }
        />
        <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
          %
        </span>
      </span>
    </div>
  );
}
