"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Clock, Hourglass, Pause, Pencil, Play, Trash2, UserRound } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { initials, money } from "@/components/pos/ui/posStyles";
import { formatQty } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";
import { useProductsByIds } from "@/modules/products/hooks";
import { useTeamMembers } from "@/modules/customers/hooks";
import {
  pausedBadges,
  pausedExpiry,
  pausedPreview,
  pausedTimeLabel,
  pausedTitle,
  type PausedExpiry,
  type PausedPayment,
  type PausedPreviewLine,
  type PausedSale,
} from "@/modules/paused-sales/logic";
import { DiscardPausedDialog } from "./PausedSaleDialogs";

// Lista de ventas pausadas (ADR-106, rediseño de ADR-108): cada pausada es una
// tarjeta con su cliente, lo que lleva (fotos, cantidades y subtotales), el
// total, la hora, quién la pausó y cuánto falta para que venza a las 24 h.
// Sin sombras, gradientes ni bordes de color: tokens del tema.

const METHOD_LABEL: Record<string, string> = {
  cash: "Efectivo",
  debit: "Débito",
  credit: "Crédito",
  qr: "QR",
  transfer: "Transferencia",
  account: "Cuenta corriente",
  store_credit: "Saldo a favor",
};

const STATUS_LABEL: Partial<Record<PausedPayment["status"], string>> = {
  pending: "esperando el pago",
  approved: "cobrado",
  rejected: "rechazado",
  cancelled: "cancelado",
  expired: "vencido",
};

function paymentText(p: PausedPayment): string {
  const title = typeof p.line?.title === "string" ? (p.line.title as string) : (METHOD_LABEL[p.method] ?? p.method);
  const st = p.kind === "intent" ? STATUS_LABEL[p.status] : null;
  return `${title} ${money(p.amount)}${st ? ` (${st})` : ""}`;
}

function qtyText(l: PausedPreviewLine): string {
  return l.unit === "un" ? `x${formatQty(l.quantity)}` : `${formatQty(l.quantity)} ${l.unit}`;
}

// ── Nombre o nota editable, sutil ────────────────────────────────────────────
function LabelEditor({ sale, onRename }: { sale: PausedSale; onRename: (s: PausedSale, label: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(sale.label ?? "");
  const input = useRef<HTMLInputElement>(null);
  const closing = useRef(false);
  useEffect(() => {
    if (!editing) setValue(sale.label ?? "");
  }, [sale.label, editing]);
  useEffect(() => {
    if (editing) {
      closing.current = false;
      input.current?.select();
    }
  }, [editing]);

  const title = pausedTitle(sale);
  // Si el nombre repite al cliente, no suma: se invita a poner una nota.
  const customer = (sale.customer_name ?? sale.cart.customer?.name ?? "").trim();
  const label = (sale.label ?? "").trim();
  const shown = label && label !== customer ? label : null;
  function commit() {
    if (closing.current) return;
    closing.current = true;
    setEditing(false);
    if (value.trim() !== label) onRename(sale, value);
  }

  if (editing) {
    return (
      <input
        ref={input}
        value={value}
        maxLength={60}
        autoFocus
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            e.stopPropagation();
            setValue(sale.label ?? "");
            setEditing(false);
          }
        }}
        placeholder="Nombre o nota (ej.: señora de rojo)"
        aria-label="Nombre de la venta pausada"
        className="h-8 w-full min-w-0 rounded-md border border-border bg-background px-2 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
      />
    );
  }
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="group -mx-1 flex h-8 max-w-full items-center gap-1.5 rounded-md px-1 text-left text-[13px] text-muted-foreground outline-none transition-colors hover:bg-fg-6 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
      aria-label={`Cambiar el nombre: ${title}`}
      title="Cambiar el nombre o agregar una nota"
    >
      <span className={cn("truncate", !shown && "opacity-80")}>{shown ?? "Agregar nombre o nota"}</span>
      <Pencil size={13} className="shrink-0 opacity-70 group-hover:opacity-100" aria-hidden />
    </button>
  );
}

