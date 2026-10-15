"use client";

// Ingresos Brutos: liquidación mensual por jurisdicción (F18 · H106 / H108,
// ADR-095). El servidor arma el cálculo (iibb_liquidation_preview) con las
// ventas del mes por actividad, las retenciones y percepciones sufridas y el
// saldo a favor anterior; al confirmar lo vuelve a calcular y lo guarda
// (iibb_liquidation_confirm). Actividades con su alícuota y coeficientes de
// Convenio Multilateral se cargan acá. Dueño o encargado, feature
// percepciones_retenciones. No genera el archivo de cada provincia.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Download, Landmark, Lock, Pencil, Plus, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { PageContainer, PageHeader } from "@/components/ui/PageHeader";
import { Segmented } from "@/components/ui/Segmented";
import { Select } from "@/components/ui/Select";
import { SettingsCard } from "@/components/settings/Settings";
import { Spinner } from "@/components/ui/Spinner";
import { UpgradeModal } from "@/components/saas/UpgradeModal";
import { useToast } from "@/components/ui/Toast";
import { formatCurrency } from "@/lib/utils/format";
import { exportXlsx } from "@/lib/utils/xlsx";
import { JURISDICTIONS, jurisdictionName } from "@/lib/tax/catalog";
import { IIBB_WARNING_TEXT, iibbSheetRows, type IibbPreview } from "@/lib/tax/iibb";
import { parseArAmount } from "@/lib/tax/suffered";
import { taxErrorMessage } from "@/modules/tax/api";
import type { IibbActivity, IibbCoefficient } from "@/modules/tax/subjectApi";
import {
  useIibbActivities,
  useIibbCoefficients,
  useIibbLiquidations,
  useIibbMutations,
  useIibbPreview,
  useIibbTemplates,
} from "@/modules/tax/subjectHooks";
import { useTaxSettings } from "@/modules/tax/hooks";
import { useCategories } from "@/modules/products/hooks";
import { useFeature } from "@/modules/saas/gating";
import { useMyTenant } from "@/modules/tenants/hooks";

type Tab = "liquidacion" | "actividades" | "cm" | "historial";

function lastMonth(): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

const fmtPeriod = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

function Row({ label, value, strong, muted }: { label: string; value: number; strong?: boolean; muted?: boolean }) {
  return (
    <div className={`flex items-center justify-between gap-3 py-1.5 text-sm ${strong ? "font-semibold" : ""} ${muted ? "text-muted-foreground" : ""}`}>
      <span>{label}</span>
      <span className="tabular-nums">{formatCurrency(value)}</span>
    </div>
  );
}

