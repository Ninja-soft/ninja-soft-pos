"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Columns3, Plus, Settings2, Trash2, UserRound } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { selectCls } from "@/components/stock/transfers/shared";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import { SHIPMENT_STATUS_LABELS, mlErrorMessage } from "@/lib/mercadolibre/labels";
import {
  CLAIM_KIND_LABELS,
  CLAIM_KIND_TONE,
  URGENCY_TONE,
  autoClaimKey,
  autoSalesKey,
  dueLabel,
  effectiveStage,
  urgency,
  type AutoKey,
  type Board,
  type StageRow,
} from "@/lib/mercadolibre/postsale";
import { useTeamMembers } from "@/modules/customers/hooks";
import { getCurrentUser } from "@/lib/supabase/currentUser";
import { useMlOrders, useMlShipments, type MlAccount } from "@/modules/mercadolibre/hooks";
import { reasonTitleOf } from "@/lib/mercadolibre/claimReasons";
import { useMlClaimReasons } from "@/modules/mercadolibre/reasonHooks";
import { useMlBoard, useMlClaims, useMlGestorMutations, type MlBoardCard } from "@/modules/mercadolibre/gestorHooks";

// Embudos (H141 · ADR-132): tableros de ventas y de posventa. Cada tarjeta
// entra sola en la etapa de su estado en Mercado Libre; si alguien la mueve,
// queda donde la dejó (salvo que el caso se cierre después en ML). Se puede
// asignar a alguien del equipo. Arrastrar en la compu; "Mover a" en todos lados.

const AUTO_LABELS: Record<AutoKey, string> = {
  new: "Nueva / nuevo",
  to_prepare: "Lista para despachar",
  shipped: "Despachada",
  delivered: "Entregada",
  claim: "Con reclamo abierto",
  waiting: "Esperando al comprador o a ML",
  resolved: "Cerrada o resuelta",
};
const AUTO_BY_BOARD: Record<Board, AutoKey[]> = {
  sales: ["new", "to_prepare", "shipped", "delivered", "claim", "resolved"],
  claims: ["new", "waiting", "resolved"],
};

