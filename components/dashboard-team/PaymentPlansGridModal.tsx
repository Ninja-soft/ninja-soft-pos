"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, EyeOff, FileDown, Info, Plus, RotateCcw, Save, Upload, X } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { createClient } from "@/lib/supabase/client";
import { useProviderPlans, usePaymentPlanMutations } from "@/modules/pos/hooks";
import { planCode, type PaymentPlan } from "@/modules/pos/api";
import {
  ALL_BRANDS,
  BRAND_LABEL,
  BRAND_OPTIONS,
  DEBIT_BRANDS,
  DEFAULT_INSTALLMENTS,
  planLabel,
  BASE_LABEL,
} from "@/modules/pos/planConstants";
import { parsePlansXlsx, type PlanRow } from "@/modules/pos/plansXlsx";
import { exportXlsx, type XlsxColumn } from "@/lib/utils/xlsx";
import { cleanMerchantNumber, type MerchantNumbers } from "@/lib/payments/merchantNumbers";
import { Callout } from "@/components/ui/Callout";
import { CardBrandLogo } from "@/components/ui/ThemedLogo";
import { BrandLogo } from "@/components/dashboard-team/payments/ui";
import { ScopeBar, type ScopeSel } from "@/components/config/ScopedConfig";
import { useBranchContext } from "@/modules/branches/hooks";
import { cellState, clearActionForBranch, overridesByStore, type PlanOrigin } from "@/lib/payments/planScope";

type MethodConfig = {
  installments?: number[];
  brands?: string[];
  plan_mode?: "global" | "plans";
  /** N° de comercio por marca (opcional, para conciliación). */
  merchant_numbers?: MerchantNumbers;
};

