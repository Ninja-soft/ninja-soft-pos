"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Lock, PackageOpen, Plus, Printer, Settings2, Truck } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/ui/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { EmptyState } from "@/components/ui/EmptyState";
import { Segmented } from "@/components/ui/Segmented";
import { Select } from "@/components/ui/Select";
import { SearchField } from "@/components/ui/SearchField";
import { useToast } from "@/components/ui/Toast";
import { UpgradeModal } from "@/components/saas/UpgradeModal";
import { ShipmentFormModal } from "@/components/shipping/ShipmentFormModal";
import { ShipmentDetailModal } from "@/components/shipping/ShipmentDetailModal";
import { formatCurrency } from "@/lib/utils/format";
import { shippingErrorMessage } from "@/lib/shipping/form";
import { enqueueZplLabel, openPdfForPrint } from "@/lib/shipping/print";
import { STATUS_GROUPS, statusLabel, statusTone } from "@/lib/shipping/status";
import { useBranchContext } from "@/modules/branches/hooks";
import { useFeature } from "@/modules/saas/gating";
import { useMyTenant } from "@/modules/tenants/hooks";
import { shippingApi } from "@/modules/shipping/api";
import { useShipments, useShippingProviders } from "@/modules/shipping/hooks";

// Envíos (ADR-103): lista con filtros por estado, logística y sucursal,
// impresión de etiquetas por lote (PDF combinado o ZPL a la cola del equipo),
// alta desde una venta o a mano y detalle con seguimiento.

type Group = "all" | (typeof STATUS_GROUPS)[number]["key"];

