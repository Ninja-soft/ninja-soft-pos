"use client";

// Acciones de Expedición de L5 (ADR-165): rotura al armar o cargar (merma
// con foto y motivo), entrega parcial en el mostrador, resolver lo que quedó
// pendiente (reprogramar o dar por resuelto con la devolución) y pedir stock a
// otra sucursal con un traslado enlazado a la entrega.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { selectCls } from "@/components/stock/transfers/shared";
import { DamageFields, OutcomeForm } from "@/components/logistics/expedition/OutcomeForm";
import type { PhotoValue } from "@/components/logistics/PhotoInput";
import { cn } from "@/lib/utils/cn";
import {
  DEFAULT_EXPEDITION_SETTINGS,
  expeditionErrorMessage,
  itemOpenQty,
  outcomeLines,
  outcomePayload,
  outcomePlan,
  outcomeProblem,
  outcomeSummary,
  type DamageReason,
  type OutcomeLine,
} from "@/lib/logistics/expedition";
import { expeditionApi, useExpeditionMutations, useExpeditionSettings, useStockStatus } from "@/modules/logistics/expedition";
import { useMyTenant } from "@/modules/tenants/hooks";
import type { Dispatch, DispatchPartItem } from "@/modules/orders/api";

const fmt = (n: number) => n.toLocaleString("es-AR", { maximumFractionDigits: 3 });
const itemName = (i: DispatchPartItem) => (i.variant_label ? `${i.product_name} (${i.variant_label})` : i.product_name);

async function uploadAll(tenantId: string, dispatchId: string, photos: PhotoValue[]): Promise<string[]> {
  const out: string[] = [];
  for (const p of photos) out.push(await expeditionApi.uploadDispatchPhoto(tenantId, dispatchId, p.blob, p.type));
  return out;
}

// ── Rotura al armar o al cargar ─────────────────────────────────────────────