interface Item {
  key: string;
  title: string;
  sub: string;
  amount: number | null;
  badges: Array<{ label: string; tone: "neutral" | "warning" | "danger" | "info" | "success" | "brand" }>;
  auto: AutoKey;
  updatedAt: string | null;
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

export function MlBoardsTab({ account, canManage }: { account: MlAccount; canManage: boolean }) {
  const { toast } = useToast();
  const [board, setBoard] = useState<Board>("sales");
  const [onlyMine, setOnlyMine] = useState(false);
  const [editing, setEditing] = useState(false);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const { data, isLoading } = useMlBoard(board, account.id);
  const { data: orders = [] } = useMlOrders(account.id);
  const { data: shipments = [] } = useMlShipments(account.id);
  const { data: claims = [] } = useMlClaims(account.id, 60);
  const { index: reasons } = useMlClaimReasons();
  const { data: team = [] } = useTeamMembers();
  const { setCard } = useMlGestorMutations();
  const [me, setMe] = useState<string | null>(null);
  useEffect(() => {
    void getCurrentUser().then((u) => setMe(u?.id ?? null));
  }, []);

  const items: Item[] = useMemo(() => {
    if (board === "claims") {
      return claims.map((c) => ({
        key: String(c.claim_id),
        title: c.detail_title || reasonTitleOf(reasons, c.reason_id),
        sub: `Reclamo ${c.claim_id}${c.resource_id ? ` · venta ${c.resource_id}` : ""}${c.status === "opened" ? ` · ${dueLabel(c.due_at)}` : ""}`,
        amount: null,
        badges: [
          { label: CLAIM_KIND_LABELS[c.kind], tone: CLAIM_KIND_TONE[c.kind] },
          ...(c.status === "opened" && urgency(c.due_at) !== "ok" && urgency(c.due_at) !== "sin_plazo"
            ? [{ label: urgency(c.due_at) === "vencido" ? "Vencido" : "Vence pronto", tone: URGENCY_TONE[urgency(c.due_at)] }]
            : []),
        ],
        auto: autoClaimKey(c),
        updatedAt: c.ml_last_updated,
      }));
    }
    const since = Date.now() - 30 * 86400_000;
    const packs = new Map<string, typeof orders>();
    for (const o of orders) {
      if (o.date_created && Date.parse(o.date_created) < since) continue;
      const list = packs.get(o.pack_key) ?? [];
      list.push(o);
      packs.set(o.pack_key, list);
    }
    return [...packs.entries()].map(([pack, os]) => {
      const first = os[0]!;
      const ship = shipments.find((s) => s.pack_key === pack || (first.shipment_id != null && s.shipment_id === first.shipment_id));
      const claim = claims.find((c) => c.pack_key === pack || os.some((o) => o.ml_order_id === c.resource_id));
      const status = os.every((o) => o.status === "cancelled") ? "cancelled" : first.status;
      const lines = os.flatMap((o) => o.lines ?? []);
      return {
        key: pack,
        title: lines.map((l) => `${l.quantity ?? 1} × ${l.title ?? ""}`).join(", ").slice(0, 90) || `Venta ${pack}`,
        sub: `${first.buyer_nickname ?? "Comprador"} · ${first.date_created ? new Date(first.date_created).toLocaleDateString("es-AR") : ""}`,
        amount: os.reduce((s, o) => s + Number(o.total_amount ?? 0), 0),
        badges: [
          ...(ship ? [{ label: SHIPMENT_STATUS_LABELS[ship.status] ?? ship.status, tone: "neutral" as const }] : []),
          ...(claim && claim.status === "opened" ? [{ label: "Reclamo abierto", tone: "danger" as const }] : []),
          ...(status === "cancelled" ? [{ label: "Cancelada", tone: "neutral" as const }] : []),
        ],
        auto: autoSalesKey({ orderStatus: status, shipmentStatus: ship?.status ?? null, substatus: ship?.substatus ?? null, claimStatus: claim?.status ?? null }),
        updatedAt: claim?.ml_last_updated ?? null,
      };
    });
  }, [board, claims, orders, shipments, reasons]);

  const stages = useMemo(() => [...(data?.stages ?? [])].sort((a, b) => a.sort - b.sort), [data?.stages]);
  const cards = useMemo(() => new Map((data?.cards ?? []).map((c) => [c.ref_key, c])), [data?.cards]);
  const columns = useMemo(() => {
    const out = new Map<string, Array<Item & { card: MlBoardCard | null }>>(stages.map((s) => [s.id, []]));
    for (const it of items) {
      const card = cards.get(it.key) ?? null;
      if (onlyMine && card?.assigned_to !== me) continue;
      const st = effectiveStage(stages, it.auto, card, it.updatedAt);
      if (st) out.get(st)?.push({ ...it, card });
    }
    return out;
  }, [items, cards, stages, onlyMine, me]);

  const move = (key: string, stageId: string | null) =>
    setCard.mutate(
      { board, accountId: account.id, refKey: key, p: { stage_id: stageId } },
      { onError: (e) => toast({ title: "No se pudo mover", description: mlErrorMessage(e), variant: "error" }) },
    );
  const assign = (key: string, userId: string | null) =>
    setCard.mutate(
      { board, accountId: account.id, refKey: key, p: { assigned_to: userId } },
      { onError: (e) => toast({ title: "No se pudo asignar", description: mlErrorMessage(e), variant: "error" }) },
    );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          size="sm"
          value={board}
          onChange={setBoard}
          aria-label="Tablero"
          options={[
            { value: "sales", label: "Ventas" },
            { value: "claims", label: "Posventa" },
          ]}
        />
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={onlyMine} onCheckedChange={(v) => setOnlyMine(Boolean(v))} />
          Sólo las mías
        </label>
        {canManage && (
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)} disabled={!data}>
            <Settings2 size={15} /> Etapas
          </Button>
        )}
      </div>

      {isLoading ? (
        <SpinnerBlock className="py-16" />
      ) : items.length === 0 ? (
        <EmptyState
          icon={Columns3}
          title={board === "sales" ? "Todavía no hay ventas de Mercado Libre en los últimos 30 días" : "No hay casos de posventa"}
          description="Cada venta o reclamo entra solo en la etapa que corresponde. Movelos a mano cuando avances y asignalos a alguien del equipo."
        />
      ) : (
        <div className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0" role="list" aria-label="Etapas">
          {stages.map((s) => {
            const col = columns.get(s.id) ?? [];
            return (
              <section
                key={s.id}
                role="listitem"
                aria-label={`${s.name}: ${col.length}`}
                className={cn("flex w-72 shrink-0 snap-start flex-col gap-2 rounded-xl bg-muted/60 p-2", dragKey && "outline-dashed outline-1 outline-border")}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const key = e.dataTransfer.getData("text/plain");
                  setDragKey(null);
                  if (key) move(key, s.id);
                }}
              >
                <header className="flex items-center justify-between px-1">
                  <h3 className="text-sm font-semibold">{s.name}</h3>
                  <span className="rounded-md bg-card px-1.5 text-xs tabular-nums text-muted-foreground">{col.length}</span>
                </header>
                {col.map((it) => {
                  const assigned = team.find((t) => t.user_id === it.card?.assigned_to);
                  return (
                    <article
                      key={it.key}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData("text/plain", it.key);
                        setDragKey(it.key);
                      }}
                      onDragEnd={() => setDragKey(null)}
                      className="space-y-2 rounded-lg bg-card p-3"
                    >
                      <div className="flex flex-wrap gap-1">
                        {it.badges.map((b, i) => (
                          <Badge key={i} tone={b.tone}>
                            {b.label}
                          </Badge>
                        ))}
                        {it.card?.stage_id && <Badge tone="neutral">Movida a mano</Badge>}
                      </div>
                      <p className="line-clamp-2 text-sm font-medium">{it.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {it.sub}
                        {it.amount != null ? ` · ${formatCurrency(it.amount)}` : ""}
                      </p>
                      <div className="flex items-center gap-2">
                        <select
                          className={cn(selectCls, "h-8 flex-1 text-xs")}
                          value={it.card?.stage_id ?? ""}
                          aria-label="Mover a"
                          onChange={(e) => move(it.key, e.target.value || null)}
                        >
                          <option value="">Automática</option>
                          {stages.map((x) => (
                            <option key={x.id} value={x.id}>
                              Mover a: {x.name}
                            </option>
                          ))}
                        </select>
                        <label className="relative">
                          <span className="sr-only">Asignar</span>
                          <span
                            className="flex h-8 w-8 items-center justify-center rounded-md bg-muted text-[11px] font-semibold"
                            title={assigned ? `Asignada a ${assigned.name}` : "Sin asignar"}
                          >
                            {assigned ? initials(assigned.name) : <UserRound size={14} className="text-muted-foreground" />}
                          </span>
                          <select
                            className="absolute inset-0 cursor-pointer opacity-0"
                            value={it.card?.assigned_to ?? ""}
                            aria-label="Asignar a"
                            onChange={(e) => assign(it.key, e.target.value || null)}
                          >
                            <option value="">Sin asignar</option>
                            {team.map((t) => (
                              <option key={t.user_id} value={t.user_id}>
                                {t.name}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                    </article>
                  );
                })}
              </section>
            );
          })}
        </div>
      )}

      {editing && data && <StagesEditor board={board} stages={stages} onClose={() => setEditing(false)} />}
    </div>
  );
}