export function IibbLiquidacion() {
  const feature = useFeature("percepciones_retenciones");
  const { data: me } = useMyTenant();
  const { data: settings } = useTaxSettings(feature === true);
  const [tab, setTab] = useState<Tab>("liquidacion");
  const [upgrade, setUpgrade] = useState(false);
  const locked = feature === false;
  const forbidden = me !== undefined && !me?.canManage;
  const enabled = feature === true && !forbidden;

  return (
    <PageContainer size="lg">
      <PageHeader
        eyebrow="Impuestos"
        title="Ingresos Brutos"
        icon={Landmark}
        description="Liquidación mensual por jurisdicción: base por actividad, alícuota, retenciones y percepciones sufridas y saldo a favor."
      />
      <div className="mt-6 space-y-6">
        {locked ? (
          <Callout
            tone="warning"
            icon={Lock}
            title="No incluido en tu plan"
            actions={
              <Button size="sm" onClick={() => setUpgrade(true)}>
                Ver planes
              </Button>
            }
          >
            La liquidación de Ingresos Brutos viene con Percepciones y retenciones.
          </Callout>
        ) : forbidden ? (
          <Callout tone="warning" icon={Lock} title="Sólo dueño o encargado">
            Pedile a quien administra el negocio que liquide Ingresos Brutos.
          </Callout>
        ) : (
          <>
            <Segmented<Tab> scrollOnMobile
              value={tab}
              onChange={setTab}
              aria-label="Sección"
              options={[
                { value: "liquidacion", label: "Liquidación" },
                { value: "actividades", label: "Actividades" },
                ...(settings?.convenio_multilateral ? [{ value: "cm" as Tab, label: "Convenio Multilateral" }] : []),
                { value: "historial", label: "Historial" },
              ]}
            />
            {tab === "liquidacion" && <LiquidacionTab home={settings?.iibb_jurisdiction ?? null} enabled={enabled} />}
            {tab === "actividades" && <ActividadesTab home={settings?.iibb_jurisdiction ?? null} enabled={enabled} />}
            {tab === "cm" && <CoeficientesTab enabled={enabled} />}
            {tab === "historial" && <HistorialTab enabled={enabled} />}
            <SettingsCard title="Antes de presentar" padded>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>
                  El cálculo es una ayuda para tu contador: las alícuotas, los mínimos y los coeficientes los cargás vos y
                  conviene validarlos con él. Todavía no generamos el archivo de cada provincia (ARBA, e-ARCIBA, SIFERE):
                  cargá los importes en el sistema del organismo.
                </p>
                <p>
                  Las retenciones y percepciones que se descuentan están en{" "}
                  <Link href="/impuestos/sufridas" className="font-medium text-foreground underline underline-offset-2">
                    Retenciones sufridas
                  </Link>
                  .
                </p>
              </div>
            </SettingsCard>
          </>
        )}
      </div>
      <UpgradeModal open={upgrade} onOpenChange={setUpgrade} featureKey="percepciones_retenciones" featureLabel="Ingresos Brutos" />
    </PageContainer>
  );
}

