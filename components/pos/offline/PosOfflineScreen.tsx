"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CloudOff, Lock, Minus, Plus, Search, Wifi } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { OfflineTicketModal } from "@/components/pos/offline/OfflineTicketModal";
import { SwUpdateBanner } from "@/components/pwa/SwUpdateBanner";
import { idbAvailable, idbKv } from "@/lib/pos/offline/idb";
import type { OfflineQueueEntry } from "@/lib/pos/offline/queue";
import { snapshotKey, snapshotMatches, type OfflineSnapshot } from "@/lib/pos/offline/snapshot";
import {
  resolveOfflineMode,
  type LastPosSession,
  type OfflineMode,
  type PersistedSessionInfo,
} from "@/lib/pos/offline/session";
import {
  SHELL_METHODS,
  addShellLine,
  buildShellSale,
  setShellQty,
  shellProductBlock,
  shellTotal,
  type ShellLine,
  type ShellMethod,
  type ShellProduct,
} from "@/lib/pos/offline/shellCart";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";
import { useOfflinePos } from "@/modules/pos/offline/useOfflinePos";
import {
  readIdleCookie,
  readLastPos,
  readPersistedSession,
  touchIdleCookie,
} from "@/modules/pos/offline/offlineSession";

// POS abierto sin conexión (H65, ADR-087). Es el shell anónimo que guarda el
// service worker: la página no trae datos del servidor; todo sale de lo que
// ya está en el dispositivo (sesión de Supabase, puntero pos.last, foto local
// y cola). Vende sólo con un usuario identificado; si no, queda en sólo
// lectura con el motivo.

type Boot =
  | { status: "loading" }
  | {
      status: "ready";
      last: LastPosSession | null;
      session: PersistedSessionInfo | null;
      snapshot: OfflineSnapshot<ShellProduct> | null;
    };

const RECHECK_MS = 60_000;
const ACTIVITY_DEBOUNCE_MS = 30_000;
/** Motivos de sólo lectura en los que el usuario es el mismo: se ve el catálogo. */
const BROWSE_REASONS = new Set(["disabled", "stale", "no_shift"]);