// Columnas del Excel de planes: tipo y marca con lista desplegable (los nombres
// que entiende el import) y el n° de comercio opcional por marca.
const XLSX_COLUMNS: XlsxColumn[] = [
  { header: "tipo", key: "tipo", width: 12, options: ["Crédito", "Débito"] },
  { header: "marca", key: "marca", width: 14, options: BRAND_OPTIONS.map((b) => b.label) },
  { header: "cuotas", key: "cuotas", type: "number" },
  { header: "recargo", key: "recargo", type: "number" },
  { header: "n° de comercio", key: "comercio", width: 18 },
];

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
  // Alcance (F17 · ADR-057): "Todo el negocio" o una sucursal. En una
  // sucursal la grilla muestra el valor heredado del negocio y lo que la
  // sucursal pisa u oculta.
  const branchCtx = useBranchContext();
  const liveBranches = branchCtx.all.filter((b) => !b.deleted_at);
  const showScope = liveBranches.length > 1;
  const [scope, setScope] = useState<ScopeSel>({ scope: "tenant" });
  const storeId = scope.scope === "store" ? scope.id : null;
  const { data: rows = [] } = useProviderPlans(open ? providerKey : null, storeId);
  const m = usePaymentPlanMutations(providerKey, storeId);
  // Planes del alcance que se editan, exportan y cuentan: en el negocio, los
  // del negocio; en una sucursal, los efectivos (propios activos + heredados).
  const plans = rows.filter((p) => {
    const sid = (p as { store_id?: string | null }).store_id ?? null;
    if (!storeId) return sid === null;
    const st = cellState(rows, storeId, providerKey, p.code ?? "");
    return st.plan === p && st.origin !== "hidden";
  });
  const branchOverrides = overridesByStore(rows, providerKey);
  const fileRef = useRef<HTMLInputElement>(null);
  const [importRows, setImportRows] = useState<PlanRow[] | null>(null);
  const [importMerchants, setImportMerchants] = useState<MerchantNumbers>({});
  const [merchants, setMerchants] = useState<MerchantNumbers>({});
  const [editBrands, setEditBrands] = useState(false);
  // Recargo único del medio + modo (global desactiva los planes).
  const [globalMode, setGlobalMode] = useState(false);
  const [globalPct, setGlobalPct] = useState("0");
  const [removeCuotaN, setRemoveCuotaN] = useState<number | null>(null);
  // Vigencia de la financiación del medio (H27): se aplica a TODOS los planes del
  // medio. Vacío = sin límite. Al cobrar, sólo se ofrecen los planes vigentes hoy.
  const [validFrom, setValidFrom] = useState("");
  const [validUntil, setValidUntil] = useState("");

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
    setMerchants(cfg.config.merchant_numbers ?? {});
  }, [cfg]);

  // Inicializa la vigencia visible desde el primer plan que tenga una ventana
  // cargada (setProviderValidity escribe la misma en todos, así que es consistente).
  const validitySource = (storeId
    ? rows.filter((p) => (p as { store_id?: string | null }).store_id === storeId)
    : plans
  ).find((p) => p.valid_from || p.valid_until);
  useEffect(() => {
    setValidFrom(validitySource?.valid_from ?? "");
    setValidUntil(validitySource?.valid_until ?? "");
  }, [validitySource?.valid_from, validitySource?.valid_until, storeId]);
  // Cada apertura arranca en "Todo el negocio".
  useEffect(() => {
    if (open) setScope({ scope: "tenant" });
  }, [open]);

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
      // En una sucursal sólo se guarda la vigencia de sus planes propios: el
      // recargo único y los n° de comercio por sucursal van por Medios de pago
      // (configuración heredable, ADR-049).
      if (storeId) {
        await m.setProviderValidity.mutateAsync({
          validFrom: validFrom || null,
          validUntil: validUntil || null,
        });
        return;
      }
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
          config: { ...cur, plan_mode: globalMode ? "global" : "plans", merchant_numbers: cleanMerchants(merchants) },
        })
        .eq("provider_key", providerKey);
      if (error) throw error;
      // Modo global → planes inactivos (no se ofrecen). Modo planes → activos.
      await m.setProviderActive.mutateAsync(!globalMode);
      // Vigencia (H27): aplica la ventana a todos los planes del medio. Vacío = null.
      await m.setProviderValidity.mutateAsync({
        validFrom: validFrom || null,
        validUntil: validUntil || null,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["method-config", providerKey] });
      qc.invalidateQueries({ queryKey: ["tenant-payment-methods"] });
      toast({ title: "Guardado", variant: "success" });
      onOpenChange(false);
    },
    onError: () => toast({ title: "No se pudo guardar", variant: "error" }),
  });

  const installments = (
    cfg?.config.installments && cfg.config.installments.length
      ? cfg.config.installments
      : DEFAULT_INSTALLMENTS
  )
    .slice()
    .sort((a, b) => a - b);
  const brands = cfg?.config.brands && cfg.config.brands.length ? cfg.config.brands : ALL_BRANDS;

  const byKey = new Map<string, PaymentPlan>();
  for (const p of plans) byKey.set(keyOf(p.base ?? "otro", p.brand, p.installments ?? 1), p);
  const cellOf = (base: string, brand: string | null, n: number) =>
    cellState(rows, storeId, providerKey, planCode(base, brand, n));

  function setCell(base: string, brand: string | null, n: number, pct: number) {
    m.setCell.mutate(
      {
        provider_key: providerKey,
        base,
        brand,
        installments: n,
        surcharge_pct: pct,
        label: planLabel(base, brand, n),
        is_active: true,
      },
      {
        onSuccess: () => toast({ title: "Recargo guardado", variant: "success" }),
        onError: (e) =>
          toast({
            title: "No se pudo guardar el recargo",
            description: e instanceof Error ? e.message : undefined,
            variant: "error",
          }),
      },
    );
  }
  function clearCell(base: string, brand: string | null, n: number) {
    if (storeId) {
      const st = cellOf(base, brand, n);
      const action = clearActionForBranch(st);
      if (action === "hide") {
        // La sucursal oculta el plan del negocio (fila propia inactiva).
        m.setCell.mutate(
          {
            provider_key: providerKey,
            base,
            brand,
            installments: n,
            surcharge_pct: Number(st.inherited?.surcharge_pct ?? st.plan?.surcharge_pct ?? 0),
            label: planLabel(base, brand, n),
            is_active: false,
          },
          {
            onSuccess: () => toast({ title: "No se ofrece en esta sucursal", variant: "success" }),
            onError: () => toast({ title: "No se pudo quitar", variant: "error" }),
          },
        );
        return;
      }
      if (action === "none") return;
    }
    m.removeCell.mutate(
      { base, brand, installments: n },
      { onError: () => toast({ title: "No se pudo quitar", variant: "error" }) },
    );
  }
  // Volver a heredar: borra la fila propia de la sucursal.
  function inheritCell(base: string, brand: string | null, n: number) {
    m.removeCell.mutate(
      { base, brand, installments: n },
      {
        onSuccess: () => toast({ title: "Vuelve a heredar del negocio", variant: "success" }),
        onError: () => toast({ title: "No se pudo volver a heredar", variant: "error" }),
      },
    );
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const { rows, errors, merchantNumbers } = await parsePlansXlsx(await file.arrayBuffer());
      if (errors.length) toast({ title: errors[0]!, variant: "error" });
      if (rows.length === 0) return;
      setImportRows(rows);
      setImportMerchants(merchantNumbers);
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
        // Los n° de comercio del archivo se suman a los cargados (no borran otros).
        if (Object.keys(importMerchants).length > 0) {
          const next = { ...merchants, ...importMerchants };
          setMerchants(next);
          saveConfig.mutate({ merchant_numbers: cleanMerchants(next) });
        }
        setImportRows(null);
        setImportMerchants({});
      },
      onError: () => toast({ title: "No se pudo importar", variant: "error" }),
    });
  }

  async function exportPlans() {
    await exportXlsx(`planes-${providerKey}${scopeTag}`, [
      {
        name: "Planes",
        title: `Planes · ${providerName}${scopeName ? ` · ${scopeName}` : ""}`,
        columns: XLSX_COLUMNS,
        rows: plans.map((p) => ({
          tipo: BASE_LABEL[p.base ?? ""] ?? p.base,
          marca: p.brand ? (BRAND_LABEL[p.brand] ?? p.brand) : "",
          cuotas: p.installments ?? 1,
          recargo: Number(p.surcharge_pct) || 0,
          comercio: p.brand ? (merchants[p.brand] ?? "") : "",
        })),
      },
    ]);
  }

  // Plantilla con ejemplos: tipo y marca se eligen de una lista desplegable.
  async function downloadTemplate() {
    await exportXlsx(`plantilla-planes-${providerKey}`, [
      {
        name: "Planes",
        title: `Plantilla de planes · ${providerName} • completá y reimportá`,
        columns: XLSX_COLUMNS,
        rows: [
          { tipo: "Débito", marca: "Visa", cuotas: 1, recargo: 0, comercio: "" },
          { tipo: "Crédito", marca: "Visa", cuotas: 3, recargo: 8, comercio: "" },
          { tipo: "Crédito", marca: "Mastercard", cuotas: 6, recargo: 15, comercio: "" },
        ],
      },
    ]);
  }

  function addCuotaNum(n: number) {
    if (!n || n < 1 || installments.includes(n)) return;
    saveConfig.mutate({ installments: [...installments, n].sort((a, b) => a - b) });
  }
  function removeCuota(n: number) {
    // Saca la columna y borra los planes de esa cuota en todas las marcas.
    saveConfig.mutate({ installments: installments.filter((x) => x !== n) });
    for (const b of brands) {
      if (byKey.get(keyOf("credito", b, n))) m.removeCell.mutate({ base: "credito", brand: b, installments: n });
    }
    setRemoveCuotaN(null);
  }
  function toggleBrand(b: string) {
    const next = brands.includes(b) ? brands.filter((x) => x !== b) : [...brands, b];
    saveConfig.mutate({ brands: next });
  }

  const debitBrands = brands.filter((b) => DEBIT_BRANDS.has(b));
  // En una sucursal el recargo único del negocio no apaga su grilla: el modo
  // por sucursal se pisa en Medios de pago.
  const disabled = globalMode && !storeId;
  const branchMode = Boolean(storeId);
  const scopeBranch = storeId ? liveBranches.find((b) => b.id === storeId) : null;
  const scopeName = scopeBranch ? scopeBranch.name : null;
  const scopeTag = scopeBranch ? `-${(scopeBranch.short_name || scopeBranch.name).toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : "";
  const cellProps = (base: string, brand: string | null, n: number) => {
    const st = cellOf(base, brand, n);
    return {
      plan: st.origin === "hidden" ? undefined : st.plan,
      origin: branchMode ? st.origin : null,
      inheritedPct: st.inherited ? Number(st.inherited.surcharge_pct) : null,
      onInherit: branchMode && (st.origin === "store" || st.origin === "hidden") ? () => inheritCell(base, brand, n) : undefined,
    };
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`Planes de cuotas · ${providerName}`}
      className="max-w-3xl"
      header={
        <div className="flex items-center gap-3">
          <BrandLogo brandKey={providerKey} name={providerName} size={40} />
          <div className="min-w-0">
            <p className="text-lg font-bold leading-tight tracking-tight">Planes de cuotas</p>
            <p className="mt-0.5 truncate text-[13px] text-muted-foreground">
              {providerName} ·{" "}
              {plans.length > 0
                ? `${plans.length} ${plans.length === 1 ? "plan cargado" : "planes cargados"}`
                : "Sin planes"}
            </p>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Cargá el recargo por marca y cuotas. Celda vacía = ese plan no se ofrece.
          Al cobrar con {providerName}, el cajero elige el plan y el recargo se suma
          al total.
        </p>
        <PlansProviderNote providerKey={providerKey} />

        {showScope && (
          <ScopeBar value={scope} onChange={setScope} allowRegister={false} allowGroup={false} />
        )}
        {branchMode && (
          <Callout icon={Info} title={`Planes de ${scopeName ?? "la sucursal"}`}>
            Cada celda hereda el recargo de <strong>Todo el negocio</strong> salvo que la cambies acá.
            Vaciar una celda heredada la oculta sólo en esta sucursal; con{" "}
            <RotateCcw size={12} className="inline" aria-hidden /> vuelve a heredar. El recargo único y
            los n° de comercio de la sucursal se cambian en Medios de pago con el selector de alcance.
          </Callout>
        )}
        {!branchMode && showScope && Object.keys(branchOverrides).length > 0 && (
          <p className="text-xs text-muted-foreground">
            {Object.keys(branchOverrides).length === 1
              ? "1 sucursal tiene planes propios para este medio."
              : `${Object.keys(branchOverrides).length} sucursales tienen planes propios para este medio.`}
          </p>
        )}

        {/* Recargo único del medio */}
        {!branchMode && (
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
        )}

        {/* Vigencia de la financiación (H27): ventana de fechas para los planes
            del medio. Al cobrar, sólo se ofrecen los planes vigentes hoy. Vacío =
            sin límite. Se aplica a todos los planes del medio al Guardar. */}
        <div className="rounded-lg border border-border bg-muted/30 p-4">
          <div className="min-w-0">
            <div className="font-semibold">Vigencia de los planes</div>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Período en que se ofrecen estos planes al cobrar. Fuera de la
              vigencia (vencidos o todavía no empezados) no aparecen en el selector
              de cuotas. Dejá vacío para que estén siempre disponibles.
            </p>
          </div>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="text-sm">
              <span className="mb-1 block text-muted-foreground">Desde</span>
              <input
                type="date"
                value={validFrom}
                onChange={(e) => setValidFrom(e.target.value)}
                className="h-9 rounded-md border border-input bg-background px-2 text-sm outline-none focus:border-ninja-flameSoft"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-muted-foreground">Hasta</span>
              <input
                type="date"
                value={validUntil}
                min={validFrom || undefined}
                onChange={(e) => setValidUntil(e.target.value)}
                className="h-9 rounded-md border border-input bg-background px-2 text-sm outline-none focus:border-ninja-flameSoft"
              />
            </label>
            {(validFrom || validUntil) && (
              <button
                type="button"
                onClick={() => {
                  setValidFrom("");
                  setValidUntil("");
                }}
                className="h-9 rounded-md border border-border px-3 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
              >
                Sin límite
              </button>
            )}
          </div>
        </div>

        {/* N° de comercio por marca (opcional): se guarda con el cobro para
            conciliar contra la liquidación de la tarjeta. Se guarda al Guardar. */}
        {!branchMode && (
        <div className="rounded-lg border border-border bg-muted/30 p-4">
          <div className="font-semibold">
            Números de comercio <span className="text-sm font-normal text-muted-foreground">(opcional)</span>
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Si tenés un n° de comercio por tarjeta con {providerName}, cargalo y queda guardado en cada
            cobro para conciliar con la liquidación.
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {brands.map((b) => (
              <label key={b} className="flex items-center gap-2.5">
                <CardBrandLogo brand={b} label={BRAND_LABEL[b] ?? b} height={20} />
                <span className="w-24 shrink-0 text-sm">{BRAND_LABEL[b] ?? b}</span>
                <input
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={20}
                  placeholder="Sin cargar"
                  aria-label={`N° de comercio ${BRAND_LABEL[b] ?? b}`}
                  value={merchants[b] ?? ""}
                  onChange={(e) => setMerchants((m) => ({ ...m, [b]: cleanMerchantNumber(e.target.value) }))}
                  className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-2.5 text-sm tabular-nums outline-none focus:border-ninja-flameSoft"
                />
              </label>
            ))}
          </div>
        </div>
        )}

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
          {!branchMode && (
            <Button
              variant={editBrands ? "primary" : "ghost"}
              size="sm"
              onClick={() => setEditBrands((v) => !v)}
            >
              Marcas
            </Button>
          )}
        </div>

        {/* Editor de marcas */}
        {editBrands && !branchMode && (
          <div className="flex flex-wrap gap-2 rounded-xl bg-fg-4 p-3">
            {BRAND_OPTIONS.map((b) => {
              const on = brands.includes(b.value);
              return (
                <button
                  key={b.value}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleBrand(b.value)}
                  className={
                    on
                      ? "inline-flex h-9 items-center gap-2 rounded-full bg-fg-10 pl-2 pr-3 text-xs font-semibold text-foreground"
                      : "inline-flex h-9 items-center gap-2 rounded-full pl-2 pr-3 text-xs text-muted-foreground opacity-60 transition hover:bg-fg-6 hover:opacity-100"
                  }
                >
                  <CardBrandLogo brand={b.value} label={b.label} height={18} />
                  {b.label}
                </button>
              );
            })}
          </div>
        )}

        {/* Leyenda */}
        {!disabled && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="h-3 w-3 rounded border border-dashed border-border" /> Vacío = no se ofrece
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-3 w-3 rounded border border-emerald-500/70" /> 0% sin recargo
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-3 w-3 rounded border border-ninja-flameSoft/70" /> recargo
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-3 w-3 rounded border border-red-500/70" /> descuento (negativo)
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
                    {...cellProps("debito", b, 1)}
                    label="Pago"
                    disabled={disabled}
                    onSet={(pct) => setCell("debito", b, 1, pct)}
                    onClear={() => clearCell("debito", b, 1)}
                  />
                </BrandRow>
              ))}
            </Section>
          )}

          <Section
            title="Crédito"
            action={
              <div className="flex flex-wrap items-center gap-1.5">
                {!branchMode && installments
                  .filter((n) => n > 1)
                  .map((n) => (
                    <span
                      key={n}
                      className="flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px]"
                    >
                      {n}c
                      <button
                        onClick={() => setRemoveCuotaN(n)}
                        className="text-muted-foreground hover:text-destructive"
                        title={`Quitar ${n} cuotas`}
                      >
                        <X size={11} />
                      </button>
                    </span>
                  ))}
              </div>
            }
          >
            {brands.map((b) => (
              <BrandRow key={`c-${b}`} brand={b}>
                {installments.map((n) => (
                  <PlanCell
                    key={n}
                    {...cellProps("credito", b, n)}
                    label={n === 1 ? "1 pago" : `${n} cuotas`}
                    disabled={disabled}
                    onSet={(pct) => setCell("credito", b, n, pct)}
                    onClear={() => clearCell("credito", b, n)}
                  />
                ))}
                {!disabled && !branchMode && <AddCuotaCell onAdd={addCuotaNum} />}
              </BrandRow>
            ))}
          </Section>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
          <span className="text-xs text-muted-foreground">
            Los recargos por celda se guardan al instante{branchMode && scopeName ? ` en ${scopeName}` : ""}.
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

      {/* Confirmar quitar una cuota (borra esa columna en todas las marcas) */}
      <ConfirmDialog
        open={removeCuotaN !== null}
        onOpenChange={(o) => !o && setRemoveCuotaN(null)}
        title={`Quitar ${removeCuotaN ?? ""} cuotas`}
        description={`Se quita la columna de ${removeCuotaN ?? ""} cuotas y se borran los recargos cargados en esa cuota para todas las marcas de ${providerName}.`}
        confirmLabel="Quitar"
        danger
        onConfirm={() => removeCuotaN !== null && removeCuota(removeCuotaN)}
      />

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
            querés hacer con los planes de {providerName}
            {scopeName ? ` en ${scopeName}` : ""}?
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

function Section({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs font-bold uppercase tracking-wide text-ninja-flameSoft">
          {title}
        </div>
        {action}
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function BrandRow({ brand, children }: { brand: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2.5 rounded-xl bg-fg-4 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3">
      <div className="flex shrink-0 items-center gap-2.5 sm:w-40">
        <CardBrandLogo brand={brand} label={BRAND_LABEL[brand] ?? brand} height={26} />
        <span className="text-sm font-medium leading-tight">{BRAND_LABEL[brand] ?? brand}</span>
      </div>
      <div className="flex flex-1 flex-wrap gap-3">{children}</div>
    </div>
  );
}

// "+" por fila para agregar una cuota nueva (se aplica a todas las filas y se
// ordena de menor a mayor).
function AddCuotaCell({ onAdd }: { onAdd: (n: number) => void }) {
  const [openInput, setOpenInput] = useState(false);
  const [val, setVal] = useState("");
  function commit() {
    const n = parseInt(val, 10);
    if (n) onAdd(n);
    setVal("");
    setOpenInput(false);
  }
  return (
    <div className="flex flex-col items-center justify-end gap-1">
      <span className="text-[10px] uppercase tracking-wide text-transparent">+</span>
      {openInput ? (
        <input
          autoFocus
          type="number"
          min="2"
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && commit()}
          placeholder="cuota"
          className="h-9 w-[72px] rounded-md border border-ninja-flameSoft bg-background px-2 text-right text-sm outline-none"
        />
      ) : (
        <button
          onClick={() => setOpenInput(true)}
          title="Agregar cuota"
          className="flex h-9 w-9 items-center justify-center rounded-md border border-dashed border-border text-muted-foreground transition hover:border-ninja-flameSoft hover:text-ninja-flameSoft"
        >
          <Plus size={16} />
        </button>
      )}
    </div>
  );
}

function PlanCell({
  plan,
  label,
  disabled,
  onSet,
  onClear,
  origin = null,
  inheritedPct = null,
  onInherit,
}: {
  plan: PaymentPlan | undefined;
  label: string;
  disabled?: boolean;
  onSet: (pct: number) => void;
  onClear: () => void;
  /** En una sucursal: de dónde sale el valor (null en "Todo el negocio"). */
  origin?: PlanOrigin | null;
  inheritedPct?: number | null;
  onInherit?: () => void;
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

  // Color del borde: vacío = punteado (no se ofrece) · 0% verde · + naranja · − rojo.
  const t = val.trim();
  const num = Number(t.replace(",", "."));
  const has = t !== "" && Number.isFinite(num);
  const border = !has
    ? "border-dashed border-border"
    : num === 0
      ? "border-emerald-500/70"
      : num > 0
        ? "border-ninja-flameSoft/70"
        : "border-red-500/70";

  const originTitle =
    origin === "store"
      ? `Propio de la sucursal${inheritedPct !== null ? ` (el negocio: ${inheritedPct}%)` : ""}`
      : origin === "hidden"
        ? `Oculto en esta sucursal${inheritedPct !== null ? ` (el negocio: ${inheritedPct}%)` : ""}`
        : origin === "tenant"
          ? "Heredado de Todo el negocio"
          : undefined;
  return (
    <div className="flex flex-col items-center gap-1" title={originTitle}>
      <span className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
        {origin === "store" && <span className="h-1.5 w-1.5 rounded-full bg-ninja-flameSoft" aria-label="Propio" />}
        {origin === "hidden" && <EyeOff size={10} aria-label="Oculto en la sucursal" />}
        {onInherit && (
          <button
            type="button"
            onClick={onInherit}
            className="text-muted-foreground hover:text-foreground"
            title="Volver a heredar del negocio"
            aria-label="Volver a heredar del negocio"
          >
            <RotateCcw size={10} />
          </button>
        )}
      </span>
      <span className="relative">
        <input
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          placeholder=""
          disabled={disabled}
          title={has ? undefined : "Vacío: este plan no se ofrece al cobrar"}
          className={`h-9 w-[72px] rounded-md border bg-background px-2 pr-6 text-right text-sm outline-none focus:border-ninja-flameSoft ${border} ${origin === "tenant" ? "text-muted-foreground" : ""}`}
        />
        <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
          %
        </span>
      </span>
    </div>
  );
}

// Cómo usa cada proveedor los planes cargados acá: el texto depende de quién
// fija las cuotas (nuestro checkout, la terminal o la cuenta del proveedor).
function PlansProviderNote({ providerKey }: { providerKey: string }) {
  if (providerKey === "payway") {
    return (
      <Callout icon={Info} title="Cómo se usan en Payway">
        El cliente paga en tu checkout de Payway y <strong>elige ahí la tarjeta y las
        cuotas</strong> entre los planes que cargues acá. El recargo de cada plan se
        suma al total en el momento. Celda vacía: ese plan no se ofrece. Celda en{" "}
        <strong>0</strong>: cuotas sin recargo.
      </Callout>
    );
  }
  if (providerKey === "mobbex") {
    return (
      <Callout icon={Info} title="Cómo se usan en Mobbex">
        El plan <strong>solo suma el recargo</strong> al total del cobro. Las cuotas y el
        interés que ve el cliente en el checkout son los que tengas configurados en tu
        cuenta de Mobbex: revisá que coincidan con lo que cargás acá. Celda en{" "}
        <strong>0</strong>: sin recargo.
      </Callout>
    );
  }
  if (providerKey === "mercadopago" || providerKey === "mercadopago_point") {
    return (
      <Callout icon={Info} title="Cómo se usan en Mercado Pago">
        El cajero elige el plan al cobrar y el recargo se suma al total. En el Point
        podés dejar preseleccionadas las cuotas; con QR o link las cuotas{" "}
        <strong>las elige el cliente</strong>, así que controlá que pague en las
        acordadas. Para que Mercado Pago cobre el interés de las cuotas, configuralo en{" "}
        <a
          href="https://www.mercadopago.com.ar/costs-section/installments"
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-ninja-flameSoft underline"
        >
          Tu negocio › Costos › Cuotas
        </a>
        . Celda en <strong>0</strong>: sin recargo.
      </Callout>
    );
  }
  return (
    <Callout icon={Info} title="Cómo se usan">
      El cajero elige el plan al cobrar y el recargo se suma al total. Celda vacía: ese
      plan no se ofrece. Celda en <strong>0</strong>: sin recargo.
    </Callout>
  );
}


/** Sin vacíos: una marca sin número no se guarda. */
function cleanMerchants(m: MerchantNumbers): MerchantNumbers {
  return Object.fromEntries(
    Object.entries(m)
      .map(([k, v]) => [k, cleanMerchantNumber(v ?? "")] as const)
      .filter(([, v]) => v !== ""),
  );
}