// ── Liquidación ───────────────────────────────────────────────────────────
function LiquidacionTab({ home, enabled }: { home: string | null; enabled: boolean }) {
  const { toast } = useToast();
  const m = useIibbMutations();
  const [jur, setJur] = useState<string>("");
  const [month, setMonth] = useState("");
  const [opening, setOpening] = useState("");
  useEffect(() => setMonth(lastMonth()), []);
  useEffect(() => {
    if (!jur && home) setJur(home);
  }, [home, jur]);
  const openingNum = parseArAmount(opening);
  const period = month ? `${month}-01` : "";
  const { data: pv, isLoading, error, refetch } = useIibbPreview(jur, period, openingNum && openingNum > 0 ? openingNum : null, enabled);
  const jurOptions = useMemo(() => JURISDICTIONS.map((j) => ({ value: j.code, label: `${j.name} (${j.code})` })), []);
  const finished = month !== "" && month < `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`;

  async function confirm() {
    if (!pv) return;
    try {
      await m.confirm.mutateAsync({
        jurisdiction: jur,
        period,
        to_pay: pv.to_pay,
        credit_next: pv.credit_next,
        opening: openingNum && openingNum > 0 ? openingNum : null,
      });
      toast({ title: "Liquidación confirmada", variant: "success" });
    } catch (e) {
      toast({ title: taxErrorMessage(e), variant: "error" });
      void refetch();
    }
  }

  async function download(p: IibbPreview) {
    await exportXlsx(`iibb-${p.jurisdiction}-${p.period.slice(0, 7)}`, [
      {
        name: "Liquidación",
        title: `Ingresos Brutos ${jurisdictionName(p.jurisdiction)} ${fmtPeriod(p.period)}`,
        subtitle: p.regime === "cm" ? `Convenio Multilateral, coeficiente ${p.coefficient ?? 0}` : "Régimen local",
        columns: [
          { header: "Concepto", key: "concepto", width: 44 },
          { header: "Importe", key: "importe", type: "money", width: 16 },
          { header: "Detalle", key: "detalle", width: 40 },
        ],
        rows: iibbSheetRows(p),
      },
      {
        name: "Actividades",
        columns: [
          { header: "Código", key: "code", width: 10 },
          { header: "Actividad", key: "name", width: 32 },
          { header: "Ventas", key: "sales", type: "money", width: 16 },
          { header: "Anulaciones", key: "voids", type: "money", width: 16 },
          { header: "Devoluciones", key: "returns", type: "money", width: 16 },
          { header: "Base", key: "base", type: "money", width: 16 },
          { header: "Alícuota %", key: "rate", type: "number", width: 10 },
          { header: "Impuesto", key: "tax", type: "money", width: 14 },
        ],
        rows: p.activities.map((a) => ({ ...a, code: a.code ?? "" })),
        totals: { base: p.base_total, tax: p.determined },
      },
    ]);
  }

  return (
    <div className="space-y-6">
      <SettingsCard title="Mes y jurisdicción" padded>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Select<string> label="Jurisdicción" value={jur || null} onChange={setJur} options={jurOptions} placeholder="Elegí la jurisdicción" />
          <Input label="Mes" type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
          <Input
            label="Saldo a favor inicial"
            inputMode="decimal"
            value={opening}
            onChange={(e) => setOpening(e.target.value)}
            hint="Sólo en la primera liquidación de la jurisdicción."
          />
        </div>
      </SettingsCard>

      {error ? (
        <Callout tone="warning" icon={AlertTriangle} title="No se pudo calcular">
          {taxErrorMessage(error)}
        </Callout>
      ) : isLoading || !pv ? (
        jur && month ? <p className="text-sm text-muted-foreground">Calculando...</p> : null
      ) : (
        <>
          {pv.warnings.length > 0 && (
            <Callout tone="warning" icon={AlertTriangle} title="Revisá antes de confirmar">
              <ul className="list-disc space-y-1 pl-4">
                {pv.warnings.map((w) => (
                  <li key={w}>{IIBB_WARNING_TEXT[w] ?? w}</li>
                ))}
              </ul>
            </Callout>
          )}
          <SettingsCard title="Base por actividad">
            <ul className="divide-y divide-border">
              {pv.activities.map((a) => (
                <li key={a.id} className="px-4 py-3 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium">
                      {a.code ? `${a.code} · ` : ""}
                      {a.name}
                    </span>
                    <span className="font-semibold tabular-nums">{formatCurrency(a.tax)}</span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Ventas {formatCurrency(a.sales)} − anulaciones {formatCurrency(a.voids)} − devoluciones{" "}
                    {formatCurrency(a.returns)}
                    {pv.regime === "cm" ? ` × coeficiente ${pv.coefficient ?? 0}` : ""} = base {formatCurrency(a.base)} ×{" "}
                    {a.rate} %{a.minimum_applied ? " (va el mínimo)" : ""}
                  </div>
                </li>
              ))}
            </ul>
          </SettingsCard>
          <SettingsCard title={`Liquidación ${jurisdictionName(pv.jurisdiction)} ${fmtPeriod(pv.period)}`} padded>
            <Row label="Impuesto determinado" value={pv.determined} strong />
            <Row label="Retenciones sufridas" value={-pv.deductions.retencion} muted />
            <Row label="Percepciones sufridas (incluye compras)" value={-pv.deductions.percepcion} muted />
            <Row label="SIRCREB" value={-pv.deductions.sircreb} muted />
            <Row label="SIRTAC" value={-pv.deductions.sirtac} muted />
            <Row
              label={pv.previous_period ? `Saldo a favor de ${fmtPeriod(pv.previous_period)}` : "Saldo a favor inicial"}
              value={-pv.previous_credit}
              muted
            />
            <div className="my-2 border-t border-border" />
            <Row label="Saldo a pagar" value={pv.to_pay} strong />
            <Row label="Saldo a favor para el mes siguiente" value={pv.credit_next} />
            <p className="mt-3 text-xs text-muted-foreground">
              {pv.sales_count} ventas · {pv.entries} retenciones registradas · {pv.purchase_perceptions} facturas con percepción.
            </p>
            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              {pv.confirmed ? (
                <Badge tone="success">
                  <CheckCircle2 size={14} /> Confirmada
                </Badge>
              ) : (
                <Button onClick={() => void confirm()} disabled={!finished || m.confirm.isPending} className="w-full sm:w-auto">
                  {m.confirm.isPending ? <Spinner size={15} /> : <CheckCircle2 size={16} />} Confirmar liquidación
                </Button>
              )}
              <Button variant="secondary" onClick={() => void download(pv)} className="w-full sm:w-auto">
                <Download size={16} /> XLSX
              </Button>
            </div>
            {!finished && !pv.confirmed && (
              <p className="mt-2 text-xs text-muted-foreground">Se confirma cuando termina el mes.</p>
            )}
          </SettingsCard>
        </>
      )}
    </div>
  );
}