export function DamageModal({ dispatch, onClose }: { dispatch: Dispatch | null; onClose: () => void }) {
  const { toast } = useToast();
  const { data: me } = useMyTenant();
  const { data: settings = DEFAULT_EXPEDITION_SETTINGS } = useExpeditionSettings(Boolean(dispatch));
  const m = useExpeditionMutations();
  const [qty, setQty] = useState<Record<string, number>>({});
  const [reason, setReason] = useState<DamageReason | null>(null);
  const [note, setNote] = useState("");
  const [photos, setPhotos] = useState<PhotoValue[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setQty({});
    setReason(null);
    setNote("");
    setPhotos([]);
  }, [dispatch]);
  if (!dispatch) return null;
  const items = (dispatch.items ?? []).filter((i) => i.id && i.qty > 0);
  const total = Object.values(qty).reduce((a, b) => a + b, 0);
  const problem =
    total <= 0
      ? "Marcá cuánto se rompió."
      : !reason
        ? "Elegí qué le pasó."
        : reason === "otro" && note.trim().length < 3
          ? "Contá qué pasó."
          : settings.damage_requires_photo && photos.length === 0
            ? "Sacale una foto."
            : null;

  async function submit() {
    if (!dispatch || !me?.tenantId || !reason) return;
    setBusy(true);
    try {
      const paths = await uploadAll(me.tenantId, dispatch.id, photos);
      await m.damageReport.mutateAsync({
        dispatchId: dispatch.id,
        stage: dispatch.status === "listo" ? "carga" : "armado",
        items: Object.entries(qty)
          .filter(([, q]) => q > 0)
          .map(([item_id, q]) => ({ item_id, qty: q })),
        reason,
        note: note.trim() || null,
        photoPaths: paths,
      });
      toast({
        title: "Rotura registrada",
        description:
          settings.damaged_destination === "deposito"
            ? "Lo roto pasó al depósito de merma. La entrega sigue igual: reponelo del stock."
            : "Se dio de baja como merma. La entrega sigue igual: reponelo del stock.",
        variant: "success",
      });
      onClose();
    } catch (e) {
      toast({ title: "No se pudo registrar", description: expeditionErrorMessage(e), variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Algo se rompió: entrega N° ${dispatch.number}`}
      description="Lo roto se descuenta del stock como merma con su foto y motivo. La entrega no cambia: se arma con otro del stock."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Volver
          </Button>
          <Button onClick={() => void submit()} disabled={Boolean(problem)} loading={busy}>
            Registrar la rotura
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <ul className="space-y-2">
          {items.map((i) => (
            <li key={i.id} className="flex items-center justify-between gap-3">
              <span className="min-w-0 text-sm">
                {itemName(i)} <span className="text-xs text-muted-foreground">(lleva {fmt(i.qty)})</span>
              </span>
              <input
                aria-label={`Rotos de ${itemName(i)}`}
                type="number"
                min={0}
                max={i.qty}
                step="1"
                value={qty[i.id!] ?? 0}
                onChange={(e) => setQty((x) => ({ ...x, [i.id!]: Math.max(0, Math.min(i.qty, Number(e.target.value) || 0)) }))}
                className="h-11 w-20 rounded-lg border border-input bg-background px-2 text-center text-base"
              />
            </li>
          ))}
        </ul>
        <DamageFields
          reason={reason}
          onReason={setReason}
          note={note}
          onNote={setNote}
          photos={photos}
          onPhotos={setPhotos}
          photoRequired={settings.damage_requires_photo}
        />
        {problem && total > 0 && <p className="text-sm text-warning">{problem}</p>}
      </div>
    </Modal>
  );
}
DamageModal.displayName = "DamageModal";

// ── Entrega parcial en el mostrador ─────────────────────────────────────────

export function PartialDeliverModal({ dispatch, onClose }: { dispatch: Dispatch | null; onClose: () => void }) {
  const { toast } = useToast();
  const { data: me } = useMyTenant();
  const { data: settings = DEFAULT_EXPEDITION_SETTINGS } = useExpeditionSettings(Boolean(dispatch));
  const m = useExpeditionMutations();
  const [lines, setLines] = useState<OutcomeLine[]>([]);
  const [to, setTo] = useState("");
  const [reason, setReason] = useState<DamageReason | null>(null);
  const [note, setNote] = useState("");
  const [photos, setPhotos] = useState<PhotoValue[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setLines(outcomeLines((dispatch?.items ?? []).filter((i) => i.id).map((i) => ({ id: i.id!, name: itemName(i), qty: i.qty }))));
    setTo(dispatch?.pickup_name ?? dispatch?.customer_name ?? "");
    setReason(null);
    setNote("");
    setPhotos([]);
  }, [dispatch]);
  if (!dispatch) return null;
  const needsName = dispatch.delivery_type === "retiro";
  const damaged = lines.some((l) => l.damaged > 0);
  const plan = outcomePlan(lines, settings);
  const nameOf = (id: string) => lines.find((l) => l.itemId === id)?.name ?? "";
  const problem =
    outcomeProblem(lines, { settings, photos: photos.length, reason, note, mustDeliver: true }) ??
    (needsName && to.trim().length < 2 ? "Cargá quién retira." : null);

  async function submit() {
    if (!dispatch || !me?.tenantId) return;
    setBusy(true);
    try {
      const paths = damaged ? await uploadAll(me.tenantId, dispatch.id, photos) : [];
      const r = await m.partialDeliver.mutateAsync({
        dispatchId: dispatch.id,
        items: outcomePayload(lines),
        deliveredTo: to.trim() || null,
        damageReason: damaged ? reason : null,
        damageNote: damaged ? note.trim() || null : null,
        photoPaths: paths,
      });
      toast({
        title: `Entrega N° ${dispatch.number}: ${r.complete ? "entregada" : "entregada en parte"}`,
        description: r.child
          ? `Lo pendiente sigue en la entrega N° ${r.child.number}.`
          : r.issue_open
            ? "Lo que no se llevó quedó en Con problemas para resolver."
            : undefined,
        variant: "success",
      });
      onClose();
    } catch (e) {
      toast({ title: "No se pudo entregar", description: expeditionErrorMessage(e), variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Entrega parcial: N° ${dispatch.number}`}
      description="Marcá lo que se lleva, lo que está roto y lo que no quiere. Lo roto se da de baja como merma."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Volver
          </Button>
          <Button onClick={() => void submit()} disabled={Boolean(problem)} loading={busy}>
            Entregar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <OutcomeForm lines={lines} onChange={setLines} />
        {damaged && (
          <DamageFields
            reason={reason}
            onReason={setReason}
            note={note}
            onNote={setNote}
            photos={photos}
            onPhotos={setPhotos}
            photoRequired={settings.damage_requires_photo}
          />
        )}
        <Input label={needsName ? "Retira" : "Entregado a (opcional)"} value={to} onChange={(e) => setTo(e.target.value)} maxLength={120} />
        <p className="text-sm text-muted-foreground">{outcomeSummary(lines)}</p>
        {plan.child.length > 0 && (
          <p className="text-xs text-muted-foreground">Sale una entrega nueva con {plan.child.map((c) => `${fmt(c.qty)} ${nameOf(c.itemId)}`).join(", ")}.</p>
        )}
        {plan.open.length > 0 && (
          <p className="text-xs text-muted-foreground">Queda en Con problemas: {plan.open.map((c) => `${fmt(c.qty)} ${nameOf(c.itemId)}`).join(", ")}.</p>
        )}
        {problem && <p className="text-sm text-warning">{problem}</p>}
      </div>
    </Modal>
  );
}
PartialDeliverModal.displayName = "PartialDeliverModal";

// ── Resolver lo pendiente ───────────────────────────────────────────────────

export function ResolveIssueModal({ dispatch, onClose }: { dispatch: Dispatch | null; onClose: () => void }) {
  const { toast } = useToast();
  const m = useExpeditionMutations();
  const [action, setAction] = useState<"reprogramar" | "resuelto">("reprogramar");
  const [note, setNote] = useState("");
  const [qty, setQty] = useState<Record<string, number>>({});
  const open = useMemo(
    () => (dispatch?.items ?? []).filter((i) => i.id && itemOpenQty(i) > 0).map((i) => ({ i, open: itemOpenQty(i) })),
    [dispatch],
  );
  useEffect(() => {
    setAction("reprogramar");
    setNote("");
    setQty(Object.fromEntries(open.map((x) => [x.i.id!, x.open])));
  }, [open]);
  if (!dispatch) return null;
  const items = Object.entries(qty)
    .filter(([, q]) => q > 0)
    .map(([item_id, q]) => ({ item_id, qty: q }));
  const problem = items.length === 0 ? "Elegí qué resolver." : action === "resuelto" && note.trim().length < 3 ? "Contá cómo se resolvió." : null;

  async function submit() {
    if (!dispatch) return;
    try {
      const r = await m.resolve.mutateAsync({ dispatchId: dispatch.id, action, items, note: note.trim() || null });
      toast({
        title: action === "reprogramar" ? `Reprogramado en la entrega N° ${r.child?.number ?? ""}` : "Marcado como resuelto",
        description: action === "reprogramar" ? "Está en Pendientes para armarlo de nuevo." : undefined,
        variant: "success",
      });
      onClose();
    } catch (e) {
      toast({ title: "No se pudo resolver", description: expeditionErrorMessage(e), variant: "error" });
    }
  }

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Resolver: entrega N° ${dispatch.number}`}
      description={dispatch.issue_summary ?? "Quedó algo sin entregar."}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Volver
          </Button>
          <Button onClick={() => void submit()} disabled={Boolean(problem)} loading={m.resolve.isPending}>
            {action === "reprogramar" ? "Reprogramar" : "Marcar resuelto"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Segmented<"reprogramar" | "resuelto">
          aria-label="Qué hacer"
          value={action}
          onChange={setAction}
          options={[
            { value: "reprogramar", label: "Volver a enviar" },
            { value: "resuelto", label: "Ya se resolvió" },
          ]}
        />
        <ul className="space-y-2">
          {open.map(({ i, open: max }) => (
            <li key={i.id} className="flex items-center justify-between gap-3">
              <span className="min-w-0 text-sm">
                {itemName(i)}
                <span className="block text-xs text-muted-foreground">
                  {[
                    i.qty_damaged ? `${fmt(i.qty_damaged)} roto` : null,
                    i.qty_rejected ? `${fmt(i.qty_rejected)} rechazado` : null,
                    i.qty_missing ? `${fmt(i.qty_missing)} sin entregar` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}{" "}
                  · pendiente {fmt(max)}
                </span>
              </span>
              <input
                aria-label={`Cantidad de ${itemName(i)}`}
                type="number"
                min={0}
                max={max}
                value={qty[i.id!] ?? 0}
                onChange={(e) => setQty((x) => ({ ...x, [i.id!]: Math.max(0, Math.min(max, Number(e.target.value) || 0)) }))}
                className="h-11 w-20 rounded-lg border border-input bg-background px-2 text-center text-base"
              />
            </li>
          ))}
        </ul>
        {action === "resuelto" ? (
          <>
            <Input label="Cómo se resolvió" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="Por ejemplo: devolución hecha en la caja" />
            <p className="text-xs text-muted-foreground">
              Si el cliente no lo va a recibir, hacé la devolución de la venta en{" "}
              <Link href={"/devoluciones" as Route} className="font-semibold text-foreground underline-offset-2 hover:underline">
                Devoluciones
              </Link>
              : devuelve la plata y vuelve a sumar el stock de lo que no se entregó.
            </p>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">Se crea una entrega nueva con esto, en Pendientes. Lo roto se arma con otro del stock.</p>
        )}
        {problem && items.length > 0 && <p className="text-sm text-warning">{problem}</p>}
      </div>
    </Modal>
  );
}
ResolveIssueModal.displayName = "ResolveIssueModal";

// ── Pedir stock a otra sucursal ─────────────────────────────────────────────

export function RequestStockModal({ dispatch, onClose }: { dispatch: Dispatch | null; onClose: () => void }) {
  const { toast } = useToast();
  const m = useExpeditionMutations();
  const q = useStockStatus(dispatch?.id ?? null);
  const [origin, setOrigin] = useState("");
  const [qty, setQty] = useState<Record<string, number>>({});
  const [notes, setNotes] = useState("");
  const origins = useMemo(() => {
    const map = new Map<string, { id: string; name: string; covers: number }>();
    for (const i of q.data?.items ?? []) {
      for (const s of i.stores) {
        const o = map.get(s.store_id) ?? { id: s.store_id, name: s.name, covers: 0 };
        if (s.qty >= Math.max(i.shortage, 1)) o.covers++;
        map.set(s.store_id, o);
      }
    }
    return [...map.values()].sort((a, b) => b.covers - a.covers);
  }, [q.data]);
  useEffect(() => {
    if (!q.data) return;
    setQty(Object.fromEntries(q.data.items.filter((i) => i.transferable).map((i) => [i.item_id, i.shortage])));
    setOrigin((o) => o || origins[0]?.id || "");
  }, [q.data, origins]);
  if (!dispatch) return null;
  const items = Object.entries(qty)
    .filter(([, n]) => n > 0)
    .map(([item_id, n]) => ({ item_id, qty: n }));

  async function submit() {
    if (!dispatch) return;
    try {
      const r = await m.requestStock.mutateAsync({ dispatchId: dispatch.id, originStoreId: origin, items, notes: notes.trim() || null });
      toast({
        title: `Traslado R-${String(r.number).padStart(6, "0")} pedido`,
        description:
          r.status === "pending_approval"
            ? "Espera la aprobación del dueño. La entrega queda esperando stock."
            : "Cuando la sucursal lo reciba, la entrega deja de esperar sola.",
        variant: "success",
      });
      onClose();
    } catch (e) {
      toast({ title: "No se pudo pedir", description: expeditionErrorMessage(e, "Pedir stock a otra sucursal es de un dueño o encargado."), variant: "error" });
    }
  }

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Pedir stock: entrega N° ${dispatch.number}`}
      description="Arma un traslado desde otra sucursal con lo que falta. Sigue las reglas de Traslados (quién puede y aprobación)."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Volver
          </Button>
          <Button onClick={() => void submit()} disabled={!origin || items.length === 0} loading={m.requestStock.isPending}>
            Pedir el traslado
          </Button>
        </>
      }
    >
      {q.isLoading || !q.data ? (
        <Skeleton className="h-40 rounded-lg" />
      ) : (
        <div className="space-y-4">
          {q.data.awaiting_transfer && (
            <p className="rounded-lg bg-info/10 px-3 py-2 text-sm text-info">
              Ya hay un traslado pedido (R-{String(q.data.awaiting_transfer.number).padStart(6, "0")}).
            </p>
          )}
          <ul className="space-y-3">
            {q.data.items.map((i) => (
              <li key={i.item_id} className="rounded-lg bg-muted/30 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">{i.name}</p>
                    <p className={cn("text-xs", i.shortage > 0 ? "text-danger" : "text-muted-foreground")}>
                      Lleva {fmt(i.qty)} · {i.shortage > 0 ? `faltan ${fmt(i.shortage)}` : "hay stock acá"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {i.stores.length ? i.stores.map((s) => `${s.name}: ${fmt(s.qty)}`).join(" · ") : "Sin stock en otras sucursales"}
                    </p>
                  </div>
                  {i.transferable ? (
                    <input
                      aria-label={`Pedir de ${i.name}`}
                      type="number"
                      min={0}
                      max={i.qty}
                      value={qty[i.item_id] ?? 0}
                      onChange={(e) => setQty((x) => ({ ...x, [i.item_id]: Math.max(0, Math.min(i.qty, Number(e.target.value) || 0)) }))}
                      className="h-11 w-20 shrink-0 rounded-lg border border-input bg-background px-2 text-center text-base"
                    />
                  ) : (
                    <span className="shrink-0 text-xs text-muted-foreground">No se traslada</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <div>
            <label htmlFor="rq-origin" className="mb-1 block text-sm font-medium">
              Desde
            </label>
            <select id="rq-origin" className={cn(selectCls, "h-11 w-full")} value={origin} onChange={(e) => setOrigin(e.target.value)}>
              <option value="" disabled className="bg-popover text-popover-foreground">
                Elegí la sucursal
              </option>
              {origins.map((o) => (
                <option key={o.id} value={o.id} className="bg-popover text-popover-foreground">
                  {o.name}
                </option>
              ))}
            </select>
            {origins.length === 0 && <p className="mt-1 text-xs text-muted-foreground">Ninguna otra sucursal tiene estos productos.</p>}
          </div>
          <Input label="Nota para la otra sucursal (opcional)" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} />
        </div>
      )}
    </Modal>
  );
}
RequestStockModal.displayName = "RequestStockModal";
