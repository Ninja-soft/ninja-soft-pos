"use client";

// Garantías por número de serie (F14 · H64, ADR-092): el mostrador de
// posventa busca la serie, ve si está en garantía (fábrica + extendida) y
// abre o sigue el reclamo.

import { useState } from "react";
import { Search, ShieldAlert } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { fmtDateTime } from "@/components/stock/transfers/shared";
import {
  CLAIM_STATUS_LABEL,
  WARRANTY_STATE_LABEL,
  daysLeft,
  nextClaimStatuses,
  normalizeSerial,
  serialErrorMessage,
  warrantyState,
  type ClaimStatus,
  type SerialClaim,
  type WarrantyState,
} from "@/lib/stock/serialWarranty";
import { useSerialClaimMutations, useSerialLookup } from "@/modules/stock/inventoryPro";

const STATE_TONE: Record<WarrantyState, BadgeTone> = {
  vigente: "success",
  vencida: "danger",
  sin_garantia: "neutral",
  anulada: "neutral",
  devuelta: "neutral",
};

const todayIso = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });
const fmtDate = (iso: string | null) => (iso ? iso.split("-").reverse().join("/") : "Sin fecha");

export function SerialWarrantyPanel({ canManage }: { canManage: boolean }) {
  const [input, setInput] = useState("");
  const [serial, setSerial] = useState<string | null>(null);
  const { data, isFetching, error } = useSerialLookup(serial);
  const m = useSerialClaimMutations();
  const { toast } = useToast();
  const [opening, setOpening] = useState<{ saleId: string | null } | null>(null);
  const [reason, setReason] = useState("");
  const [editing, setEditing] = useState<{ claim: SerialClaim; status: ClaimStatus } | null>(null);
  const [resolution, setResolution] = useState("");
  const today = todayIso();

  function search(e: React.FormEvent) {
    e.preventDefault();
    const s = normalizeSerial(input);
    if (s.length < 3) {
      toast({ title: "Escribí al menos 3 caracteres de la serie.", variant: "error" });
      return;
    }
    setSerial(s);
  }

  async function openClaim() {
    if (!serial || !opening) return;
    try {
      await m.open.mutateAsync({ serial, reason, saleId: opening.saleId });
      toast({ title: "Reclamo abierto", variant: "success" });
      setOpening(null);
      setReason("");
    } catch (e) {
      toast({ title: "No se pudo abrir", description: serialErrorMessage(e), variant: "error" });
    }
  }

  async function updateClaim() {
    if (!editing) return;
    try {
      await m.update.mutateAsync({ id: editing.claim.id, status: editing.status, resolution });
      toast({ title: "Reclamo actualizado", variant: "success" });
      setEditing(null);
      setResolution("");
    } catch (e) {
      toast({ title: "No se pudo actualizar", description: serialErrorMessage(e), variant: "error" });
    }
  }

  const empty = data && data.sales.length === 0 && data.in_stock.length === 0 && data.claims.length === 0;

  return (
    <div className="space-y-6">
      <form onSubmit={search} className="flex max-w-md gap-2">
        <Input
          aria-label="Número de serie"
          placeholder="IMEI o número de serie"
          value={input}
          autoCapitalize="characters"
          onChange={(e) => setInput(e.target.value)}
          className="h-11"
        />
        <Button type="submit" loading={isFetching}>
          <Search size={16} /> Buscar
        </Button>
      </form>

      {error && <p className="text-sm text-danger">{serialErrorMessage(error)}</p>}

      {empty && (
        <EmptyState
          icon={ShieldAlert}
          title="No encontramos esa serie"
          description="No hay ventas ni unidades en stock con ese número. Revisá que esté bien escrito."
        />
      )}

      {data && data.sales.length > 0 && (
        <section className="space-y-3">
          {data.sales.map((s) => {
            const st = warrantyState(s, today);
            const left = daysLeft(s.warranty_until, today);
            return (
              <article key={s.line_id} className="rounded-lg bg-card p-4 ring-1 ring-border">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold">{s.product_name}</p>
                    <p className="text-xs text-muted-foreground">
                      Serie {s.serial} · Venta #{s.sale_number ?? "?"} del {fmtDate(s.sale_date)}
                      {s.store_name ? ` · ${s.store_name}` : ""}
                      {s.customer_name ? ` · ${s.customer_name}` : ""}
                    </p>
                  </div>
                  <Badge tone={STATE_TONE[st]}>{WARRANTY_STATE_LABEL[st]}</Badge>
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
                  <div>
                    <dt className="text-xs text-muted-foreground">De fábrica</dt>
                    <dd>
                      {s.manufacturer_months > 0
                        ? `${s.manufacturer_months} meses, hasta ${fmtDate(s.manufacturer_until)}`
                        : "Sin garantía de fábrica"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Extendida</dt>
                    <dd>{s.extended_label ? `${s.extended_label} (+${s.extended_months} meses)` : "No"}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Vence</dt>
                    <dd>
                      {fmtDate(s.warranty_until)}
                      {left != null && left >= 0 && st === "vigente" ? ` (quedan ${left} días)` : ""}
                    </dd>
                  </div>
                </dl>
                <Button className="mt-3" size="sm" variant="secondary" onClick={() => setOpening({ saleId: s.sale_id })}>
                  Abrir reclamo
                </Button>
              </article>
            );
          })}
        </section>
      )}

      {data && data.in_stock.length > 0 && (
        <p className="text-sm text-muted-foreground">
          En stock sin vender: {data.in_stock.map((x) => x.product_name).join(", ")}.
        </p>
      )}

      {data && data.claims.length > 0 && (
        <section className="border-t-2 border-ninja-flame pt-4">
          <h2 className="text-base font-semibold">Reclamos de esta serie</h2>
          <ul className="mt-2 divide-y divide-border text-sm">
            {data.claims.map((c) => (
              <li key={c.id} className="py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{fmtDateTime(c.created_at)}</span>
                  <span className="flex items-center gap-2">
                    {c.in_warranty ? <Badge tone="success">En garantía</Badge> : <Badge>Fuera de garantía</Badge>}
                    <Badge tone={c.status === "resolved" ? "success" : c.status === "rejected" ? "danger" : "warning"}>
                      {CLAIM_STATUS_LABEL[c.status]}
                    </Badge>
                  </span>
                </div>
                <p className="mt-1 text-muted-foreground">{c.reason}</p>
                {c.resolution && <p className="mt-1">{c.resolution}</p>}
                {canManage && nextClaimStatuses(c.status).length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {nextClaimStatuses(c.status).map((s) => (
                      <Button key={s} size="sm" variant="ghost" onClick={() => setEditing({ claim: c, status: s })}>
                        {CLAIM_STATUS_LABEL[s]}
                      </Button>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <Modal
        open={Boolean(opening)}
        onOpenChange={(o) => !o && setOpening(null)}
        title="Abrir reclamo"
        description={`Serie ${serial ?? ""}. Queda registrado si estaba en garantía al abrirlo.`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpening(null)}>
              Cancelar
            </Button>
            <Button onClick={openClaim} loading={m.open.isPending} disabled={reason.trim().length < 3}>
              Abrir
            </Button>
          </>
        }
      >
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Qué le pasa</span>
          <Input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
        </label>
      </Modal>

      <Modal
        open={Boolean(editing)}
        onOpenChange={(o) => !o && setEditing(null)}
        title={editing ? `Pasar a: ${CLAIM_STATUS_LABEL[editing.status]}` : ""}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)}>
              Cancelar
            </Button>
            <Button
              onClick={updateClaim}
              loading={m.update.isPending}
              disabled={Boolean(editing && ["resolved", "rejected"].includes(editing.status) && !resolution.trim())}
            >
              Guardar
            </Button>
          </>
        }
      >
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Resolución</span>
          <Input value={resolution} maxLength={500} onChange={(e) => setResolution(e.target.value)} />
        </label>
      </Modal>
    </div>
  );
}