// ── Actividades ───────────────────────────────────────────────────────────
function ActividadesTab({ home, enabled }: { home: string | null; enabled: boolean }) {
  const { data: acts = [], isLoading } = useIibbActivities(enabled);
  const { data: templates = [] } = useIibbTemplates(enabled);
  const { data: cats = [] } = useCategories();
  const [edit, setEdit] = useState<Partial<IibbActivity> | null>(null);
  const { toast } = useToast();
  const m = useIibbMutations();

  async function save() {
    if (!edit) return;
    const rate = Number(String(edit.rate ?? "").replace(",", "."));
    if (!edit.jurisdiction || !edit.name || !Number.isFinite(rate)) {
      toast({ title: "Completá jurisdicción, nombre y alícuota.", variant: "error" });
      return;
    }
    try {
      await m.saveActivity.mutateAsync({ ...edit, jurisdiction: edit.jurisdiction, name: edit.name, rate });
      setEdit(null);
    } catch (e) {
      toast({ title: taxErrorMessage(e), variant: "error" });
    }
  }

  const catName = (id: string) => (cats as { id: string; name: string }[]).find((c) => c.id === id)?.name ?? "Categoría";

  return (
    <div className="space-y-6">
      <SettingsCard
        title="Actividades"
        description="Cada jurisdicción necesita al menos una. La principal toma las ventas de categorías que no estén en otra actividad."
        actions={
          <Button size="sm" onClick={() => setEdit({ jurisdiction: home ?? "", is_default: acts.length === 0, rate: 0, min_tax: 0, category_ids: [] })}>
            <Plus size={15} /> Agregar
          </Button>
        }
      >
        {isLoading ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">Cargando...</p>
        ) : acts.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">Todavía no cargaste actividades.</p>
        ) : (
          <ul className="divide-y divide-border">
            {acts.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0 text-sm">
                  <div className="flex flex-wrap items-center gap-2 font-medium">
                    {a.code ? `${a.code} · ` : ""}
                    {a.name}
                    {a.is_default && <Badge>Principal</Badge>}
                    {!a.is_active && <Badge tone="danger">Inactiva</Badge>}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {jurisdictionName(a.jurisdiction)} · {a.rate} %
                    {a.min_tax > 0 ? ` · mínimo ${formatCurrency(a.min_tax)}` : ""}
                    {a.category_ids.length ? ` · ${a.category_ids.map(catName).join(", ")}` : ""}
                  </div>
                </div>
                <Button size="sm" variant="ghost" aria-label="Editar" onClick={() => setEdit(a)}>
                  <Pencil size={15} />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </SettingsCard>
      {templates.length > 0 && (
        <SettingsCard title="Plantillas orientativas" description="Alícuotas de referencia a verificar con tu contador: dependen de la ley impositiva del año y de tus ingresos.">
          <ul className="divide-y divide-border">
            {templates.map((t) => (
              <li key={`${t.jurisdiction}-${t.code}`} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
                <span>
                  {jurisdictionName(t.jurisdiction)} · {t.code} {t.name} · {t.rate} %
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    setEdit({
                      jurisdiction: t.jurisdiction,
                      code: t.code,
                      name: t.name,
                      rate: t.rate,
                      min_tax: 0,
                      category_ids: [],
                      is_default: !acts.some((a) => a.jurisdiction === t.jurisdiction && a.is_default && a.is_active),
                    })
                  }
                >
                  Usar
                </Button>
              </li>
            ))}
          </ul>
        </SettingsCard>
      )}
      <Modal
        open={Boolean(edit)}
        onOpenChange={(v) => !v && setEdit(null)}
        title={edit?.id ? "Editar actividad" : "Nueva actividad"}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEdit(null)}>
              Cancelar
            </Button>
            <Button onClick={() => void save()} disabled={m.saveActivity.isPending}>
              {m.saveActivity.isPending ? <Spinner size={15} /> : null} Guardar
            </Button>
          </>
        }
      >
        {edit && (
          <div className="space-y-3">
            <Select<string>
              label="Jurisdicción"
              value={edit.jurisdiction || null}
              onChange={(v) => setEdit({ ...edit, jurisdiction: v })}
              options={JURISDICTIONS.map((j) => ({ value: j.code, label: `${j.name} (${j.code})` }))}
            />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Input label="Código (NAES)" inputMode="numeric" value={edit.code ?? ""} onChange={(e) => setEdit({ ...edit, code: e.target.value.replace(/\D/g, "").slice(0, 6) })} />
              <Input label="Nombre" value={edit.name ?? ""} onChange={(e) => setEdit({ ...edit, name: e.target.value })} maxLength={120} />
              <Input label="Alícuota %" inputMode="decimal" value={String(edit.rate ?? "")} onChange={(e) => setEdit({ ...edit, rate: e.target.value as unknown as number })} />
              <Input
                label="Impuesto mínimo mensual"
                inputMode="decimal"
                value={String(edit.min_tax ?? 0)}
                onChange={(e) => setEdit({ ...edit, min_tax: parseArAmount(e.target.value) ?? 0 })}
              />
            </div>
            <div>
              <span className="mb-2 block text-sm font-medium text-muted-foreground">Categorías de productos</span>
              <div className="flex flex-wrap gap-2">
                {(cats as { id: string; name: string }[]).map((c) => {
                  const on = (edit.category_ids ?? []).includes(c.id);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() =>
                        setEdit({
                          ...edit,
                          category_ids: on ? (edit.category_ids ?? []).filter((x) => x !== c.id) : [...(edit.category_ids ?? []), c.id],
                        })
                      }
                      className={`h-8 rounded-md px-2.5 text-xs ${on ? "bg-foreground text-background" : "bg-muted text-muted-foreground"}`}
                    >
                      {c.name}
                    </button>
                  );
                })}
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={Boolean(edit.is_default)} onChange={(e) => setEdit({ ...edit, is_default: e.target.checked })} />
              Actividad principal de la jurisdicción
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={edit.is_active !== false} onChange={(e) => setEdit({ ...edit, is_active: e.target.checked })} />
              Activa
            </label>
          </div>
        )}
      </Modal>
    </div>
  );
}

