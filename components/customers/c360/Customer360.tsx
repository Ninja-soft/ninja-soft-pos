"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Download, Lock, Pencil, Store, Wallet } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Eyebrow, Display } from "@/components/ui/Typography";
import { headerActionsRow } from "@/components/ui/PageHeader";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { UpgradeModal } from "@/components/saas/UpgradeModal";
import { KpiCard } from "@/components/reports/KpiCard";
import { C360Warranties } from "./C360Warranties";
import { CustomerFormModal } from "@/components/customers/CustomerFormModal";
import { cn } from "@/lib/utils/cn";
import { formatCurrency, formatInt } from "@/lib/utils/format";
import { exportXlsx } from "@/lib/utils/xlsx";
import { methodLabel } from "@/lib/sales/paymentDetail";
import {
  SEGMENT_META,
  TIMELINE_XLSX_COLUMNS,
  customerSegments,
  dateRange,
  timelineXlsxRows,
  type C360Summary,
  type TimelineKind,
} from "@/lib/customers/c360";
import { DOC_TYPE_LABELS, IVA_LABELS } from "@/modules/customers/schemas";
import type { Customer } from "@/modules/customers/api";
import { useFeature } from "@/modules/saas/gating";
import { useBranchContext } from "@/modules/branches/hooks";
import { fetchAllTimeline, useCustomer360Summary, type TimelineFilters } from "@/modules/customers/c360";
import { C360Charts } from "./C360Charts";
import { C360Timeline } from "./C360Timeline";
import { C360Notes } from "./C360Notes";
import { C360Addresses } from "./C360Addresses";
import { C360Receipts } from "./C360Receipts";
import { C360Account } from "./C360Account";
import { C360Attachments } from "./C360Attachments";

const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" }) : "Sin dato";

