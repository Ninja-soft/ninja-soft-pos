"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Plus, Sparkles, Upload, X } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { createClient } from "@/lib/supabase/client";
import { useProviderPlans, usePaymentPlanMutations } from "@/modules/pos/hooks";
import { TYPICAL_AR_PLANS, type PaymentPlan } from "@/modules/pos/api";
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

type MethodConfig = { installments?: number[]; brands?: string[] };

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

  // Config visual del medio (qué cuotas / qué marcas) en tenant_payment_methods.config
  const { data: cfg } = useQuery({
    queryKey: ["method-config", providerKey],
    enabled: open,
    queryFn: async (): Promise<MethodConfig> => {
      const { data } = await supabase
        .from("tenant_payment_methods")
        .select("config")
        .eq("provider_key", providerKey)
        .maybeSingle();
      return ((data?.config as MethodConfig) ?? {}) as MethodConfig;
    },
  });

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

  const installments =
    cfg?.installments && cfg.installments.length ? cfg.installments : DEFAULT_INSTALLMENTS;
  const brands = cfg?.brands && cfg.brands.length ? cfg.brands : ALL_BRANDS;

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

  function seedAr() {
    const existing = new Set(plans.map((p) => p.code).filter(Boolean));
    const missing = TYPICAL_AR_PLANS.filter((p) => !existing.has(p.code ?? null));
    if (missing.length === 0) {
      toast({ title: "Ya están los planes AR", variant: "info" });
      return;
    }
    m.seed.mutate(missing, {
      onSuccess: () => toast({ title: "Planes AR cargados", variant: "success" }),
      onError: () => toast({ title: "No se pudo cargar", variant: "error" }),
    });
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

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`Planes · ${providerName}`}
      className="max-w-3xl"
    >
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Cargá el recargo por marca y cuotas. Una celda vacía = ese plan no se
          ofrece. Al cobrar con {providerName}, el cajero elige el plan y el
          recargo se suma al total.
        </p>

        {/* Toolbar */}
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={seedAr} loading={m.seed.isPending}>
            <Sparkles size={14} /> Cargar planes AR
          </Button>
          <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>
            <Upload size={14} /> Importar XLSX
          </Button>
          <Button variant="secondary" size="sm" onClick={exportPlans} disabled={plans.length === 0}>
            <Download size={14} /> Exportar XLSX
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx"
            className="hidden"
            onChange={onFile}
          />
          <span className="flex-1" />
          <Button
            variant={editBrands ? "primary" : "ghost"}
            size="sm"
            onClick={() => setEditBrands((v) => !v)}
          >
            Elegir marcas
          </Button>
          <Button
            variant={editCuotas ? "primary" : "ghost"}
            size="sm"
            onClick={() => setEditCuotas((v) => !v)}
          >
            Editar cuotas
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
                className="h-8 w-20 rounded-md border border-input bg-background px-2 text-sm outline-none focus:border-ninja-flameSoft"
              />
              <button onClick={addCuota} className="text-ninja-flameSoft" title="Agregar">
                <Plus size={16} />
              </button>
            </span>
          </div>
        )}

        {/* Débito */}
        {debitBrands.length > 0 && (
          <Section title="Débito">
            {debitBrands.map((b) => (
              <BrandRow key={`d-${b}`} brand={b} base="debito">
                <PlanCell
                  plan={byKey.get(keyOf("debito", b, 1))}
                  label="Pago"
                  onSet={(pct) => setCell("debito", b, 1, pct)}
                  onClear={() => clearCell("debito", b, 1)}
                />
              </BrandRow>
            ))}
          </Section>
        )}

        {/* Crédito */}
        <Section title="Crédito">
          {brands.map((b) => (
            <BrandRow key={`c-${b}`} brand={b} base="credito">
              {installments.map((n) => (
                <PlanCell
                  key={n}
                  plan={byKey.get(keyOf("credito", b, n))}
                  label={n === 1 ? "1 pago" : `${n}c`}
                  onSet={(pct) => setCell("credito", b, n, pct)}
                  onClear={() => clearCell("credito", b, n)}
                />
              ))}
            </BrandRow>
          ))}
        </Section>
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
            <Button
              onClick={() => runImport("replace")}
              loading={m.replaceProvider.isPending}
            >
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

function BrandRow({
  brand,
  base,
  children,
}: {
  brand: string;
  base: string;
  children: React.ReactNode;
}) {
  const logo = brandLogo(brand, base);
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2">
      <span className="flex w-28 shrink-0 items-center gap-2">
        {logo ? (
          <Image src={logo} alt={brand} width={40} height={26} className="h-6 w-auto object-contain" />
        ) : (
          <span className="h-6 w-10" />
        )}
        <span className="text-sm font-medium">{BRAND_LABEL[brand] ?? brand}</span>
      </span>
      <span className="flex flex-wrap gap-2">{children}</span>
    </div>
  );
}

function PlanCell({
  plan,
  label,
  onSet,
  onClear,
}: {
  plan: PaymentPlan | undefined;
  label: string;
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
    <span className="flex flex-col items-center">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="relative flex items-center">
        <input
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          placeholder="—"
          className={
            plan
              ? "h-9 w-16 rounded-md border border-ninja-flameSoft/50 bg-ninja-flame/5 px-2 text-right text-sm outline-none focus:border-ninja-flameSoft"
              : "h-9 w-16 rounded-md border border-input bg-background px-2 text-right text-sm text-muted-foreground outline-none focus:border-ninja-flameSoft"
          }
        />
        <span className="pointer-events-none absolute right-1.5 text-xs text-muted-foreground">
          %
        </span>
      </span>
    </span>
  );
}