// ── Convenio Multilateral ─────────────────────────────────────────────────
function CoeficientesTab({ enabled }: { enabled: boolean }) {
  const { data: rows = [] } = useIibbCoefficients(enabled);
  const m = useIibbMutations();
  const { toast } = useToast();
  const [edit, setEdit] = useState<Partial<IibbCoefficient> | null>(null);

  async function save() {
    if (!edit?.jurisdiction || !edit.valid_from) return;
    const c = Number(String(edit.coefficient ?? "").replace(",", "."));
    if (!Number.isFinite(c) || c < 0 || c > 1) {
      toast({ title: "El coeficiente va de 0 a 1 (por ejemplo 0,354321).", variant: "error" });
      return;
    }
    try {
      await m.saveCoefficient.mutateAsync({ ...edit, jurisdiction: edit.jurisdiction, valid_from: `${edit.valid_from.slice(0, 7)}-01`, coefficient: c });
      setEdit(null);
    } catch (e) {
      toast({ title: taxErrorMessage(e), variant: "error" });
    }
  }

  return (
    <SettingsCard
      title="Coeficientes unificados"
      description="Los calcula tu contador con la DDJJ anual (CM05). Se usa el vigente al mes liquidado; la base de todo el país se multiplica por el coeficiente de cada jurisdicción."
      actions={
        <Button size="sm" onClick={() => setEdit({ jurisdiction: "", valid_from: "", coefficient: 0 })}>
          <Plus size={15} /> Agregar
        </Button>
      }
    >
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">Sin coeficientes cargados.</p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
              <span>
                {jurisdictionName(r.jurisdiction)} · desde {fmtPeriod(r.valid_from)}
              </span>
              <span className="flex items-center gap-2">
                <span className="tabular-nums">{r.coefficient.toFixed(6)}</span>
                <Button size="sm" variant="ghost" aria-label="Editar" onClick={() => setEdit(r)}>
                  <Pencil size={15} />
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <Modal
        open={Boolean(edit)}
        onOpenChange={(v) => !v && setEdit(null)}
        title="Coeficiente"
        footer={
          <>
            <Button variant="secondary" onClick={() => setEdit(null)}>
              Cancelar
            </Button>
            <Button onClick={() => void save()} disabled={m.saveCoefficient.isPending}>
              Guardar
            </Button>
          </>
        }
      >
        {edit && (
          <div className="space-y-3">
            <Select<string>
              label="Jurisdicción"
              value={edit.jurisdiction || null}
              onChange={(v) => setEdit({ ...edit, jurisdiction: v })}
              options={JURISDICTIONS.map((j) => ({ value: j.code, label: `${j.name} (${j.code})` }))}
            />
            <Input label="Vigente desde" type="month" value={(edit.valid_from ?? "").slice(0, 7)} onChange={(e) => setEdit({ ...edit, valid_from: e.target.value })} />
            <Input
              label="Coeficiente"
              inputMode="decimal"
              value={String(edit.coefficient ?? "")}
              onChange={(e) => setEdit({ ...edit, coefficient: e.target.value as unknown as number })}
            />
          </div>
        )}
      </Modal>
    </SettingsCard>
  );
}