// Ficha del cliente 360 (H31b · ADR-067): perfil, datos fiscales, segmentos,
// indicadores, sucursales, gráficos, línea de tiempo unificada con filtros y
// paginación, notas internas y exportación a Excel. Todo lo calcula el
// servidor (customer_360_summary / customer_360_timeline) respetando negocio,
// sucursales y rol.
export function Customer360({ customerId }: { customerId: string | null }) {
  const { toast } = useToast();
  const feature = useFeature("clientes_360");
  const accountEnabled = useFeature("cuenta_corriente");
  const exportEnabled = useFeature("export_xlsx");
  const branchCtx = useBranchContext();
  const [storeId, setStoreId] = useState<string>("");
  const [editing, setEditing] = useState(false);
  const [upgrade, setUpgrade] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [filters, setFilters] = useState<{ kinds: TimelineKind[]; from: string; to: string }>({
    kinds: [],
    from: "",
    to: "",
  });

  const summary = useCustomer360Summary(customerId, storeId || null, feature !== false);
  const s = summary.data;
  const tlFilters: TimelineFilters = useMemo(() => {
    const r = dateRange(filters.from || null, filters.to || null);
    return { kinds: filters.kinds.length ? filters.kinds : null, from: r.from, to: r.to, storeId: storeId || null };
  }, [filters, storeId]);

  const segments = s ? customerSegments(s.kpis, s.vip_threshold) : [];
  const errMsg = summary.error instanceof Error ? summary.error.message : "";

  if (feature === false || errMsg.includes("feature_not_in_plan")) {
    return (
      <Shell>
        <div className="mt-8 flex flex-col items-start gap-3 rounded-xl bg-muted/40 p-6">
          <span className="grid h-10 w-10 place-items-center rounded-lg bg-muted text-muted-foreground">
            <Lock size={18} />
          </span>
          <div>
            <p className="font-semibold">La ficha del cliente 360 es del plan Pro</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Indicadores, línea de tiempo completa, productos y medios preferidos, segmentos, notas y exportación. El
              historial básico sigue disponible en la lista de clientes.
            </p>
          </div>
          <Button onClick={() => setUpgrade(true)}>Ver planes</Button>
        </div>
        {upgrade && (
          <UpgradeModal
            open
            onOpenChange={(o) => !o && setUpgrade(false)}
            featureKey="clientes_360"
            featureLabel="Ficha del cliente 360"
          />
        )}
      </Shell>
    );
  }

  if (summary.isLoading || feature === undefined) {
    return (
      <Shell>
        <SpinnerBlock className="py-16" label="Cargando la ficha del cliente" />
      </Shell>
    );
  }

  if (!s) {
    return (
      <Shell>
        <p className="mt-8 rounded-xl bg-muted/40 p-6 text-sm text-muted-foreground">
          {errMsg.includes("customer_not_found")
            ? "No encontramos este cliente en tu negocio."
            : errMsg.includes("forbidden")
              ? "No tenés acceso a esta ficha."
              : "No se pudo cargar la ficha del cliente."}
        </p>
      </Shell>
    );
  }

  const p = s.profile as C360Summary["profile"] & Record<string, string | number | boolean | null>;
  const k = s.kpis;
  const doc = p.document_type
    ? `${DOC_TYPE_LABELS[p.document_type as keyof typeof DOC_TYPE_LABELS] ?? p.document_type} ${p.document_number ?? ""}`
    : null;
  const iva = p.iva_condition ? (IVA_LABELS[p.iva_condition as keyof typeof IVA_LABELS] ?? String(p.iva_condition)) : null;

  async function exportAll() {
    if (!s || !customerId) return;
    setExporting(true);
    try {
      const items = await fetchAllTimeline(customerId, tlFilters);
      const name = String(s.profile.name ?? "cliente");
      await exportXlsx(`cliente-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}`, [
        {
          name: "Resumen",
          title: `Ficha de ${name} • NinjaPos`,
          columns: [
            { header: "Indicador", key: "k", width: 32 },
            { header: "Valor", key: "v", width: 24 },
          ],
          rows: [
            { k: "Total comprado", v: formatCurrency(k.total) },
            { k: "Compras", v: formatInt(k.purchases) },
            { k: "Ticket promedio", v: formatCurrency(k.avg_ticket) },
            { k: "Primera compra", v: fmtDate(k.first_at) },
            { k: "Última compra", v: fmtDate(k.last_at) },
            { k: "Frecuencia (días entre compras)", v: k.frequency_days ?? "" },
            { k: "Devoluciones", v: formatCurrency(k.returns_total) },
            { k: "Deuda en cuenta corriente", v: formatCurrency(k.account_balance) },
            { k: "Deuda vencida", v: formatCurrency(k.account_overdue) },
            { k: "Saldo a favor", v: formatCurrency(k.store_credit) },
            { k: "Segmentos", v: segments.map((x) => SEGMENT_META[x].label).join(", ") },
          ],
        },
        { name: "Línea de tiempo", title: `Movimientos de ${name}`, columns: TIMELINE_XLSX_COLUMNS, rows: timelineXlsxRows(items) },
        {
          name: "Productos",
          columns: [
            { header: "Producto", key: "name", width: 40 },
            { header: "Unidades", key: "qty", type: "number", width: 12 },
            { header: "Compras", key: "purchases", type: "number", width: 12 },
            { header: "Total", key: "total", type: "money", width: 16 },
          ],
          rows: s.top_products,
        },
        {
          name: "Medios de pago",
          columns: [
            { header: "Medio", key: "label", width: 28 },
            { header: "Cobros", key: "count", type: "number", width: 12 },
            { header: "Total", key: "total", type: "money", width: 16 },
          ],
          rows: s.payment_methods.map((m) => ({ ...m, label: methodLabel(m.method) })),
        },
        {
          name: "Por sucursal",
          columns: [
            { header: "Sucursal", key: "name", width: 28 },
            { header: "Compras", key: "count", type: "number", width: 12 },
            { header: "Total", key: "total", type: "money", width: 16 },
            { header: "Ticket promedio", key: "avg_ticket", type: "money", width: 16 },
            { header: "Última compra", key: "last", type: "date", width: 16 },
          ],
          rows: s.by_store.map((b) => ({ ...b, last: b.last_at ? new Date(b.last_at) : null })),
        },
      ]);
    } catch {
      toast({ title: "No se pudo exportar", variant: "error" });
    } finally {
      setExporting(false);
    }
  }

  return (
    <Shell>
      {/* Encabezado */}
      <div className="mt-4 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <Eyebrow>Ficha del cliente</Eyebrow>
          <Display className="mt-2 break-words text-3xl md:text-4xl">{String(p.name)}</Display>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {p.is_active === false && <Badge tone="neutral">Inactivo en la base</Badge>}
            {segments.map((x) => (
              <Badge key={x} tone={SEGMENT_META[x].tone} title={SEGMENT_META[x].help}>
                {SEGMENT_META[x].label}
              </Badge>
            ))}
          </div>
        </div>
        <div className={headerActionsRow}>
          {branchCtx.isMulti && (
            <label className="relative">
              <span className="sr-only">Sucursal</span>
              <Store size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <select
                value={storeId}
                onChange={(e) => setStoreId(e.target.value)}
                className="h-10 rounded-lg border border-input bg-background pl-9 pr-3 text-sm outline-none focus:border-ninja-flameSoft"
              >
                <option value="">Todas mis sucursales</option>
                {branchCtx.allowed.map((b) => (
                  <option key={b.id} value={b.id} className="bg-popover text-popover-foreground">
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <Button variant="secondary" onClick={() => setEditing(true)}>
            <Pencil size={15} /> Editar
          </Button>
          {accountEnabled !== false && (
            <Link href={`/clientes/cuentas/${customerId}`} className={buttonVariants({ variant: "secondary" })}>
              <Wallet size={15} /> Cuenta corriente
            </Link>
          )}
          <Button
            variant="secondary"
            loading={exporting}
            disabled={exportEnabled === false}
            title={exportEnabled === false ? "Exportar a Excel no está en tu plan" : undefined}
            onClick={exportAll}
          >
            <Download size={15} /> Exportar XLSX
          </Button>
        </div>
      </div>

      {/* Indicadores */}
      <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label="Total comprado" value={formatCurrency(k.total)} spark={s.monthly.map((m) => m.total)} hint="Últimos 12 meses en la línea" />
        <KpiCard label="Compras" value={formatInt(k.purchases)} hint={`${formatInt(k.purchases_90d)} en los últimos 90 días`} />
        <KpiCard label="Ticket promedio" value={formatCurrency(k.avg_ticket)} />
        <KpiCard
          label="Última compra"
          value={k.last_at ? fmtDate(k.last_at) : "Nunca"}
          hint={
            k.days_since_last != null
              ? `Hace ${formatInt(k.days_since_last)} días${k.frequency_days ? ` · compra cada ${k.frequency_days} días` : ""}`
              : undefined
          }
        />
        <KpiCard label="Devoluciones" value={formatCurrency(k.returns_total)} hint={`${formatInt(k.returns)} devoluciones`} />
        <KpiCard
          label="Deuda en cuenta corriente"
          value={formatCurrency(k.account_balance)}
          valueClassName={k.account_overdue > 0 ? "text-danger" : undefined}
          hint={
            k.account_overdue > 0
              ? `${formatCurrency(k.account_overdue)} vencida`
              : k.account_next_due
                ? `Próximo vencimiento ${fmtDate(k.account_next_due)}`
                : undefined
          }
        />
        <KpiCard label="Saldo a favor" value={formatCurrency(k.store_credit)} />
        <KpiCard
          label="Cobros en espera"
          value={formatInt(k.pending_charges)}
          hint={
            k.pending_charges > 0
              ? formatCurrency(k.pending_charges_total)
              : s.is_manager && k.open_disputes > 0
                ? `${formatInt(k.open_disputes)} contracargos o reclamos abiertos`
                : undefined
          }
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        {/* Perfil y datos fiscales */}
        <section className="rounded-xl border border-border bg-card p-4 lg:col-span-1">
          <h2 className="text-sm font-semibold">Datos del cliente</h2>
          <dl className="mt-3 space-y-2.5 text-sm">
            <Field label="Documento" value={doc} />
            <Field label="Condición frente al IVA" value={iva} />
            <Field label="Email" value={(p.email as string | null) ?? null} />
            <Field label="Teléfono" value={(p.phone as string | null) ?? null} />
            <Field label="Domicilio" value={(p.address as string | null) ?? null} />
            <Field label="Nacimiento" value={p.birth_date ? fmtDate(String(p.birth_date)) : null} />
            <Field label="Grupo" value={p.group_name ?? null} />
            <Field label="Sucursal de alta" value={p.store_alta_name ?? null} />
            <Field label="Cliente desde" value={fmtDate(String(p.created_at ?? ""))} />
            <Field
              label="Límite de crédito"
              value={Number(k.credit_limit ?? 0) > 0 ? formatCurrency(Number(k.credit_limit)) : "Sin límite"}
            />
            {p.notes ? <Field label="Observaciones" value={String(p.notes)} /> : null}
          </dl>

          {s.by_store.length > 0 && (
            <div className="mt-5">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Por sucursal</h3>
              <ul className="mt-2 space-y-2">
                {s.by_store.map((b) => (
                  <li key={b.store_id} className="rounded-lg bg-muted/40 px-3 py-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">{b.name}</span>
                      <span className="tabular-nums">{formatCurrency(b.total)}</span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {formatInt(b.count)} compras · ticket {formatCurrency(b.avg_ticket)} · última {fmtDate(b.last_at)}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        {/* Gráficos y notas */}
        <div className="space-y-6 lg:col-span-2">
          <C360Charts summary={s} />
          {customerId && (
            <C360Receipts customerId={customerId} storeId={storeId || null} email={(p.email as string | null) ?? null} />
          )}
          {customerId && accountEnabled !== false && <C360Account customerId={customerId} />}
          {customerId && <C360Notes customerId={customerId} pinned={s.pinned_notes} />}
          {customerId && <C360Attachments customerId={customerId} />}
          {customerId && <C360Addresses customerId={customerId} />}
          {customerId && <C360Warranties customerId={customerId} />}
        </div>
      </div>

      {/* Línea de tiempo */}
      {customerId && (
        <C360Timeline
          customerId={customerId}
          filters={filters}
          onFilters={setFilters}
          tlFilters={tlFilters}
          isManager={s.is_manager}
        />
      )}

      {editing && (
        <CustomerFormModal
          open
          onOpenChange={(o) => {
            if (!o) {
              setEditing(false);
              void summary.refetch();
            }
          }}
          customer={s.profile as unknown as Customer}
        />
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
      <Link
        href="/clientes"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-foreground"
      >
        <ArrowLeft size={15} /> Clientes
      </Link>
      {children}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className={cn("min-w-0 break-words text-right", !value && "text-muted-foreground")}>{value || "Sin dato"}</dd>
    </div>
  );
}