function when(iso: string): string {
  return new Date(iso).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export default function EnviosPage() {
  const enabled = useFeature("envios");
  const { toast } = useToast();
  const { data: me } = useMyTenant();
  const canOperate = Boolean(me && me.role !== "viewer");
  const canManage = Boolean(me?.canManage);
  const ctx = useBranchContext();
  const { data: providers = [] } = useShippingProviders();
  const [group, setGroup] = useState<Group>("all");
  const [provider, setProvider] = useState<string>("");
  const [storeId, setStoreId] = useState<string>("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [formOpen, setFormOpen] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);

  const statuses = group === "all" ? undefined : STATUS_GROUPS.find((g) => g.key === group)?.statuses;
  const filters = useMemo(
    () => ({ statuses, provider: provider || null, storeId: storeId || null, search }),
    [statuses, provider, storeId, search],
  );
  const { data: list = [], isLoading, error } = useShipments(filters);
  const providerName = (k: string | null) => (k ? (providers.find((p) => p.key === k)?.name ?? k) : "Sin logística");
  const storeName = (id: string) => ctx.branchName(id) ?? "Sucursal";
  const zplCapable = (k: string | null) => Boolean(providers.find((p) => p.key === k)?.label_formats.includes("zpl"));

  const printable = list.filter((s) => s.label_path);
  const chosen = list.filter((s) => selected.has(s.id));
  const toggle = (id: string) =>
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  async function printBatch(format: "pdf" | "zpl") {
    const ids = chosen.filter((s) => s.label_path && s.label_format === format).map((s) => s.id);
    if (ids.length === 0) {
      toast({ title: `Ninguno de los elegidos tiene etiqueta ${format.toUpperCase()}`, variant: "error" });
      return;
    }
    setBatchBusy(true);
    try {
      const r = await shippingApi.labelsBatch(ids, format);
      if (format === "zpl" && r.zpl) {
        enqueueZplLabel(r.zpl, `Lote de ${r.included.length} etiquetas`);
        toast({ title: `${r.included.length} etiquetas a la cola de impresión de este equipo`, variant: "success" });
      } else if (r.url) {
        if (!openPdfForPrint(r.url)) toast({ title: "El navegador bloqueó la pestaña del PDF", variant: "error" });
      }
      if (r.skipped.length > 0) toast({ title: `${r.skipped.length} sin etiqueta en ese formato`, variant: "warning" });
    } catch (e) {
      toast({ title: shippingErrorMessage(e), variant: "error" });
    } finally {
      setBatchBusy(false);
    }
  }

  const header = (
    <PageHeader
      eyebrow="Operación"
      title="Envíos"
      icon={Truck}
      description="Cotizá entre tus logísticas, imprimí la etiqueta y seguí cada envío hasta que llega."
      actions={
        enabled ? (
          <div className="contents">
            {canManage && (
              <Link href="/configuracion?seccion=envios">
                <Button variant="secondary">
                  <Settings2 size={16} /> Logísticas
                </Button>
              </Link>
            )}
            {canOperate && (
              <Button onClick={() => setFormOpen(true)}>
                <Plus size={16} /> Nuevo envío
              </Button>
            )}
          </div>
        ) : undefined
      }
    />
  );

  if (enabled === false) {
    return (
      <PageContainer>
        {header}
        <div className="mt-8 rounded-lg bg-muted/40 p-8 text-center">
          <Lock className="mx-auto text-ninja-flameSoft" size={28} />
          <p className="mt-3 font-semibold">Envíos no está incluido en tu plan</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Conectá Andreani y otras logísticas, cotizá, imprimí etiquetas y seguí cada envío sin salir de NinjaSoft.
          </p>
          <Button className="mt-4" onClick={() => setUpgradeOpen(true)}>
            Ver planes
          </Button>
          <UpgradeModal open={upgradeOpen} onOpenChange={setUpgradeOpen} featureKey="envios" featureLabel="Envíos y logística" />
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      {header}

      <div className="mt-6 flex flex-col gap-3">
        <Segmented<Group>
          aria-label="Estado"
          value={group}
          onChange={(g) => {
            setGroup(g);
            setSelected(new Set());
          }}
          size="sm"
          options={[{ value: "all", label: "Todos" }, ...STATUS_GROUPS.map((g) => ({ value: g.key as Group, label: g.label }))]}
        />
        <div className="grid gap-3 sm:grid-cols-3">
          <SearchField value={search} onValueChange={setSearch} placeholder="Seguimiento, pedido o destinatario" />
          <Select
            value={provider}
            onChange={setProvider}
            options={[{ value: "", label: "Todas las logísticas" }, ...providers.filter((p) => p.status !== "planned").map((p) => ({ value: p.key, label: p.name }))]}
          />
          {ctx.allowed.length > 1 && (
            <Select
              value={storeId}
              onChange={setStoreId}
              options={[{ value: "", label: "Todas las sucursales" }, ...ctx.allowed.map((b) => ({ value: b.id, label: b.name }))]}
            />
          )}
        </div>
      </div>

      {chosen.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg bg-muted/60 px-4 py-3">
          <span className="text-sm font-medium">{chosen.length} elegidos</span>
          <Button size="sm" onClick={() => printBatch("pdf")} loading={batchBusy}>
            <Printer size={15} /> Imprimir etiquetas PDF
          </Button>
          {chosen.some((s) => zplCapable(s.provider_key)) && (
            <Button size="sm" variant="secondary" onClick={() => printBatch("zpl")} loading={batchBusy}>
              <Printer size={15} /> Mandar a térmica (ZPL)
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Limpiar
          </Button>
        </div>
      )}

      <section className="mt-4">
        {isLoading ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Cargando envíos…</p>
        ) : error ? (
          <p className="py-8 text-center text-sm text-danger">{shippingErrorMessage(error)}</p>
        ) : list.length === 0 ? (
          <EmptyState
            icon={PackageOpen}
            title="No hay envíos con estos filtros"
            description="Creá un envío desde una venta o a mano. Para probar sin contrato, usá el Simulador de envíos."
          />
        ) : (
          <ul className="divide-y divide-border">
            {printable.length > 0 && (
              <li className="flex items-center gap-3 py-2 text-xs text-muted-foreground">
                <Checkbox
                  checked={printable.every((s) => selected.has(s.id)) ? true : printable.some((s) => selected.has(s.id)) ? "indeterminate" : false}
                  onCheckedChange={(on) => setSelected(on ? new Set(printable.map((s) => s.id)) : new Set())}
                  aria-label="Elegir todos los que tienen etiqueta"
                />
                Elegir todos con etiqueta ({printable.length})
              </li>
            )}
            {list.map((s) => (
              <li key={s.id} className="flex items-start gap-3 py-3">
                <div className="pt-1">
                  <Checkbox checked={selected.has(s.id)} onCheckedChange={() => toggle(s.id)} aria-label={`Elegir envío a ${s.recipient?.name ?? ""}`} />
                </div>
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setDetail(s.id)}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">{s.recipient?.name}</span>
                    <Badge tone={statusTone(s.status)}>{statusLabel(s.status)}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {providerName(s.provider_key)}
                    {s.tracking_number ? ` · ${s.tracking_number}` : ""} · {s.service_type === "branch" ? "a sucursal" : "a domicilio"} ·{" "}
                    {s.destination?.postal_code} {s.destination?.city ?? ""}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {when(s.created_at)} · {storeName(s.store_id)}
                    {s.order_ref ? ` · Pedido ${s.order_ref}` : s.sale_id ? " · Venta del POS" : ""}
                    {s.quoted_cost != null ? ` · ${formatCurrency(s.quoted_cost)}` : ""}
                    {s.status_detail && s.status === "error" ? ` · ${s.status_detail}` : ""}
                  </p>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ShipmentFormModal
        open={formOpen}
        onOpenChange={setFormOpen}
        stores={ctx.allowed}
        defaultStoreId={ctx.posStoreId ?? ctx.filterStoreId ?? ctx.allowed[0]?.id ?? null}
        onCreated={(s) => setDetail(s.id)}
      />
      <ShipmentDetailModal
        id={detail}
        onClose={() => setDetail(null)}
        providers={providers}
        canManage={canManage}
        canOperate={canOperate}
      />
    </PageContainer>
  );
}