// ── Historial ─────────────────────────────────────────────────────────────
function HistorialTab({ enabled }: { enabled: boolean }) {
  const { data: rows = [], isLoading } = useIibbLiquidations(enabled);
  const m = useIibbMutations();
  const { toast } = useToast();
  const [voiding, setVoiding] = useState<string | null>(null);

  return (
    <SettingsCard title="Liquidaciones">
      {isLoading ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">Cargando...</p>
      ) : rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">Todavía no confirmaste liquidaciones.</p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 font-medium">
                  {jurisdictionName(l.jurisdiction)} · {fmtPeriod(l.period)}
                  {l.status === "voided" ? <Badge tone="danger">Anulada</Badge> : <Badge tone="success">Confirmada</Badge>}
                  {l.regime === "cm" && <Badge>CM</Badge>}
                </div>
                <div className="text-xs text-muted-foreground">
                  Determinado {formatCurrency(l.determined)} · deducciones {formatCurrency(l.deductions_total + l.previous_credit)} · a
                  favor {formatCurrency(l.credit_next)}
                  {l.void_reason ? ` · ${l.void_reason}` : ""}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="font-semibold tabular-nums">{formatCurrency(l.to_pay)}</span>
                {l.status === "confirmed" && (
                  <Button size="sm" variant="ghost" aria-label="Anular" onClick={() => setVoiding(l.id)}>
                    <XCircle size={15} />
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={Boolean(voiding)}
        onOpenChange={(v) => !v && setVoiding(null)}
        title="Anular la liquidación"
        description="Se anula la última de la jurisdicción. Las retenciones del mes vuelven a quedar editables y, con contabilidad, se hace el contra-asiento."
        confirmLabel="Anular"
        danger
        withReason
        loading={m.void.isPending}
        onConfirm={(reason) =>
          void m.void
            .mutateAsync({ id: voiding!, reason })
            .then(() => setVoiding(null))
            .catch((e) => toast({ title: taxErrorMessage(e), variant: "error" }))
        }
      />
    </SettingsCard>
  );
}
