"use client";

// Remitos de entrega y de envío (ADR-136): lista por sucursal, emisión para
// una venta por su número (las entregas de Expedición se emiten desde su
// tarjeta), detalle con PDF, impresión, email, COT y anulación.

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { FileText, Lock, Plus, Search } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/ui/PageHeader";
import { Button, buttonVariants } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { EmptyState } from "@/components/ui/EmptyState";
import { useToast } from "@/components/ui/Toast";
import { UpgradeModal } from "@/components/saas/UpgradeModal";
import { RemitoIssueModal, type RemitoSource } from "@/components/remitos/RemitoIssueModal";
import { RemitoDetailModal } from "@/components/remitos/RemitoDetailModal";
import { selectCls } from "@/components/stock/transfers/shared";
import { cn } from "@/lib/utils/cn";
import { COT_JURISDICTION_SHORT, cotRequired, dateAr, moneyAr, remitoErrorMessage, remitoNumberLabel } from "@/lib/remitos/logic";
import { useFeature } from "@/modules/saas/gating";
import { useMyTenant } from "@/modules/tenants/hooks";
import { useBranchContext } from "@/modules/branches/hooks";
import { useStores } from "@/modules/stock/hooks";
import { remitosApi, useRemitoConfig, useRemitos } from "@/modules/remitos/api";

export default function RemitosPage() {
  const enabled = useFeature("entregas_remitos");
  const { toast } = useToast();
  const { data: me } = useMyTenant();
  const canOperate = Boolean(me && me.role !== "viewer");
  const canManage = Boolean(me?.canManage);
  const ctx = useBranchContext();
  const { data: stores = [] } = useStores();
  const [storeId, setStoreId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [askSale, setAskSale] = useState(false);
  const [saleNumber, setSaleNumber] = useState("");
  const [finding, setFinding] = useState(false);
  const [issuing, setIssuing] = useState<RemitoSource | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    if (storeId === null && ctx.ready) setStoreId(ctx.posStoreId ?? ctx.filterStoreId ?? "");
  }, [ctx.ready, ctx.posStoreId, ctx.filterStoreId, storeId]);

  const { data: list = [], isLoading } = useRemitos(storeId || null, search, enabled === true);
  const { data: cfg } = useRemitoConfig(enabled === true);
  const storeName = (id: string) => stores.find((s) => s.id === id)?.name ?? "Sucursal";

  async function findSale() {
    const n = Number(saleNumber);
    if (!Number.isInteger(n) || n <= 0) return;
    setFinding(true);
    try {
      const saleId = await remitosApi.saleIdByNumber(n);
      setAskSale(false);
      setIssuing({ dispatchId: null, saleId, label: `Venta #${n}`, kind: "entrega" });
    } catch (e) {
      toast({ title: "No encontramos esa venta", description: remitoErrorMessage(e), variant: "error" });
    } finally {
      setFinding(false);
    }
  }

  const header = (
    <PageHeader
      eyebrow="Operación"
      title="Remitos"
      icon={FileText}
      description="Remitos de entrega y de envío con bultos, transporte y COT. Se imprimen, se bajan en PDF y se mandan por email."
      actions={
        enabled && canOperate ? (
          <>
            <Button onClick={() => setAskSale(true)}>
              <Plus size={16} /> Emitir para una venta
            </Button>
            <Link href={"/expedicion" as Route} className={buttonVariants({ variant: "secondary" })}>
              Expedición
            </Link>
          </>
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
          <p className="mt-3 font-semibold">Los remitos no están incluidos en tu plan</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Emití remitos de entrega y de envío con numeración propia, transporte y COT, y partí las entregas de una venta.
          </p>
          <Button className="mt-4" onClick={() => setUpgradeOpen(true)}>
            Ver planes
          </Button>
          <UpgradeModal open={upgradeOpen} onOpenChange={setUpgradeOpen} featureKey="entregas_remitos" featureLabel="Entregas partidas y remitos" />
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      {header}
      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
        {stores.length > 1 && (
          <select aria-label="Sucursal" className={cn(selectCls, "h-10 sm:max-w-[14rem]")} value={storeId ?? ""} onChange={(e) => setStoreId(e.target.value)}>
            <option value="" className="bg-popover text-popover-foreground">
              Todas las sucursales
            </option>
            {stores.map((s) => (
              <option key={s.id} value={s.id} className="bg-popover text-popover-foreground">
                {s.name}
              </option>
            ))}
          </select>
        )}
        <div className="relative w-full sm:max-w-sm">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="Número o destinatario" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
        </div>
      </div>

      <section className="mt-6">
        {isLoading ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Cargando remitos…</p>
        ) : list.length === 0 ? (
          <EmptyState
            icon={FileText}
            title="Todavía no hay remitos"
            description="Emití un remito desde una entrega en Expedición o para una venta con su número."
          />
        ) : (
          <ul className="grid gap-3 md:grid-cols-2">
            {list.map((r) => {
              const missing = !r.cot_number && cotRequired(cfg?.cot_threshold ?? null, r.cot_jurisdiction, r.declared_value);
              return (
                <li key={r.id}>
                  <button type="button" onClick={() => setOpenId(r.id)} className="flex w-full flex-col rounded-xl bg-card p-4 text-left transition-colors hover:bg-fg-4">
                    <div className="flex w-full items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-semibold tabular-nums">{remitoNumberLabel(r.pto_vta, r.number)}</p>
                        <p className="truncate text-sm">{r.receiver_name}</p>
                      </div>
                      <Badge tone={r.status === "emitido" ? "success" : "neutral"}>{r.status === "emitido" ? "Emitido" : "Anulado"}</Badge>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      <Badge tone="neutral">{r.kind === "envio" ? "Envío" : "Entrega"}</Badge>
                      {r.cot_number ? (
                        <Badge tone="info">COT {r.cot_jurisdiction ? COT_JURISDICTION_SHORT[r.cot_jurisdiction] : ""}</Badge>
                      ) : missing ? (
                        <Badge tone="warning">Falta el COT</Badge>
                      ) : null}
                      <span>
                        {dateAr(r.issued_at)} · {r.packages} {r.packages === 1 ? "bulto" : "bultos"} · $ {moneyAr(r.declared_value)}
                      </span>
                      {stores.length > 1 && <span>· {storeName(r.store_id)}</span>}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <Modal
        open={askSale}
        onOpenChange={setAskSale}
        title="Emitir remito para una venta"
        description="Para una venta ya cobrada. Las entregas de Expedición tienen su botón Remito."
        footer={
          <>
            <Button variant="secondary" onClick={() => setAskSale(false)}>
              Cancelar
            </Button>
            <Button onClick={findSale} disabled={!/^\d+$/.test(saleNumber)} loading={finding}>
              Seguir
            </Button>
          </>
        }
      >
        <Input label="Número de venta" inputMode="numeric" value={saleNumber} onChange={(e) => setSaleNumber(e.target.value.replace(/\D/g, ""))} />
      </Modal>
      <RemitoIssueModal
        source={issuing}
        onClose={() => setIssuing(null)}
        onIssued={(id) => {
          setIssuing(null);
          setOpenId(id);
        }}
      />
      <RemitoDetailModal id={openId} canManage={canManage} onClose={() => setOpenId(null)} />
    </PageContainer>
  );
}