async function serverUp(): Promise<boolean> {
  if (typeof navigator !== "undefined" && !navigator.onLine) return false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch("/api/health", { cache: "no-store", signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

export function PosOfflineScreen() {
  const [boot, setBoot] = useState<Boot>({ status: "loading" });
  const [now, setNow] = useState(() => Date.now());
  const [online, setOnline] = useState(false);
  const [lines, setLines] = useState<ShellLine[]>([]);
  const linesRef = useRef(lines);
  linesRef.current = lines;

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [last, session] = await Promise.all([readLastPos(), readPersistedSession()]);
      let snapshot: OfflineSnapshot<ShellProduct> | null = null;
      if (last && idbAvailable()) {
        try {
          const s = await idbKv.get<OfflineSnapshot<ShellProduct>>(snapshotKey(last.tenantId, last.userId));
          snapshot = snapshotMatches(s, last.tenantId, last.userId) ? (s ?? null) : null;
        } catch {
          snapshot = null;
        }
      }
      if (alive) setBoot({ status: "ready", last, session, snapshot });
    })();
    const t = setInterval(() => setNow(Date.now()), RECHECK_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // Conexión: si NinjaSoft responde al abrir, vuelve al POS completo. Si vuelve
  // a mitad de una venta, sólo ofrece volver (no corta el cobro).
  useEffect(() => {
    let alive = true;
    // El service worker sirve este shell en /pos cuando /pos no responde (o
    // con ?from= al abrirlo a mano): no se vuelve solo (con una red lenta
    // sería un ida y vuelta), se ofrece el botón.
    const fromPos =
      window.location.pathname !== "/pos-offline" || new URLSearchParams(window.location.search).has("from");
    const check = async (auto: boolean) => {
      const up = await serverUp();
      if (!alive) return;
      setOnline(up);
      if (up && auto && !fromPos && linesRef.current.length === 0) window.location.replace("/pos");
    };
    void check(true);
    const on = () => void check(false);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      alive = false;
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  const mode: OfflineMode | null = useMemo(() => {
    if (boot.status !== "ready") return null;
    return resolveOfflineMode({
      last: boot.last,
      session: boot.session,
      idle: readIdleCookie(),
      snapshot: boot.snapshot,
      now,
    });
  }, [boot, now]);

  const canBrowse = mode?.mode === "sell" || (mode?.mode === "readonly" && BROWSE_REASONS.has(mode.reason));

  return (
    <div data-testid="pos-offline-screen" className="flex min-h-[100dvh] flex-col bg-background text-foreground">
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <span
          aria-hidden
          className={cn(
            "grid h-9 w-9 shrink-0 place-items-center rounded-md",
            online ? "bg-success/15 text-success" : "bg-warning/15 text-warning",
          )}
        >
          {online ? <Wifi size={18} /> : <CloudOff size={18} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">
            {online ? "Hay conexión" : "POS sin conexión"}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {boot.status === "ready" && boot.session?.email && canBrowse ? boot.session.email : "NinjaSoft POS"}
          </span>
        </span>
        {online && (
          <Button size="sm" variant="secondary" onClick={() => window.location.assign("/pos")}>
            Abrir el POS completo
          </Button>
        )}
      </header>

      <div className="pt-3">
        <SwUpdateBanner busy={lines.length > 0} />
      </div>

      {boot.status === "loading" || !mode ? (
        <p className="px-4 py-10 text-center text-sm text-muted-foreground">Cargando datos del dispositivo</p>
      ) : (
        <>
          {mode.mode === "readonly" && (
            <div
              role="alert"
              data-testid="pos-offline-readonly"
              data-reason={mode.reason}
              className="mx-3 mb-3 flex items-start gap-3 rounded-lg border border-border bg-card p-3 md:mx-4"
            >
              <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-warning/15 text-warning">
                <Lock size={18} />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold">Sólo lectura: {mode.title}</span>
                <span className="block text-xs text-muted-foreground">{mode.text}</span>
              </span>
            </div>
          )}
          {canBrowse && boot.last && boot.snapshot && (
            <ShellSeller
              last={boot.last}
              snapshot={boot.snapshot}
              canSell={mode.mode === "sell"}
              lines={lines}
              setLines={setLines}
            />
          )}
        </>
      )}
    </div>
  );
}

function ShellSeller({
  last,
  snapshot,
  canSell,
  lines,
  setLines,
}: {
  last: LastPosSession;
  snapshot: OfflineSnapshot<ShellProduct>;
  canSell: boolean;
  lines: ShellLine[];
  setLines: (fn: (l: ShellLine[]) => ShellLine[]) => void;
}) {
  const { toast } = useToast();
  const offline = useOfflinePos({
    tenantId: last.tenantId,
    userId: last.userId,
    shiftId: snapshot.shift?.id ?? null,
    storeId: snapshot.shift?.storeId ?? null,
    policy: null,
    frozenSnapshot: true,
  });
  const [q, setQ] = useState("");
  const [method, setMethod] = useState<ShellMethod>("cash");
  const [received, setReceived] = useState("");
  const [reference, setReference] = useState("");
  const [voucher, setVoucher] = useState({ lote: "", cupon: "", autorizacion: "" });
  const [saving, setSaving] = useState(false);
  const [ticket, setTicket] = useState<OfflineQueueEntry | null>(null);

  // Actividad real: mantiene viva la marca de inactividad (misma cookie que el panel).
  const lastTouch = useRef(0);
  const onActivity = useCallback(() => {
    if (!canSell) return;
    const t = Date.now();
    if (t - lastTouch.current < ACTIVITY_DEBOUNCE_MS) return;
    lastTouch.current = t;
    touchIdleCookie(t);
  }, [canSell]);

  const results = useMemo(
    () => (offline.searchProducts(q) ?? []).slice(0, 60) as unknown as ShellProduct[],
    [offline, q],
  );
  const total = shellTotal(lines);
  const at = new Date(snapshot.at).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" });

  async function charge() {
    const built = buildShellSale(lines, {
      method,
      received: method === "cash" && received.trim() ? Number(received.replace(",", ".")) : null,
      reference,
      voucher,
    });
    if (!built.ok) {
      toast({ title: built.message, variant: "error" });
      return;
    }
    setSaving(true);
    try {
      const res = await offline.saveSale(built.input);
      if (!res.ok) {
        toast({ title: res.message, variant: "error" });
        return;
      }
      toast({
        title: `Venta guardada sin conexión (${res.entry.provisional})`,
        description: `Total ${formatCurrency(res.entry.total)}. Se envía sola cuando vuelve la conexión.`,
        variant: "success",
      });
      setTicket(res.entry);
      setLines(() => []);
      setReceived("");
      setReference("");
      setVoucher({ lote: "", cupon: "", autorizacion: "" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="flex flex-1 flex-col gap-3 px-3 pb-6 md:flex-row md:px-4"
      onPointerDown={onActivity}
      onKeyDown={onActivity}
    >
      <section className="flex min-w-0 flex-1 flex-col gap-3">
        <p className="text-xs text-muted-foreground" data-testid="pos-offline-status">
          Catálogo del {at}. {offline.pending === 1 ? "1 venta" : `${offline.pending} ventas`} por sincronizar.
          {offline.held > 0 ? ` ${offline.held} retenidas en este dispositivo.` : ""}
        </p>
        <label className="relative block">
          <span className="sr-only">Buscar producto</span>
          <Search size={16} aria-hidden className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar por nombre, código, SKU o PLU"
            className="h-11 w-full rounded-lg border border-border bg-card pl-9 pr-3 text-sm outline-none focus:border-foreground/30"
          />
        </label>
        <ul className="divide-y divide-border rounded-lg border border-border bg-card" data-testid="pos-offline-results">
          {results.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted-foreground">Sin resultados</li>}
          {results.map((p) => {
            const block = shellProductBlock(p);
            return (
              <li key={p.id} className="flex items-center gap-3 px-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{p.name}</span>
                  {block && <span className="block text-xs text-muted-foreground">{block}</span>}
                </span>
                <span className="shrink-0 text-sm tabular-nums">{formatCurrency(Number(p.price))}</span>
                {canSell && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={Boolean(block)}
                    onClick={() => setLines((l) => addShellLine(l, p))}
                    aria-label={`Agregar ${p.name}`}
                  >
                    <Plus size={16} aria-hidden />
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {canSell && (
        <aside className="flex w-full flex-col gap-3 md:w-96" data-testid="pos-offline-cart">
          <ul className="divide-y divide-border rounded-lg border border-border bg-card">
            {lines.length === 0 && (
              <li className="px-3 py-6 text-center text-sm text-muted-foreground">Agregá productos para cobrar</li>
            )}
            {lines.map((l) => (
              <li key={l.productId} className="flex items-center gap-2 px-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{l.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {l.quantity} {l.unit === "kg" ? "kg" : "u"} × {formatCurrency(l.unitPrice)}
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Quitar uno de ${l.name}`}
                  onClick={() => setLines((ls) => setShellQty(ls, l.productId, l.quantity - (l.unit === "kg" ? 0.1 : 1)))}
                >
                  <Minus size={16} aria-hidden />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Sumar uno de ${l.name}`}
                  onClick={() => setLines((ls) => setShellQty(ls, l.productId, l.quantity + (l.unit === "kg" ? 0.1 : 1)))}
                >
                  <Plus size={16} aria-hidden />
                </Button>
              </li>
            ))}
          </ul>

          <div className="space-y-3 rounded-lg border border-border bg-card p-3">
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-muted-foreground">Total</span>
              <span className="text-xl font-semibold tabular-nums" data-testid="pos-offline-total">
                {formatCurrency(total)}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Medio de pago">
              {SHELL_METHODS.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={method === m.id}
                  onClick={() => setMethod(m.id)}
                  className={cn(
                    "h-10 rounded-md border px-2 text-xs font-medium transition-colors",
                    method === m.id ? "border-foreground/40 bg-fg-6" : "border-border hover:bg-fg-6",
                  )}
                >
                  {m.label}
                </button>
              ))}
            </div>
            {method === "cash" && (
              <Input
                label="Efectivo recibido (opcional)"
                inputMode="decimal"
                value={received}
                onChange={(e) => setReceived(e.target.value)}
                hint={
                  received.trim() && Number(received.replace(",", ".")) >= total
                    ? `Vuelto ${formatCurrency(Number(received.replace(",", ".")) - total)}`
                    : undefined
                }
              />
            )}
            {method === "transfer" && (
              <Input label="N° de operación (opcional)" value={reference} onChange={(e) => setReference(e.target.value)} />
            )}
            {(method === "debit" || method === "credit") && (
              <div className="grid grid-cols-3 gap-2">
                <Input label="Lote" value={voucher.lote} onChange={(e) => setVoucher({ ...voucher, lote: e.target.value })} />
                <Input label="Cupón" value={voucher.cupon} onChange={(e) => setVoucher({ ...voucher, cupon: e.target.value })} />
                <Input
                  label="Autoriz."
                  value={voucher.autorizacion}
                  onChange={(e) => setVoucher({ ...voucher, autorizacion: e.target.value })}
                />
              </div>
            )}
            <Button className="w-full" disabled={lines.length === 0} loading={saving} onClick={() => void charge()}>
              Cobrar {formatCurrency(total)}
            </Button>
            <p className="text-xs text-muted-foreground">
              Ticket provisorio. Precios de la última foto del catálogo: el servidor los revisa al sincronizar.
            </p>
          </div>
        </aside>
      )}

      <OfflineTicketModal entry={ticket} onOpenChange={(o) => !o && setTicket(null)} />
    </div>
  );
}