// ── Cliente ──────────────────────────────────────────────────────────────────
function CustomerHead({ sale }: { sale: PausedSale }) {
  const name = (sale.customer_name ?? sale.cart.customer?.name ?? "").trim();
  if (name) {
    return (
      <div className="flex min-w-0 items-center gap-3">
        <Avatar name={name} size={40} />
        <p className="truncate text-[15px] font-semibold leading-tight text-foreground">{name}</p>
      </div>
    );
  }
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-fg-6 text-muted-foreground" aria-hidden>
        <UserRound size={18} />
      </span>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        <p className="truncate text-[15px] font-semibold leading-tight text-muted-foreground">Consumidor final</p>
        <Badge tone="neutral">Sin cliente</Badge>
      </div>
    </div>
  );
}

// ── Contenido ────────────────────────────────────────────────────────────────
function Thumb({ name, src }: { name: string; src: string | null }) {
  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt=""
        width={36}
        height={36}
        loading="lazy"
        decoding="async"
        className="h-9 w-9 shrink-0 rounded-md bg-fg-6 object-cover"
      />
    );
  }
  return (
    <span
      className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-fg-6 text-[11px] font-semibold text-muted-foreground"
      aria-hidden
    >
      {initials(name) || "·"}
    </span>
  );
}

function LineRow({ line, image }: { line: PausedPreviewLine; image: string | null }) {
  return (
    <li className="flex items-center gap-3 py-1.5">
      <Thumb name={line.name} src={image} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium leading-tight text-foreground">{line.name}</p>
        {line.detail && <p className="truncate text-[11px] leading-tight text-muted-foreground">{line.detail}</p>}
      </div>
      <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">{qtyText(line)}</span>
      <span className="w-20 shrink-0 text-right font-price text-[13px] tabular-nums text-foreground">
        {money(line.subtotal)}
      </span>
    </li>
  );
}

function Contents({ sale, images }: { sale: PausedSale; images: Map<string, string> }) {
  const [open, setOpen] = useState(false);
  const { shown, hidden } = useMemo(() => pausedPreview(sale.cart.lines, 3), [sale.cart.lines]);
  if (shown.length === 0) {
    return <p className="text-[13px] text-muted-foreground">Sin productos cargados.</p>;
  }
  const img = (l: PausedPreviewLine) => (l.productId ? (images.get(l.productId) ?? null) : null);
  return (
    <div>
      <ul className="divide-y divide-border/60">
        {shown.map((l) => (
          <LineRow key={l.lineId} line={l} image={img(l)} />
        ))}
        {open && hidden.map((l) => <LineRow key={l.lineId} line={l} image={img(l)} />)}
      </ul>
      {hidden.length > 0 && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="mt-1 flex h-8 items-center gap-1 rounded-md px-1 text-[12px] font-semibold text-ninja-flameSoft transition-colors hover:bg-fg-6"
        >
          <ChevronDown size={14} className={cn("transition-transform", open && "rotate-180")} aria-hidden />
          {open ? "Ver menos" : `+${hidden.length} ${hidden.length === 1 ? "producto más" : "productos más"}`}
        </button>
      )}
    </div>
  );
}

