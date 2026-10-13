"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Bell, ListPlus, MessageCircle, Users, UserX, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Checkbox } from "@/components/ui/Checkbox";
import { useToast } from "@/components/ui/Toast";
import { useDiningTables } from "@/modules/dining/hooks";
import {
  WAITLIST_STATUS_LABELS,
  useWaitlist,
  useWaitlistMutations,
  type WaitlistEntry,
} from "@/modules/dining/waitlist";
import { useTicketBranding } from "@/modules/tickets/hooks";
import {
  isOverQuoted,
  isWaitlistActive,
  sortWaitlist,
  suggestTables,
  waitedMinutes,
  waitlistPositions,
  waitlistReadyMessage,
  waitlistWhatsappLink,
} from "@/lib/gastro/waitlist";
import { diningErrorMessage } from "@/lib/gastro/tableOps";
import { cn } from "@/lib/utils/cn";

const QUOTES = [10, 20, 30, 45];

// Lista de espera del salón (F13 · H51). Mobile-first: alta en dos toques,
// fila ordenada por prioridad y llegada, minutos esperados contra lo prometido,
// avisar por WhatsApp (link manual) y sentar en una mesa libre sugerida.
export function WaitlistPanel() {
  const { toast } = useToast();
  const router = useRouter();
  const { data: tables } = useDiningTables();
  const { data: brand } = useTicketBranding(true);
  const { create, setStatus, seat } = useWaitlistMutations();

  const since = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }, []);
  const { data: entries, isLoading } = useWaitlist(since);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [party, setParty] = useState(2);
  const [priority, setPriority] = useState(false);
  const [quoted, setQuoted] = useState<number | null>(20);
  const [seating, setSeating] = useState<WaitlistEntry | null>(null);

  const sorted = useMemo(() => sortWaitlist(entries ?? []), [entries]);
  const positions = useMemo(() => waitlistPositions(entries ?? []), [entries]);
  const waiting = sorted.filter((e) => isWaitlistActive(e.status));
  const closed = sorted.filter((e) => !isWaitlistActive(e.status));
  const options = useMemo(
    () => (seating ? suggestTables(tables ?? [], seating.party_size) : []),
    [tables, seating],
  );

  function err(title: string, e: unknown) {
    toast({ title, description: diningErrorMessage(e), variant: "error" });
  }

  async function add() {
    if (!name.trim()) return;
    try {
      await create.mutateAsync({
        customer_name: name,
        customer_phone: phone,
        party_size: party,
        priority: priority ? 1 : 0,
        quoted_minutes: quoted,
      });
      setName("");
      setPhone("");
      setParty(2);
      setPriority(false);
      toast({ title: "Anotado en la lista de espera", variant: "success" });
    } catch (e) {
      err("No se pudo anotar", e);
    }
  }

  function notify(e: WaitlistEntry) {
    const link = waitlistWhatsappLink(e.customer_phone, waitlistReadyMessage(e.customer_name, brand?.legal_name));
    if (link) window.open(link, "_blank", "noopener,noreferrer");
    if (e.status === "esperando") {
      setStatus.mutate({ id: e.id, status: "avisado" }, { onError: (x) => err("No se pudo marcar", x) });
    }
  }

  function doSeat(tableId: string) {
    if (!seating) return;
    seat.mutate(
      { id: seating.id, tableId },
      {
        onSuccess: (r) => {
          setSeating(null);
          toast({ title: "Mesa abierta", variant: "success" });
          router.push(`/pos?table=${r.order_id}`);
        },
        onError: (x) => err("No se pudo sentar", x),
      },
    );
  }

  return (
    <div className="space-y-6">
      {/* Alta rápida */}
      <Card className="space-y-3 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Nombre" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          <Input
            label="Teléfono (opcional)"
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            maxLength={30}
          />
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-1">
            <span className="mr-2 text-sm text-muted-foreground">Personas</span>
            <button
              type="button"
              onClick={() => setParty((p) => Math.max(1, p - 1))}
              className="grid h-11 w-11 place-items-center rounded-md border border-border hover:bg-muted"
              aria-label="Menos personas"
            >
              -
            </button>
            <span className="w-8 text-center font-semibold tabular-nums">{party}</span>
            <button
              type="button"
              onClick={() => setParty((p) => Math.min(100, p + 1))}
              className="grid h-11 w-11 place-items-center rounded-md border border-border hover:bg-muted"
              aria-label="Más personas"
            >
              +
            </button>
          </div>
          <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
            <Checkbox checked={priority} onCheckedChange={setPriority} />
            Prioridad
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">Espera prometida</span>
          {QUOTES.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => setQuoted(quoted === q ? null : q)}
              className={cn(
                "min-h-9 rounded-md border px-3 text-sm tabular-nums",
                quoted === q ? "border-foreground bg-muted font-medium" : "border-border hover:bg-muted/50",
              )}
            >
              {q} min
            </button>
          ))}
        </div>
        <Button onClick={add} disabled={!name.trim() || create.isPending} loading={create.isPending} className="w-full sm:w-auto">
          <ListPlus size={16} /> Anotar
        </Button>
      </Card>

      {/* Fila */}
      {!isLoading && waiting.length === 0 ? (
        <Card>
          <EmptyState icon={Users} title="Nadie esperando" description="Cuando el salón se llene, anotá a los que llegan." />
        </Card>
      ) : (
        <div className="space-y-2">
          {waiting.map((e) => {
            const mins = waitedMinutes(e.created_at, now);
            const late = isOverQuoted(e, now);
            return (
              <Card key={e.id} className="p-3">
                <div className="flex items-start gap-3">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-muted text-sm font-bold tabular-nums">
                    {positions.get(e.id)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 text-sm font-semibold">
                      <span className="truncate">{e.customer_name}</span>
                      <span className="font-normal text-muted-foreground">· {e.party_size} pers.</span>
                      {e.priority > 0 && (
                        <span className="text-xs font-medium uppercase text-warning">Prioridad</span>
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span className={cn("h-1.5 w-1.5 rounded-full", late ? "bg-red-500" : "bg-muted-foreground")} />
                      <span className={cn("tabular-nums", late && "font-semibold text-danger")}>
                        {mins} min
                        {e.quoted_minutes ? ` de ${e.quoted_minutes}` : ""}
                      </span>
                      <span>· {WAITLIST_STATUS_LABELS[e.status]}</span>
                    </div>
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2">
                  <Button size="sm" variant="secondary" onClick={() => notify(e)} disabled={setStatus.isPending}>
                    {e.customer_phone ? <MessageCircle size={15} /> : <Bell size={15} />} Avisar
                  </Button>
                  <Button size="sm" onClick={() => setSeating(e)}>
                    Sentar
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setStatus.mutate(
                        { id: e.id, status: e.status === "avisado" ? "se_fue" : "cancelado" },
                        { onError: (x) => err("No se pudo actualizar", x) },
                      )
                    }
                    disabled={setStatus.isPending}
                  >
                    {e.status === "avisado" ? <UserX size={15} /> : <X size={15} />}
                    {e.status === "avisado" ? "Se fue" : "Quitar"}
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {closed.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Hoy</p>
          <ul className="divide-y divide-border text-sm">
            {closed.map((e) => (
              <li key={e.id} className="flex items-center justify-between py-2">
                <span className="truncate">
                  {e.customer_name} · {e.party_size} pers.
                </span>
                <span className="text-muted-foreground">{WAITLIST_STATUS_LABELS[e.status]}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Elegir mesa libre */}
      <Modal
        open={seating !== null}
        onOpenChange={(o) => {
          if (!o) setSeating(null);
        }}
        title="Sentar"
        description={seating ? `${seating.customer_name} · ${seating.party_size} personas` : undefined}
      >
        {options.length === 0 ? (
          <p className="text-sm text-muted-foreground">No hay mesas libres ahora.</p>
        ) : (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {options.map((t) => {
              const fits = t.capacity >= (seating?.party_size ?? 0);
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => doSeat(t.id)}
                  disabled={seat.isPending}
                  className="flex min-h-16 flex-col items-start justify-between rounded-md border border-border bg-card px-2.5 py-2 text-left hover:bg-muted/50 disabled:opacity-50"
                >
                  <span className="text-base font-bold">{t.label}</span>
                  <span className={cn("text-[11px]", fits ? "text-muted-foreground" : "text-warning")}>
                    {t.capacity} lugares
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </Modal>
    </div>
  );
}