function StagesEditor({ board, stages, onClose }: { board: Board; stages: StageRow[]; onClose: () => void }) {
  const { toast } = useToast();
  const { saveStages } = useMlGestorMutations();
  const [rows, setRows] = useState(stages.map((s) => ({ id: s.id as string | undefined, name: s.name, auto_key: s.auto_key, is_final: s.is_final })));
  const autos = rows.map((r) => r.auto_key).filter(Boolean);
  const dup = autos.length !== new Set(autos).size;
  const invalid = rows.length === 0 || rows.some((r) => !r.name.trim()) || dup;
  const set = (i: number, p: Partial<(typeof rows)[number]>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const swap = (i: number, j: number) =>
    setRows((rs) => {
      const n = [...rs];
      [n[i], n[j]] = [n[j]!, n[i]!];
      return n;
    });

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Etapas del tablero de ${board === "sales" ? "ventas" : "posventa"}`}
      description="Cada etapa puede recibir sola las tarjetas de un estado de Mercado Libre. Las que saques vuelven a su etapa automática."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={invalid}
            loading={saveStages.isPending}
            onClick={() =>
              saveStages.mutate(
                { board, stages: rows.map((r) => ({ ...(r.id ? { id: r.id } : {}), name: r.name.trim(), auto_key: r.auto_key, is_final: r.is_final })) },
                {
                  onSuccess: () => {
                    toast({ title: "Etapas guardadas", variant: "success" });
                    onClose();
                  },
                  onError: (e) => toast({ title: "No se pudo guardar", description: mlErrorMessage(e), variant: "error" }),
                },
              )
            }
          >
            Guardar
          </Button>
        </div>
      }
    >
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="grid gap-2 rounded-lg bg-muted p-2 sm:grid-cols-[1fr_12rem_auto]">
            <Input aria-label="Nombre de la etapa" value={r.name} maxLength={40} onChange={(e) => set(i, { name: e.target.value })} />
            <select className={selectCls} value={r.auto_key ?? ""} aria-label="Recibe sola" onChange={(e) => set(i, { auto_key: (e.target.value || null) as AutoKey | null })}>
              <option value="">Sólo a mano</option>
              {AUTO_BY_BOARD[board].map((k) => (
                <option key={k} value={k}>
                  Recibe: {AUTO_LABELS[k]}
                </option>
              ))}
            </select>
            <div className="flex items-center gap-1">
              <label className="flex items-center gap-1 text-xs">
                <Checkbox checked={r.is_final} onCheckedChange={(v) => set(i, { is_final: Boolean(v) })} /> Final
              </label>
              <Button variant="ghost" size="sm" aria-label="Subir" disabled={i === 0} onClick={() => swap(i, i - 1)}>
                <ArrowUp size={14} />
              </Button>
              <Button variant="ghost" size="sm" aria-label="Bajar" disabled={i === rows.length - 1} onClick={() => swap(i, i + 1)}>
                <ArrowDown size={14} />
              </Button>
              <Button variant="ghost" size="sm" aria-label="Quitar" disabled={rows.length === 1} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
                <Trash2 size={14} />
              </Button>
            </div>
          </div>
        ))}
        {dup && <p className="text-xs text-danger">Cada estado automático puede ir a una sola etapa.</p>}
        <Button variant="secondary" size="sm" disabled={rows.length >= 12} onClick={() => setRows((rs) => [...rs, { id: undefined, name: "Nueva etapa", auto_key: null, is_final: false }])}>
          <Plus size={15} /> Agregar etapa
        </Button>
      </div>
    </Modal>
  );
}