// ── Vencimiento ──────────────────────────────────────────────────────────────
function ExpiryChip({ expiry }: { expiry: PausedExpiry }) {
  if (expiry.kind === "held") {
    return (
      <Badge tone="danger" className="gap-1">
        <Hourglass size={12} aria-hidden /> Venció
      </Badge>
    );
  }
  if (expiry.kind === "soon") {
    return (
      <Badge tone="warning" className="gap-1">
        <Hourglass size={12} aria-hidden /> {expiry.label}
      </Badge>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[12px] text-muted-foreground">
      <Hourglass size={12} aria-hidden /> {expiry.label}
    </span>
  );
}

export function PausedSalesPanel({
  list,
  busyId,
  role,
  currentUserId,
  onResume,
  onRename,
  onDiscard,
}: {
  list: PausedSale[];
  busyId: string | null;
  role: string | null;
  currentUserId: string | null;
  onResume: (s: PausedSale) => void;
  onRename: (s: PausedSale, label: string) => void;
  onDiscard: (s: PausedSale, reason: string | null, refundConfirmed: boolean) => Promise<boolean>;
}) {
  const [discarding, setDiscarding] = useState<PausedSale | null>(null);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(t);
  }, []);

  // Fotos de los productos de todas las pausadas (una consulta).
  const productIds = useMemo(
    () => [...new Set(list.flatMap((s) => s.cart.lines.map((l) => l.productId).filter((x): x is string => Boolean(x))))],
    [list],
  );
  const { data: products } = useProductsByIds(productIds);
  const images = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of products ?? []) if (p.image_url) m.set(p.id, p.image_url);
    return m;
  }, [products]);
  const { data: team } = useTeamMembers(list.length > 0);
  const who = (id: string | null) => {
    if (!id) return null;
    if (id === currentUserId) return "vos";
    return team?.find((m) => m.user_id === id)?.name ?? null;
  };

  if (list.length === 0) {
    return (
      <EmptyState
        icon={Pause}
        title="No hay ventas pausadas"
        description="Pausá una venta con el botón Pausar (o Shift + F8) para atender a otro cliente y retomarla después. Se guardan 24 horas."
      />
    );
  }

  return (
    <>
      <p className="mb-3 text-[13px] text-muted-foreground">
        {list.length} {list.length === 1 ? "venta pausada" : "ventas pausadas"}. Se borran solas 24 horas después de
        pausarlas, salvo las que tienen pagos.
      </p>
      <ul className="space-y-3">
        {list.map((s) => {
          const badges = pausedBadges(s);
          const expiry = pausedExpiry(s, now);
          const inUse = s.status === "resumed" && s.resumed_by !== currentUserId;
          const by = who(s.created_by);
          const lines = s.cart.lines.length;
          return (
            <li
              key={s.id}
              className={cn(
                "rounded-xl border border-border bg-fg-4 p-3 sm:p-4",
                expiry.kind === "soon" && "bg-warning/5",
                expiry.kind === "held" && "bg-danger/5",
              )}
            >
              {/* Cliente, nombre y total */}
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1 space-y-0.5">
                  <CustomerHead sale={s} />
                  <div className="pl-[52px]">
                    <LabelEditor sale={s} onRename={onRename} />
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <p className="font-price text-xl font-bold leading-tight tabular-nums text-foreground">{money(s.total)}</p>
                  <p className="text-[12px] tabular-nums text-muted-foreground">
                    {lines} {lines === 1 ? "producto" : "productos"}
                  </p>
                </div>
              </div>

              {/* Lo que lleva */}
              <div className="mt-3 border-t border-border pt-2">
                <Contents sale={s} images={images} />
              </div>

              {/* Hora, quién y vencimiento */}
              <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-t border-border pt-2.5">
                <span className="inline-flex min-w-0 items-center gap-1 text-[12px] text-muted-foreground">
                  <Clock size={12} aria-hidden />
                  <span className="tabular-nums">Pausada {pausedTimeLabel(s.paused_at, now)}</span>
                  {by && <span className="truncate">· por {by}</span>}
                </span>
                <ExpiryChip expiry={expiry} />
              </div>

              {expiry.kind === "held" && (
                <p className="mt-2 text-[12px] leading-snug text-danger">
                  Pasaron 24 horas pero tiene pagos: retomala para terminar el cobro o descartala devolviendo lo cobrado.
                </p>
              )}

              {(badges.length > 0 || s.carry_over) && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {s.carry_over && <Badge tone="neutral">Pasa a la próxima apertura</Badge>}
                  {badges.map((b) => (
                    <Badge key={b.text} tone={b.tone}>
                      {b.text}
                    </Badge>
                  ))}
                </div>
              )}
              {s.payments.length > 0 && (
                <p className="mt-1.5 text-[12px] text-muted-foreground">Pagos: {s.payments.map(paymentText).join(", ")}</p>
              )}

              {/* Acciones */}
              <div className="mt-3 grid grid-cols-[auto_1fr] gap-2">
                <Button
                  variant="ghost"
                  onClick={() => setDiscarding(s)}
                  disabled={Boolean(busyId)}
                  aria-label={`Descartar ${pausedTitle(s)}`}
                  className="text-muted-foreground hover:text-danger"
                >
                  <Trash2 size={16} aria-hidden /> Descartar
                </Button>
                <Button
                  onClick={() => onResume(s)}
                  loading={busyId === s.id}
                  disabled={Boolean(busyId) || (inUse && role !== "owner" && role !== "manager")}
                  title={inUse ? "La está cobrando otra persona" : undefined}
                >
                  <Play size={16} aria-hidden /> {inUse ? "Tomar" : "Retomar"}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      <DiscardPausedDialog
        sale={discarding}
        role={role}
        onClose={() => setDiscarding(null)}
        onResume={(s) => {
          setDiscarding(null);
          onResume(s);
        }}
        onConfirm={async (s, reason, refund) => {
          const ok = await onDiscard(s, reason, refund);
          if (ok) setDiscarding(null);
        }}
      />
    </>
  );
}
